"""Offline tests for training.nebius (httpx.MockTransport; no network, no real key)."""
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from training import nebius  # noqa: E402
from training.base import NotEnabled  # noqa: E402

L = "ABCDEFGH"


def exs(n=20):
    return [{"text": f"ticket {i}", "category": L[i % 8], "priority": f"P{i % 4 + 1}"} for i in range(n)]


class FakeNebius:
    """Minimal in-memory Token Factory. `statuses` = successive job statuses returned by GET job."""

    def __init__(self, statuses=("queued", "running", "succeeded"), lora=True, tokens=1_000_000):
        self.calls, self.statuses, self.lora, self.tokens = [], list(statuses), lora, tokens
        self.polls = 0
        self.uploads = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        assert req.headers["authorization"] == "Bearer k-test"
        path = req.url.path.replace("/v1", "", 1)
        self.calls.append((req.method, path))
        if req.method == "POST" and path == "/files":
            self.uploads.append(req.content)
            return httpx.Response(200, json={"id": f"file-{len(self.uploads)}"})
        if req.method == "POST" and path == "/fine_tuning/jobs":
            self.created = json.loads(req.content)
            return httpx.Response(200, json={"id": "job-1", "status": "validating_files"})
        if path == "/fine_tuning/jobs/job-1/cancel":
            return httpx.Response(200, json={"id": "job-1", "status": "cancelled"})
        if path == "/fine_tuning/jobs/job-1":
            s = self.statuses[min(self.polls, len(self.statuses) - 1)]
            self.polls += 1
            return httpx.Response(200, json={"id": "job-1", "status": s, "trained_tokens": self.tokens,
                                             "trained_steps": 5, "total_steps": 10,
                                             "error": {"message": "boom"} if s == "failed" else None})
        if path == "/fine_tuning/jobs/job-1/events":
            return httpx.Response(200, json={"data": [], "has_more": False})
        if path == "/fine_tuning/jobs/job-1/checkpoints":
            ck = [{"id": f"ck{i}", "step_number": i * 5, "fine_tuned_model_checkpoint": f"ft:m:ckpt-{i}",
                   "metrics": {"train_loss": 2.0 / i, "valid_loss": 2.5 / i},
                   "result_files": ["f-cfg", "f-w"]} for i in (1, 2)] if self.polls >= 2 else []
            return httpx.Response(200, json={"data": ck, "has_more": False})
        if path == "/files/f-cfg":
            return httpx.Response(200, json={"filename": "ck2/adapter_config.json"})
        if path == "/files/f-w":
            return httpx.Response(200, json={"filename": "../../ck2/adapter_model.safetensors"})
        if path in ("/files/f-cfg/content", "/files/f-w/content"):
            return httpx.Response(200, content=b"bytes-" + path.encode())
        return httpx.Response(404, json={"error": path})


def trainer(tmp_path, fake, **kw):
    c = httpx.Client(transport=httpx.MockTransport(fake))
    return nebius.NebiusTrainer(client=c, api_key="k-test", base_url="https://x.test/v1",
                                work_dir=str(tmp_path / "w"), adapters_dir=str(tmp_path / "a"),
                                sleep=lambda s: None, **kw)


def test_missing_key_is_not_enabled(monkeypatch):
    monkeypatch.delenv("NEBIUS_API_KEY", raising=False)
    monkeypatch.setattr(nebius, "load_env", lambda: None)
    with pytest.raises(NotEnabled):
        nebius.NebiusTrainer()


def test_env_vars_table_is_complete():
    assert all(isinstance(v, tuple) and len(v) == 3 for v in nebius.ENV_VARS.values())
    assert "NEBIUS_FT_MODEL" in nebius.ENV_VARS and nebius.ENV_VARS["NEBIUS_API_KEY"][0] is True


def test_prepare_writes_chat_jsonl_with_shared_prompt(tmp_path):
    t = trainer(tmp_path, FakeNebius())
    d = Path(t.prepare(exs()))
    row = json.loads((d / "train.jsonl").read_text().splitlines()[0])
    assert [m["role"] for m in row["messages"]] == ["system", "user", "assistant"]
    assert row["messages"][2]["content"] in {f"{c} P{p}" for c in L for p in range(1, 5)}
    assert (d / "valid.jsonl").is_file() and t.n_train == 18


def test_pretokenized_masks_prompt(tmp_path):
    class Tok:
        def apply_chat_template(self, msgs, add_generation_prompt=False, tokenize=True):
            ids = [1] * (len(msgs) * 3)
            return ids + ([2] if add_generation_prompt else [])
    t = trainer(tmp_path, FakeNebius(), data_format="pretokenized", tokenizer=Tok())
    # prompt = 6 tokens + 1 gen marker -> full (3 msgs*3=9) is not prefix-stable here, must refuse
    with pytest.raises(nebius.NebiusError):
        t.to_record(exs()[0])

    class Tok2(Tok):
        def apply_chat_template(self, msgs, add_generation_prompt=False, tokenize=True):
            body = [10 + i for i in range(len(msgs[:2]) * 2)]
            return body + ([99] if add_generation_prompt else [99, 7, 8] if len(msgs) == 3 else [])
    t = trainer(tmp_path, FakeNebius(), data_format="pretokenized", tokenizer=Tok2())
    r = t.to_record(exs()[0])
    assert r["labels"] == [-100] * 5 + [7, 8] and r["input_ids"][-2:] == [7, 8]
    assert len(r["labels"]) == len(r["input_ids"]) == len(r["attention_mask"])


def test_full_flow_lora_downloads_adapter_and_costs(tmp_path):
    fake = FakeNebius(lora=True)
    t = trainer(tmp_path, fake, lora=True, price_per_m=2.0, epochs=2)
    events = []
    res = t.train(1, t.prepare(exs()), events.append)
    hp = fake.created["hyperparameters"]
    assert fake.created["model"] == "google/gemma-4-E4B-it" and hp["lora"] is True and hp["lora_r"] == 16
    assert hp["n_epochs"] == 2 and fake.created["validation_file"] == "file-2"
    assert res.cost_usd == pytest.approx(2.0) and "Nebius" in res.hardware
    assert [s for s, _ in res.loss_curve] == [5, 10] and len(res.val_curve) == 2
    out = Path(res.adapter_path)
    assert (out / "adapter_model.safetensors").read_bytes().startswith(b"bytes-")  # path traversal stripped
    meta = json.loads((out / "nebius_job.json").read_text())
    assert meta["mode"] == "lora_adapter" and meta["ft_model"] == "ft:m:ckpt-2"
    assert any(e["type"] == "train_progress" and e["kind"] == "train" and e["loss"] for e in events)
    assert ("POST", "/fine_tuning/jobs/job-1/cancel") not in fake.calls


def test_no_price_means_zero_cost_with_note(tmp_path):
    fake = FakeNebius()
    t = trainer(tmp_path, fake, price_per_m=None)
    t.price_per_m = None
    res = t.train(1, t.prepare(exs()))
    assert res.cost_usd == 0.0
    assert "unset" in json.loads((Path(res.adapter_path) / "nebius_job.json").read_text())["notes"][0]


def test_full_finetune_omits_lora_hparams(tmp_path):
    fake = FakeNebius()
    t = trainer(tmp_path, fake, lora=False)
    t.train(1, t.prepare(exs()))
    assert fake.created["hyperparameters"]["lora"] is False
    assert "lora_r" not in fake.created["hyperparameters"]
    meta = json.loads((Path(t.adapters_dir) / "round_1" / "nebius_job.json").read_text())
    assert meta["mode"] == "full_weights"


def test_timeout_cancels_job(tmp_path):
    fake = FakeNebius(statuses=("running",))
    now = [0.0]

    def clock():
        now[0] += 400
        return now[0]
    t = trainer(tmp_path, fake, max_wait_min=10, clock=clock)
    with pytest.raises(TimeoutError):
        t.train(1, t.prepare(exs()))
    assert ("POST", "/fine_tuning/jobs/job-1/cancel") in fake.calls


def test_keyboard_interrupt_cancels_job(tmp_path):
    fake = FakeNebius(statuses=("running",))

    def boom(_):
        raise KeyboardInterrupt
    t = trainer(tmp_path, fake)
    t._sleep = boom
    with pytest.raises(KeyboardInterrupt):
        t.train(1, t.prepare(exs()))
    assert ("POST", "/fine_tuning/jobs/job-1/cancel") in fake.calls


def test_failed_job_raises_and_does_not_retry_create(tmp_path):
    fake = FakeNebius(statuses=("failed",))
    t = trainer(tmp_path, fake)
    with pytest.raises(nebius.NebiusError, match="boom"):
        t.train(1, t.prepare(exs()))
    assert sum(1 for c in fake.calls if c == ("POST", "/fine_tuning/jobs")) == 1


def test_create_5xx_is_not_retried(tmp_path):
    n = {"create": 0}

    def h(req):
        if req.url.path.endswith("/files"):
            return httpx.Response(200, json={"id": "f"})
        n["create"] += 1
        return httpx.Response(503, text="down")
    t = trainer(tmp_path, h)
    with pytest.raises(nebius.NebiusError):
        t.train(1, t.prepare(exs()))
    assert n["create"] == 1


def test_error_text_never_contains_key(tmp_path):
    t = trainer(tmp_path, lambda r: httpx.Response(401, text="nope"))
    with pytest.raises(nebius.NebiusError) as e:
        t._req("GET", "/models")
    assert "k-test" not in str(e.value)


def test_parse_metrics_variants():
    p = nebius.NebiusTrainer.parse_metrics
    assert p({"data": {"step": 3, "train_loss": 1.5, "valid_loss": 1.7}}) == [("train", 3, 1.5), ("val", 3, 1.7)]
    assert p({"type": "metrics", "message": "step 10 train_loss 0.42"}) == [("train", 10, 0.42)]
    assert p({"message": "Training started"}) == []

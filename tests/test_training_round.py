import json
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eval.classifiers import FakeClassifier  # noqa: E402
from training import mlx_local  # noqa: E402
from training import round as RD  # noqa: E402
from training.base import Trainer, TrainResult  # noqa: E402
from training.prompt import SYSTEM_PROMPT, build_messages, parse_answer  # noqa: E402

L = "ABCDEFGH"


def ex(i, **kw):
    d = {"id": i, "text": f"ticket number {i}", "category": L[i % 8], "priority": f"P{i % 4 + 1}"}
    d.update(kw)
    return d


def write_data(d: Path, n_test=40):
    d.mkdir(parents=True, exist_ok=True)
    for name, n, off in (("train", 30, 0), ("val", 8, 100), ("test", n_test, 200)):
        with open(d / f"{name}.jsonl", "w") as f:
            for i in range(n):
                f.write(json.dumps(ex(off + i)) + "\n")


# ---------------- prompt / data prep / parser ----------------

def test_prompt_roundtrip():
    m = build_messages("hello")
    assert m[0] == {"role": "system", "content": SYSTEM_PROMPT} and m[1]["content"] == "hello"
    assert parse_answer("C P1") == ("C", "P1")
    assert parse_answer("c, p3\n") == ("C", "P3")
    assert parse_answer("garbage") == (None, None)
    assert parse_answer("B") == ("B", None)


def test_mlx_prepare_format_and_split(tmp_path):
    t = mlx_local.MlxLocalTrainer(work_dir=str(tmp_path), adapters_dir=str(tmp_path / "ad"))
    d = Path(t.prepare([ex(i) for i in range(20)]))
    tr = [json.loads(l) for l in (d / "train.jsonl").read_text().splitlines()]
    va = [json.loads(l) for l in (d / "valid.jsonl").read_text().splitlines()]
    assert len(tr) == 18 and len(va) == 2
    msgs = tr[0]["messages"]
    assert [m["role"] for m in msgs] == ["system", "user", "assistant"]
    assert msgs[0]["content"] == SYSTEM_PROMPT
    assert parse_answer(msgs[2]["content"]) != (None, None) and len(msgs[2]["content"]) == 4
    assert {r["messages"][1]["content"] for r in tr}.isdisjoint({r["messages"][1]["content"] for r in va})
    assert t._iters() == 54


def test_loss_parser_real_lines():
    # mlx_lm 0.32 rich-UI lines captured from a piped run, and the classic mlx_lm format
    assert mlx_local.parse_loss_line("    10    2.345 ▼    1,234     1.2k") == {"kind": "train", "step": 10, "loss": 2.345}
    assert mlx_local.parse_loss_line("    20    1.002 ▲      900     2.1k")["kind"] == "train"
    assert mlx_local.parse_loss_line("    50    val 2.101    0.52s") == {"kind": "val", "step": 50, "loss": 2.101}
    assert mlx_local.parse_loss_line(
        "Iter 10: Train loss 2.345, Learning Rate 1.000e-05, It/sec 2.1, Tokens/sec 300, Trained Tokens 1234, Peak mem 5.4 GB"
    ) == {"kind": "train", "step": 10, "loss": 2.345}
    assert mlx_local.parse_loss_line("Iter 1: Val loss 3.456, Val took 0.5s")["kind"] == "val"
    assert mlx_local.parse_loss_line("Loading pretrained model") is None
    assert mlx_local.parse_loss_line("Trainable parameters: 0.1% (5.2M/4000M)") is None


def test_mlx_train_streams_subprocess(tmp_path):
    script = ("print('Loading'); print('    10    2.500 ▼    100     0.1k', flush=True); "
              "print('    20    val 2.100    0.5s'); print('    20    1.900 ▼    100     0.2k')")
    t = mlx_local.MlxLocalTrainer(work_dir=str(tmp_path), adapters_dir=str(tmp_path / "ad"),
                                  cmd_override=[sys.executable, "-c", script], iters=20)
    d = t.prepare([ex(i) for i in range(10)])
    events = []
    r = t.train(3, d, events.append)
    assert r.loss_curve == [(10, 2.5), (20, 1.9)] and r.val_curve == [(20, 2.1)]
    assert r.cost_usd == 0.0 and r.hardware and r.wall_time_s >= 0
    assert r.adapter_path.endswith("round_3") and len(events) == 3
    assert events[0]["type"] == "train_progress" and events[0]["total_steps"] == 20


def test_mlx_train_failure_raises(tmp_path):
    t = mlx_local.MlxLocalTrainer(work_dir=str(tmp_path), adapters_dir=str(tmp_path / "a"),
                                  cmd_override=[sys.executable, "-c", "import sys; print('boom'); sys.exit(2)"])
    d = t.prepare([ex(i) for i in range(4)])
    with pytest.raises(RuntimeError, match="boom"):
        t.train(1, d)


def test_only_mlx_local_trainer():
    assert RD.get_trainer("mlx_local").name == "mlx_local"
    with pytest.raises(ValueError):
        RD.get_trainer("aws")


# ---------------- promotion gate ----------------

def test_decide_promotion():
    ok, why = RD.decide_promotion(0.8, 0.7)
    assert ok and "improved" in why
    ok, why = RD.decide_promotion(0.6, 0.7)
    assert not ok and "did not improve" in why
    assert not RD.decide_promotion(0.7, 0.7)[0]            # tie -> no
    assert not RD.decide_promotion(0.72, 0.7, min_delta=0.05)[0]
    assert RD.decide_promotion(0.5, None)[0]


# ---------------- end to end with fakes ----------------

class FakeTrainer(Trainer):
    name = "fake"

    def __init__(self):
        self.prepared = None

    def prepare(self, examples):
        self.prepared = examples
        return "/fake/data"

    def train(self, round, data_dir, on_progress=None):
        for s in (10, 20):
            if on_progress:
                on_progress({"type": "train_progress", "round": round, "step": s, "loss": 3.0 / s})
        return TrainResult(f"/fake/adapters/round_{round}", [(10, 0.3), (20, 0.15)], 1.5, "FakeChip", 0.0)


class FakeBackend:
    def __init__(self, new_skill, base_skill, promoted_f1=None, examples=None, test_gold=None):
        self.examples = list(examples or [])
        self.rounds, self.calls = [], []
        self.new_skill, self.base_skill, self.promoted = new_skill, base_skill, promoted_f1
        self.gold = test_gold or {}

    def load_training_examples(self):
        return list(self.examples)

    def add_training_examples(self, rows, source):
        self.calls.append(("add", source, len(rows)))
        self.examples += [{**r, "source": source} for r in rows]
        return len(rows)

    def next_round_number(self):
        return len(self.rounds) + 1

    def promoted_eval(self):
        return None if self.promoted is None else {"round": 1, "category_macro_f1": self.promoted}

    def make_classifier(self, adapter):
        return FakeClassifier(skill=self.base_skill if adapter is None else self.new_skill, gold=self.gold)

    def promote(self, rnd, adapter, version, ev):
        self.calls.append(("promote", rnd, version))

    def recalibrate(self, val):
        self.calls.append(("recalibrate", len(val)))

    def save_round(self, row):
        self.rounds.append(row)

    def pause_serving(self):
        self.calls.append(("pause",))

    def resume_serving(self):
        self.calls.append(("resume",))


@pytest.fixture
def env(tmp_path):
    d = tmp_path / "data"
    write_data(d)
    gold = {}
    for line in (d / "test.jsonl").read_text().splitlines():
        r = json.loads(line)
        gold[r["text"]] = (r["category"], r["priority"])
    return d, tmp_path / "res", gold


def test_round_promotes_when_better(env):
    d, res, gold = env
    be = FakeBackend(new_skill=1.0, base_skill=0.0, test_gold=gold, examples=[{**ex(i), "source": "teacher"} for i in range(6)])
    events = []
    row = RD.run_round(be, trainer=FakeTrainer(), data_dir=d, results_dir=res, on_event=events.append)
    assert row["promoted"] is True and "improved" in row["reason"]
    assert row["round"] == 1 and row["model_version"] == "round_1" and row["examples"] == 6
    assert row["eval"]["category_macro_f1"] > row["baseline_macro_f1"]
    assert row["loss"] == [{"step": 10, "loss": 0.3}, {"step": 20, "loss": 0.15}]
    assert row["hardware"] == "FakeChip" and row["provisional"] is True
    names = [c[0] for c in be.calls]
    assert names == ["pause", "promote", "resume", "recalibrate"]
    assert be.calls[-1] == ("recalibrate", 8)
    assert be.rounds == [row]
    types = [e["type"] for e in events]
    assert types[0] == "round_start" and types.count("train_progress") == 2 and types[-1] == "round_complete"
    assert (res / "round_1.json").is_file() and (res / "base.json").is_file()


def test_round_not_promoted_when_worse(env):
    d, res, gold = env
    be = FakeBackend(new_skill=0.0, base_skill=1.0, promoted_f1=0.95, test_gold=gold,
                     examples=[{**ex(i), "source": "teacher"} for i in range(6)])
    row = RD.run_round(be, trainer=FakeTrainer(), data_dir=d, results_dir=res)
    assert row["promoted"] is False and "did not improve" in row["reason"]
    names = [c[0] for c in be.calls]
    assert "promote" not in names and "recalibrate" not in names
    assert names == ["pause", "resume"]
    assert be.rounds[0]["promoted"] is False


def test_resume_called_even_when_training_fails(env):
    d, res, gold = env

    class Boom(FakeTrainer):
        def train(self, *a, **k):
            raise RuntimeError("oom")

    be = FakeBackend(1.0, 0.0, test_gold=gold, examples=[ex(i) for i in range(4)])
    with pytest.raises(RuntimeError):
        RD.run_round(be, trainer=Boom(), data_dir=d, results_dir=res)
    assert [c[0] for c in be.calls] == ["pause", "resume"] and be.rounds == []


def test_seed_from_train_pool_is_labelled_and_deduped(env):
    d, res, gold = env
    be = FakeBackend(1.0, 0.0, test_gold=gold, examples=[{**ex(0), "source": "teacher"}])
    tr = FakeTrainer()
    RD.run_round(be, trainer=tr, data_dir=d, results_dir=res, seed_from_train_pool=True)
    assert be.calls[0] == ("add", "seed_train_pool", 29)       # ex(0) text already present
    assert len(tr.prepared) == 30
    assert sum(1 for e in tr.prepared if e.get("source") == "seed_train_pool") == 29


def test_too_few_examples(env):
    d, res, gold = env
    with pytest.raises(ValueError):
        RD.run_round(FakeBackend(1, 0, test_gold=gold), trainer=FakeTrainer(), data_dir=d, results_dir=res)


def test_async_round_events_and_single_flight(env):
    d, res, gold = env
    be = FakeBackend(1.0, 0.0, test_gold=gold, examples=[ex(i) for i in range(6)])
    events, gate = [], threading.Event()

    class Slow(FakeTrainer):
        def train(self, *a, **k):
            gate.wait(5)
            return super().train(*a, **k)

    t = RD.run_round_async(be, on_event=events.append, trainer=Slow(), data_dir=d, results_dir=res)
    with pytest.raises(RuntimeError, match="already running"):
        RD.run_round_async(be, trainer=FakeTrainer(), data_dir=d, results_dir=res)
    gate.set()
    t.join(10)
    assert events[-1]["type"] == "round_complete"
    # lock released: can run again
    RD.run_round_async(be, on_event=events.append, trainer=FakeTrainer(), data_dir=d, results_dir=res).join(10)
    assert events[-1]["type"] == "round_complete" and len(be.rounds) == 2


def test_async_failure_emits_round_failed(env):
    d, res, gold = env
    be = FakeBackend(1.0, 0.0, test_gold=gold, examples=[ex(0)])
    events = []
    RD.run_round_async(be, on_event=events.append, trainer=FakeTrainer(), data_dir=d, results_dir=res).join(10)
    assert events[-1]["type"] == "round_failed"

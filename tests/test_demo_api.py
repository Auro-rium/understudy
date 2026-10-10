"""X-Demo-Key auth, /api/model/*, and the OpenAI-compatible /v1 endpoints (fake classifier)."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.classifiers import FakeClassifier
from backend.db import DB
from backend.fakes import FakeTeacher

EV = {"category_acc": 0.9, "category_macro_f1": 0.9, "priority_acc": 0.8}


@pytest.fixture
def env(tmp_path, monkeypatch):
    import training.db_backend as dbb
    monkeypatch.setattr(dbb, "ADAPTERS", tmp_path / "adapters")
    monkeypatch.setenv("EVAL_RESULTS_DIR", str(tmp_path / "none"))
    monkeypatch.setenv("DEMO_PATH", str(tmp_path / "demo.jsonl"))
    (tmp_path / "demo.jsonl").write_text('{"text": "late payment"}\n')
    db = DB(str(tmp_path / "t.sqlite"))
    for n, promoted in [(1, False), (2, True), (3, True)]:
        (tmp_path / "adapters" / f"round_{n}").mkdir(parents=True)
        (tmp_path / "adapters" / f"round_{n}" / "adapters.safetensors").write_text("x")
        db.insert_round(round=n, model_version=f"round_{n}", examples=1, loss=[], wall_time_s=1, hardware="t",
                        cost_usd=0, promoted=promoted, reason="", eval={**EV, "category_macro_f1": 0.5 + n / 10})
    with TestClient(create_app(db, FakeClassifier(), FakeTeacher())) as c:
        yield c


MUTATING = [("/api/classify", {"text": "hi"}), ("/api/stream/start", {"rate_per_min": 60}),
            ("/api/stream/stop", {}), ("/api/mode/offline", {"offline": False}),
            ("/api/train/round", {"backend": "mlx_local"}), ("/api/model/activate", {"version": "base"})]


def test_open_when_key_unset(env):
    assert env.post("/api/classify", json={"text": "late payment"}).status_code == 200


def test_mutating_endpoints_need_key_but_gets_stay_open(env, monkeypatch):
    monkeypatch.setenv("DEMO_KEY", "s3cret")
    for path, body in MUTATING:
        assert env.post(path, json=body).status_code == 401, path
        assert env.post(path, json=body, headers={"X-Demo-Key": "wrong"}).status_code == 401, path
    for path in ["/api/health", "/api/metrics/summary", "/api/snapshot", "/api/rounds", "/api/model/versions",
                 "/api/tickets/recent", "/api/review_queue", "/api/eval/compare"]:
        assert env.get(path).status_code == 200, path
    ok = env.post("/api/classify", json={"text": "late payment"}, headers={"X-Demo-Key": "s3cret"})
    assert ok.status_code == 200


def test_cors_preflight_allows_demo_key_header(env, monkeypatch):
    monkeypatch.setenv("DEMO_KEY", "s3cret")
    r = env.options("/api/model/activate", headers={"Origin": "https://x.vercel.app",
                                                    "Access-Control-Request-Method": "POST",
                                                    "Access-Control-Request-Headers": "content-type,x-demo-key"})
    assert r.status_code == 200 and "x-demo-key" in r.headers["access-control-allow-headers"].lower()


def test_versions_and_activate_hot_swap(env):
    v = env.get("/api/model/versions").json()
    assert v["active"] == "round_3"
    assert [x["version"] for x in v["versions"]] == ["base", "round_1", "round_2", "round_3"]
    assert all(x["available"] for x in v["versions"])
    assert [x["promoted"] for x in v["versions"]] == [False, False, True, True]
    r = env.post("/api/model/activate", json={"version": "round_2"}).json()
    assert r["model_version"] == "round_2" and r["previous_model_version"] == "round_3" and r["changed"]
    assert env.get("/api/health").json()["model_version"] == "round_2"
    assert env.post("/api/classify", json={"text": "late payment"}).json()["model_version"] == "round_2"
    assert env.post("/api/model/activate", json={"version": "base"}).json()["model_version"] == "base"
    assert env.get("/api/health").json()["model_version"] == "base"
    assert env.post("/api/model/activate", json={"version": "base"}).json()["changed"] is False
    assert env.post("/api/model/activate", json={"version": "round_9"}).status_code == 404


def test_activate_missing_adapter_is_unavailable(env, tmp_path):
    import shutil
    shutil.rmtree(tmp_path / "adapters" / "round_1")
    v = {x["version"]: x for x in env.get("/api/model/versions").json()["versions"]}
    assert v["round_1"]["available"] is False


def test_activate_emits_model_event(env):
    app = env.app
    q = app.state.ctx.events.subscribe()
    env.post("/api/model/activate", json={"version": "round_1"})
    msg = q.get_nowait()
    assert msg["event"] == "model"
    assert json.loads(msg["data"]) == {"model_version": "round_1", "previous_model_version": "round_3"}


def test_openai_models_and_chat(env, monkeypatch):
    m = env.get("/v1/models").json()
    assert m["object"] == "list"
    assert [x["id"] for x in m["data"]] == ["understudy-base", "understudy-round_1", "understudy-round_2",
                                            "understudy-round_3"]
    r = env.post("/v1/chat/completions", json={"model": "understudy-round_2",
                                               "messages": [{"role": "user", "content": "hello there"}]})
    j = r.json()
    assert r.status_code == 200 and j["object"] == "chat.completion" and j["model"] == "understudy-round_2"
    assert "hello there" in j["choices"][0]["message"]["content"] and j["usage"]["total_tokens"] > 0
    assert env.get("/api/health").json()["model_version"] == "round_2"   # model name switched the live model
    parts = env.post("/v1/chat/completions", json={"model": "understudy-round_2", "messages": [
        {"role": "user", "content": [{"type": "text", "text": "part one"}]}]}).json()
    assert "part one" in parts["choices"][0]["message"]["content"]
    bad = env.post("/v1/chat/completions", json={"model": "gpt-4", "messages": [{"role": "user", "content": "x"}]})
    assert bad.status_code == 404 and bad.json()["error"]["type"] == "invalid_request_error"


def test_openai_streaming_format(env):
    r = env.post("/v1/chat/completions", json={"model": "understudy-round_3", "stream": True,
                                               "messages": [{"role": "user", "content": "stream me please"}]})
    assert r.headers["content-type"].startswith("text/event-stream")
    lines = [l for l in r.text.splitlines() if l.startswith("data: ")]
    assert lines[-1] == "data: [DONE]"
    chunks = [json.loads(l[6:]) for l in lines[:-1]]
    assert chunks[0]["choices"][0]["delta"]["role"] == "assistant"
    text = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks if c["choices"])
    assert "stream me please" in text


def test_v1_accepts_bearer_or_header_key(env, monkeypatch):
    monkeypatch.setenv("DEMO_KEY", "s3cret")
    body = {"model": "understudy-round_3", "messages": [{"role": "user", "content": "x"}]}
    assert env.get("/v1/models").status_code == 401
    assert env.post("/v1/chat/completions", json=body, headers={"Authorization": "Bearer nope"}).status_code == 401
    assert env.post("/v1/chat/completions", json=body, headers={"Authorization": "Bearer s3cret"}).status_code == 200
    assert env.get("/v1/models", headers={"X-Demo-Key": "s3cret"}).status_code == 200

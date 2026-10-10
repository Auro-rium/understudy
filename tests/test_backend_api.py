import asyncio
import sys
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app import create_app
from backend.classifiers import FakeClassifier
from backend.db import DB
from backend.events import Broadcaster
from backend.fakes import FakeTeacher
from backend import schemas


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("TEACHER_PRICE_IN_PER_M", "3")
    monkeypatch.setenv("TEACHER_PRICE_OUT_PER_M", "15")
    monkeypatch.setenv("EVAL_RESULTS_DIR", str(tmp_path / "none"))
    monkeypatch.setenv("DEMO_PATH", str(tmp_path / "demo.jsonl"))
    db = DB(str(tmp_path / "api.sqlite"))
    teacher = FakeTeacher()
    app = create_app(db, FakeClassifier(), teacher, probe_interval_s=0.05)
    with TestClient(app) as c:
        yield c, app, teacher, tmp_path


def test_all_endpoints_shapes(env):
    c, app, teacher, tmp = env
    h = c.get("/api/health").json()
    schemas.Health(**h)
    assert h["mode"] == "online" and h["model_version"] == "base"
    for t in ["my app crashed on login", "late payment please", "hello there", "kyc verification stuck"]:
        r = c.post("/api/classify", json={"text": t})
        assert r.status_code == 200
        schemas.ClassifyResult(**r.json())
    schemas.MetricsSummary(**c.get("/api/metrics/summary").json())
    assert c.get("/api/metrics/summary").json()["total"] == 4
    [schemas.TimePoint(**p) for p in c.get("/api/metrics/timeseries?size=2").json()]
    rec = c.get("/api/tickets/recent?limit=3").json()
    assert len(rec) == 3 and rec[0]["id"] > rec[1]["id"]
    [schemas.TicketOut(**t) for t in rec]
    assert c.get("/api/review_queue").json() == []
    assert c.get("/api/rounds").json() == []
    e = c.get("/api/eval/compare").json()
    assert set(e) == {"provisional", "models", "router", "per_category_f1", "confusion"}
    snap = c.get("/api/snapshot").json()
    assert "generated_at" in snap and snap["summary"]["total"] == 4
    assert c.get("/api/health", headers={"Origin": "http://x"}).headers["access-control-allow-origin"] == "*"


def test_offline_flow_and_auto_recovery(env):
    c, app, teacher, tmp = env
    assert c.post("/api/mode/offline", json={"offline": True}).json()["mode"] == "offline"
    texts = [f"unknown thing {i}" for i in range(20)]
    srcs = {c.post("/api/classify", json={"text": t}).json()["source"] for t in texts}
    assert "teacher" not in srcs and "review" in srcs
    q = c.get("/api/review_queue").json()
    [schemas.ReviewItem(**x) for x in q]
    assert len(q) >= 1
    assert c.get("/api/health").json()["mode"] == "offline"
    c.post("/api/mode/offline", json={"offline": False})
    # teacher down -> detected offline -> probe restores
    teacher.available = False
    for t in texts:
        c.post("/api/classify", json={"text": t + "!"})
    assert c.get("/api/health").json()["mode"] == "offline"
    teacher.available = True
    import time
    for _ in range(40):
        if c.get("/api/health").json()["mode"] == "online":
            break
        time.sleep(0.05)
    assert c.get("/api/health").json()["mode"] == "online"


def test_train_501_without_module_and_with_stub(env, monkeypatch):
    c, app, teacher, tmp = env
    monkeypatch.setitem(sys.modules, "training", None)
    assert c.post("/api/train/round", json={"backend": "mlx_local"}).status_code == 501
    mod = types.ModuleType("training.round")
    pkg = types.ModuleType("training"); pkg.__path__ = []

    import threading

    def run_round_async(backend, on_event=None, **kw):
        def work():
            on_event({"type": "round_start", "round": 1})
            n = backend.next_round_number()
            backend.pause_serving()
            backend.promote(n, "/tmp/x", f"round_{n}", {})
            backend.resume_serving()
            ev = {"category_acc": 1, "category_macro_f1": 1, "priority_acc": 1}
            backend.save_round({"round": n, "model_version": f"round_{n}", "examples": 3,
                                "loss": [{"step": 1, "loss": 1.0}], "wall_time_s": 1, "hardware": "test",
                                "cost_usd": 0, "promoted": True, "reason": "stub", "eval": ev})
            on_event({"type": "round_complete", "round": n})
        t = threading.Thread(target=work); t.start()
        return t

    mod.run_round_async = run_round_async
    monkeypatch.setitem(sys.modules, "training", pkg)
    monkeypatch.setitem(sys.modules, "training.round", mod)
    r = c.post("/api/train/round", json={"backend": "mlx_local"})
    assert r.status_code == 200 and r.json()["job_id"]
    import time
    for _ in range(40):
        if c.get("/api/rounds").json():
            break
        time.sleep(0.05)
    rounds = c.get("/api/rounds").json()
    schemas.RoundOut(**rounds[0])
    assert c.get("/api/health").json()["model_version"] == "round_1"


def test_stream_409_then_runs(env):
    c, app, teacher, tmp = env
    assert c.post("/api/stream/start", json={"rate_per_min": 600}).status_code == 409
    (tmp / "demo.jsonl").write_text('{"text": "late payment"}\n{"text": "app crash"}\n')
    assert c.post("/api/stream/start", json={"rate_per_min": 6000}).status_code == 200
    import time
    for _ in range(40):
        if c.get("/api/metrics/summary").json()["total"] >= 2:
            break
        time.sleep(0.05)
    assert c.get("/api/metrics/summary").json()["total"] == 2
    assert c.post("/api/stream/stop").status_code == 200


def test_broadcaster_pubsub():
    async def go():
        b = Broadcaster(); b.bind_loop(asyncio.get_running_loop())
        q = b.subscribe()
        b.publish("prediction", {"a": 1})
        await asyncio.to_thread(b.publish, "mode", {"mode": "offline"})  # from another thread
        m1, m2 = await asyncio.wait_for(q.get(), 1), await asyncio.wait_for(q.get(), 1)
        assert m1["event"] == "prediction" and m2["event"] == "mode"
        with pytest.raises(ValueError):
            b.publish("bogus", {})
    asyncio.run(go())

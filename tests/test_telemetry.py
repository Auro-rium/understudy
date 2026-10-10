"""Telemetry: /api/telemetry counters, /api/logs ring buffer, request middleware, /logs page (fakes only)."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.classifiers import FakeClassifier
from backend.db import DB
from backend.fakes import FakeTeacher
from backend.telemetry import Telemetry, Window

HIGH, LOW = "confident ticket", "unsure ticket"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("EVAL_RESULTS_DIR", str(tmp_path / "none"))
    clf = FakeClassifier(fixed={HIGH: ("A", "P1", 0.99), LOW: ("C", "P3", 0.30)})
    with TestClient(create_app(DB(str(tmp_path / "t.sqlite")), clf, FakeTeacher(), load_promoted=False)) as c:
        yield c


def kinds(c, **params):
    return [r["kind"] for r in c.get("/api/logs", params=params).json()["records"]]


def test_classify_counts_sources_stages_and_teacher(client):
    assert client.post("/api/classify", json={"text": HIGH}).json()["source"] == "local"
    assert client.post("/api/classify", json={"text": LOW}).json()["source"] == "teacher"
    t = client.get("/api/telemetry").json()
    assert t["classify"]["count"] == 2 and t["classify"]["by_source"] == {"local": 1, "teacher": 1}
    assert t["classify"]["stages"]["classify_total"]["count"] == 2
    assert t["classify"]["stages"]["teacher"]["count"] == 1
    assert t["teacher"]["calls"] == 1 and t["teacher"]["errors"] == 0
    assert t["events"]["prediction"] == 2
    assert t["model_version"] == "base" and t["mode"] == "online"
    route = next(r for r in t["requests"]["routes"] if r["route"] == "POST /api/classify")
    assert route["count"] == 2 and route["status"] == {"200": 2}

    recs = [r for r in client.get("/api/logs").json()["records"] if r["kind"] == "classify"]
    assert [r["msg"].split(" -> ")[1] for r in recs] == ["local", "teacher"]
    assert recs[0]["fields"]["conf"] == 0.99 and recs[0]["fields"]["text"] == HIGH


def test_logs_after_level_and_kind_filters(client):
    first = client.get("/api/logs").json()["last_seq"]
    assert "startup" in kinds(client)
    client.get("/api/health")                         # polling -> debug only
    client.post("/api/mode/offline", json={"offline": True})
    new = client.get("/api/logs", params={"after": first}).json()["records"]
    assert all(r["seq"] > first for r in new)
    assert any(r["kind"] == "mode" and r["level"] == "warning" for r in new)
    info = client.get("/api/logs", params={"after": first, "level": "info"}).json()["records"]
    assert not any(r["msg"] == "GET /api/health" for r in info)
    assert set(kinds(client, after=first, kind="mode")) == {"mode"}


def test_auth_rejections_and_self_polling_not_logged(client, monkeypatch):
    monkeypatch.setenv("DEMO_KEY", "s3cret")
    assert client.post("/api/classify", json={"text": HIGH}).status_code == 401
    t = client.get("/api/telemetry").json()
    assert t["requests"]["auth_rejected"] == 1
    recs = client.get("/api/logs").json()["records"]
    auth = [r for r in recs if r["kind"] == "auth"]
    assert len(auth) == 1 and "s3cret" not in str(recs)
    assert not any("/api/logs" in r["msg"] or "/api/telemetry" in r["msg"] for r in recs)


def test_logs_page_served(client):
    r = client.get("/logs")
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    assert "/api/telemetry" in r.text and "/api/logs" in r.text


def test_ring_buffer_bounded_and_window_stats():
    t = Telemetry(buffer=5)
    for i in range(12):
        t.record("info", "x", f"m{i}")
    out = t.logs()
    assert [r["msg"] for r in out["records"]] == [f"m{i}" for i in range(7, 12)] and out["last_seq"] == 12
    w = Window(n=3)
    for v in (10, 20, 30, 40):
        w.add(v)
    s = w.stats()
    assert s["count"] == 4 and s["mean_ms"] == 25.0 and s["p50_ms"] == 30 and s["max_ms"] == 40


def test_classify_log_carries_logits_and_probs():
    t = Telemetry()
    res = {"id": 1, "category": "A", "priority": "P2", "source": "local", "model_version": "m",
           "confidence": 0.9, "cost_usd": 0.0}
    t.observe_classify(res, 0.5, {"classify_total": 5.0}, "hi", {"A": 3.0, "B": 0.0})
    f = t.logs(kind="classify")["records"][-1]["fields"]
    assert f["logits"] == {"A": 3.0, "B": 0.0}
    assert abs(sum(f["probs"].values()) - 1) < 1e-3 and f["probs"]["A"] > 0.95

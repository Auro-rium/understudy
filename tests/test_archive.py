"""Reset archives the live data, zeroes the counters, and the archive stays readable."""
import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.classifiers import FakeClassifier
from backend.db import DB
from backend.fakes import FakeTeacher


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("EVAL_RESULTS_DIR", str(tmp_path / "none"))
    monkeypatch.setenv("SNAPSHOT_DIR", str(tmp_path / "snaps"))
    clf = FakeClassifier(fixed={"hi": ("A", "P1", 0.99), "lo": ("C", "P3", 0.30)})
    with TestClient(create_app(DB(str(tmp_path / "t.sqlite")), clf, FakeTeacher(), load_promoted=False)) as c:
        yield c


def test_reset_archives_then_zeroes_and_snapshot_is_readable(client):
    for t in ("hi", "lo", "hi"):
        client.post("/api/classify", json={"text": t})
    assert client.get("/api/snapshots").json() == []
    r = client.post("/api/demo/reset").json()
    assert r["snapshot"]["tickets"] == 3 and r["snapshot"]["local"] == 2 and r["snapshot"]["teacher"] == 1
    assert r["summary"]["total"] == 0
    assert client.get("/api/metrics/summary").json()["total"] == 0
    listed = client.get("/api/snapshots").json()
    assert [s["id"] for s in listed] == [r["snapshot"]["id"]]
    d = client.get(f"/api/snapshots/{listed[0]['id']}").json()
    assert d["summary"]["total"] == 3 and len(d["tickets"]) == 3 and d["tickets"][0]["category_name"]
    # the live DB keeps working and ids restart
    assert client.post("/api/classify", json={"text": "hi"}).json()["id"] == 1


def test_snapshot_id_is_validated(client):
    assert client.get("/api/snapshots/nope").status_code == 404
    assert client.get("/api/snapshots/..%2F..%2Fetc").status_code == 404

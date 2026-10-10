"""Frontend contract (frontend/docs/BACKEND_INTEGRATION.md): train_progress stage/progress,
round_complete.previous_model_version, and startup loading the promoted adapter."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.classifiers import FakeClassifier
from backend.db import DB
from backend.events import train_payload
from backend.fakes import FakeTeacher

EV = {"category_acc": 0.9, "category_macro_f1": 0.9, "priority_acc": 0.8}


def test_train_payload_stages_and_monotonic_progress():
    seq = [
        {"type": "round_start", "round": 4, "examples": 1200},
        {"type": "train_progress", "round": 4, "kind": "train", "step": 10, "total_steps": 100, "loss": 1.5},
        {"type": "train_progress", "round": 4, "kind": "train", "step": 100, "total_steps": 100, "loss": 0.2},
        {"type": "eval_progress", "round": 4, "done": 50, "total": 200},
        {"type": "eval_progress", "round": 4, "done": 200, "total": 200},
        {"type": "promoting", "round": 4},
    ]
    out = [train_payload(e, "job1") for e in seq]
    assert [o["stage"] for o in out] == ["collect", "train", "train", "evaluate", "evaluate", "promote"]
    prog = [o["progress"] for o in out]
    assert prog == sorted(prog) and all(0 <= p <= 1 for p in prog)
    assert all(o["job_id"] == "job1" and o["round"] == 4 for o in out)
    assert out[1]["loss"] == 1.5 and out[1]["step"] == 10 and out[1]["total_steps"] == 100


def test_val_loss_is_not_plotted_as_train_loss():
    o = train_payload({"type": "train_progress", "round": 1, "kind": "val", "step": 5, "total_steps": 10,
                       "loss": 0.3}, "j")
    assert "loss" not in o and "validation" in o["message"]


def test_failed_round_carries_error():
    o = train_payload({"type": "round_failed", "stage": "error", "error": "boom"}, "j")
    assert o["error"] == "boom" and o["stage"] == "train"


def test_startup_loads_latest_promoted_adapter(tmp_path, monkeypatch):
    import training.db_backend as dbb
    monkeypatch.setattr(dbb, "ADAPTERS", tmp_path / "adapters")
    (tmp_path / "adapters" / "round_2").mkdir(parents=True)
    db = DB(str(tmp_path / "t.sqlite"))
    for n, promoted in [(1, True), (2, True), (3, False)]:  # round_3 rejected -> must be ignored
        db.insert_round(round=n, model_version=f"round_{n}", examples=1, loss=[], wall_time_s=1,
                        hardware="t", cost_usd=0, promoted=promoted, reason="", eval=EV)
    clf = FakeClassifier()
    with TestClient(create_app(db, clf, FakeTeacher())) as c:
        assert c.get("/api/health").json()["model_version"] == "round_2"
        holder = c.app.state.ctx.holder
        assert holder._clf.adapters == [str(tmp_path / "adapters" / "round_2")]
    with TestClient(create_app(db, FakeClassifier(), FakeTeacher(), load_promoted=False)) as c:
        assert c.get("/api/health").json()["model_version"] == "base"


def test_startup_without_adapter_dir_falls_back_to_base(tmp_path, monkeypatch):
    import training.db_backend as dbb
    monkeypatch.setattr(dbb, "ADAPTERS", tmp_path / "nothing")
    db = DB(str(tmp_path / "t.sqlite"))
    db.insert_round(round=1, model_version="round_1", examples=1, loss=[], wall_time_s=1, hardware="t",
                    cost_usd=0, promoted=True, reason="", eval=EV)
    with TestClient(create_app(db, FakeClassifier(), FakeTeacher())) as c:
        assert c.get("/api/health").json()["model_version"] == "base"

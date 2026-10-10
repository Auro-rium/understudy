"""Cloud-only cost counterfactual falls back to the measured labeling-run average."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import metrics, router
from backend.db import DB


def test_falls_back_to_labeling_average_then_prefers_ledger(tmp_path, monkeypatch):
    lab = tmp_path / "labeled.jsonl"
    lab.write_text("\n".join(json.dumps({"label_cost_usd": c}) for c in (0.0001, 0.0003)) + "\nnot json\n")
    monkeypatch.setenv("LABELED_PATH", str(lab))
    monkeypatch.delenv("TEACHER_COST_ESTIMATE_PER_CALL", raising=False)
    db = DB(str(tmp_path / "t.sqlite"))
    avg, src = router.avg_teacher_cost(db)
    assert src == "labeling_run_average" and abs(avg - 0.0002) < 1e-12

    for i in range(5):  # five local tickets, no teacher calls yet
        db.execute("INSERT INTO tickets(text,category,priority,source,confidence,latency_ms,cost_usd,model_version,created_at)"
                   " VALUES('t','A','P1','local',0.9,1,0,'round_3','2026-01-01T00:00:0%d')" % i)
    ts = metrics.timeseries(db, "tickets", 5)
    assert abs(ts[-1]["cost_cloud_only_cumulative"] - 5 * 0.0002) < 1e-12 and ts[-1]["cost_cumulative"] == 0
    assert abs(metrics.summary(db, "round_3", "online")["cost_avoided_usd"] - 5 * 0.0002) < 1e-12

    db.add_ledger(1, "teacher", 10, 5, 0.001)   # a real teacher call now defines the average
    assert router.avg_teacher_cost(db) == (0.001, "ledger_average")


def test_env_estimate_beats_labeling_average(tmp_path, monkeypatch):
    lab = tmp_path / "labeled.jsonl"
    lab.write_text(json.dumps({"label_cost_usd": 0.5}) + "\n")
    monkeypatch.setenv("LABELED_PATH", str(lab))
    monkeypatch.setenv("TEACHER_COST_ESTIMATE_PER_CALL", "0.002")
    assert router.avg_teacher_cost(DB(str(tmp_path / "t.sqlite"))) == (0.002, "configured_estimate")

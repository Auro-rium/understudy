import json
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.classifiers import (ClassifierError, FakeClassifier, make_classifier,
                                 softmax_over_letters)
from backend.db import DB, DEFAULT_THRESHOLD
from backend.fakes import FakeTeacher
from backend.holder import ModelHolder
from backend.router import ModeState, Router, avg_teacher_cost
from backend import metrics


@pytest.fixture
def db(tmp_path):
    d = DB(str(tmp_path / "t.sqlite"))
    yield d
    d.close()


def mk_router(db, teacher=None, fixed=None, **kw):
    holder = ModelHolder(FakeClassifier(fixed=fixed, **kw), "base")
    return Router(db, holder, teacher), holder


def test_tables_created(db):
    names = {r["name"] for r in db.query("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"tickets", "predictions", "training_examples", "rounds", "evals", "cost_ledger",
            "review_queue"} <= names


def test_local_when_confident(db, monkeypatch):
    r, _ = mk_router(db, FakeTeacher(), fixed={"hi": ("C", "P2", 0.95)})
    res = r.classify("hi")
    assert res["source"] == "local" and res["category"] == "C" and res["cost_usd"] == 0
    assert db.get_training_examples() == []


def test_teacher_path_costs_and_training_example(db, monkeypatch):
    monkeypatch.setenv("TEACHER_PRICE_IN_PER_M", "3")
    monkeypatch.setenv("TEACHER_PRICE_OUT_PER_M", "15")
    t = FakeTeacher(tokens_in=1000, tokens_out=100)
    r, _ = mk_router(db, t, fixed={"my app crashed": ("H", "P4", 0.3)})
    res = r.classify("my app crashed")
    assert res["source"] == "teacher" and res["category"] == "E"  # teacher answer wins
    expected = 1000 * 3 / 1e6 + 100 * 15 / 1e6
    assert res["cost_usd"] == pytest.approx(expected)
    ex = db.get_training_examples()
    assert len(ex) == 1 and ex[0]["tokens_in"] == 1000 and ex[0]["tokens_out"] == 100
    assert ex[0]["category"] == "E"
    led = db.query("SELECT * FROM cost_ledger")
    assert led[0]["cost_usd"] == pytest.approx(expected)


def test_offline_goes_to_review(db):
    t = FakeTeacher()
    r, _ = mk_router(db, t, fixed={"x": ("A", "P1", 0.1)})
    r.mode.set_forced(True)
    res = r.classify("x")
    assert res["source"] == "review" and t.calls == 0
    assert len(metrics.review_queue(db)) == 1 and metrics.review_queue(db)[0]["id"] == res["id"]


def test_teacher_unavailable_flips_mode_and_probe_restores(db):
    t = FakeTeacher(available=False)
    r, _ = mk_router(db, t, fixed={"x": ("A", "P1", 0.1)})
    assert r.classify("x")["source"] == "review"
    assert r.mode.mode == "offline" and r.mode.detected
    t.available = True
    assert r.probe_teacher() and r.mode.mode == "online"


def test_connect_error_detected(db):
    class Boom:
        def complete(self, *a, **k):
            raise httpx.ConnectError("nope")
    r, _ = mk_router(db, Boom(), fixed={"x": ("A", "P1", 0.1)})
    assert r.classify("x")["source"] == "review" and r.mode.mode == "offline"


def test_forced_plus_detected_mode(db):
    m = ModeState()
    m.set_forced(True); m.set_detected(True)
    m.set_forced(False)
    assert m.mode == "offline"
    m.set_detected(False)
    assert m.mode == "online"


def test_cost_avoided_uses_ledger_average_not_invented(db, monkeypatch):
    monkeypatch.delenv("TEACHER_COST_ESTIMATE_PER_CALL", raising=False)
    monkeypatch.setenv("TEACHER_PRICE_IN_PER_M", "10")
    monkeypatch.setenv("TEACHER_PRICE_OUT_PER_M", "0")
    r, _ = mk_router(db, FakeTeacher(tokens_in=100000, tokens_out=0),
                     fixed={"lo": ("A", "P1", 0.1), "hi": ("A", "P1", 0.99)})
    assert avg_teacher_cost(db) == (0.0, "configured_estimate")
    r.classify("lo")
    r.classify("hi"); r.classify("hi")
    avg, src = avg_teacher_cost(db)
    assert src == "ledger_average" and avg == pytest.approx(1.0)
    s = metrics.summary(db, "base", "online")
    assert s["total"] == 3 and s["local_share"] == pytest.approx(2 / 3)
    assert s["cost_usd_total"] == pytest.approx(1.0)
    assert s["cost_avoided_usd"] == pytest.approx(2.0)


def test_estimate_when_no_ledger(db, monkeypatch):
    monkeypatch.setenv("TEACHER_COST_ESTIMATE_PER_CALL", "0.002")
    r, _ = mk_router(db, FakeTeacher(), fixed={"hi": ("A", "P1", 0.99)})
    r.classify("hi")
    assert avg_teacher_cost(db) == (0.002, "configured_estimate")
    assert metrics.summary(db, "base", "online")["cost_avoided_usd"] == pytest.approx(0.002)


def test_timeseries_cumulative_and_counterfactual(db, monkeypatch):
    monkeypatch.setenv("TEACHER_PRICE_IN_PER_M", "10")
    monkeypatch.setenv("TEACHER_PRICE_OUT_PER_M", "0")
    fixed = {f"t{i}": ("A", "P1", 0.1 if i % 2 else 0.99) for i in range(6)}
    r, _ = mk_router(db, FakeTeacher(tokens_in=100000, tokens_out=0), fixed=fixed)
    for i in range(6):
        r.classify(f"t{i}")
    ts = metrics.timeseries(db, "tickets", 3)
    assert len(ts) == 2
    assert ts[0]["local_share"] == pytest.approx(2 / 3)
    assert ts[1]["local_share"] == pytest.approx(1 / 3)
    assert ts[1]["cost_cumulative"] == pytest.approx(3.0)
    assert ts[1]["cost_cloud_only_cumulative"] == pytest.approx(6 * 1.0)
    assert ts[0]["cost_cumulative"] <= ts[1]["cost_cumulative"]
    assert len(metrics.timeseries(db, "minute")) >= 1


def test_calibrate(db):
    r, h = mk_router(db)
    assert r.threshold() == DEFAULT_THRESHOLD
    rows = [(0.95, True), (0.9, True), (0.85, True), (0.7, False), (0.6, True), (0.5, False)]
    out = r.calibrate(rows, target=0.95)
    assert out["threshold"] == 0.85 and out["coverage"] == pytest.approx(3 / 6)
    assert r.threshold() == 0.85
    out2 = r.calibrate([(0.9, False), (0.8, False)], target=0.95)
    assert out2["coverage"] == 0 and out2["threshold"] > 1
    # threshold is per version
    h.swap("round_1", classifier=FakeClassifier())
    assert r.threshold() == DEFAULT_THRESHOLD


def test_swap_version_changes_tickets_and_boosts(db):
    r, h = mk_router(db, FakeTeacher())
    assert r.classify("some text")["model_version"] == "base"
    h.swap("round_1", adapter_path="/tmp/adapters/r1")
    assert r.classify("some text")["model_version"] == "round_1"


def test_rwlock_inflight_finish_before_swap_and_new_wait():
    clf = FakeClassifier(delay_s=0.3)
    h = ModelHolder(clf, "base")
    results, order = [], []

    def reader(tag):
        out, v = h.classify("hello")
        results.append((tag, v, time.monotonic()))

    t1 = threading.Thread(target=reader, args=("inflight",))
    t1.start(); time.sleep(0.05)  # reader 1 is inside classify
    swapper = threading.Thread(target=lambda: (h.swap("round_1", classifier=FakeClassifier()),
                                               order.append(time.monotonic())))
    swapper.start(); time.sleep(0.05)
    t2 = threading.Thread(target=reader, args=("new",))  # arrives while swap pending
    t2.start()
    for t in (t1, t2, swapper):
        t.join(5)
    d = {tag: v for tag, v, _ in results}
    assert d["inflight"] == "base"   # finished on the old model
    assert d["new"] == "round_1"     # waited for the swap
    assert h.version == "round_1"


def test_db_threadsafe(db):
    def w(n):
        for i in range(50):
            db.insert_ticket(text=f"{n}-{i}", category="A", priority="P1", source="local",
                             confidence=0.9, latency_ms=1, cost_usd=0, model_version="base")
    ts = [threading.Thread(target=w, args=(n,)) for n in range(8)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert db.one("SELECT COUNT(*) n FROM tickets")["n"] == 400


def test_rounds_roundtrip(db):
    assert db.next_round_number() == 1
    db.insert_round(round=1, model_version="round_1", examples=10, loss=[{"step": 1, "loss": 2.0}],
                    wall_time_s=3.5, hardware="m-series", cost_usd=0.0, promoted=True, reason="ok",
                    eval={"category_acc": 0.9, "category_macro_f1": 0.8, "priority_acc": 0.7})
    r = db.list_rounds()[0]
    assert r["promoted"] is True and r["loss"][0]["step"] == 1 and db.next_round_number() == 2


def test_softmax_and_factory(monkeypatch):
    p = softmax_over_letters({"A": 0.0, "B": 0.0, "zzz": 5})
    assert p == {"A": 0.5, "B": 0.5}
    monkeypatch.setenv("CLASSIFIER", "fake")
    assert isinstance(make_classifier(), FakeClassifier)
    with pytest.raises(ValueError):
        make_classifier("nope")


def test_eval_compare_empty_and_merge(tmp_path):
    e = metrics.eval_compare(str(tmp_path))
    assert e["models"] == [] and e["router"] == {} and e["provisional"] is True
    (tmp_path / "a.json").write_text(json.dumps({"provisional": False, "models": [{"name": "m1"}],
                                                 "router": {"coverage": 0.5}, "per_category_f1": {"m1": {"A": 1}},
                                                 "confusion": {"m1": [[1]]}}))
    e = metrics.eval_compare(str(tmp_path))
    assert e["models"][0]["name"] == "m1" and e["router"]["coverage"] == 0.5 and e["confusion"]["m1"] == [[1]]

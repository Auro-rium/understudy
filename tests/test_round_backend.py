"""Round pipeline against the real backend.db / ModelHolder / Router with fake classifiers."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
pytest.importorskip("pydantic")
pytest.importorskip("httpx")

from eval.classifiers import FakeClassifier  # noqa: E402
from training import round as RD  # noqa: E402
from backend.round_backend import RoundBackend  # noqa: E402
from tests.test_training_round import FakeTrainer, L, env  # noqa: E402,F401


def _ctx(n_examples=6):
    from backend.classifiers import FakeClassifier as BFake
    from backend.db import DB
    from backend.holder import ModelHolder
    from backend.router import Router

    class Ctx:
        pass

    c = Ctx()
    c.db = DB(":memory:")
    c.holder = ModelHolder(BFake(), "base")
    c.router = Router(c.db, c.holder, None)
    for i in range(n_examples):
        c.db.insert_training_example(ticket_id=None, text=f"t{i}", category=L[i], priority="P2",
                                     source="teacher", tokens_in=10, tokens_out=2)
    return c


def _be(ctx, gold, **kw):
    return RoundBackend(ctx, classifier_factory=lambda ad: FakeClassifier(
        skill=0.0 if ad is None else 1.0, gold=gold), **kw)


def test_full_round(env):
    d, res, gold = env
    ctx = _ctx()
    be = _be(ctx, gold)
    row = RD.run_round(be, trainer=FakeTrainer(), data_dir=d, results_dir=res, seed_from_train_pool=True)
    assert row["promoted"] and row["examples"] == 36
    rounds = ctx.db.list_rounds()
    assert len(rounds) == 1 and rounds[0]["promoted"] and rounds[0]["eval"]["category_macro_f1"] == 1.0
    assert rounds[0]["loss"][0] == {"step": 10, "loss": 0.3}
    assert ctx.holder.version == "round_1"
    assert ctx.db.one("SELECT COUNT(*) n FROM training_examples WHERE source='seed_train_pool'")["n"] == 30
    assert ctx.db.one("SELECT COUNT(*) n FROM training_examples WHERE used_in_round=1")["n"] == 36
    assert ctx.db.one("SELECT COUNT(*) n FROM evals")["n"] >= 2
    assert ctx.db.one("SELECT 1 x FROM thresholds WHERE model_version='round_1'")
    assert be.next_round_number() == 2 and be.promoted_eval()["round"] == 1


def test_gate_uses_promoted_round(env):
    d, res, gold = env
    ctx = _ctx(4)
    RD.run_round(_be(ctx, gold), trainer=FakeTrainer(), data_dir=d, results_dir=res)
    row = RD.run_round(_be(ctx, gold), trainer=FakeTrainer(), data_dir=d, results_dir=res)
    assert row["round"] == 2 and row["promoted"] is False        # tie with perfect round 1
    assert ctx.holder.version == "round_1"
    assert [r["promoted"] for r in ctx.db.list_rounds()] == [True, False]


def test_serving_paused_during_training_and_resumed(env):
    d, res, gold = env
    ctx = _ctx(4)
    seen = []

    class Probe(FakeTrainer):
        def train(self, round, data_dir, on_progress=None):
            seen.append(ctx.holder._paused)
            return super().train(round, data_dir, on_progress)

    RD.run_round(_be(ctx, gold), trainer=Probe(), data_dir=d, results_dir=res)
    assert seen == [True] and ctx.holder._paused is False
    assert ctx.holder.classify("t0")[1] == "round_1"  # serving again, on the promoted version


def test_async_job_events(env):
    d, res, gold = env
    events = []
    job = RD.run_round_async(_be(_ctx(4), gold), on_event=events.append, trainer=FakeTrainer(),
                             data_dir=d, results_dir=res)
    job.join(10)
    assert job.row["promoted"] and job.error is None
    assert any(e["type"] == "train_progress" for e in events) and events[-1]["type"] == "round_complete"


def test_shared_prompt_is_serving_prompt():
    from backend.classifiers import CLASSIFIER_SYSTEM
    from training.prompt import build_messages
    assert build_messages("x")[0]["content"] == CLASSIFIER_SYSTEM


def test_router_eval_real_router(monkeypatch):
    from backend.classifiers import FakeClassifier as BFake
    from backend.fakes import FakeTeacher
    from eval import run as R
    tickets = [{"id": i, "text": f"worker not paid late payment {i}", "category": "A", "priority": "P2"}
               for i in range(20)]
    monkeypatch.delenv("TEACHER_PRICE_IN_PER_M", raising=False)
    monkeypatch.delenv("TEACHER_PRICE_OUT_PER_M", raising=False)
    route, known = R.build_router_route_fn(BFake(), FakeTeacher(), threshold=0.75)
    assert known is False
    res = R.evaluate_router(route, tickets, costs_known=known)
    assert 0 < res["local_share"] < 1 and res["teacher_share"] > 0
    assert res["cost_per_1k"] is None and res["cloud_only_cost_per_1k"] is None  # no invented costs
    monkeypatch.setenv("TEACHER_PRICE_IN_PER_M", "3")
    monkeypatch.setenv("TEACHER_PRICE_OUT_PER_M", "15")
    route, known = R.build_router_route_fn(BFake(), FakeTeacher(), threshold=0.75)
    res = R.evaluate_router(route, tickets, costs_known=known)
    assert res["cost_per_1k"] > 0 and res["cost_avoided_per_1k"] > 0
    assert res["cost_per_1k"] < res["cloud_only_cost_per_1k"]

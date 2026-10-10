"""RoundBackend implementation over backend.db.DB + ModelHolder + Router (see training/round.py).

Memory rule (16 GB Mac, one model in RAM): pause_serving() swaps the holder to a placeholder and
drops the in-process mlx model; the eval classifier then loads the (adapter) model alone; and
resume_serving() reloads whichever version is promoted. Hooks are injectable for tests.
NOTE: a ServerClassifier (:8080 mlx_lm.server) holds ~5 GB outside this process; stop it by hand
before a real local round (pause hook cannot free it).
"""
from __future__ import annotations

import gc
import os
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
ADAPTERS = ROOT / "adapters"


def latest_promoted_adapter(db) -> Optional[tuple]:
    """-> (model_version, adapter_dir) of the newest promoted round whose adapter exists, else None.
    Backend startup should load this so a restart keeps the promoted model."""
    for r in reversed(db.list_rounds()):
        if r["promoted"]:
            p = ADAPTERS / r["model_version"]
            if p.exists():
                return r["model_version"], str(p)
    return None


class _Paused:
    """Placeholder classifier while the real model is unloaded for training."""
    name = "paused"

    def classify(self, text):
        from backend.classifiers import ClassifierError
        raise ClassifierError("serving paused: training round in progress")

    def with_adapter(self, adapter_path):
        raise RuntimeError("cannot apply adapter while paused")


class DbRoundBackend:
    eval_kind = "mlx"

    def __init__(self, ctx, classifier_factory: Optional[Callable] = None,
                 pause_hook: Optional[Callable] = None, resume_hook: Optional[Callable] = None,
                 val_target: float = 0.95):
        """ctx: AppContext-like with .db .holder .router (.events optional).
        classifier_factory(adapter_path|None) -> eval classifier with predict()/close()
        (default: in-process MLX via eval.classifiers)."""
        self.ctx, self.db, self.holder, self.router = ctx, ctx.db, ctx.holder, ctx.router
        self._factory = classifier_factory
        self._pause_hook, self._resume_hook = pause_hook, resume_hook
        self.val_target = val_target
        self._paused_state = None
        self._pending: Optional[tuple] = None   # (version, adapter) promoted while paused
        self._eval_results: dict = {}
        if classifier_factory is not None:
            self.eval_kind = "custom"

    # ---- data
    def load_training_examples(self):
        return self.db.get_training_examples()

    def add_training_examples(self, rows, source):
        for r in rows:
            self.db.insert_training_example(ticket_id=None, text=r["text"], category=r["category"],
                                            priority=r["priority"], source=source,
                                            tokens_in=0, tokens_out=0)
        return len(rows)

    def next_round_number(self):
        return self.db.next_round_number()

    def promoted_eval(self):
        for r in reversed(self.db.list_rounds()):
            if r["promoted"]:
                return {"round": r["round"], **r["eval"]}
        return None

    # ---- models
    def make_classifier(self, adapter_path):
        if self._factory:
            return self._factory(adapter_path)
        from eval.classifiers import make_classifier
        return make_classifier("mlx", adapter_path)

    def pause_serving(self):
        if self._pause_hook:
            return self._pause_hook()
        h = self.holder
        old = h._clf
        if getattr(old, "name", "") == "mlx":
            self._paused_state = (old.model_path, old.adapter_path, h.version)
            h.swap(h.version, classifier=_Paused())
            del old
            gc.collect()
            try:
                import mlx.core as mx
                mx.clear_cache()
            except Exception:
                pass
        # other classifiers (fake / server) hold no in-process model: nothing to free

    def resume_serving(self):
        if self._resume_hook:
            return self._resume_hook()
        st, self._paused_state = self._paused_state, None
        pending, self._pending = self._pending, None
        if st is None:
            return
        from backend.classifiers import MlxInProcessClassifier
        path, adapter, version = st
        if pending:
            version, adapter = pending
        self.holder.swap(version, classifier=MlxInProcessClassifier(path, adapter))

    def promote(self, round_no, adapter_path, version, ev):
        if self._paused_state is not None:      # model unloaded: resume_serving loads the new one
            self._pending = (version, adapter_path)
        else:
            self.holder.swap(version, adapter_path=adapter_path)

    def recalibrate(self, val_tickets):
        """Threshold for the now-serving version from (confidence, correct) over the val set."""
        rows = []
        for t in val_tickets:
            out, _ = self.holder.classify(t["text"])
            rows.append((out.confidence, out.letter == t["category"]))
        if rows:
            self.router.calibrate(rows, target=self.val_target, version=self.holder.version)

    # ---- persistence
    def record_eval(self, version, result):
        self._eval_results[version] = result
        self.db.insert_eval(version, result)

    def save_round(self, row):
        self.db.insert_round(round=row["round"], model_version=row["model_version"],
                             examples=row["examples"], loss=row["loss"], wall_time_s=row["wall_time_s"],
                             hardware=row["hardware"], cost_usd=row["cost_usd"], promoted=row["promoted"],
                             reason=row["reason"], eval=row["eval"])
        self.db.mark_examples_used(row["round"])


def get_round_backend():
    """Standalone CLI context (python -m training.round): own DB/holder/router, no web app.
    Uses DB_PATH (default understudy.sqlite). A running app will not hot-swap from a CLI round;
    restart it (it should load latest_promoted_adapter) or trigger rounds via POST /api/train/round."""
    from backend.app import default_teacher
    from backend.classifiers import make_classifier
    from backend.db import DB
    from backend.holder import ModelHolder
    from backend.router import Router

    class Ctx:
        pass

    ctx = Ctx()
    ctx.db = DB()
    clf = make_classifier(os.environ.get("CLASSIFIER", "mlx"))
    cur = latest_promoted_adapter(ctx.db)
    if cur and hasattr(clf, "with_adapter"):
        try:
            clf = clf.with_adapter(cur[1])
        except Exception:
            cur = None
    ctx.holder = ModelHolder(clf, cur[0] if cur else "base")
    ctx.router = Router(ctx.db, ctx.holder, default_teacher())
    return DbRoundBackend(ctx)

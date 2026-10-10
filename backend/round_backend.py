"""Adapter between training.round.run_round (RoundBackend duck type) and the backend (DB + ModelHolder)."""
import os
import time
from typing import Optional

from backend.classifiers import BaseClassifier, FakeClassifier, MlxInProcessClassifier
from backend.schemas import PRIORITIES

_CURRENT = None  # AppContext of the running app (set by create_app)


def set_current_ctx(ctx):
    global _CURRENT
    _CURRENT = ctx


class _EvalClassifier:
    """predict(text) -> {category, priority, confidence, latency_ms}; close()."""

    def __init__(self, clf: BaseClassifier):
        self.clf = clf

    def predict(self, text: str) -> dict:
        t0 = time.perf_counter()
        o = self.clf.classify(text)
        return {"category": o.letter, "priority": o.priority, "confidence": o.confidence,
                "latency_ms": (time.perf_counter() - t0) * 1000}

    def close(self):
        if hasattr(self.clf, "unload"):
            self.clf.unload()


class AppRoundBackend:
    def __init__(self, ctx):
        self.ctx = ctx
        self.db = ctx.db
        self.holder = ctx.holder

    # --- data
    def load_training_examples(self) -> list[dict]:
        return [{"text": r["text"], "category": r["category"], "priority": r["priority"],
                 "source": r["source"]} for r in self.db.get_training_examples()]

    def add_training_examples(self, rows, source) -> int:
        for r in rows:
            self.db.insert_training_example(ticket_id=None, text=r["text"], category=r["category"],
                                            priority=r["priority"], source=source, tokens_in=0, tokens_out=0)
        return len(rows)

    def next_round_number(self) -> int:
        return self.db.next_round_number()

    def promoted_eval(self) -> Optional[dict]:
        done = [r for r in self.db.list_rounds() if r["promoted"]]
        if not done:
            return None
        last = done[-1]
        return {"round": last["round"], **last["eval"]}

    # --- models
    def make_classifier(self, adapter_path: Optional[str]) -> _EvalClassifier:
        """Separate in-process eval model (does not touch the serving holder)."""
        if os.environ.get("CLASSIFIER", "fake").lower() == "fake":
            base = FakeClassifier()
            return _EvalClassifier(base.with_adapter(adapter_path) if adapter_path else base)
        return _EvalClassifier(MlxInProcessClassifier(adapter_path=adapter_path))

    def promote(self, round_no, adapter_path, version, eval) -> None:
        self.holder.swap(version, adapter_path=adapter_path)  # safe while paused

    def recalibrate(self, val_tickets) -> dict:
        rows = []
        for t in val_tickets:
            o, _ = self.holder.classify(t["text"])
            rows.append((o.confidence, o.letter == t["category"]))
        if not rows:
            return {}
        return self.ctx.router.calibrate(rows)

    def save_round(self, row: dict) -> None:
        self.db.insert_round(round=row["round"], model_version=row["model_version"],
                             examples=row["examples"], loss=row["loss"], wall_time_s=row["wall_time_s"],
                             hardware=row["hardware"], cost_usd=row["cost_usd"], promoted=row["promoted"],
                             reason=row["reason"], eval=row["eval"])
        self.db.insert_eval(row["model_version"], {k: v for k, v in row.items() if k != "loss"})
        self.db.mark_examples_used(row["round"])

    def pause_serving(self):
        self.holder.pause()

    def resume_serving(self):
        self.holder.resume()


def get_round_backend() -> AppRoundBackend:
    """Used by `python -m training.round` and the API. Standalone (CLI) builds its own context."""
    if _CURRENT is not None:
        return AppRoundBackend(_CURRENT)
    from backend.app import AppContext, default_teacher
    from backend.classifiers import make_classifier
    from backend.db import DB
    from backend.events import Broadcaster
    from backend.holder import ModelHolder
    return AppRoundBackend(AppContext(DB(), ModelHolder(make_classifier(), "base"), default_teacher(),
                                      Broadcaster()))

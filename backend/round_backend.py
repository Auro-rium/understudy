"""The RoundBackend that training.round.run_round drives (duck type documented there): DB + ModelHolder + Router.

Memory rule (16 GB Mac, one model in RAM): pause_serving() blocks classify calls and unloads the serving
model; the eval classifier then loads the candidate adapter alone; promote() swaps the holder while
paused; resume_serving() reloads whatever is now serving. Keep this module free of top-level `training`
imports (the API tests stub that package).
"""
import os
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
ADAPTERS = ROOT / "adapters"


def latest_promoted_adapter(db) -> Optional[tuple]:
    """-> (model_version, adapter_dir) of the newest promoted round whose adapter exists, else None."""
    for r in reversed(db.list_rounds()):
        if r["promoted"]:
            p = ADAPTERS / r["model_version"]
            if p.exists():
                return r["model_version"], str(p)
    return None


def load_promoted(classifier, db) -> tuple:
    """-> (classifier, version): the newest promoted adapter applied, else (classifier, 'base').
    Used at app startup and by the CLI so a restart keeps the promoted model."""
    cur = latest_promoted_adapter(db)
    if cur:
        try:
            return classifier.with_adapter(cur[1]), cur[0]
        except Exception as e:  # noqa: BLE001
            print(f"[backend] could not load promoted adapter {cur[0]}: {e!r}; serving base")
    return classifier, "base"


class RoundBackend:
    def __init__(self, ctx, classifier_factory: Optional[Callable] = None, val_target: float = 0.95):
        """ctx: AppContext-like (.db .holder .router). classifier_factory(adapter_path|None) -> eval
        classifier with predict()/close(); default is a fresh in-process model of the serving kind."""
        self.ctx, self.db, self.holder, self.router = ctx, ctx.db, ctx.holder, ctx.router
        self._factory = classifier_factory
        self.val_target = val_target
        # eval_kind keys the cached base result in eval/results (must match its `classifier` field)
        self.eval_kind = ("custom" if classifier_factory else
                          "fake" if os.environ.get("CLASSIFIER", "fake").lower() == "fake" else "mlx")

    # ---- data
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
        for r in reversed(self.db.list_rounds()):
            if r["promoted"]:
                return {"round": r["round"], **r["eval"]}
        return None

    # ---- models
    def make_classifier(self, adapter_path: Optional[str]):
        """Separate eval model (never the serving holder)."""
        if self._factory:
            return self._factory(adapter_path)
        from backend.classifiers import FakeClassifier, MlxInProcessClassifier
        from eval.classifiers import BackendAdapter
        if self.eval_kind == "fake":
            base = FakeClassifier()
            return BackendAdapter(base.with_adapter(adapter_path) if adapter_path else base)
        return BackendAdapter(MlxInProcessClassifier(adapter_path=adapter_path))

    def pause_serving(self):
        self.holder.pause()

    def resume_serving(self):
        self.holder.resume()

    def promote(self, round_no, adapter_path, version, ev) -> None:
        self.holder.swap(version, adapter_path=adapter_path)  # the pausing thread may swap

    def recalibrate(self, val_tickets) -> dict:
        """Confidence threshold for the now-serving version from the val set."""
        rows = []
        for t in val_tickets:
            out, _ = self.holder.classify(t["text"])
            rows.append((out.confidence, out.letter == t["category"]))
        return self.router.calibrate(rows, target=self.val_target, version=self.holder.version) if rows else {}

    # ---- persistence
    def record_eval(self, version, result) -> None:
        self.db.insert_eval(version, result)

    def save_round(self, row: dict) -> None:
        self.db.insert_round(round=row["round"], model_version=row["model_version"],
                             examples=row["examples"], loss=row["loss"], wall_time_s=row["wall_time_s"],
                             hardware=row["hardware"], cost_usd=row["cost_usd"], promoted=row["promoted"],
                             reason=row["reason"], eval=row["eval"])
        self.db.mark_examples_used(row["round"])


def get_round_backend() -> RoundBackend:
    """Standalone context for `python -m training.round` (no web app). A running app does not pick up a
    CLI round until restarted; prefer POST /api/train/round."""
    from backend.app import AppContext, default_teacher
    from backend.classifiers import make_classifier
    from backend.db import DB
    from backend.events import Broadcaster
    from backend.holder import ModelHolder
    db = DB()
    clf, version = load_promoted(make_classifier(os.environ.get("CLASSIFIER", "mlx")), db)
    return RoundBackend(AppContext(db, ModelHolder(clf, version), default_teacher(), Broadcaster()))

"""One self-improvement round: train -> eval -> promotion gate -> hot-swap.

CLI:  python -m training.round --backend mlx_local [--seed-from-train-pool] [--iters N]

`backend` is any object implementing RoundBackend (duck-typed; see below). The real one wraps
backend.db + the model holder; tests pass a fake. Required methods:

  load_training_examples() -> [{text, category 'A'-'H', priority 'P1'-'P4', source}]
  add_training_examples(rows, source) -> int      # used for seeding (source='seed_train_pool')
  next_round_number() -> int
  promoted_eval() -> {"round": n|0, "category_macro_f1": f, ...} | None   # None => evaluate base
  make_classifier(adapter_path|None) -> clf with predict(text)/close()    # in-process eval model
  promote(round_no, adapter_path, version, eval)   # hot-swap pointer (resume_serving loads it)
  recalibrate(val_tickets)                          # recompute confidence threshold on val set
  save_round(row)                                   # insert into `rounds`
  pause_serving() / resume_serving()                # free/reload the in-process model + pause stream
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eval.run import (RESULTS, DATA, evaluate_classifier, load_jsonl, load_test,  # noqa: E402
                      read_result, write_result)
from training.base import NotEnabled, Trainer  # noqa: E402

_round_lock = threading.Lock()


def get_trainer(name: str, **kw) -> Trainer:
    if name == "mlx_local":
        from training.mlx_local import MlxLocalTrainer
        return MlxLocalTrainer(**kw)
    if name == "aws":
        from training.aws import AwsTrainer
        return AwsTrainer()
    if name == "modal":
        from training.modal import ModalTrainer
        return ModalTrainer()
    raise ValueError(f"unknown training backend {name!r}")


def decide_promotion(new_f1: float, baseline_f1: Optional[float], min_delta: float = 0.0):
    """Promote only if category macro-F1 strictly improves (by > min_delta) over the promoted model."""
    if baseline_f1 is None:
        return True, f"no promoted baseline; macro-F1 {new_f1:.3f}"
    if new_f1 > baseline_f1 + min_delta:
        return True, f"macro-F1 improved {baseline_f1:.3f} -> {new_f1:.3f}"
    return False, (f"macro-F1 {new_f1:.3f} did not improve over promoted {baseline_f1:.3f}"
                   + (f" (+{min_delta} required)" if min_delta else ""))


def _baseline(backend, test, provisional, results_dir):
    pe = backend.promoted_eval()
    if pe and pe.get("category_macro_f1") is not None:
        return pe["category_macro_f1"]
    kind = getattr(backend, "eval_kind", "real")
    cached = read_result("base", results_dir)
    if cached and cached.get("n") == len(test) and cached.get("classifier") == kind:
        return cached["category_macro_f1"]
    clf = backend.make_classifier(None)
    try:
        res = evaluate_classifier(clf, test, "base", provisional, kind=kind)
    finally:
        clf.close()
    write_result(res, results_dir)
    if hasattr(backend, "record_eval"):
        backend.record_eval("base", res)
    return res["category_macro_f1"]


def run_round(backend, trainer: Optional[Trainer] = None, trainer_name: str = "mlx_local",
              seed_from_train_pool: bool = False, on_event: Optional[Callable[[dict], None]] = None,
              iters: Optional[int] = None, data_dir: Path = DATA, results_dir: Path = RESULTS,
              min_delta: float = 0.0) -> dict:
    """Returns the saved `rounds` row (dict)."""
    emit = on_event or (lambda e: None)
    if trainer is None:
        trainer = get_trainer(trainer_name, **({"iters": iters} if iters and trainer_name == "mlx_local" else {}))
    test, provisional = load_test(data_dir)

    if seed_from_train_pool:
        have = {e["text"] for e in backend.load_training_examples()}
        pool = [r for r in load_jsonl(Path(data_dir) / "train.jsonl") if r["text"] not in have]
        if pool:
            backend.add_training_examples(
                [{"text": r["text"], "category": r["category"], "priority": r["priority"]} for r in pool],
                "seed_train_pool")
    examples = backend.load_training_examples()
    if len(examples) < 2:
        raise ValueError(f"need at least 2 training examples, have {len(examples)}")

    rnd = backend.next_round_number()
    version = f"round_{rnd}"
    emit({"type": "round_start", "round": rnd, "examples": len(examples)})

    def progress(ev):
        emit(ev)

    paused = False
    try:
        backend.pause_serving()
        paused = True
        data_path = trainer.prepare(examples)
        tr = trainer.train(rnd, data_path, progress)
        baseline = _baseline(backend, test, provisional, results_dir)
        clf = backend.make_classifier(tr.adapter_path)
        try:
            res = evaluate_classifier(clf, test, version, provisional,
                                      kind=getattr(backend, "eval_kind", "real"),
                                      on_progress=lambda i, n: emit(
                                          {"type": "eval_progress", "round": rnd, "done": i, "total": n}))
        finally:
            clf.close()
        write_result(res, results_dir)
        if hasattr(backend, "record_eval"):
            backend.record_eval(version, res)
        promoted, reason = decide_promotion(res["category_macro_f1"], baseline, min_delta)
        ev = {"category_acc": res["category_acc"], "category_macro_f1": res["category_macro_f1"],
              "priority_acc": res["priority_acc"]}
        if promoted:
            backend.promote(rnd, tr.adapter_path, version, ev)
    finally:
        if paused:
            backend.resume_serving()

    if promoted:
        try:
            val_path = Path(data_dir) / "val.jsonl"
            backend.recalibrate(load_jsonl(val_path) if val_path.is_file() else [])
        except Exception as e:  # promotion stands; threshold keeps its previous value
            reason += f" (recalibration failed: {e})"

    row = {"round": rnd, "model_version": version, "examples": len(examples),
           "loss": [{"step": s, "loss": l} for s, l in tr.loss_curve],
           "wall_time_s": tr.wall_time_s, "hardware": tr.hardware, "cost_usd": tr.cost_usd,
           "promoted": promoted, "reason": reason, "eval": ev,
           "adapter_path": tr.adapter_path, "baseline_macro_f1": baseline,
           "provisional": provisional, "backend": trainer.name}
    backend.save_round(row)
    emit({"type": "round_complete", **row})
    return row


class RoundJob(threading.Thread):
    """Thread running a round. Also awaitable (`await job`) so FastAPI can `await` it without
    blocking the loop; re-raises the round's exception. `.error` / `.row` hold the outcome."""

    def __init__(self, fn):
        super().__init__(name="train-round", daemon=True)
        self._fn, self.row, self.error = fn, None, None

    def run(self):
        try:
            self.row = self._fn()
        except BaseException as e:  # noqa: BLE001
            self.error = e
        finally:
            _round_lock.release()

    def __await__(self):
        import asyncio

        async def _wait():
            while self.is_alive():
                await asyncio.sleep(0.2)
            if self.error:
                raise self.error
            return self.row
        return _wait().__await__()


def run_round_async(backend="mlx_local", ctx=None, job_id=None, progress=None, on_event=None,
                    **kw) -> RoundJob:
    """Start a round in a thread. Only one at a time (RuntimeError if busy).

    Called by backend.app as run_round_async(backend=<'mlx_local'|'aws'|'modal'>, job_id=, ctx=, progress=)
    -> `backend` is a trainer NAME and `ctx` (AppContext) supplies db/holder/router. For tests/other
    callers pass a RoundBackend object as `backend` plus trainer=/trainer_name= kwargs.
    `progress`/`on_event` receive events; app's round_complete is published by the app itself, so
    progress does not get 'round_complete'.
    """
    if isinstance(backend, str):
        from training.db_backend import DbRoundBackend
        kw.setdefault("trainer_name", backend)
        rb = DbRoundBackend(ctx)
    else:
        rb = backend
    cbs = [c for c in (on_event,) if c]

    def emit(e):
        for c in cbs:
            c(e)
        if progress and e.get("type") != "round_complete":
            progress(e)

    if not _round_lock.acquire(blocking=False):
        raise RuntimeError("a training round is already running")

    def work():
        try:
            return run_round(rb, on_event=emit, **kw)
        except Exception as e:
            emit({"type": "round_failed", "stage": "error",
                  "error": f"not enabled: {e}" if isinstance(e, NotEnabled) else str(e)})
            raise

    job = RoundJob(work)
    try:
        job.start()
    except BaseException:
        _round_lock.release()
        raise
    return job


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="mlx_local", choices=["mlx_local", "aws", "modal"])
    ap.add_argument("--seed-from-train-pool", action="store_true")
    ap.add_argument("--iters", type=int)
    ap.add_argument("--min-delta", type=float, default=0.0)
    a = ap.parse_args(argv)
    from training.db_backend import get_round_backend
    row = run_round(get_round_backend(), trainer_name=a.backend,
                    seed_from_train_pool=a.seed_from_train_pool, iters=a.iters, min_delta=a.min_delta,
                    on_event=lambda e: print(json.dumps(e), flush=True))
    print(json.dumps({k: v for k, v in row.items() if k != "loss"}, indent=2))


if __name__ == "__main__":
    main()

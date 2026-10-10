# Backend internals (for training / eval agents)

Run (repo root): `CLASSIFIER=fake TEACHER=fake backend/.venv/bin/uvicorn backend.app:app --port 8000`
Env: CLASSIFIER=mlx|fake, TEACHER=real|fake, DB_PATH, DEMO_PATH (default data/demo.jsonl),
TEACHER_PRICE_IN_PER_M / TEACHER_PRICE_OUT_PER_M (unset = 0), TEACHER_COST_ESTIMATE_PER_CALL
(only used until a real teacher call exists in cost_ledger), EVAL_RESULTS_DIR (default eval/results),
HEALTH_PROBE_S (default 10), LOCAL_MODEL, LABELED_PATH, DEMO_KEY, LOG_LEVEL.

## Training integration (already wired)
`POST /api/train/round {backend}` calls `training.round.run_round_async(RoundBackend(ctx), on_event=cb,
trainer_name=backend)`; 409 if a round is running, 501 if training.round is not importable.
`backend/round_backend.py::RoundBackend` (the only one; the CLI uses it too) implements the RoundBackend duck type from training/round.py:
- `load_training_examples()` -> all rows of `training_examples` (teacher answers + seeds)
- `add_training_examples(rows, source)`; `next_round_number()`; `promoted_eval()` (latest promoted round)
- `make_classifier(adapter|None)` -> eval wrapper with `predict(text)->{category,priority,confidence,latency_ms}`,
  `close()` (separate in-process model; fake when CLASSIFIER=fake, else MlxInProcessClassifier)
- `pause_serving()` = `ModelHolder.pause()`: waits for in-flight classify, blocks new ones, unloads the mlx model.
- `promote(round, adapter_path, version, eval)` = `ModelHolder.swap(version, adapter_path=...)` (builds
  `classifier.with_adapter(path)`, sets pointer under the write lock; allowed while paused).
- `resume_serving()` reloads the (new) model and releases the lock. `recalibrate(val)` runs AFTER resume.
- `record_eval(version, result)` -> `evals` table; `save_round(row)` -> `rounds` table, marks examples used.
- CLI: `backend.round_backend.get_round_backend()` builds a standalone context.

on_event dicts are forwarded as SSE: type `round_complete` -> `round_complete` event, everything else ->
`train_progress` (plus `job_id`).

## Eval integration
`eval/run.py::build_router_route_fn` routes through a private in-memory Router (no writes to the prod DB).
`/api/eval/compare` merges `eval/results/*.json`:
`router.json` -> `router`, `teacher.json` (unless `skipped`) and other named files -> `models`.

## DB
tables: tickets, predictions (local model output even when escalated), training_examples, rounds, evals,
cost_ledger (kind='teacher'), review_queue, thresholds (per model_version, default 0.8).
Tickets routed to `review` keep the local model's best guess as category/priority.

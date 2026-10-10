# Understudy (team e/acc)

Support tickets from gig workers are routed to a small local model (Gemma 4 E4B, 4-bit, on Apple silicon).
When it is confident its answer is used; otherwise a cloud teacher answers and that answer becomes training
data. Training rounds LoRA-fine-tune Gemma on the saved teacher answers, score the result on a held-out test
set, and promote the new adapter only if category macro-F1 improves. When the teacher is unreachable,
low-confidence tickets go to a human review queue.

Output per ticket: `{"category": A..H, "priority": P1..P4}`; the team is a fixed lookup from the category
(`backend/schemas.py`). Every number the API shows comes from SQLite or `eval/results/*.json`.

## Layout
| Path | What |
|---|---|
| `backend/` | FastAPI app, SQLite, classifier (`mlx`/`fake`), router, hot-swap holder, SSE, telemetry (`/logs`), OpenAI-compatible `/v1` |
| `data/` | ticket generation, teacher labeling, splits, audit; `train/val/test/demo.jsonl` |
| `training/` | `mlx_local` LoRA trainer, `round.py` (train, score, promote) |
| `eval/` | metrics and the scoring runner, results in `eval/results/` |
| `common/teacher.py` | Backboard.io client (cache, rate limit, retries, real token counts) |
| `scripts/` | `live_test.py` (end-to-end check), `snapshot.py`, `demo_reset.sh`, `start_webui.sh` |
| `docs/spike.md` | measured findings (logprobs, thinking-off, LoRA memory, PEFT to MLX); the spike scripts it cites live in git history |

## Setup
```bash
python3.11 -m venv backend/.venv
backend/.venv/bin/pip install -r requirements.txt mlx-lm
cp .env.example .env     # then fill BACKBOARD_API_KEY (never commit .env)
```
Models in `.env` (Backboard `provider/model` ids; prices from the OpenAI and Google pricing pages):
teacher `openai/gpt-6-luna` ($0.10 in / $0.50 out per 1M tokens), generator `google/gemini-2.5-flash`
($0.30 / $2.50, thinking billed as output).

## Data (about $2, about 15 minutes)
```bash
PY=backend/.venv/bin/python
$PY data/gen.py --n 1900                        # generator model, resumable, cached
TEACHER_RATE=10 $PY data/label.py --workers 16  # teacher labels, strict JSON
$PY data/split.py && $PY data/audit.py --file data/labeled.jsonl
```
Eval uses `data/test_gold.jsonl` (human labels) when present, otherwise `data/test.jsonl` and results are flagged
`provisional`. Fill the last two columns of `data/test_for_human_review.csv` to create gold labels.

## Run the API
```bash
CLASSIFIER=mlx backend/.venv/bin/uvicorn backend.app:app --port 8000     # real local model
CLASSIFIER=fake TEACHER=fake backend/.venv/bin/uvicorn backend.app:app --port 8000   # no model, for UI work
```
OpenAPI at `http://127.0.0.1:8000/docs`; SSE at `/api/events`; `POST /api/stream/start {"rate_per_min": 30}`
replays `data/demo.jsonl`; `POST /api/mode/offline {"offline": true}` forces offline mode.
`./start.sh` runs the backend plus Open WebUI (which talks to the backend's `/v1`; no separate model server).
Training unloads the serving model while it runs, so one model is in RAM at a time.

## Train and score a round (local)
```bash
MLX_PYTHON=$PWD/../../../.venv/bin/python CLASSIFIER=mlx \
  $PY -m training.round --backend mlx_local --seed-from-train-pool --iters 300
```
`--seed-from-train-pool` seeds the pool from `data/train.jsonl` teacher labels, recorded as
`source='seed_train_pool'`. Promotion requires a strict macro-F1 gain; the reason is stored either way.
Or `POST /api/train/round {"backend": "mlx_local"}` (progress over SSE).

## Tests
```bash
backend/.venv/bin/python -m pytest tests -q
```

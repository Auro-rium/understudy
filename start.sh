#!/usr/bin/env bash
# Launch the Understudy stack: backend (:8000, in-process Gemma 4 E4B + promoted adapter) + Open WebUI (:3000).
# Open WebUI talks to the backend's OpenAI-compatible /v1, so there is no separate model server.
# Usage: ./start.sh            (reads DEMO_KEY, Backboard keys, ... from .env)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs

pids=()
cleanup() { echo; echo "Stopping..."; kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup INT TERM EXIT

CLASSIFIER="${CLASSIFIER:-mlx}" TEACHER="${TEACHER:-real}" DB_PATH="${DB_PATH:-logs/demo.sqlite}" \
  backend/.venv/bin/uvicorn backend.app:app --host 127.0.0.1 --port 8000 > logs/backend.log 2>&1 &
pids+=($!)

echo -n "Waiting for backend (loads the model)"
until curl -sf http://127.0.0.1:8000/api/health >/dev/null 2>&1; do
  kill -0 "${pids[0]}" 2>/dev/null || { echo " failed, see logs/backend.log"; exit 1; }
  echo -n "."; sleep 2
done
echo " ready"

bash scripts/start_webui.sh > logs/webui.log 2>&1 &
pids+=($!)

echo "Backend   : http://127.0.0.1:8000  (logs page: /logs)"
echo "Open WebUI: http://127.0.0.1:3000  (first launch takes ~1 min)"
echo "Ctrl+C to stop both."
wait

#!/usr/bin/env bash
# Launch the local Gemma 4 E4B stack: mlx_lm.server (:8080) + Open WebUI (:3000).
set -euo pipefail
cd "$(dirname "$0")"

MODEL="mlx-community/gemma-4-e4b-it-4bit"
LLM_PORT=8080
UI_PORT=3000
mkdir -p logs data

pids=()
cleanup() { echo; echo "Stopping..."; kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup INT TERM EXIT

# 1. OpenAI-compatible model server
# Sampling defaults (Gemma 4 recommended). Override per run: TEMP=0.7 THINK=false ./start.sh
TEMP="${TEMP:-1.0}" TOP_P="${TOP_P:-0.95}" TOP_K="${TOP_K:-64}" MIN_P="${MIN_P:-0.0}"
MAX_TOKENS="${MAX_TOKENS:-4096}" THINK="${THINK:-true}"
.venv/bin/mlx_lm.server --model "$MODEL" --host 127.0.0.1 --port "$LLM_PORT" \
  --temp "$TEMP" --top-p "$TOP_P" --top-k "$TOP_K" --min-p "$MIN_P" --max-tokens "$MAX_TOKENS" \
  --chat-template-args "{\"enable_thinking\": $THINK}" > logs/mlx.log 2>&1 &
pids+=($!)

echo -n "Waiting for model server"
until curl -sf "http://127.0.0.1:$LLM_PORT/v1/models" >/dev/null 2>&1; do
  kill -0 "${pids[0]}" 2>/dev/null || { echo " failed, see logs/mlx.log"; exit 1; }
  echo -n "."; sleep 2
done
echo " ready"

# 2. Open WebUI, pre-wired to the local OpenAI endpoint
export OPENAI_API_BASE_URL="http://127.0.0.1:$LLM_PORT/v1"
export OPENAI_API_KEY="local"
export ENABLE_OLLAMA_API=false
export DATA_DIR="$PWD/data"
export WEBUI_AUTH=false
export ANONYMIZED_TELEMETRY=false SCARF_NO_ANALYTICS=true DO_NOT_TRACK=true
export ENABLE_VERSION_UPDATE_CHECK=false
.venv-webui/bin/open-webui serve --host 127.0.0.1 --port "$UI_PORT" > logs/webui.log 2>&1 &
pids+=($!)

echo "Model API : http://127.0.0.1:$LLM_PORT/v1"
echo "Open WebUI: http://127.0.0.1:$UI_PORT  (first launch takes ~1 min)"
echo "Ctrl+C to stop both."
wait

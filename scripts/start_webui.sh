#!/usr/bin/env bash
# Open WebUI pointed at the Understudy backend's OpenAI-compatible API (:8000/v1) - no mlx_lm.server / :8080.
# Models appear as understudy-base, understudy-round_1..N; picking one hot-swaps the backend's live model.
# Usage: scripts/start_webui.sh   (backend must already be running)
set -euo pipefail
cd "$(dirname "$0")/.."

MAIN="${UNDERSTUDY_MAIN:-/Users/thakuraiyush/Documents/understudy}"   # checkout that owns .venv-webui
KEY="$(grep -E '^DEMO_KEY=' .env | head -1 | cut -d= -f2-)"
mkdir -p logs

export OPENAI_API_BASE_URL="http://127.0.0.1:8000/v1"
export OPENAI_API_KEY="${KEY:-local}"
export ENABLE_PERSISTENT_CONFIG=false      # otherwise a saved :8080 connection from the first launch wins
export ENABLE_OLLAMA_API=false
export DATA_DIR="$MAIN/data"
export WEBUI_AUTH=false
export ANONYMIZED_TELEMETRY=false SCARF_NO_ANALYTICS=true DO_NOT_TRACK=true
export ENABLE_VERSION_UPDATE_CHECK=false
# Open WebUI fires extra background generations (titles, tags, follow-ups) at the same model; each one
# would serialise behind the single in-process MLX thread, so keep them off for the demo.
export ENABLE_TITLE_GENERATION=false ENABLE_TAGS_GENERATION=false ENABLE_FOLLOW_UP_GENERATION=false
export ENABLE_AUTOCOMPLETE_GENERATION=false

exec "$MAIN/.venv-webui/bin/open-webui" serve --host 127.0.0.1 --port 3000

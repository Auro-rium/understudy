#!/usr/bin/env bash
# Refresh public/export/snapshot.json (the bundled fallback the app shows when the backend is unreachable).
#   bash scripts/sync-snapshot.sh                      # from the backend branch: git show origin/backend:exports/snapshot.json
#   bash scripts/sync-snapshot.sh http://127.0.0.1:8000  # from a running backend: curl <API_URL>/api/snapshot
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../public/export/snapshot.json"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if [ "$#" -ge 1 ] && [ -n "$1" ]; then
  URL="${1%/}"
  curl --fail --silent --show-error --max-time 15 "$URL/api/snapshot" -o "$TMP"
else
  git -C "$HERE" show origin/backend:exports/snapshot.json > "$TMP"
fi

# refuse to overwrite with something that is not a snapshot
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!s||typeof s.generated_at!=="string") process.exit(1)' "$TMP" \
  || { echo "sync-snapshot: source is not a valid snapshot (no generated_at)" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
cp "$TMP" "$OUT"
echo "sync-snapshot: wrote $OUT"

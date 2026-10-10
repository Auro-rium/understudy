#!/usr/bin/env bash
# Fresh demo database: keeps round history, eval results, thresholds and training examples from the
# source DB, but zeroes every live counter (tickets, predictions, cost ledger, review queue).
# Usage (backend must be STOPPED):  scripts/demo_reset.sh [SRC=understudy.sqlite] [DST=logs/demo.sqlite]
# Then start with:  DB_PATH=logs/demo.sqlite CLASSIFIER=mlx uvicorn backend.app:app --port 8000
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${1:-understudy.sqlite}"
DST="${2:-logs/demo.sqlite}"
PY="${PYTHON:-backend/.venv/bin/python}"

[ -f "$SRC" ] || { echo "source DB not found: $SRC" >&2; exit 1; }
if lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "something is listening on :8000 - stop the backend first (it holds the DB open)" >&2
  exit 1
fi

mkdir -p "$(dirname "$DST")"
rm -f "$DST" "$DST-wal" "$DST-shm"   # stale WAL files next to a fresh copy corrupt it

"$PY" - "$SRC" "$DST" <<'EOF'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s, d = sqlite3.connect(src), sqlite3.connect(dst)
s.backup(d)          # consistent copy even if SRC is in WAL mode
s.close()
for t in ("tickets", "predictions", "cost_ledger", "review_queue"):
    d.execute(f"DELETE FROM {t}")
d.execute("DELETE FROM sqlite_sequence WHERE name IN ('tickets','predictions','cost_ledger','review_queue')")
d.commit()
d.execute("VACUUM")
q = lambda sql: d.execute(sql).fetchone()[0]
print(f"{dst}: tickets={q('select count(*) from tickets')} predictions={q('select count(*) from predictions')} "
      f"ledger={q('select count(*) from cost_ledger')} review={q('select count(*) from review_queue')} | "
      f"kept: rounds={q('select count(*) from rounds')} evals={q('select count(*) from evals')} "
      f"thresholds={q('select count(*) from thresholds')} training_examples={q('select count(*) from training_examples')}")
d.close()
EOF

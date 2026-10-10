"""Demo reset + archive. Reset copies the live DB to logs/snapshots/<id>.sqlite, then zeroes the live
counters (tickets, predictions, cost ledger, review queue). Rounds, evals, thresholds and training
examples are kept, so the model and its history survive. Archives are read back through the same
metrics queries the live dashboard uses."""
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from backend import metrics
from backend.db import DB

LIVE_TABLES = ("tickets", "predictions", "cost_ledger", "review_queue")
_ID = re.compile(r"^\d{8}-\d{6}(-\d+)?$")


def snapshot_dir() -> Path:
    return Path(os.environ.get("SNAPSHOT_DIR", "logs/snapshots"))


def reset(db: DB, directory: Path | None = None) -> dict:
    """Archive then zero the live counters; returns the archive's summary row. Holds the DB lock throughout."""
    directory = directory or snapshot_dir()
    directory.mkdir(parents=True, exist_ok=True)
    sid = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    n = 1
    while (directory / f"{sid}.sqlite").exists():
        n += 1
        sid = f"{sid.split('-')[0]}-{sid.split('-')[1]}-{n}"
    path = directory / f"{sid}.sqlite"
    with db._lock:
        dst = sqlite3.connect(path)
        try:
            db._conn.backup(dst)
        finally:
            dst.close()
        for t in LIVE_TABLES:
            db._conn.execute(f"DELETE FROM {t}")
        db._conn.execute("DELETE FROM sqlite_sequence WHERE name IN (%s)" % ",".join("?" * len(LIVE_TABLES)),
                         LIVE_TABLES)
        db._conn.commit()
    return _row(sid, path)


def _row(sid: str, path: Path) -> dict:
    d = DB(str(path))
    try:
        by = {r["source"]: r["n"] for r in d.query("select source, count(*) n from tickets group by source")}
        agg = d.one("select count(*) n, coalesce(sum(cost_usd),0) c, min(created_at) a, max(created_at) b from tickets")
        ver = d.one("select model_version v from tickets group by model_version order by count(*) desc limit 1")
        return {"id": sid, "created_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(timespec="seconds"),
                "tickets": agg["n"], "local": by.get("local", 0), "teacher": by.get("teacher", 0),
                "review": by.get("review", 0), "cost_usd": agg["c"], "first_ticket_at": agg["a"],
                "last_ticket_at": agg["b"], "model_version": ver["v"] if ver else None}
    finally:
        d.close()


def list_snapshots(directory: Path | None = None) -> list[dict]:
    directory = directory or snapshot_dir()
    if not directory.exists():
        return []
    files = sorted((p for p in directory.glob("*.sqlite") if _ID.match(p.stem)), reverse=True)
    return [_row(p.stem, p) for p in files]


def open_snapshot(sid: str, directory: Path | None = None) -> dict | None:
    """Everything the live page shows, read from an archive (read-only use; the id is validated)."""
    directory = directory or snapshot_dir()
    path = directory / f"{sid}.sqlite"
    if not _ID.match(sid) or not path.exists():
        return None
    d = DB(str(path))
    try:
        row = _row(sid, path)
        return {"snapshot": row, "summary": metrics.summary(d, row["model_version"] or "", "online"),
                "timeseries": metrics.timeseries(d), "tickets": metrics.recent_tickets(d, 200),
                "review_queue": metrics.review_queue(d), "rounds": d.list_rounds()}
    finally:
        d.close()

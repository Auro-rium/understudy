"""SQLite storage. One shared connection guarded by an RLock (thread-safe)."""
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

DEFAULT_THRESHOLD = 0.8  # used until calibrate() has stored a threshold for a model version

SCHEMA = """
CREATE TABLE IF NOT EXISTS tickets(
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
  category TEXT NOT NULL, priority TEXT NOT NULL, source TEXT NOT NULL,
  confidence REAL, latency_ms REAL NOT NULL, cost_usd REAL NOT NULL,
  model_version TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS predictions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
  model_version TEXT NOT NULL, category TEXT NOT NULL, priority TEXT NOT NULL,
  confidence REAL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS training_examples(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, text TEXT NOT NULL,
  category TEXT NOT NULL, priority TEXT NOT NULL, source TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  used_in_round INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rounds(
  round INTEGER PRIMARY KEY, model_version TEXT NOT NULL, examples INTEGER NOT NULL,
  loss_json TEXT NOT NULL, wall_time_s REAL NOT NULL, hardware TEXT NOT NULL,
  cost_usd REAL NOT NULL, promoted INTEGER NOT NULL, reason TEXT NOT NULL,
  eval_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS evals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, model_version TEXT NOT NULL,
  data_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cost_ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, kind TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS review_queue(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, text TEXT NOT NULL,
  created_at TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS thresholds(
  model_version TEXT PRIMARY KEY, threshold REAL NOT NULL, coverage REAL,
  accuracy REAL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tickets_source ON tickets(source);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class DB:
    def __init__(self, path: Optional[str] = None):
        self.path = path or os.environ.get("DB_PATH", "understudy.sqlite")
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            if self.path != ":memory:":
                self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    # ---- generic helpers
    def execute(self, sql: str, params: Iterable[Any] = ()) -> int:
        with self._lock:
            cur = self._conn.execute(sql, tuple(params))
            self._conn.commit()
            return cur.lastrowid

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, tuple(params)).fetchall()]

    def one(self, sql: str, params: Iterable[Any] = ()) -> Optional[dict]:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def close(self):
        with self._lock:
            self._conn.close()

    # ---- tickets
    def insert_ticket(self, *, text, category, priority, source, confidence, latency_ms,
                      cost_usd, model_version) -> int:
        return self.execute(
            "INSERT INTO tickets(text,category,priority,source,confidence,latency_ms,cost_usd,"
            "model_version,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (text, category, priority, source, confidence, latency_ms, cost_usd, model_version, now_iso()))

    def insert_prediction(self, ticket_id, model_version, category, priority, confidence):
        return self.execute(
            "INSERT INTO predictions(ticket_id,model_version,category,priority,confidence,created_at)"
            " VALUES(?,?,?,?,?,?)", (ticket_id, model_version, category, priority, confidence, now_iso()))

    def insert_training_example(self, *, ticket_id, text, category, priority, source,
                                tokens_in, tokens_out) -> int:
        return self.execute(
            "INSERT INTO training_examples(ticket_id,text,category,priority,source,tokens_in,"
            "tokens_out,created_at) VALUES(?,?,?,?,?,?,?,?)",
            (ticket_id, text, category, priority, source, tokens_in, tokens_out, now_iso()))

    def get_training_examples(self, unused_only: bool = False) -> list[dict]:
        sql = "SELECT * FROM training_examples"
        if unused_only:
            sql += " WHERE used_in_round IS NULL"
        return self.query(sql + " ORDER BY id")

    def mark_examples_used(self, round_no: int, ids: Optional[list[int]] = None):
        if ids is None:
            self.execute("UPDATE training_examples SET used_in_round=? WHERE used_in_round IS NULL", (round_no,))
        else:
            for i in ids:
                self.execute("UPDATE training_examples SET used_in_round=? WHERE id=?", (round_no, i))

    def add_ledger(self, ticket_id, kind, tokens_in, tokens_out, cost_usd) -> int:
        return self.execute(
            "INSERT INTO cost_ledger(ticket_id,kind,tokens_in,tokens_out,cost_usd,created_at)"
            " VALUES(?,?,?,?,?,?)", (ticket_id, kind, tokens_in, tokens_out, cost_usd, now_iso()))

    def add_review(self, ticket_id, text) -> int:
        return self.execute("INSERT INTO review_queue(ticket_id,text,created_at) VALUES(?,?,?)",
                            (ticket_id, text, now_iso()))

    # ---- thresholds
    def get_threshold(self, model_version: str) -> float:
        r = self.one("SELECT threshold FROM thresholds WHERE model_version=?", (model_version,))
        return r["threshold"] if r else DEFAULT_THRESHOLD

    def set_threshold(self, model_version, threshold, coverage=None, accuracy=None):
        self.execute(
            "INSERT INTO thresholds(model_version,threshold,coverage,accuracy,updated_at) VALUES(?,?,?,?,?)"
            " ON CONFLICT(model_version) DO UPDATE SET threshold=excluded.threshold,"
            " coverage=excluded.coverage, accuracy=excluded.accuracy, updated_at=excluded.updated_at",
            (model_version, threshold, coverage, accuracy, now_iso()))

    # ---- rounds / eval results (training agent writes these)
    def insert_round(self, *, round, model_version, examples, loss, wall_time_s, hardware,
                     cost_usd, promoted, reason, eval) -> None:
        """loss: [{'step':int,'loss':float}]; eval: {'category_acc','category_macro_f1','priority_acc'}"""
        self.execute(
            "INSERT OR REPLACE INTO rounds(round,model_version,examples,loss_json,wall_time_s,hardware,"
            "cost_usd,promoted,reason,eval_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (round, model_version, examples, json.dumps(loss), wall_time_s, hardware, cost_usd,
             int(bool(promoted)), reason, json.dumps(eval), now_iso()))

    def insert_eval(self, model_version: str, data: dict):
        self.execute("INSERT INTO evals(model_version,data_json,created_at) VALUES(?,?,?)",
                     (model_version, json.dumps(data), now_iso()))

    def list_rounds(self) -> list[dict]:
        out = []
        for r in self.query("SELECT * FROM rounds ORDER BY round"):
            out.append({"round": r["round"], "model_version": r["model_version"],
                        "examples": r["examples"], "loss": json.loads(r["loss_json"]),
                        "wall_time_s": r["wall_time_s"], "hardware": r["hardware"],
                        "cost_usd": r["cost_usd"], "promoted": bool(r["promoted"]),
                        "reason": r["reason"], "eval": json.loads(r["eval_json"])})
        return out

    def next_round_number(self) -> int:
        r = self.one("SELECT MAX(round) m FROM rounds")
        return (r["m"] or 0) + 1

"""All metrics computed from SQLite. Nothing hard-coded."""
import glob
import json
import os
from typing import Optional

from backend.db import DB
from backend.router import avg_teacher_cost


def summary(db: DB, model_version: str, mode: str) -> dict:
    rows = db.query("SELECT source, COUNT(*) n FROM tickets GROUP BY source")
    c = {r["source"]: r["n"] for r in rows}
    total = sum(c.values())

    def share(k):
        return (c.get(k, 0) / total) if total else 0.0

    cost = db.one("SELECT COALESCE(SUM(cost_usd),0) s FROM cost_ledger")["s"]
    avg, _src = avg_teacher_cost(db)
    return {"total": total, "local_share": share("local"), "teacher_share": share("teacher"),
            "review_share": share("review"), "cost_usd_total": float(cost),
            "cost_avoided_usd": c.get("local", 0) * avg, "model_version": model_version, "mode": mode}


def timeseries(db: DB, bucket: str = "tickets", size: int = 10) -> list[dict]:
    """bucket='tickets': every `size` tickets; bucket='minute': per UTC minute.
    local_share is within the bucket; costs are cumulative at the end of the bucket.
    Cloud-only counterfactual = tickets_so_far * average teacher cost per call."""
    avg, _ = avg_teacher_cost(db)
    # Grouped in SQL (this is polled every ~2 s); the bare created_at is the one on the row with MAX(id),
    # i.e. the last ticket of the bucket.
    key = "substr(created_at, 1, 16)" if bucket == "minute" else "(rn - 1) / %d" % max(1, int(size))
    groups = db.query(
        "WITH t AS (SELECT id, source, cost_usd, created_at, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM tickets) "
        "SELECT COUNT(*) AS n, SUM(source = 'local') AS local_n, SUM(cost_usd) AS cost, MAX(id) AS last_id, "
        f"created_at FROM t GROUP BY {key} ORDER BY MAX(id)")
    out, cum_cost, seen = [], 0.0, 0
    for g in groups:
        cum_cost += g["cost"]
        seen += g["n"]
        out.append({"t": g["created_at"], "local_share": g["local_n"] / g["n"],
                    "cost_cumulative": cum_cost, "cost_cloud_only_cumulative": seen * avg})
    return out


def recent_tickets(db: DB, limit: int = 50) -> list[dict]:
    return db.query("SELECT id, text, category, priority, source, confidence, latency_ms, cost_usd,"
                    " model_version, created_at FROM tickets ORDER BY id DESC LIMIT ?", (limit,))


def review_queue(db: DB) -> list[dict]:
    return db.query("SELECT ticket_id AS id, text, created_at FROM review_queue WHERE resolved=0 ORDER BY id")


def eval_compare(results_dir: Optional[str] = None) -> dict:
    """Merge eval/results/*.json. Accepts full-shape files or single-model dicts ({'name':...})."""
    results_dir = results_dir or os.environ.get("EVAL_RESULTS_DIR", "eval/results")
    out = {"provisional": False, "models": [], "router": {}, "per_category_f1": {}, "confusion": {}}
    any_file = False
    for p in sorted(glob.glob(os.path.join(results_dir, "*.json"))):
        try:
            d = json.load(open(p))
        except Exception:
            continue
        if not isinstance(d, dict):
            continue
        any_file = True
        if "provisional" in d:
            out["provisional"] = out["provisional"] or bool(d["provisional"])
        if isinstance(d.get("models"), list):
            out["models"].extend(d["models"])
        elif d.get("name") == "router":  # eval/run.py router result
            out["router"] = {k: v for k, v in d.items() if k not in ("confusion", "per_category_f1")}
        elif "name" in d and not d.get("skipped"):
            out["models"].append({k: d.get(k) for k in ("name", "category_acc", "category_macro_f1",
                                                        "priority_acc", "latency_ms", "cost_per_1k")})
            if isinstance(d.get("per_category_f1"), dict):
                out["per_category_f1"][d["name"]] = d["per_category_f1"]
            if "confusion" in d:
                out["confusion"][d["name"]] = d["confusion"]
        if isinstance(d.get("router"), dict):
            out["router"].update(d["router"])
        if isinstance(d.get("per_category_f1"), dict) and "models" in d:
            out["per_category_f1"].update(d["per_category_f1"])
        if isinstance(d.get("confusion"), dict):
            out["confusion"].update(d["confusion"])
    if not any_file:
        out["provisional"] = True
    return out

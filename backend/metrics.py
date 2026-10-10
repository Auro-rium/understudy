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
    rows = db.query("SELECT id, source, cost_usd, created_at FROM tickets ORDER BY id")
    avg, _ = avg_teacher_cost(db)
    groups: list[list[dict]] = []
    if bucket == "minute":
        cur_key = None
        for r in rows:
            k = r["created_at"][:16]
            if k != cur_key:
                groups.append([])
                cur_key = k
            groups[-1].append(r)
    else:
        size = max(1, int(size))
        groups = [rows[i:i + size] for i in range(0, len(rows), size)]
    out, cum_cost, seen = [], 0.0, 0
    for g in groups:
        cum_cost += sum(r["cost_usd"] for r in g)
        seen += len(g)
        out.append({"t": g[-1]["created_at"],
                    "local_share": sum(1 for r in g if r["source"] == "local") / len(g),
                    "cost_cumulative": cum_cost,
                    "cost_cloud_only_cumulative": seen * avg})
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

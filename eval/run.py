"""Evaluate a named system on the test set.

  python -m eval.run --system base|round_N|teacher|router [--classifier mlx|fake] [--limit N]

Writes eval/results/<name>.json:
 {name, provisional, n, category_acc, category_macro_f1, priority_acc, latency_ms,
  per_category_f1, confusion, cost_per_1k, local_share}
Costs are only ever REAL recorded teacher costs; null if none is available.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eval.metrics import summarize  # noqa: E402
from training.prompt import parse_answer  # noqa: E402

RESULTS = ROOT / "eval" / "results"
DATA = ROOT / "data"
_NAME2LETTER = {"payment_delay": "A", "payment_dispute": "B", "onboarding_kyc": "C",
                "task_assignment": "D", "app_technical": "E", "task_submission": "F",
                "account_status": "G", "other": "H"}


def _norm_cat(c) -> str:
    c = str(c).strip()
    return _NAME2LETTER.get(c.lower(), c.upper()[:1])


def load_jsonl(path) -> list[dict]:
    rows = []
    for line in Path(path).read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            r["category"] = _norm_cat(r["category"])
            rows.append(r)
    return rows


def load_test(data_dir: Path = DATA) -> tuple[list[dict], bool]:
    """-> (tickets, provisional). Prefers human-verified test_gold.jsonl."""
    gold = Path(data_dir) / "test_gold.jsonl"
    if gold.is_file():
        return load_jsonl(gold), False
    return load_jsonl(Path(data_dir) / "test.jsonl"), True


def write_result(res: dict, results_dir: Path = RESULTS) -> Path:
    results_dir = Path(results_dir)
    results_dir.mkdir(parents=True, exist_ok=True)
    p = results_dir / f"{res['name']}.json"
    p.write_text(json.dumps(res, indent=2))
    return p


def read_result(name: str, results_dir: Path = RESULTS) -> Optional[dict]:
    p = Path(results_dir) / f"{name}.json"
    return json.loads(p.read_text()) if p.is_file() else None


def _base_result(name, tickets, provisional, preds, lat, **extra) -> dict:
    s = summarize([t["category"] for t in tickets], [p[0] for p in preds],
                  [t["priority"] for t in tickets], [p[1] for p in preds], lat)
    res = {"name": name, "provisional": provisional, **s, "cost_per_1k": None, "local_share": None}
    res.update(extra)
    return res


def evaluate_classifier(clf, tickets: list[dict], name: str, provisional: bool = True,
                        on_progress: Optional[Callable] = None, kind: Optional[str] = None) -> dict:
    preds, lat = [], []
    for i, t in enumerate(tickets):
        r = clf.predict(t["text"])
        preds.append((r.get("category"), r.get("priority")))
        lat.append(r.get("latency_ms"))
        if on_progress:
            on_progress(i + 1, len(tickets))
    res = _base_result(name, tickets, provisional, preds, lat)
    res["cost_per_1k"] = 0.0  # local inference: no API cost (electricity ignored)
    res["classifier"] = kind  # 'mlx' | 'fake' | None; lets caches avoid mixing fake and real runs
    return res


def evaluate_teacher(teacher, tickets, provisional=True, label_fn=None) -> dict:
    """Fresh teacher prediction on test ticket text vs data/test labels. Skipped if not configured."""
    try:
        teacher.require_config()
    except Exception as e:
        return {"name": "teacher", "provisional": provisional, "skipped": True, "reason": str(e)}
    if label_fn is None:
        from data.label import label_one as label_fn
    preds, lat, costs = [], [], []
    import time
    for t in tickets:
        t0 = time.perf_counter()
        r = label_fn(teacher, t["text"])
        lat.append((time.perf_counter() - t0) * 1000)
        if r is None:
            preds.append((None, None))
            continue
        preds.append((r[0], r[1]))
        costs.append(r[4])
    res = _base_result("teacher", tickets, provisional, preds, lat)
    res["skipped"] = False
    # cost only meaningful if the teacher has configured prices (cost > 0)
    res["cost_per_1k"] = (sum(costs) / len(costs) * 1000) if costs and sum(costs) > 0 else None
    return res


def evaluate_router(route_fn: Callable[[str], dict], tickets, provisional=True,
                    teacher_cost_per_ticket: Optional[float] = None, costs_known: bool = True) -> dict:
    """route_fn(text) -> {category, priority, source: local|teacher|review, cost_usd, latency_ms}.

    cost_per_1k  = real routed cost per 1,000 tickets (sum of recorded cost_usd)
    cloud_only_cost_per_1k = 1000 * mean REAL teacher cost/ticket (observed on routed tickets, or
                             `teacher_cost_per_ticket` from a teacher eval); null if unknown.
    """
    preds, lat, srcs, cost, t_costs = [], [], [], 0.0, []
    for t in tickets:
        r = route_fn(t["text"])
        preds.append((r.get("category"), r.get("priority")))
        lat.append(r.get("latency_ms"))
        srcs.append(r.get("source"))
        c = r.get("cost_usd") or 0.0
        cost += c
        if r.get("source") == "teacher" and c > 0:
            t_costs.append(c)
    n = max(1, len(tickets))
    res = _base_result("router", tickets, provisional, preds, lat)
    res["local_share"] = sum(1 for s in srcs if s == "local") / n
    res["teacher_share"] = sum(1 for s in srcs if s == "teacher") / n
    res["review_share"] = sum(1 for s in srcs if s == "review") / n
    per_t = (sum(t_costs) / len(t_costs)) if t_costs else teacher_cost_per_ticket
    res["cost_per_1k"] = cost / n * 1000  # sum of recorded per-ticket costs
    res["cloud_only_cost_per_1k"] = per_t * 1000 if per_t is not None else None
    res["cost_avoided_per_1k"] = (res["cloud_only_cost_per_1k"] - res["cost_per_1k"]
                                  if res["cloud_only_cost_per_1k"] is not None
                                  and res["cost_per_1k"] is not None else None)
    if not costs_known:  # teacher prices not configured: never report invented/zero costs
        res["cost_per_1k"] = res["cloud_only_cost_per_1k"] = res["cost_avoided_per_1k"] = None
    return res


def build_router_route_fn(classifier, teacher=None, threshold: Optional[float] = None):
    """Real backend Router over an in-memory DB (no pollution of the live DB).
    -> (route_fn, costs_known). costs_known is False if teacher prices are unset."""
    from backend.db import DB
    from backend.holder import ModelHolder
    from backend.router import Router
    from backend.teacher_iface import teacher_prices
    db = DB(":memory:")
    holder = ModelHolder(classifier, "eval")
    if threshold is not None:
        db.set_threshold("eval", threshold)
    router = Router(db, holder, teacher)

    def route(text):
        return router.classify(text, force_offline=False)

    return route, any(teacher_prices())


def _adapter_for(name: str) -> Optional[str]:
    if name == "base":
        return None
    p = ROOT / "adapters" / name
    if not p.exists():
        raise SystemExit(f"no adapter at {p}")
    return str(p)


def _latest_promoted_adapter() -> Optional[str]:
    try:
        from backend.round_backend import latest_promoted_adapter
        from backend.db import DB
        r = latest_promoted_adapter(DB())
        return r[1] if r else None
    except Exception:
        return None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--system", required=True, help="base | round_N | teacher | router")
    ap.add_argument("--classifier", default="mlx", choices=["mlx", "fake"])
    ap.add_argument("--limit", type=int)
    ap.add_argument("--threshold", type=float, help="router confidence threshold (default: DB default)")
    ap.add_argument("--data-dir", default=str(DATA))
    ap.add_argument("--results-dir", default=str(RESULTS))
    a = ap.parse_args(argv)
    tickets, prov = load_test(Path(a.data_dir))
    if a.limit:
        tickets = tickets[:a.limit]
    from eval.classifiers import make_classifier
    gold = {t["text"]: (t["category"], t["priority"]) for t in tickets}
    if a.system == "teacher":
        from common.teacher import get_teacher
        res = evaluate_teacher(get_teacher(), tickets, prov)
    elif a.system == "router":
        if a.classifier == "fake":
            clf = make_classifier("fake", gold=gold)

            def route(text):
                r = clf.predict(text)
                local = (r["confidence"] or 0) >= 0.7
                return {**r, "source": "local" if local else "teacher", "cost_usd": 0.0 if local else 0.002}
            known = True
        else:
            from backend.classifiers import MlxInProcessClassifier
            from backend.app import default_teacher
            adapter = _latest_promoted_adapter()
            route, known = build_router_route_fn(
                MlxInProcessClassifier(adapter_path=adapter), default_teacher(), a.threshold)
        td = read_result("teacher", Path(a.results_dir))
        per_t = (td["cost_per_1k"] / 1000) if td and td.get("cost_per_1k") else None
        res = evaluate_router(route, tickets, prov, per_t, costs_known=known)
        res["classifier"] = a.classifier  # 'fake' costs are synthetic: never quote them
    else:
        clf = make_classifier(a.classifier, _adapter_for(a.system) if a.classifier == "mlx" else None, gold)
        res = evaluate_classifier(clf, tickets, a.system, prov, kind=a.classifier)
        clf.close()
    p = write_result(res, Path(a.results_dir))
    print(json.dumps({k: v for k, v in res.items() if k not in ("confusion",)}, indent=2))
    print("wrote", p)


if __name__ == "__main__":
    main()

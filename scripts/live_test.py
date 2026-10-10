"""Live end-to-end test against a RUNNING backend (real model + real teacher).

  CLASSIFIER=mlx DB_PATH=logs/live.sqlite uvicorn backend.app:app --port 8000     # in one shell
  python scripts/live_test.py --db logs/live.sqlite                                # in another

Phase A  replays data/demo.jsonl through the stream at the calibrated threshold and scores it against the
         demo (teacher) labels. Phase B temporarily raises the threshold (written straight to the DB copy)
         so the teacher and offline/review paths get exercised; those tickets are reported separately.
Also checks the frontend contract (docs/BACKEND_INTEGRATION.md): CORS preflight, SSE headers/events, shapes.
Writes eval/results/live_test.json. Every number is read from the API / SQLite, nothing is hand-typed.
"""
import argparse
import json
import sqlite3
import sys
import threading
import time
from collections import Counter
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from eval.metrics import LETTERS, macro_f1, accuracy  # noqa: E402

TICKET_KEYS = {"id", "text", "created_at", "category", "category_name", "priority", "team", "source",
               "confidence", "latency_ms", "cost_usd", "model_version"}
SUMMARY_KEYS = {"total", "local_share", "teacher_share", "review_share", "cost_usd_total",
                "cost_avoided_usd", "model_version", "mode"}
checks: list = []


def check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""), flush=True)
    return ok


class Sse(threading.Thread):
    """Listens to /api/events, counts events by type, keeps the first payload of each type."""

    def __init__(self, base, origin):
        super().__init__(daemon=True)
        self.base, self.origin = base, origin
        self.counts, self.samples, self.headers, self.error = Counter(), {}, {}, None
        self.ready = threading.Event()
        self._stop = threading.Event()

    def run(self):
        try:
            with httpx.stream("GET", f"{self.base}/api/events", headers={"Origin": self.origin},
                              timeout=httpx.Timeout(10, read=None)) as r:
                self.headers = dict(r.headers)
                self.ready.set()
                ev = None
                for line in r.iter_lines():
                    if self._stop.is_set():
                        break
                    if line.startswith("event:"):
                        ev = line.split(":", 1)[1].strip()
                    elif line.startswith("data:") and ev:
                        self.counts[ev] += 1
                        try:
                            self.samples.setdefault(ev, json.loads(line.split(":", 1)[1]))
                        except ValueError:
                            pass
        except Exception as e:  # noqa: BLE001
            self.error = repr(e)
            self.ready.set()

    def stop(self):
        self._stop.set()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--db", default="logs/live.sqlite", help="the DB the server uses (threshold edits + ledger checks)")
    ap.add_argument("--demo", default=str(ROOT / "data" / "demo.jsonl"))
    ap.add_argument("--rate", type=float, default=600, help="stream rate_per_min (bounded by model latency)")
    ap.add_argument("--limit", type=int, default=0, help="only expect the first N demo tickets (0 = all)")
    ap.add_argument("--phase-b-threshold", type=float, default=0.9)
    ap.add_argument("--phase-b-n", type=int, default=40)
    ap.add_argument("--origin", default="http://localhost:3001")
    ap.add_argument("--out", default=str(ROOT / "eval" / "results" / "live_test.json"))
    a = ap.parse_args()
    base = a.base.rstrip("/")
    c = httpx.Client(base_url=base, timeout=120, headers={"Origin": a.origin})
    demo = [json.loads(l) for l in Path(a.demo).read_text().splitlines() if l.strip()]
    if a.limit:
        demo = demo[:a.limit]
    by_text = {d["text"]: d for d in demo}
    report: dict = {"base": base, "started": time.strftime("%Y-%m-%dT%H:%M:%S")}

    # ---------------------------------------------------------------- smoke / contract
    h = c.get("/api/health").json()
    report["model_version"] = h["model_version"]
    check("health reports a promoted round (not base)", h["model_version"].startswith("round_"), h)
    check("health keys", set(h) >= {"status", "model_version", "mode"} and h["mode"] == "online", h)
    pre = c.options("/api/train/round", headers={"Origin": a.origin, "Access-Control-Request-Method": "POST",
                                                  "Access-Control-Request-Headers": "content-type"})
    check("CORS preflight allows origin", pre.status_code == 200 and
          pre.headers.get("access-control-allow-origin") in ("*", a.origin), pre.headers.get("access-control-allow-origin"))
    snap = c.get("/api/snapshot").json()
    check("snapshot has all keys", set(snap) >= {"generated_at", "health", "summary", "timeseries", "tickets",
                                                 "review_queue", "rounds", "eval_compare"})
    sse = Sse(base, a.origin)
    sse.start()
    sse.ready.wait(10)
    check("SSE content-type + CORS", sse.error is None and "text/event-stream" in sse.headers.get("content-type", "")
          and sse.headers.get("access-control-allow-origin") in ("*", a.origin), sse.error or sse.headers.get("content-type"))
    t0 = time.time()
    first = c.post("/api/classify", json={"text": demo[0]["text"]})
    check("first classify works in a worker thread (MLX stream gate)", first.status_code == 200,
          f"{first.status_code} {first.text[:200]}")
    if first.status_code != 200:
        sys.exit(1)
    report["first_classify_s"] = round(time.time() - t0, 2)
    check("classify response shape", set(first.json()) >= {"id", "category", "category_name", "priority", "team",
                                                           "source", "confidence", "latency_ms", "cost_usd",
                                                           "model_version"}, list(first.json()))

    # ---------------------------------------------------------------- phase A: stream
    sum0 = c.get("/api/metrics/summary").json()
    max_id0 = max([t["id"] for t in c.get("/api/tickets/recent?limit=1").json()] or [0])
    r = c.post("/api/stream/start", json={"rate_per_min": a.rate})
    check("stream start", r.status_code == 200, r.text)
    tA = time.time()
    deadline = tA + 900
    while time.time() < deadline:
        n = c.get("/api/metrics/summary").json()["total"] - sum0["total"]
        if n >= len(demo):
            break
        time.sleep(2)
    wall = time.time() - tA
    c.post("/api/stream/stop")
    time.sleep(1)
    rows = [t for t in c.get("/api/tickets/recent?limit=1000").json() if t["id"] > max_id0]
    check(f"stream produced {len(demo)} tickets", len(rows) == len(demo), f"{len(rows)} in {wall:.0f}s")
    check("ticket shape matches frontend types", all(TICKET_KEYS <= set(t) for t in rows[:20]))
    check("recent tickets newest first", [t["id"] for t in rows] == sorted((t["id"] for t in rows), reverse=True))
    scored = [(by_text[t["text"]], t) for t in rows if t["text"] in by_text]
    true_c, pred_c = [d["category"] for d, _ in scored], [t["category"] for _, t in scored]
    true_p, pred_p = [d["priority"] for d, _ in scored], [t["priority"] for _, t in scored]
    clear = [(d, t) for d, t in scored if not d.get("disagrees")]
    A = {"n": len(scored), "wall_s": round(wall, 1), "tickets_per_s": round(len(scored) / wall, 2) if wall else None,
         "category_acc": accuracy(true_c, pred_c), "category_macro_f1": macro_f1(true_c, pred_c, LETTERS),
         "priority_acc": accuracy(true_p, pred_p),
         "source": dict(Counter(t["source"] for _, t in scored)),
         "mean_latency_ms": sum(t["latency_ms"] for _, t in scored) / max(1, len(scored)),
         "cost_usd": sum(t["cost_usd"] for _, t in scored),
         "n_disagree_rows": len(scored) - len(clear),
         "category_acc_excluding_disagrees": accuracy([d["category"] for d, _ in clear], [t["category"] for _, t in clear]),
         "model_versions": dict(Counter(t["model_version"] for _, t in scored))}
    report["phase_a_stream_at_calibrated_threshold"] = A
    print(json.dumps(A, indent=2))
    check("every phase-A ticket served by the promoted model", set(A["model_versions"]) == {h["model_version"]})
    s1 = c.get("/api/metrics/summary").json()
    check("summary keys + shares sum to 1", SUMMARY_KEYS <= set(s1) and abs(
        s1["local_share"] + s1["teacher_share"] + s1["review_share"] - 1) < 1e-6, s1)
    check("summary total counts tickets", s1["total"] == sum0["total"] + len(demo), s1["total"])
    ts = c.get("/api/metrics/timeseries").json()
    check("timeseries non-empty with frontend keys", bool(ts) and {"t", "local_share", "cost_cumulative",
                                                                   "cost_cloud_only_cumulative"} <= set(ts[0]), len(ts))
    check("SSE delivered a prediction per ticket", sse.counts["prediction"] >= len(demo), dict(sse.counts))
    if "prediction" in sse.samples:
        check("SSE prediction payload has ticket keys", TICKET_KEYS <= set(sse.samples["prediction"]),
              sorted(TICKET_KEYS - set(sse.samples["prediction"])))

    # ---------------------------------------------------------------- phase B: teacher + offline
    db = sqlite3.connect(a.db, timeout=30)
    version = c.get("/api/health").json()["model_version"]
    old = db.execute("SELECT threshold FROM thresholds WHERE model_version=?", (version,)).fetchone()
    db.execute("INSERT INTO thresholds(model_version,threshold,coverage,accuracy,updated_at) VALUES(?,?,NULL,NULL,datetime('now')) "
               "ON CONFLICT(model_version) DO UPDATE SET threshold=excluded.threshold", (version, a.phase_b_threshold))
    db.commit()
    report["phase_b_threshold"] = {"version": version, "calibrated": old[0] if old else None, "temporary": a.phase_b_threshold}
    sample = demo[len(demo) // 2:][:a.phase_b_n]
    before = c.get("/api/metrics/summary").json()
    teach, review = [], []
    out_b = []
    try:
        for d in sample:
            r = c.post("/api/classify", json={"text": d["text"]}).json()
            out_b.append(r)
            if r["source"] == "teacher":
                teach.append((d, r))
            if teach:
                break
        check("teacher path: at least one ticket escalated to the real teacher", len(teach) >= 1,
              Counter(r["source"] for r in out_b))
        if teach:
            d, r = teach[0]
            check("teacher ticket billed from real token counts", r["cost_usd"] > 0, r["cost_usd"])
            check("teacher ticket confidence below threshold", r["confidence"] is not None and r["confidence"] < a.phase_b_threshold, r["confidence"])
            report["teacher_example"] = {"demo_label": [d["category"], d["priority"]], "teacher": [r["category"], r["priority"]], "cost_usd": r["cost_usd"]}
        after = c.get("/api/metrics/summary").json()
        check("cost_avoided_usd > 0 once a teacher call exists", after["cost_avoided_usd"] > 0, after["cost_avoided_usd"])
        te = db.execute("SELECT COUNT(*), COALESCE(SUM(cost_usd),0) FROM cost_ledger").fetchone()
        tr = db.execute("SELECT COUNT(*) FROM training_examples WHERE source='teacher'").fetchone()[0]
        a_teach = [t for _, t in scored if t["source"] == "teacher"]  # phase-A escalations count too
        n_t = len(a_teach) + len(teach)
        cost_t = sum(t["cost_usd"] for t in a_teach) + sum(r["cost_usd"] for _, r in teach)
        check("ledger rows == all teacher tickets; training_examples written", te[0] == n_t and tr == n_t, f"ledger={te} train={tr} teacher_tickets={n_t}")
        check("ledger cost == sum of ticket cost_usd", abs(te[1] - cost_t) < 1e-9, f"{te[1]} vs {cost_t}")

        # offline: uncertain tickets must go to review, never to the cloud
        mr = c.post("/api/mode/offline", json={"offline": True})
        h2 = c.get("/api/health").json()
        time.sleep(0.5)
        check("offline: health + SSE mode event", mr.status_code == 200 and h2["mode"] == "offline" and sse.counts["mode"] >= 2,
              f"{h2['mode']} mode_events={sse.counts['mode']}")
        out_off = []
        # tickets that were uncertain online (they escalated above) are the ones that must go to review offline
        for d in [x for x, _ in teach] + demo[:a.phase_b_n]:
            r = c.post("/api/classify", json={"text": d["text"]}).json()
            out_off.append(r)
            if r["source"] == "review":
                review.append(r)
                break
        check("offline: low-confidence ticket -> source=review (no cloud call)", len(review) >= 1,
              Counter(r["source"] for r in out_off))
        check("offline: no teacher call made", all(r["source"] != "teacher" for r in out_off))
        q = c.get("/api/review_queue").json()
        texts = {i["text"] for i in q}
        rtext = next((d["text"] for d in demo if review and d["text"] in texts), None)
        check("offline: review_queue lists a review ticket", bool(review) and rtext is not None, len(q))
        c.post("/api/mode/offline", json={"offline": False})
        check("back online", c.get("/api/health").json()["mode"] == "online")
    finally:
        if old:
            db.execute("UPDATE thresholds SET threshold=? WHERE model_version=?", (old[0], version))
        else:
            db.execute("DELETE FROM thresholds WHERE model_version=?", (version,))
        db.commit()
    report["phase_b"] = {"teacher_tickets": len(teach), "review_tickets": len(review),
                         "note": "threshold temporarily raised so uncertain tickets exist; NOT part of phase A numbers"}

    # ---------------------------------------------------------------- finish
    sse.stop()
    report["sse_event_counts"] = dict(sse.counts)
    report["checks"] = checks
    report["passed"] = sum(x["ok"] for x in checks)
    report["failed"] = [x["name"] for x in checks if not x["ok"]]
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(report, indent=2))
    print(f"\n{report['passed']}/{len(checks)} checks passed; wrote {a.out}")
    sys.exit(1 if report["failed"] else 0)


if __name__ == "__main__":
    main()

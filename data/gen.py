"""Generate synthetic tickets via the Teacher. Resumable; output data/raw_tickets.jsonl.

  python data/gen.py --dry-run --limit 10
  python data/gen.py --limit 20            # pilot
  python data/gen.py --n 1900              # full (nohup it)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from common.teacher import TeacherConfigError, TeacherUnavailable, get_teacher  # noqa: E402
from data.spec import build_matrix, build_prompt  # noqa: E402

OUT = HERE / "raw_tickets.jsonl"


def parse_tickets(text: str, k: int) -> list[str] | None:
    t = text.strip()
    t = re.sub(r"^```(?:json)?|```$", "", t, flags=re.M).strip()
    try:
        d = json.loads(t)
    except Exception:
        m = re.search(r"\{.*\}|\[.*\]", t, re.S)
        if not m:
            return None
        try:
            d = json.loads(m.group(0))
        except Exception:
            return None
    items = d.get("tickets") if isinstance(d, dict) else d
    if not isinstance(items, list):
        return None
    out = []
    for it in items:
        s = it.get("text") if isinstance(it, dict) else it
        if not isinstance(s, str) or len(s.strip()) < 8:
            return None
        out.append(s.strip())
    return out if len(out) == k else None


def done_ids(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    ids = set()
    for line in path.read_text().splitlines():
        try:
            ids.add(json.loads(line)["spec_id"])
        except Exception:
            pass
    return ids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1900, help="total tickets (extra over 1800 absorbs dedupe loss)")
    ap.add_argument("--batch", type=int, default=5)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--limit", type=int, default=None, help="only first N specs (pilot)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args()

    specs = build_matrix(a.n, a.seed)
    if a.limit:
        specs = specs[: a.limit]
    batches = [specs[i:i + a.batch] for i in range(0, len(specs), a.batch)]

    if a.dry_run:
        for i, b in enumerate(batches[:3]):
            sysm, user = build_prompt(b)
            print(f"=== batch {i} SYSTEM ===\n{sysm}\n=== USER ===\n{user}\n")
        print(f"[dry-run] {len(specs)} specs, {len(batches)} batches; no network.")
        return

    out = Path(a.out)
    have = done_ids(out)
    todo = [b for b in batches if not all(s["spec_id"] in have for s in b)]
    print(f"{len(specs)} specs, {len(have)} done, {len(todo)} batches to run", flush=True)
    try:
        teacher = get_teacher()
        teacher.require_config()
    except TeacherConfigError as e:
        sys.exit(f"ERROR: {e}")

    def run(b):
        sysm, user = build_prompt(b)
        for attempt in range(3):
            # vary the user prompt on retry so the cache doesn't return the bad parse
            u = user if attempt == 0 else user + f"\n(Attempt {attempt + 1}: return strictly valid JSON.)"
            r = teacher.complete(sysm, u, json_mode=True)
            texts = parse_tickets(r.text, len(b))
            if texts:
                return b, texts, r
        return b, None, r

    t0 = time.time()
    n_ok = n_fail = tin = tout = 0
    cost = 0.0
    with ThreadPoolExecutor(a.workers) as ex, out.open("a") as f:
        futs = [ex.submit(run, b) for b in todo]
        for k, fut in enumerate(as_completed(futs), 1):
            try:
                b, texts, r = fut.result()
            except TeacherConfigError as e:
                sys.exit(f"ERROR: {e}")
            except TeacherUnavailable as e:
                n_fail += 1
                print(f"batch failed (unavailable): {e}", flush=True)
                continue
            if not texts:
                n_fail += 1
                print("batch failed: unparseable output", flush=True)
                continue
            for s, t in zip(b, texts):
                f.write(json.dumps({"spec_id": s["spec_id"], "text": t,
                                    "intended_category": s["category"],
                                    "edge": s.get("edge"), "job": s["job"], "city": s["city"],
                                    "tone": s["tone"], "typos": s["typos"],
                                    "sentences": s["sentences"]}) + "\n")
            f.flush()
            n_ok += len(b)
            tin += r.tokens_in
            tout += r.tokens_out
            cost += r.cost_usd
            if k % 5 == 0 or k == len(futs):
                el = time.time() - t0
                print(f"[{k}/{len(futs)}] tickets_ok={n_ok} failed_batches={n_fail} "
                      f"tok_in={tin} tok_out={tout} cost=${cost:.3f} elapsed={el:.0f}s", flush=True)
    print(f"done. wrote to {out}. failed batches: {n_fail} (rerun to resume)")


if __name__ == "__main__":
    main()

"""Audit a labeled/split dataset (stdlib only).

  python data/audit.py [--file data/labeled.jsonl] [--samples 20]
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from data.split import dedupe  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(HERE / "labeled.jsonl"))
    ap.add_argument("--samples", type=int, default=20)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    p = Path(a.file)
    if not p.is_file():
        sys.exit(f"missing {p}")
    rows = [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
    n = len(rows)
    if not n:
        sys.exit("empty file")
    print(f"== {p.name}: {n} rows ==")
    cat = Counter(r.get("category", "?") for r in rows)
    print("\nClass balance (category):")
    for k in sorted(cat):
        print(f"  {k}: {cat[k]:5d} {cat[k] / n:6.1%} " + "#" * int(40 * cat[k] / n))
    print("\nPriority:", dict(sorted(Counter(r.get("priority", "?") for r in rows).items())))
    if "intended_category" in rows[0]:
        dis = sum(1 for r in rows if r.get("category") != r["intended_category"])
        print(f"\nDisagreement (teacher vs intended): {dis}/{n} = {dis / n:.1%}")
        pairs = Counter((r["intended_category"], r["category"]) for r in rows
                        if r.get("category") != r["intended_category"])
        print("  top confusions (intended->teacher):", pairs.most_common(8))
    words = [len(r["text"].split()) for r in rows]
    print(f"\nLength (words): min={min(words)} median={sorted(words)[n // 2]} max={max(words)}")
    bins = Counter(min(w // 10, 8) for w in words)
    for b in sorted(bins):
        lab = f"{b * 10}-{b * 10 + 9}" if b < 8 else "80+"
        print(f"  {lab:>6}: {bins[b]:5d} " + "#" * int(40 * bins[b] / n))
    _, dropped = dedupe(rows)
    print(f"\nNear-duplicate rate (exact + trigram>0.8): {dropped}/{n} = {dropped / n:.1%}")
    rng = random.Random(a.seed)
    print(f"\n{a.samples} random samples:")
    for r in rng.sample(rows, min(a.samples, n)):
        print(f"  [{r.get('category')}/{r.get('priority')} intended={r.get('intended_category')}] {r['text']}")


if __name__ == "__main__":
    main()

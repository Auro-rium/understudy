"""Dedupe + stratified seeded split of data/labeled.jsonl (stdlib only).

  python data/split.py [--seed 13]
Writes data/{train,val,test,demo}.jsonl and data/test_for_human_review.csv.
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import re
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
TARGETS = {"train": 1100, "val": 200, "test": 200, "demo": 300}


def norm(t: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", re.sub(r"\s+", " ", t.lower())).strip()


def trigrams(t: str) -> set:
    s = f"  {norm(t)} "
    return {s[i:i + 3] for i in range(len(s) - 2)}


def dedupe(rows: list[dict], thr: float = 0.8):
    seen, kept, sigs, dropped = set(), [], [], 0
    for r in rows:
        n = norm(r["text"])
        if n in seen:
            dropped += 1
            continue
        g = trigrams(r["text"])
        if any(len(g & h) / max(1, len(g | h)) > thr for h in sigs):
            dropped += 1
            continue
        seen.add(n)
        sigs.append(g)
        kept.append(r)
    return kept, dropped


def stratified(rows: list[dict], seed: int, targets: dict) -> dict:
    n = len(rows)
    tot = sum(targets.values())
    if n < tot:  # scale down proportionally
        targets = {k: int(v * n / tot) for k, v in targets.items()}
        targets["train"] += n - sum(targets.values())
    rng = random.Random(seed)
    groups = defaultdict(list)
    for r in rows:
        groups[r["category"]].append(r)
    remaining = dict(targets)
    alloc = {}
    fr = []
    for c, g in sorted(groups.items()):
        rng.shuffle(g)
        ideal = {k: len(g) * targets[k] / n for k in targets}
        alloc[c] = {k: int(v) for k, v in ideal.items()}
        for k in targets:
            remaining[k] -= alloc[c][k]
            fr.append((ideal[k] - int(ideal[k]), c, k))
    # distribute leftover slots by largest fractional part, respecting group sizes
    fr.sort(reverse=True)
    for _, c, k in fr:
        if remaining[k] > 0 and sum(alloc[c].values()) < len(groups[c]):
            alloc[c][k] += 1
            remaining[k] -= 1
    out = {k: [] for k in targets}
    for c, g in groups.items():
        i = 0
        for k in ("test", "val", "demo", "train"):
            m = alloc[c][k]
            out[k].extend(g[i:i + m])
            i += m
        out["train"].extend(g[i:])  # any remainder
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inp", default=str(HERE / "labeled.jsonl"))
    ap.add_argument("--outdir", default=str(HERE))
    ap.add_argument("--seed", type=int, default=13)
    a = ap.parse_args()
    inp = Path(a.inp)
    if not inp.is_file():
        sys.exit(f"missing {inp}; run gen.py then label.py")
    rows = [json.loads(l) for l in inp.read_text().splitlines() if l.strip()]
    rows.sort(key=lambda r: r["spec_id"])
    kept, dropped = dedupe(rows)
    print(f"{len(rows)} labeled -> {len(kept)} after dedupe ({dropped} dropped)")
    sp = stratified(kept, a.seed, TARGETS)

    ids = {k: {r["spec_id"] for r in v} for k, v in sp.items()}
    texts = {k: {norm(r["text"]) for r in v} for k, v in sp.items()}
    ks = list(sp)
    for i in range(len(ks)):
        for j in range(i + 1, len(ks)):
            assert not ids[ks[i]] & ids[ks[j]], f"id overlap {ks[i]}/{ks[j]}"
            assert not texts[ks[i]] & texts[ks[j]], f"text overlap {ks[i]}/{ks[j]}"

    outdir = Path(a.outdir)
    for k, v in sp.items():
        v.sort(key=lambda r: r["spec_id"])
        with (outdir / f"{k}.jsonl").open("w") as f:
            for r in v:
                f.write(json.dumps({
                    "id": r["spec_id"], "text": r["text"], "category": r["category"],
                    "priority": r["priority"], "intended_category": r["intended_category"],
                    "label_source": "teacher",
                    "disagrees": bool(r.get("disagrees_with_intended"))}) + "\n")
        print(f"{k}: {len(v)}")
    with (outdir / "test_for_human_review.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "text", "teacher_category", "teacher_priority",
                    "human_category", "human_priority"])
        for r in sp["test"]:
            w.writerow([r["spec_id"], r["text"], r["category"], r["priority"], "", ""])
    print("no overlap across splits (ids and normalized text): OK")


if __name__ == "__main__":
    main()

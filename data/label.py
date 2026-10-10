"""Teacher labeling: strict-JSON category+priority per ticket. Output data/labeled.jsonl.

  python data/label.py --dry-run --limit 3
  python data/label.py [--limit N]
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
from data.spec import CATEGORIES, PRIORITIES  # noqa: E402

RAW = HERE / "raw_tickets.jsonl"
OUT = HERE / "labeled.jsonl"

LABEL_SYSTEM = """You are the triage classifier for the support desk of a large Indian gig-work platform (field auditors, delivery partners, telecallers, exam proctors, data-annotation workers). Classify one worker ticket.

Categories:
A payment_delay: payout not received / late.
B payment_dispute: payout received or shown but wrong amount, deductions, penalties, incentives/bonus missing.
C onboarding_kyc: signup, documents, KYC verification, bank details, training before starting work.
D task_assignment: cannot get tasks, cancellations, slots, allocation/zone issues.
E app_technical: crash, login/OTP, GPS, upload failures, app bugs.
F task_submission: submission rejected, proof/photo/QC or audit disputes, quality score from rejections.
G account_status: account blocked/deactivated/suspended/restricted, rating drops, reactivation/appeals.
H other: feedback, info/policy questions, referrals, certificates, safety incidents, anything not above.

Tie-breaking: pick the DOMINANT issue the worker wants fixed. Late money = A; wrong money = B. A technical failure that causes the problem = E. A rejection dispute = F. A block/deactivation of an already-onboarded worker = G; unfinished verification = C. Safety incidents (assault, accident, harassment, unsafe situation) = H.

Priority:
P1 urgent: money owed more than 7 days, account blocked/deactivated (worker cannot earn), or any safety/harassment/injury issue.
P2 high: blocks earning or loses real money but not P1 (money owed 2-7 days, wrong deduction of notable amount, cannot log in, KYC blocking start of work, no tasks for days).
P3 normal: ordinary problem with limited impact.
P4 low: information query, feedback, appreciation, feature request, tiny issue.

Reply with ONLY a JSON object: {"category": "<A-H>", "priority": "<P1-P4>"}. No other text."""


def parse_label(text: str):
    t = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        d = json.loads(t)
    except Exception:
        m = re.search(r"\{[^{}]*\}", t)
        if not m:
            return None
        try:
            d = json.loads(m.group(0))
        except Exception:
            return None
    if not isinstance(d, dict):
        return None
    c, p = str(d.get("category", "")).strip().upper(), str(d.get("priority", "")).strip().upper()
    if c in CATEGORIES and p in PRIORITIES:
        return c, p
    return None


def label_one(teacher, text: str):
    """Returns (cat, pri, tokens_in, tokens_out, cost) or None after 3 invalid tries."""
    tin = tout = 0
    cost = 0.0
    for attempt in range(3):
        user = f"Ticket:\n{text}" + ("" if attempt == 0 else
                                      f"\n\n(Attempt {attempt + 1}: output only valid JSON with category A-H and priority P1-P4.)")
        r = teacher.complete(LABEL_SYSTEM, user, json_mode=True)
        tin += r.tokens_in
        tout += r.tokens_out
        cost += r.cost_usd
        lab = parse_label(r.text)
        if lab:
            return lab[0], lab[1], tin, tout, cost
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inp", default=str(RAW))
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    inp, out = Path(a.inp), Path(a.out)
    rows = [json.loads(l) for l in inp.read_text().splitlines() if l.strip()] if inp.is_file() else []
    if a.limit:
        rows = rows[: a.limit]
    if a.dry_run:
        print("=== SYSTEM ===\n" + LABEL_SYSTEM)
        for r in rows[:3] or [{"text": "<ticket text here>"}]:
            print("=== USER ===\nTicket:\n" + r["text"] + "\n")
        print(f"[dry-run] {len(rows)} tickets would be labeled; no network.")
        return
    if not rows:
        sys.exit(f"no input tickets at {inp}; run data/gen.py first")

    have = set()
    if out.is_file():
        have = {json.loads(l)["spec_id"] for l in out.read_text().splitlines() if l.strip()}
    todo = [r for r in rows if r["spec_id"] not in have]
    print(f"{len(rows)} tickets, {len(have)} labeled, {len(todo)} to do", flush=True)
    try:
        teacher = get_teacher()
        teacher.require_config()
    except TeacherConfigError as e:
        sys.exit(f"ERROR: {e}")

    t0 = time.time()
    ok = bad = 0
    tin = tout = 0
    cost = 0.0
    with ThreadPoolExecutor(a.workers) as ex, out.open("a") as f:
        futs = {ex.submit(label_one, teacher, r["text"]): r for r in todo}
        for k, fut in enumerate(as_completed(futs), 1):
            r = futs[fut]
            try:
                res = fut.result()
            except TeacherConfigError as e:
                sys.exit(f"ERROR: {e}")
            except TeacherUnavailable as e:
                bad += 1
                print(f"unavailable: {e}", flush=True)
                continue
            if not res:
                bad += 1
                continue
            c, p, ti, to, co = res
            tin, tout, cost = tin + ti, tout + to, cost + co
            r = dict(r, category=c, priority=p, label_source="teacher",
                     disagrees_with_intended=(c != r["intended_category"]),
                     label_tokens_in=ti, label_tokens_out=to, label_cost_usd=round(co, 6))
            f.write(json.dumps(r) + "\n")
            f.flush()
            ok += 1
            if k % 25 == 0 or k == len(futs):
                print(f"[{k}/{len(futs)}] ok={ok} invalid={bad} tok_in={tin} tok_out={tout} "
                      f"cost=${cost:.3f} elapsed={time.time() - t0:.0f}s", flush=True)
    print(f"done: {ok} labeled, {bad} failed (rerun to resume). -> {out}")


if __name__ == "__main__":
    main()

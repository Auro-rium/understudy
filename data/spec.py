"""Seeded prompt matrix for synthetic gig-worker support tickets (English only)."""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
try:
    from backend.schemas import CATEGORIES, PRIORITIES
except Exception:  # pydantic missing in stdlib-only runs
    CATEGORIES = {"A": "payment_delay", "B": "payment_dispute", "C": "onboarding_kyc",
                  "D": "task_assignment", "E": "app_technical", "F": "task_submission",
                  "G": "account_status", "H": "other"}
    PRIORITIES = ["P1", "P2", "P3", "P4"]

JOBS = {
    "field auditor": "visits shops/stores/addresses to verify listings, take geo-tagged photos, fill audit forms",
    "delivery partner": "delivers food/parcels/groceries on a bike, paid per order plus incentives",
    "telecaller": "makes outbound/inbound calls from home for lead qualification or surveys, paid per connected call/shift",
    "exam proctor": "invigilates online or centre-based exams, paid per session",
    "data-annotation worker": "labels images/text/audio on a task queue, paid per approved task",
}
CITIES = [
    "Mumbai", "Delhi", "Bengaluru", "Hyderabad", "Chennai", "Kolkata", "Pune", "Ahmedabad",
    "Jaipur", "Lucknow", "Indore", "Bhopal", "Patna", "Ranchi", "Raipur", "Guwahati",
    "Coimbatore", "Madurai", "Vijayawada", "Visakhapatnam", "Nagpur", "Surat", "Vadodara",
    "Nashik", "Kochi", "Thiruvananthapuram", "Bhubaneswar", "Dehradun", "Jodhpur", "Agra",
    "Varanasi", "Kanpur", "Meerut", "Ludhiana", "Amritsar", "Mysuru", "Hubballi", "Belagavi",
    "Warangal", "Tirupati", "Siliguri", "Gorakhpur", "Jabalpur", "Udaipur", "Shillong",
    "Imphal", "Cuttack", "Salem", "Rajkot", "Aurangabad",
]
TENURES = ["joined this week", "about 1 month on the platform", "3 months", "6 months",
           "over a year", "2+ years, a veteran", "returned after a long break"]
TONES = {
    "angry": "angry and frustrated, maybe a bit rude, possibly some CAPS",
    "polite": "very polite and formal, uses sir/madam, thanks in advance",
    "confused": "confused, unsure what is happening, asks questions",
    "terse": "extremely terse, few words, almost telegraphic",
    "desperate": "desperate, mentions rent/EMI/family/medical need",
    "neutral": "plain and matter-of-fact",
}
TONE_WEIGHTS = {"angry": 3, "polite": 3, "confused": 2, "terse": 2, "desperate": 2, "neutral": 3}
TYPOS = {
    "none": "clean spelling and punctuation",
    "light": "a couple of small typos or missing punctuation, lowercase i",
    "heavy": "many typos, no punctuation, sms-style shortforms (pls, plz, u, acct, amt), phone-keyboard errors",
}
TYPO_WEIGHTS = {"none": 4, "light": 4, "heavy": 2}

CAT_DESC = {
    "A": "payment_delay: payout not received or late (earnings stuck, weekly settlement missing, withdrawal pending)",
    "B": "payment_dispute: wrong amount, unfair deductions/penalties, missing incentives/bonus, rate mismatch",
    "C": "onboarding_kyc: signup, document upload/verification (Aadhaar, PAN, license), bank account details, training",
    "D": "task_assignment: cannot get tasks, orders cancelled/reassigned, slot booking problems, zone has no work",
    "E": "app_technical: crash, login/OTP failure, GPS wrong, upload failing, notification bugs, app freeze",
    "F": "task_submission: submission rejected, proof/photo/QC dispute, audit marked wrong, quality score contest",
    "G": "account_status: account blocked/deactivated/suspended, rating or score drop, restriction, reactivation",
    "H": "other: feedback, general how-do-I questions, policy info, referral, certificates, feature requests, appreciation",
}
# Weights: roughly balanced across A-H.
CAT_WEIGHTS = {k: 1.0 for k in CATEGORIES}

# --- Edge-case seeds (>= 40). (category, description) -----------------------
EDGE_SEEDS = [
    ("A", "Payout for last week missing, and it has now been more than 10 days; states exact dates"),
    ("A", "Payout delayed by only 1 day, asks politely if it is normal (low urgency)"),
    ("A", "Money debited from earnings screen to bank but bank has not received it; shows UTR number"),
    ("A", "Weekly settlement skipped after a public holiday; wants to know when it will arrive"),
    ("A", "Withdrawal request shows 'processing' for 3 weeks, worker is out of cash"),
    ("B", "Payout arrived on time but the amount is lower than the app earnings screen (dispute, NOT delay)"),
    ("B", "Incentive/bonus promised for 50 tasks completed but not credited, even though payout itself arrived"),
    ("B", "Penalty deduction applied for a cancellation the worker says was not their fault"),
    ("B", "Per-task rate silently reduced compared to what the onboarding said"),
    ("B", "Double deduction of the same insurance/uniform/kit fee"),
    ("B", "Payment is late AND partially wrong; the dominant complaint is the wrong amount"),
    ("C", "KYC stuck in 'under review' for days while worker cannot start earning (onboarding, not blocked account)"),
    ("C", "Bank account name does not match PAN name, verification fails"),
    ("C", "New worker asks which documents are needed before signing up (polite info query)"),
    ("C", "Aadhaar OTP never arrives during e-KYC"),
    ("C", "Existing worker changing bank account details and the new IFSC is rejected"),
    ("C", "Training module video will not complete so onboarding cannot be finished"),
    ("D", "No tasks showing in the zone for several days despite being online all day"),
    ("D", "Order/task cancelled by the system after the worker already travelled to the location"),
    ("D", "Slot booking: slots are full within seconds, never able to book one"),
    ("D", "Assigned a task 40 km from home, wants reassignment"),
    ("D", "Tasks appear for colleagues but not for this worker; suspects unfair allocation (not blocked)"),
    ("E", "App crashes on opening the camera during a task (technical, not a submission rejection)"),
    ("E", "Login OTP not coming; locked out of the app entirely"),
    ("E", "GPS shows worker at wrong location so check-in fails"),
    ("E", "Photo upload spins forever on a 4G connection and then fails"),
    ("E", "App update broke the earnings screen; shows blank"),
    ("E", "App crashes at the final submit step and the task timer expires (technical dominant)"),
    ("F", "Submission rejected with reason 'blurry photo' but worker says photo is clear (proof dispute)"),
    ("F", "Audit marked incorrect by QC, worker has evidence and wants a re-review"),
    ("F", "Approved submissions suddenly showing as rejected after the payout cycle"),
    ("F", "Quality score dropped because of rejections the worker believes are wrong; account still active"),
    ("F", "Data-annotation tasks rejected in bulk with no reason given"),
    ("G", "Account blocked without any notice or reason; worker cannot work at all"),
    ("G", "Account deactivated after a customer complaint; wants to appeal"),
    ("G", "Rating dropped from 4.8 to 4.1 after one bad day; asks how ratings are computed"),
    ("G", "Account suspended after KYC was already approved (account_status, not onboarding)"),
    ("G", "Temporarily restricted for 'low acceptance rate' and asks when it will be lifted"),
    ("G", "Account blocked AND pending payout is stuck; the block is the dominant issue"),
    ("H", "Polite question about how referral bonus works (info only, no problem)"),
    ("H", "Asks for an experience/work certificate for a bank loan"),
    ("H", "Appreciation message for a helpful support agent"),
    ("H", "Feature request: wants a Tamil/regional language option or dark mode"),
    ("H", "Asks about accident insurance coverage terms for partners"),
    ("H", "Complaint about another worker's behaviour at a hub, no direct personal loss"),
    ("H", "SAFETY: Was assaulted/threatened by a customer or shopkeeper while on a task, needs help now"),
    ("H", "SAFETY: Road accident during delivery, injured, asks about help and insurance"),
    ("H", "SAFETY: Harassment by a supervisor or customer (esp. a woman worker at night); asks for escalation"),
    ("H", "SAFETY: Sent to an unsafe, isolated address late at night for an audit and feels unsafe"),
    ("A", "Sarcastic: 'Great job, my salary is on a holiday for the third week in a row' (payment_delay)"),
    ("D", "Sarcastic: 'Wow thanks for giving me zero orders again, so generous' (task_assignment)"),
    ("E", "Sarcastic: 'Love how the app logs me out every 5 minutes, such a premium experience'"),
    ("G", "Sarcastic: 'Thanks for blocking me, I enjoy sitting at home anyway' (account blocked)"),
    ("F", "Sarcastic: 'Rejected again, I guess my eyes are lying to me' (submission rejected)"),
    ("B", "Multi-issue: three different complaints in one message but money deducted wrongly is the dominant one"),
    ("A", "Multi-issue: app lag, low rating, and payout missing for 2 weeks; payout is the dominant issue"),
    ("E", "Multi-issue: payment screen looks odd, but the real problem is login keeps failing"),
    ("C", "Onboarding confusion: worker thinks account is blocked but actually documents were never verified"),
    ("G", "Account-status confusion: looks like onboarding problem but is a deactivation after past violation"),
    ("H", "Vague message with almost no detail ('need help please')"),
    ("H", "Polite request to update the registered mobile number or address"),
]

# --- Matrix builder -----------------------------------------------------------

def _wchoice(rng, weights):
    keys = list(weights)
    return rng.choices(keys, weights=[weights[k] for k in keys])[0]


def build_matrix(n: int, seed: int = 7, edge_frac: float = 0.25) -> list[dict]:
    """Deterministic list of n spec dicts, balanced over A-H, ~edge_frac edge cases."""
    rng = random.Random(seed)
    cats = list(CATEGORIES)
    specs = []
    n_edge = int(n * edge_frac)
    # Edge cases: cycle through shuffled seeds so every one is used repeatedly.
    pool = []
    while len(pool) < n_edge:
        s = EDGE_SEEDS[:]
        rng.shuffle(s)
        pool.extend(s)
    pool = pool[:n_edge]
    for cat, desc in pool:
        specs.append({"category": cat, "edge": desc})
    # Regular: round-robin across categories to stay balanced overall.
    counts = {c: sum(1 for s in specs if s["category"] == c) for c in cats}
    for _ in range(n - n_edge):
        c = min(cats, key=lambda k: (counts[k], rng.random()))
        counts[c] += 1
        specs.append({"category": c, "edge": None})
    rng.shuffle(specs)
    for i, s in enumerate(specs):
        job = rng.choice(list(JOBS))
        s.update({
            "spec_id": f"s{seed}-{i:05d}",
            "job": job,
            "city": rng.choice(CITIES),
            "tenure": rng.choice(TENURES),
            "tone": _wchoice(rng, TONE_WEIGHTS),
            "sentences": rng.choices([1, 2, 3, 4, 5, 6], weights=[2, 4, 4, 3, 2, 1])[0],
            "typos": _wchoice(rng, TYPO_WEIGHTS),
        })
        if s["category"] == "H" and not s["edge"]:
            s["flavor"] = rng.choice(["feedback or appreciation", "a how-do-I / policy question",
                                      "referral or certificate query", "feature suggestion",
                                      "a complaint about something outside the other categories"])
    return specs


GEN_SYSTEM = """You write realistic, diverse support tickets that gig workers in India send to the support team of a large gig-work platform. You output ONLY valid JSON, no commentary.

Rules:
- English only (no Hindi/Hinglish words). Natural Indian-English phrasing is fine ("kindly do the needful", "since 3 days").
- Each ticket is written by the worker in first person, as typed into an in-app support form. No subject lines, no ticket numbers unless a worker would plausibly include one.
- Follow the requested persona, tone, length (number of sentences) and typo level exactly.
- Make tickets concrete: plausible rupee amounts, dates/days, app screens, order/task counts, area names in the city. Vary openings; never start two tickets the same way; do not copy example wording.
- Do NOT name the category or use the platform's internal category labels in the text.
- The ticket must clearly read as the requested issue type to a careful human reader, unless the scenario says it is deliberately confusing or multi-issue (then the dominant issue should still be identifiable).
"""


def render_item(i: int, s: dict) -> str:
    lines = [
        f"Ticket {i}:",
        f"  - worker: {s['job']} ({JOBS[s['job']]}); city: {s['city']}; tenure: {s['tenure']}",
        f"  - issue type: {CAT_DESC[s['category']]}",
    ]
    if s.get("edge"):
        lines.append(f"  - specific scenario: {s['edge']}")
    elif s.get("flavor"):
        lines.append(f"  - flavor: {s['flavor']}")
    lines += [
        f"  - tone: {TONES[s['tone']]}",
        f"  - length: exactly {s['sentences']} sentence(s)",
        f"  - typos: {TYPOS[s['typos']]}",
    ]
    return "\n".join(lines)


def build_prompt(batch: list[dict]) -> tuple[str, str]:
    items = "\n\n".join(render_item(i + 1, s) for i, s in enumerate(batch))
    user = (f"Write {len(batch)} tickets, one per spec below, in order.\n\n{items}\n\n"
            'Return JSON: {"tickets": [{"n": 1, "text": "..."}, ...]} with exactly '
            f"{len(batch)} entries.")
    return GEN_SYSTEM, user


if __name__ == "__main__":
    m = build_matrix(int(sys.argv[1]) if len(sys.argv) > 1 else 20)
    print(len(EDGE_SEEDS), "edge seeds")
    for s in m[:5]:
        print(json.dumps(s))

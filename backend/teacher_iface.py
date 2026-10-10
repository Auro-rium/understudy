"""Teacher prompt/answer parsing/prices shared by the router and eval."""
import json
import os
import re

from common.teacher import TeacherResult, TeacherUnavailable  # noqa: F401  (re-exported)
from backend.schemas import CATEGORIES, LETTERS, PRIORITIES

TEACHER_SYSTEM = (
    "You triage support tickets for a gig-work platform. Categories:\n"
    + "\n".join(f"{k}: {v}" for k, v in CATEGORIES.items())
    + "\nPriorities: P1 (most urgent) to P4 (least). "
    'Reply ONLY with JSON: {"category": "<letter A-H>", "priority": "<P1-P4>"}'
)


def parse_teacher_answer(text: str):
    """Return (letter, priority) or raise ValueError."""
    try:
        m = re.search(r"\{.*\}", text, re.S)
        d = json.loads(m.group(0)) if m else {}
        letter = str(d.get("category", "")).strip().upper()[:1]
        prio = str(d.get("priority", "")).strip().upper()
        if letter in LETTERS and prio in PRIORITIES:
            return letter, prio
    except Exception:
        pass
    m = re.search(r"\b([A-H])\b\W+(P[1-4])\b", text.upper())
    if m:
        return m.group(1), m.group(2)
    raise ValueError(f"unparseable teacher answer: {text[:100]!r}")


def teacher_prices():
    """USD per 1M tokens from env; unset means 0.0 (nothing invented)."""
    def f(k):
        try:
            return float(os.environ.get(k) or 0)
        except ValueError:
            return 0.0
    return f("TEACHER_PRICE_IN_PER_M"), f("TEACHER_PRICE_OUT_PER_M")

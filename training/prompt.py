"""SINGLE shared prompt for training AND serving (train/serve consistency).

Source of truth is backend.classifiers.CLASSIFIER_SYSTEM (system) + raw ticket text (user),
rendered with apply_chat_template(..., enable_thinking=False). Training uses exactly that.
The assistant answer is exactly 'X Pn' (category letter, space, priority).
"""
from __future__ import annotations

import re
from typing import Optional

try:
    from backend.schemas import CATEGORIES, PRIORITIES
except Exception:  # pragma: no cover
    CATEGORIES = {"A": "payment_delay", "B": "payment_dispute", "C": "onboarding_kyc",
                  "D": "task_assignment", "E": "app_technical", "F": "task_submission",
                  "G": "account_status", "H": "other"}
    PRIORITIES = ["P1", "P2", "P3", "P4"]

try:  # ONE prompt: the serving classifier's CLASSIFIER_SYSTEM is the source of truth
    from backend.classifiers import CLASSIFIER_SYSTEM as SYSTEM_PROMPT
except Exception:  # pragma: no cover - identical copy for environments without backend deps
    SYSTEM_PROMPT = (
        "You are a support-ticket triage model. Categories:\n"
        + "\n".join(f"{k}: {v}" for k, v in CATEGORIES.items())
        + "\nPriorities P1 (most urgent) to P4. Answer with exactly: <letter> <priority>, e.g. 'C P2'."
    )

_ANS = re.compile(r"\b([A-H])\s*[,:\-]?\s*(P[1-4])\b", re.I)


def build_messages(text: str) -> list[dict]:
    return [{"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text}]  # NOT stripped: serving does not strip


def format_answer(category: str, priority: str) -> str:
    return f"{category} {priority}"


def parse_answer(s: str) -> tuple[Optional[str], Optional[str]]:
    """'C P1' -> ('C','P1'); tolerant of case/punctuation; (None, None) if unparseable."""
    m = _ANS.search(s or "")
    if m:
        return m.group(1).upper(), m.group(2).upper()
    m = re.match(r"\s*([A-H])\b", s or "", re.I)
    return (m.group(1).upper(), None) if m else (None, None)

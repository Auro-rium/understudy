"""Pure metric functions (no sklearn needed). Categories are letters A-H."""
from __future__ import annotations

from typing import Optional, Sequence

LETTERS = list("ABCDEFGH")


def accuracy(y_true: Sequence, y_pred: Sequence) -> float:
    if not y_true:
        return 0.0
    return sum(1 for t, p in zip(y_true, y_pred) if t == p) / len(y_true)


def confusion_matrix(y_true, y_pred, labels=LETTERS) -> list[list[int]]:
    """rows = true, cols = predicted, in `labels` order. Unknown predictions are ignored."""
    idx = {l: i for i, l in enumerate(labels)}
    m = [[0] * len(labels) for _ in labels]
    for t, p in zip(y_true, y_pred):
        if t in idx and p in idx:
            m[idx[t]][idx[p]] += 1
    return m


def per_category_f1(y_true, y_pred, labels=LETTERS) -> dict[str, float]:
    out = {}
    for l in labels:
        tp = sum(1 for t, p in zip(y_true, y_pred) if t == l and p == l)
        fp = sum(1 for t, p in zip(y_true, y_pred) if t != l and p == l)
        fn = sum(1 for t, p in zip(y_true, y_pred) if t == l and p != l)
        d = 2 * tp + fp + fn
        out[l] = (2 * tp / d) if d else 0.0
    return out


def macro_f1(y_true, y_pred, labels=LETTERS, only_present: bool = True) -> float:
    """Macro-F1 over labels. With only_present (sklearn-like for labels=present), classes absent
    from both truth and prediction are skipped."""
    f1 = per_category_f1(y_true, y_pred, labels)
    if only_present:
        present = set(y_true) | set(y_pred)
        labels = [l for l in labels if l in present]
    if not labels:
        return 0.0
    return sum(f1[l] for l in labels) / len(labels)


def latency_mean(latencies: Sequence[Optional[float]]) -> Optional[float]:
    xs = [x for x in latencies if x is not None]
    return sum(xs) / len(xs) if xs else None


def summarize(true_cat, pred_cat, true_pri, pred_pri, latencies=()) -> dict:
    return {
        "n": len(true_cat),
        "category_acc": accuracy(true_cat, pred_cat),
        "category_macro_f1": macro_f1(true_cat, pred_cat),
        "priority_acc": accuracy(true_pri, pred_pri),
        "latency_ms": latency_mean(list(latencies)),
        "per_category_f1": per_category_f1(true_cat, pred_cat),
        "confusion": confusion_matrix(true_cat, pred_cat),
    }

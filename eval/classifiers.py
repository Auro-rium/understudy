"""Classifier adapters used by eval/round. Protocol:

    clf.predict(text) -> {"category": 'A'-'H', "priority": 'P1'-'P4', "latency_ms": float,
                          "confidence": float|None}
    clf.close()   # release model memory (optional)

BackendAdapter wraps any backend.classifiers.BaseClassifier (classify() -> ClassifierOutput),
so eval uses the exact serving classifier (same prompt, same A-H softmax confidence).
"""
from __future__ import annotations

import gc
import hashlib
import time
from typing import Optional

LETTERS = list("ABCDEFGH")


class FakeClassifier:
    """Deterministic, no model. `skill` in [0,1]: chance of echoing the gold label when `gold` known
    (looked up by text); otherwise hash-based. Lets the pipeline run without MLX."""

    def __init__(self, skill: float = 0.6, gold: Optional[dict] = None):
        self.skill, self.gold = skill, gold or {}

    def predict(self, text: str) -> dict:
        h = int(hashlib.sha256(text.encode()).hexdigest(), 16)
        g = self.gold.get(text)
        if g and (h % 1000) / 1000 < self.skill:
            cat, pri = g
        else:
            cat, pri = LETTERS[h % 8], f"P{(h >> 8) % 4 + 1}"
        return {"category": cat, "priority": pri, "latency_ms": 1.0,
                "confidence": 0.5 + (h % 500) / 1000}

    def close(self):
        pass


class BackendAdapter:
    def __init__(self, clf):
        self.clf = clf

    def predict(self, text: str) -> dict:
        t0 = time.perf_counter()
        out = self.clf.classify(text)
        return {"category": out.letter, "priority": out.priority, "confidence": out.confidence,
                "latency_ms": (time.perf_counter() - t0) * 1000}

    def close(self):
        self.clf = None
        gc.collect()
        try:
            import mlx.core as mx
            mx.clear_cache()
        except Exception:
            pass


def make_classifier(kind: str, adapter_path: Optional[str] = None, gold: Optional[dict] = None):
    if kind == "fake":
        return FakeClassifier(gold=gold)
    if kind == "mlx":
        from backend.classifiers import MlxInProcessClassifier
        return BackendAdapter(MlxInProcessClassifier(adapter_path=adapter_path))
    raise ValueError(f"unknown classifier kind {kind!r}")

"""Pluggable local classifiers. All return ClassifierOutput(letter, priority, confidence)."""
import math
import os
import re
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Optional

from backend.schemas import CATEGORIES, LETTERS, PRIORITIES

CLASSIFIER_SYSTEM = (
    "You are a support-ticket triage model. Categories:\n"
    + "\n".join(f"{k}: {v}" for k, v in CATEGORIES.items())
    + "\nPriorities P1 (most urgent) to P4. Answer with exactly: <letter> <priority>, e.g. 'C P2'."
)


class ClassifierError(Exception):
    pass


@dataclass
class ClassifierOutput:
    letter: str
    priority: str
    confidence: float  # softmax prob of chosen letter over A-H


def softmax_over_letters(scores: dict) -> dict:
    """scores: letter -> logit/logprob (non-letters ignored)."""
    ls = {k: v for k, v in scores.items() if k in LETTERS}
    if not ls:
        raise ClassifierError("no letter scores")
    m = max(ls.values())
    ex = {k: math.exp(v - m) for k, v in ls.items()}
    z = sum(ex.values())
    return {k: v / z for k, v in ex.items()}


def parse_answer(text: str):
    m = re.search(r"\b([A-H])\b", text.upper())
    p = re.search(r"\bP([1-4])\b", text.upper())
    return (m.group(1) if m else None), (f"P{p.group(1)}" if p else None)


class BaseClassifier:
    name = "base"

    def classify(self, text: str) -> ClassifierOutput:  # pragma: no cover
        raise NotImplementedError

    def with_adapter(self, adapter_path: str) -> "BaseClassifier":
        """Return a NEW classifier with the adapter applied (called outside the swap lock)."""
        raise NotImplementedError


# ---------------------------------------------------------------- fake
_KEYWORDS = [
    ("A", ("late payment", "not paid", "payment delayed", "haven't been paid", "still waiting for payment")),
    ("B", ("dispute", "wrong amount", "underpaid", "deducted")),
    ("C", ("kyc", "verification", "onboard", "id document")),
    ("D", ("assign", "no tasks", "no task")),
    ("E", ("crash", "bug", "app", "error", "login")),
    ("F", ("submission", "submitted", "rejected task", "upload")),
    ("G", ("suspended", "banned", "account")),
]


class FakeClassifier(BaseClassifier):
    """Deterministic. Confidence comes from a hash of the text; each adapter adds `boost`."""
    name = "fake"

    def __init__(self, boost: float = 0.0, fixed: Optional[dict] = None, delay_s: float = 0.0):
        self.boost = boost
        self.fixed = fixed or {}  # text -> (letter, priority, confidence)
        self.delay_s = delay_s
        self.adapters: list = []

    def classify(self, text: str) -> ClassifierOutput:
        if self.delay_s:
            time.sleep(self.delay_s)
        if text in self.fixed:
            return ClassifierOutput(*self.fixed[text])
        low = text.lower()
        letter = "H"
        for k, kws in _KEYWORDS:
            if any(w in low for w in kws):
                letter = k
                break
        h = zlib.crc32(text.encode())
        conf = min(0.99, 0.5 + (h % 45) / 100 + self.boost)
        return ClassifierOutput(letter, PRIORITIES[(h >> 8) % 4], round(conf, 4))

    def with_adapter(self, adapter_path: str) -> "FakeClassifier":
        n = FakeClassifier(self.boost + 0.15, self.fixed, self.delay_s)
        n.adapters = self.adapters + [adapter_path]
        return n


# ---------------------------------------------------------------- mlx in-process
# MLX streams are per-thread: arrays made by a model loaded on one thread fail ("no Stream(gpu) in
# current thread") when used from FastAPI's worker threads. All load+inference runs on ONE thread.
_MLX_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")
_MLX_THREAD_IDS: set = set()


def _on_mlx_thread(fn, *args):
    if threading.get_ident() in _MLX_THREAD_IDS:
        return fn(*args)

    def run():
        _MLX_THREAD_IDS.add(threading.get_ident())
        return fn(*args)
    return _MLX_POOL.submit(run).result()


class MlxInProcessClassifier(BaseClassifier):
    """mlx_lm.load + softmax over A-H first-token logits. mlx is imported lazily."""
    name = "mlx"

    def __init__(self, model_path: Optional[str] = None, adapter_path: Optional[str] = None,
                 _loaded=None):
        self.model_path = model_path or os.environ.get("LOCAL_MODEL", "mlx-community/gemma-4-e4b-it-4bit")
        self.adapter_path = adapter_path
        if _loaded is None:
            def _load():
                from mlx_lm import load  # lazy
                return load(self.model_path, adapter_path=adapter_path)
            _loaded = _on_mlx_thread(_load)
        self.model, self.tokenizer = _loaded[0], _loaded[1]
        self._letter_ids = None

    def _prompt(self, text: str) -> str:
        msgs = [{"role": "system", "content": CLASSIFIER_SYSTEM}, {"role": "user", "content": text}]
        try:
            return self.tokenizer.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False,
                                                      enable_thinking=False)
        except TypeError:
            return self.tokenizer.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False)

    def _ids(self):
        if self._letter_ids is None:
            ids = {}
            for L in LETTERS:
                cand = set()
                for v in (L, " " + L):
                    t = self.tokenizer.encode(v, add_special_tokens=False)
                    if t:
                        cand.add(t[-1])
                ids[L] = sorted(cand)
            self._letter_ids = ids
        return self._letter_ids

    def classify(self, text: str) -> ClassifierOutput:
        return _on_mlx_thread(self._classify, text)

    def _classify(self, text: str) -> ClassifierOutput:
        import mlx.core as mx  # lazy
        from mlx_lm import generate
        prompt = self._prompt(text)
        toks = self.tokenizer.encode(prompt, add_special_tokens=False)
        logits = self.model(mx.array(toks)[None])[:, -1, :][0].astype(mx.float32)
        scores = {L: max(float(logits[i]) for i in ids) for L, ids in self._ids().items()}
        probs = softmax_over_letters(scores)
        letter = max(probs, key=probs.get)
        out = generate(self.model, self.tokenizer, prompt=prompt, max_tokens=20)  # greedy (temp 0)
        _, prio = parse_answer(out)
        # P3 only when the model emitted no parsable priority
        return ClassifierOutput(letter, prio or "P3", probs[letter])

    def unload(self):
        """Free model memory (used while training runs)."""
        self.model = self.tokenizer = None
        self._letter_ids = None
        import gc
        gc.collect()
        try:
            import mlx.core as mx
            mx.clear_cache()
        except Exception:
            pass

    def reload(self):
        if self.model is None:
            from mlx_lm import load
            self.model, self.tokenizer = _on_mlx_thread(
                lambda: load(self.model_path, adapter_path=self.adapter_path))

    def with_adapter(self, adapter_path: str) -> "MlxInProcessClassifier":
        return MlxInProcessClassifier(self.model_path, adapter_path)


# ---------------------------------------------------------------- server (:8080)
class ServerClassifier(BaseClassifier):
    name = "server"

    def __init__(self, base_url: Optional[str] = None, model: Optional[str] = None,
                 client=None, timeout: float = 30.0):
        import httpx
        self.base_url = (base_url or os.environ.get("LOCAL_SERVER_URL", "http://127.0.0.1:8080/v1")).rstrip("/")
        self.model = model or os.environ.get("LOCAL_MODEL", "mlx-community/gemma-4-e4b-it-4bit")
        self.client = client or httpx.Client(timeout=timeout)

    def classify(self, text: str) -> ClassifierOutput:
        body = {"model": self.model, "temperature": 0, "max_tokens": 20, "logprobs": True,
                "top_logprobs": 20, "chat_template_kwargs": {"enable_thinking": False},
                "messages": [{"role": "system", "content": CLASSIFIER_SYSTEM},
                             {"role": "user", "content": text}]}
        r = self.client.post(f"{self.base_url}/chat/completions", json=body)
        r.raise_for_status()
        return self.parse_response(r.json())

    @staticmethod
    def parse_response(d: dict) -> ClassifierOutput:
        ch = d["choices"][0]
        lp = (ch.get("logprobs") or {}).get("content")
        if not lp:
            raise ClassifierError("server returned no logprobs")
        first = next((t for t in lp if t.get("token", "").strip()), lp[0])
        scores = {}
        for cand in list(first.get("top_logprobs", [])) + [first]:
            tok = cand["token"].strip().upper()
            if tok in LETTERS:
                scores[tok] = max(scores.get(tok, -1e9), cand["logprob"])
        probs = softmax_over_letters(scores)
        letter = max(probs, key=probs.get)
        _, prio = parse_answer(ch["message"]["content"])
        return ClassifierOutput(letter, prio or "P3", probs[letter])

    def with_adapter(self, adapter_path: str) -> "ServerClassifier":
        raise ClassifierError("ServerClassifier cannot hot-swap adapters; restart the server with the adapter")


def make_classifier(kind: Optional[str] = None) -> BaseClassifier:
    kind = (kind or os.environ.get("CLASSIFIER", "fake")).lower()
    if kind == "mlx":
        return MlxInProcessClassifier()
    if kind == "server":
        return ServerClassifier()
    if kind == "fake":
        return FakeClassifier()
    raise ValueError(f"unknown CLASSIFIER={kind!r} (mlx|server|fake)")

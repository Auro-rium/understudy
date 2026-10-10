"""Teacher LLM client (Backboard.io, with OpenAI-compatible fallback).

Backboard API (verified from docs.backboard.io):
  POST https://app.backboard.io/api/threads/messages   header X-API-Key
  JSON body: content, system_prompt (per-turn), llm_provider, model_name,
  json_output, stream=false, memory="off". Omitting thread_id auto-creates a
  fresh thread + default assistant. Response has content, status, input_tokens,
  output_tokens, total_tokens, model_name.

TEACHER_MODEL format: "provider/model" (e.g. "anthropic/claude-sonnet-4-20250514");
a bare model name defaults to provider "openai".
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
MISSING_KEY_MSG = ("create /Users/thakuraiyush/Documents/understudy/.env with "
                   "BACKBOARD_API_KEY and TEACHER_MODEL")


class TeacherUnavailable(RuntimeError):
    pass


class TeacherConfigError(RuntimeError):
    pass


class _Retry(Exception):
    pass


@dataclass
class TeacherResult:
    text: str
    tokens_in: int
    tokens_out: int
    latency_s: float
    estimated: bool = False
    cached: bool = False
    cost_usd: float = 0.0


def load_env() -> Optional[Path]:
    """Load the first existing .env from cwd, repo root, main checkout."""
    try:
        from dotenv import load_dotenv
    except ImportError:  # minimal fallback parser
        load_dotenv = None
    for p in (Path.cwd() / ".env", ROOT / ".env",
              Path("/Users/thakuraiyush/Documents/understudy/.env")):
        if p.is_file():
            if load_dotenv:
                load_dotenv(p, override=False)
            else:
                for line in p.read_text().splitlines():
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        os.environ.setdefault(k.strip(), v.strip().strip('"\''))
            return p
    return None


class RateLimiter:
    """Token bucket, thread-safe."""

    def __init__(self, rate: float, burst: Optional[float] = None):
        self.rate = max(rate, 1e-6)
        self.cap = burst if burst is not None else max(1.0, rate)
        self.tokens = self.cap
        self.t = time.monotonic()
        self.lock = threading.Lock()

    def acquire(self):
        while True:
            with self.lock:
                now = time.monotonic()
                self.tokens = min(self.cap, self.tokens + (now - self.t) * self.rate)
                self.t = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                wait = (1 - self.tokens) / self.rate
            time.sleep(wait)


def _est(s: str) -> int:
    return max(1, len(s) // 4)


class Teacher:
    """complete(system, user, json_mode) -> TeacherResult.

    `transport(system, user, json_mode) -> dict(text, tokens_in, tokens_out)`
    may be injected (tests). Raises TeacherUnavailable on connect/timeout errors.
    """

    def __init__(self, model: Optional[str] = None, api_key: Optional[str] = None,
                 rate: Optional[float] = None, cache_dir: Optional[Path] = None,
                 max_retries: int = 5, backoff_base: float = 1.5,
                 timeout: float = 120.0, transport: Optional[Callable] = None,
                 use_cache: bool = True, base_url: Optional[str] = None,
                 env_prefix: str = "TEACHER"):
        load_env()
        self.model = model or os.environ.get(f"{env_prefix}_MODEL", "")
        self.api_key = api_key if api_key is not None else os.environ.get("BACKBOARD_API_KEY", "")
        self.base_url = (base_url or os.environ.get("BACKBOARD_BASE_URL")
                         or "https://app.backboard.io/api").rstrip("/")
        self.price_in = float(os.environ.get(f"{env_prefix}_PRICE_IN_PER_M") or 0)
        self.price_out = float(os.environ.get(f"{env_prefix}_PRICE_OUT_PER_M") or 0)
        self.limiter = RateLimiter(rate if rate is not None
                                   else float(os.environ.get("TEACHER_RATE", 2)))
        self.cache_dir = Path(cache_dir) if cache_dir else ROOT / "data" / ".teacher_cache"
        self.use_cache = use_cache
        self.max_retries, self.backoff_base, self.timeout = max_retries, backoff_base, timeout
        self._transport = transport
        self._client = None

    # --- helpers -------------------------------------------------------
    def require_config(self):
        if self._transport is None and (not self.api_key or not self.model):
            raise TeacherConfigError(MISSING_KEY_MSG)

    def _key(self, system, user):
        return hashlib.sha256(json.dumps([self.model, system, user]).encode()).hexdigest()

    def cost(self, tin, tout):
        return tin * self.price_in / 1e6 + tout * self.price_out / 1e6

    def _split_model(self):
        if "/" in self.model:
            prov, name = self.model.split("/", 1)
            return prov, name
        return "openai", self.model

    def _http(self):
        if self._client is None:
            import httpx
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    # --- transports ----------------------------------------------------
    def _call_real(self, system, user, json_mode) -> dict:
        import httpx
        prov, name = self._split_model()
        body = {"content": user, "system_prompt": system, "llm_provider": prov,
                "model_name": name, "stream": False, "memory": "off",
                "web_search": "off", "json_output": bool(json_mode)}
        try:
            r = self._http().post(f"{self.base_url}/threads/messages", json=body,
                                  headers={"X-API-Key": self.api_key})
        except (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError) as e:
            raise TeacherUnavailable(f"backboard unreachable: {e}") from e
        if r.status_code in (429, 500, 502, 503, 504):
            raise _Retry(f"HTTP {r.status_code}: {r.text[:200]}")
        if r.status_code >= 400:
            raise TeacherConfigError(f"Backboard HTTP {r.status_code}: {r.text[:300]}")
        d = r.json()
        if d.get("status") == "FAILED" or not d.get("content"):
            raise _Retry(f"backboard empty/failed: {str(d)[:200]}")
        return {"text": d["content"], "tokens_in": d.get("input_tokens"),
                "tokens_out": d.get("output_tokens")}

    def _call(self, system, user, json_mode) -> dict:
        return (self._transport or self._call_real)(system, user, json_mode)

    # --- public --------------------------------------------------------
    def complete(self, system: str, user: str, json_mode: bool = False) -> TeacherResult:
        key = self._key(system, user)
        path = self.cache_dir / f"{key}.json"
        if self.use_cache and path.is_file():
            try:
                d = json.loads(path.read_text())
                d["cached"] = True
                return TeacherResult(**d)
            except Exception:
                pass
        self.require_config()
        last = None
        out = None
        t0 = time.monotonic()
        for attempt in range(self.max_retries):
            self.limiter.acquire()
            t0 = time.monotonic()
            try:
                out = self._call(system, user, json_mode)
                break
            except _Retry as e:
                last = e
            except TeacherUnavailable as e:
                last = e
                if attempt >= 2:  # connect errors: only a few tries
                    raise
            time.sleep(self.backoff_base ** attempt + random.random() * 0.3)
        if out is None:
            raise TeacherUnavailable(f"retries exhausted: {last}")
        lat = time.monotonic() - t0
        text = out["text"]
        est = out.get("tokens_in") is None or out.get("tokens_out") is None
        tin = out["tokens_in"] if out.get("tokens_in") is not None else _est(system + user)
        tout = out["tokens_out"] if out.get("tokens_out") is not None else _est(text)
        res = TeacherResult(text, int(tin), int(tout), lat, estimated=est,
                            cost_usd=self.cost(tin, tout))
        if self.use_cache:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            d = asdict(res)
            d.pop("cached", None)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(d))
            tmp.replace(path)
        return res

    def healthy(self) -> bool:
        try:
            self.require_config()
            r = self.complete("Reply with the single word OK.", "ping", False)
            return bool(r.text)
        except Exception:
            return False


class OpenAITeacher(Teacher):
    """OpenAI-compatible /chat/completions fallback (TEACHER_BACKEND=openai)."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.base_url = (os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
        self.api_key = kw.get("api_key") or os.environ.get("OPENAI_API_KEY", "")

    def _call_real(self, system, user, json_mode) -> dict:
        import httpx
        body = {"model": self.model, "messages": [{"role": "system", "content": system},
                                                  {"role": "user", "content": user}]}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        try:
            r = self._http().post(f"{self.base_url}/chat/completions", json=body,
                                  headers={"Authorization": f"Bearer {self.api_key}"})
        except (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError) as e:
            raise TeacherUnavailable(f"openai backend unreachable: {e}") from e
        if r.status_code in (429, 500, 502, 503, 504):
            raise _Retry(f"HTTP {r.status_code}")
        if r.status_code >= 400:
            raise TeacherConfigError(f"HTTP {r.status_code}: {r.text[:300]}")
        d = r.json()
        u = d.get("usage") or {}
        return {"text": d["choices"][0]["message"]["content"],
                "tokens_in": u.get("prompt_tokens"), "tokens_out": u.get("completion_tokens")}


def get_teacher(**kw) -> Teacher:
    load_env()
    if os.environ.get("TEACHER_BACKEND", "backboard").lower() == "openai":
        return OpenAITeacher(**kw)
    return Teacher(**kw)

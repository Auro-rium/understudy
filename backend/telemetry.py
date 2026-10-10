"""Observability: a structured-log ring buffer plus in-process telemetry (HTTP requests, classify stage
timings, teacher calls, SSE events, memory). Read it via GET /api/logs, GET /api/telemetry and the /logs page.

Everything lives in memory and resets on restart. Nothing secret is recorded: no headers, no query strings,
ticket text is truncated. Log lines are also printed to the uvicorn console (LOG_LEVEL, default INFO).
"""
from __future__ import annotations

import collections
import logging
import math
import os
import resource
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warning": logging.WARNING, "error": logging.ERROR}
STAGES = ("classify_total", "model_forward", "model_generate", "teacher", "db_write")
# dashboard polling: kept out of the console and logged at debug so the tail stays readable
QUIET_GETS = ("/api/health", "/api/rounds", "/api/tickets/recent", "/api/metrics/summary",
              "/api/metrics/timeseries", "/api/review_queue", "/api/snapshot", "/api/model/versions",
              "/api/eval/compare")
SELF_PATHS = ("/api/logs", "/api/telemetry", "/logs")  # the log page's own polling: counted, never logged

_console = logging.getLogger("understudy")
if not _console.handlers:
    _h = logging.StreamHandler(sys.stderr)
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%H:%M:%S"))
    _console.addHandler(_h)
    _console.propagate = False
_console.setLevel(LEVELS.get(os.environ.get("LOG_LEVEL", "info").lower(), logging.INFO))

_ACTIVE: Optional["Telemetry"] = None  # the newest app's telemetry receives uvicorn's own log records


class _UvicornHandler(logging.Handler):
    """Copies uvicorn server messages and tracebacks into the active ring buffer."""

    def emit(self, record):
        if _ACTIVE is None:
            return
        try:
            msg = record.getMessage()
            if record.exc_info:
                msg += "\n" + logging.Formatter().formatException(record.exc_info)
            _ACTIVE.record(record.levelname.lower() if record.levelname.lower() in LEVELS else "info",
                           "server", msg[:4000])
        except Exception:  # noqa: BLE001 - logging must never break the server
            pass


_uv = logging.getLogger("uvicorn.error")
if not any(isinstance(h, _UvicornHandler) for h in _uv.handlers):
    _uv.addHandler(_UvicornHandler())


class Window:
    """Rolling latency samples (last n) plus lifetime count/mean."""

    def __init__(self, n: int = 500):
        self.d: collections.deque = collections.deque(maxlen=n)
        self.count, self.total = 0, 0.0

    def add(self, ms: float):
        self.d.append(ms)
        self.count += 1
        self.total += ms

    def stats(self) -> dict:
        s = sorted(self.d)

        def pct(p):
            return round(s[min(len(s) - 1, int(p * len(s)))], 1) if s else None
        return {"count": self.count, "mean_ms": round(self.total / self.count, 1) if self.count else None,
                "p50_ms": pct(0.5), "p95_ms": pct(0.95), "max_ms": round(s[-1], 1) if s else None}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _fmt_fields(fields: dict) -> str:
    return " ".join(f"{k}={v}" for k, v in fields.items() if v is not None and k not in ("text", "logits", "probs"))


class Telemetry:
    def __init__(self, buffer: int = 3000):
        global _ACTIVE
        self.started = time.time()
        self._lock = threading.Lock()
        self._logs: collections.deque = collections.deque(maxlen=buffer)
        self._seq = 0
        self.routes: dict = {}
        self.stages = {s: Window() for s in STAGES}
        self.sources: collections.Counter = collections.Counter()
        self.events: collections.Counter = collections.Counter()
        self.teacher = {"calls": 0, "errors": 0, "unparseable": 0, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0}
        self.teacher_ms = Window()
        self.req_times: collections.deque = collections.deque(maxlen=5000)
        self.cls_times: collections.deque = collections.deque(maxlen=5000)
        self.sse_open = 0
        self.auth_rejected = 0
        self.errors_5xx = 0
        self._rss_cache = (0.0, None)
        _ACTIVE = self

    # ------------------------------------------------------------ logs
    def record(self, level: str, kind: str, msg: str, **fields) -> dict:
        """Append to the ring buffer only (no console echo)."""
        with self._lock:
            self._seq += 1
            rec = {"seq": self._seq, "ts": _now_iso(), "level": level, "kind": kind, "msg": msg,
                   "fields": {k: v for k, v in fields.items() if v is not None}}
            self._logs.append(rec)
        return rec

    def log(self, level: str, kind: str, msg: str, **fields) -> dict:
        rec = self.record(level, kind, msg, **fields)
        extra = _fmt_fields(rec["fields"])
        _console.log(LEVELS.get(level, logging.INFO), "%-8s %s%s", kind, msg, f"  {extra}" if extra else "")
        return rec

    def logs(self, after: int = 0, limit: int = 300, level: str = "debug", kind: Optional[str] = None) -> dict:
        floor = LEVELS.get(level, logging.DEBUG)
        kinds = set(kind.split(",")) if kind else None
        with self._lock:
            recs = [r for r in self._logs if r["seq"] > after and LEVELS[r["level"]] >= floor
                    and (kinds is None or r["kind"] in kinds)]
            last = self._seq
        return {"records": recs[-limit:], "last_seq": last}

    # ------------------------------------------------------------ requests
    def observe_request(self, method: str, path: str, status: int, ms: float, client: str):
        now = time.time()
        key = f"{method} {path}" if status != 404 else f"{method} (not found)"
        with self._lock:
            r = self.routes.setdefault(key, {"window": Window(200), "status": collections.Counter()})
            r["window"].add(ms)
            r["status"][status] += 1
            self.req_times.append(now)
            if status >= 500:
                self.errors_5xx += 1
            if status in (401, 403):
                self.auth_rejected += 1
        if path in SELF_PATHS:
            return
        f = {"status": status, "ms": round(ms, 1), "client": client}
        if status >= 500:
            self.log("error", "http", f"{method} {path}", **f)
        elif status in (401, 403):
            self.log("warning", "auth", f"rejected {method} {path} (missing or wrong demo key)", **f)
        elif status >= 400:
            self.log("warning", "http", f"{method} {path}", **f)
        elif method == "GET" and path in QUIET_GETS:
            self.record("debug", "http", f"{method} {path}", **f)
        else:
            self.log("info", "http", f"{method} {path}", **f)

    # ------------------------------------------------------------ classify / teacher / events
    def observe_classify(self, result: dict, threshold: float, stages: dict, text: str, logits: Optional[dict] = None):
        with self._lock:
            self.sources[result["source"]] += 1
            self.cls_times.append(time.time())
            for k, v in stages.items():
                if v is not None and k in self.stages:
                    self.stages[k].add(v)
        probs = None
        if logits:  # same softmax-over-A-H the router gates on: shows exactly how confidence was formed
            m = max(logits.values())
            ex = {k: math.exp(v - m) for k, v in logits.items()}
            z = sum(ex.values())
            probs = {k: round(v / z, 4) for k, v in ex.items()}
            logits = {k: round(v, 3) for k, v in logits.items()}
        level = "info" if result["source"] == "local" else "warning" if result["source"] == "review" else "info"
        self.log(level, "classify",
                 f"#{result['id']} {result['category']} {result['priority']} -> {result['source']}",
                 model=result["model_version"], conf=round(result["confidence"], 3), thr=round(threshold, 3),
                 cost=round(result["cost_usd"], 6) if result["cost_usd"] else None,
                 total_ms=round(stages.get("classify_total") or 0, 1),
                 forward_ms=_r(stages.get("model_forward")), generate_ms=_r(stages.get("model_generate")),
                 teacher_ms=_r(stages.get("teacher")), logits=logits, probs=probs, text=" ".join(text.split())[:100])

    def observe_teacher(self, outcome: str, ms: float, tokens_in: int = 0, tokens_out: int = 0,
                        cost: float = 0.0, error: Optional[str] = None):
        with self._lock:
            self.teacher["calls"] += 1
            self.teacher_ms.add(ms)
            if outcome == "ok":
                self.teacher["tokens_in"] += tokens_in
                self.teacher["tokens_out"] += tokens_out
                self.teacher["cost_usd"] += cost
            elif outcome == "unparseable":
                self.teacher["unparseable"] += 1
            else:
                self.teacher["errors"] += 1
        if outcome == "ok":
            self.log("info", "teacher", "cloud teacher answered", ms=round(ms, 1), tokens_in=tokens_in,
                     tokens_out=tokens_out, cost=round(cost, 6))
        elif outcome == "unparseable":
            self.log("warning", "teacher", "teacher answer unparseable -> review", ms=round(ms, 1), error=error)
        else:
            self.log("error", "teacher", "teacher unreachable -> review, mode offline", ms=round(ms, 1), error=error)

    def count_event(self, type_: str):
        with self._lock:
            self.events[type_] += 1

    def sse(self, delta: int):
        with self._lock:
            self.sse_open += delta

    # ------------------------------------------------------------ memory
    def memory(self) -> dict:
        out = {}
        t, rss = self._rss_cache
        if time.time() - t > 2:
            try:
                kb = subprocess.run(["ps", "-o", "rss=", "-p", str(os.getpid())], capture_output=True,
                                    text=True, timeout=2).stdout.strip()
                rss = int(kb) * 1024 if kb else None
            except Exception:  # noqa: BLE001
                rss = None
            self._rss_cache = (time.time(), rss)
        out["rss_mb"] = round(rss / 2**20, 1) if rss else None
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        out["peak_rss_mb"] = round(peak / (2**20 if sys.platform == "darwin" else 2**10), 1)
        if "mlx.core" in sys.modules:  # never import MLX just to report on it
            mx = sys.modules["mlx.core"]
            for name in ("active", "peak", "cache"):
                try:
                    out[f"mlx_{name}_mb"] = round(getattr(mx, f"get_{name}_memory")() / 2**20, 1)
                except Exception:  # noqa: BLE001
                    pass
        return out

    # ------------------------------------------------------------ snapshot
    def snapshot(self, ctx) -> dict:
        now = time.time()
        with self._lock:
            routes = sorted(({"route": k, **v["window"].stats(), "status": dict(v["status"])}
                             for k, v in self.routes.items()), key=lambda r: -r["count"])
            req_min = sum(1 for t in self.req_times if now - t <= 60)
            cls_min = sum(1 for t in self.cls_times if now - t <= 60)
            stages = {k: w.stats() for k, w in self.stages.items()}
            sources = dict(self.sources)
            teacher = {**self.teacher, "cost_usd": round(self.teacher["cost_usd"], 6), **self.teacher_ms.stats()}
            events = dict(self.events)
            total_req = sum(sum(v["status"].values()) for v in self.routes.values())
            last_seq = self._seq
            buf = len(self._logs)
        training = any(v == "running" for v in ctx.jobs.values())
        stream = bool(ctx.stream_task and not ctx.stream_task.done())
        return {
            "now": _now_iso(), "started_at": datetime.fromtimestamp(self.started, timezone.utc).isoformat(timespec="seconds"),
            "uptime_s": round(now - self.started, 1), "pid": os.getpid(),
            "model_version": ctx.holder.version, "classifier": type(ctx.holder._clf).__name__,
            "mode": ctx.mode.mode, "mode_forced": ctx.mode.forced, "mode_detected": ctx.mode.detected,
            "threshold": round(ctx.router.threshold(), 4), "teacher_configured": ctx.teacher is not None,
            "stream": {"running": stream, "rate_per_min": ctx.stream_rate if stream else None},
            "training_running": training, "sse_clients": self.sse_open,
            "requests": {"total": total_req, "per_min": req_min, "errors_5xx": self.errors_5xx,
                         "auth_rejected": self.auth_rejected, "routes": routes},
            "classify": {"count": sum(sources.values()), "per_min": cls_min, "by_source": sources, "stages": stages},
            "teacher": teacher, "events": events, "memory": self.memory(),
            "logs": {"buffered": buf, "last_seq": last_seq},
        }


def _r(v):
    return round(v, 1) if v is not None else None


class RequestTelemetry:
    """Pure ASGI middleware (safe with SSE/streaming): status + latency for every HTTP request."""

    def __init__(self, app, tele: Telemetry):
        self.app, self.tele = app, tele

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        t0 = time.perf_counter()
        status = {"code": 500}
        path, method = scope.get("path", ""), scope.get("method", "GET")
        headers = dict(scope.get("headers") or [])
        client = "tunnel" if b"cf-connecting-ip" in headers else "local"
        sse = path == "/api/events"
        if sse:
            self.tele.sse(+1)
            self.tele.log("info", "sse", "client connected", client=client)

        async def _send(msg):
            if msg["type"] == "http.response.start":
                status["code"] = msg["status"]
            await send(msg)
        try:
            await self.app(scope, receive, _send)
        finally:
            ms = (time.perf_counter() - t0) * 1000
            if sse:
                self.tele.sse(-1)
                self.tele.log("info", "sse", "client disconnected", client=client, open_s=round(ms / 1000, 1))
            elif method != "OPTIONS":
                self.tele.observe_request(method, path, status["code"], ms, client)


_PAGE = Path(__file__).with_name("logs_page.html")


def install(app, ctx):
    from fastapi import Query
    from fastapi.responses import HTMLResponse

    tele: Telemetry = ctx.telemetry

    @app.get("/api/telemetry")
    def _telemetry():
        return tele.snapshot(ctx)

    @app.get("/api/logs")
    def _logs(after: int = Query(0, ge=0), limit: int = Query(300, ge=1, le=3000),
              level: str = Query("debug", pattern="^(debug|info|warning|error)$"), kind: Optional[str] = None):
        return tele.logs(after, limit, level, kind)

    @app.get("/logs", response_class=HTMLResponse, include_in_schema=False)
    def _page():
        return HTMLResponse(_PAGE.read_text())

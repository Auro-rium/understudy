"""asyncio pub/sub for SSE. publish() is safe to call from any thread."""
import asyncio
import json
import threading
from typing import Optional

EVENT_TYPES = ("prediction", "train_progress", "round_complete", "mode", "model")


class Broadcaster:
    def __init__(self):
        self._subs: set = set()
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self.on_publish = None  # telemetry hook: fn(event_type)

    def bind_loop(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop

    def subscribe(self, maxsize: int = 1000) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subs.discard(q)

    def _put(self, q, msg):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass  # slow consumer: drop

    def publish(self, type_: str, data: dict):
        if type_ not in EVENT_TYPES:
            raise ValueError(f"bad event type {type_}")
        msg = {"event": type_, "data": json.dumps(data)}
        if self.on_publish:
            self.on_publish(type_)
        with self._lock:
            subs = list(self._subs)
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        for q in subs:
            if running is not None and running is self._loop:
                self._put(q, msg)
            elif self._loop is not None and not self._loop.is_closed():
                self._loop.call_soon_threadsafe(self._put, q, msg)
            else:
                self._put(q, msg)


# Overall progress bands for the 4 stages the frontend draws (collect -> train -> evaluate -> promote).
_BANDS = {"collect": (0.0, 0.05), "train": (0.05, 0.8), "evaluate": (0.8, 0.95), "promote": (0.95, 1.0)}


def _frac(done, total) -> float:
    try:
        return min(1.0, max(0.0, float(done) / float(total))) if total else 0.0
    except (TypeError, ValueError):
        return 0.0


def train_payload(e: dict, job_id: str) -> dict:
    """Round-runner event -> `train_progress` SSE payload {job_id, round, stage, progress 0..1, ...}."""
    t = e.get("type")
    out = {"job_id": job_id, "round": e.get("round", 0)}
    if t == "round_failed":
        return {**out, "stage": "train", "progress": 0.0, "error": e.get("error", "Training round failed")}
    msg = None
    if t == "round_start":
        stage, f, msg = "collect", 0.0, f"{e.get('examples', 0)} training examples"
    elif t == "train_progress":
        stage, f = "train", _frac(e.get("step"), e.get("total_steps"))
        if e.get("kind") == "val":
            msg = f"validation loss {e.get('loss')}"
        elif "loss" in e:
            out["loss"] = e["loss"]
        out["step"], out["total_steps"] = e.get("step"), e.get("total_steps")
    elif t == "eval_progress":
        stage, f, msg = "evaluate", _frac(e.get("done"), e.get("total")), "scoring the test set"
    elif t == "promoting":
        stage, f, msg = "promote", 0.0, "applying the new adapter"
    else:
        stage, f, msg = "train", 0.0, str(t)
    lo, hi = _BANDS[stage]
    out.update(stage=stage, progress=round(lo + (hi - lo) * f, 4))
    if msg:
        out["message"] = msg
    return out

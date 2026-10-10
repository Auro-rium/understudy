"""asyncio pub/sub for SSE. publish() is safe to call from any thread."""
import asyncio
import json
import threading
from typing import Optional

EVENT_TYPES = ("prediction", "train_progress", "round_complete", "mode")


class Broadcaster:
    def __init__(self):
        self._subs: set = set()
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None

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

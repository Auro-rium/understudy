"""FastAPI app. Run: uvicorn backend.app:app --port 8000  (from the repo root)."""
import asyncio
import inspect
import json
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from backend import metrics
from backend.classifiers import BaseClassifier, make_classifier
from backend.db import DB
from backend.events import Broadcaster
from backend.holder import ModelHolder
from backend.router import ModeState, Router
from backend.schemas import (CATEGORIES, TEAMS, ClassifyRequest, ClassifyResult, Health, MetricsSummary,
                             OfflineRequest, ReviewItem, RoundOut, StreamStart, TicketOut, TimePoint,
                             TrainRequest)
from backend import teacher_iface


class AppContext:
    """Passed to the training agent: ctx.db, ctx.holder, ctx.router, ctx.events, ctx.teacher."""

    def __init__(self, db: DB, holder: ModelHolder, teacher, events: Broadcaster):
        self.db, self.holder, self.teacher, self.events = db, holder, teacher, events
        self.mode = ModeState(on_change=lambda m: events.publish("mode", {"mode": m}))
        self.router = Router(db, holder, teacher, self.mode,
                             on_prediction=lambda d: events.publish("prediction", _ticket_out(d)))
        self.stream_task: Optional[asyncio.Task] = None
        self.stream_rate: Optional[float] = None
        self.jobs: dict = {}


def _ticket_out(d: dict) -> dict:
    d = dict(d)
    d.setdefault("category_name", CATEGORIES[d["category"]])
    d.setdefault("team", TEAMS[d["category"]])
    return d


def default_teacher():
    kind = os.environ.get("TEACHER", "real").lower()
    if kind == "fake":
        from backend.fakes import FakeTeacher
        return FakeTeacher()
    if teacher_iface.TEACHER_AVAILABLE and teacher_iface.Teacher is not None:
        try:
            return teacher_iface.Teacher()
        except Exception as e:  # missing API key etc.
            print(f"[backend] teacher unavailable: {e!r}; low-confidence tickets go to review")
    return None


def create_app(db: Optional[DB] = None, classifier: Optional[BaseClassifier] = None, teacher="auto",
               probe_interval_s: Optional[float] = None) -> FastAPI:
    db = db or DB()
    classifier = classifier or make_classifier()
    teacher = default_teacher() if teacher == "auto" else teacher
    events = Broadcaster()
    ctx = AppContext(db, ModelHolder(classifier, "base"), teacher, events)
    interval = probe_interval_s if probe_interval_s is not None else float(os.environ.get("HEALTH_PROBE_S", 10))

    async def probe_loop():
        while True:
            await asyncio.sleep(interval)
            if ctx.mode.detected:  # only probe while we believe the teacher is down
                await asyncio.to_thread(ctx.router.probe_teacher)

    @asynccontextmanager
    async def lifespan(app):
        events.bind_loop(asyncio.get_running_loop())
        task = asyncio.create_task(probe_loop())
        yield
        task.cancel()
        if ctx.stream_task:
            ctx.stream_task.cancel()

    app = FastAPI(title="Understudy", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    app.state.ctx = ctx
    from backend.round_backend import set_current_ctx
    set_current_ctx(ctx)

    # ------------------------------------------------------------ reads
    def health():
        return {"status": "ok", "model_version": ctx.holder.version, "mode": ctx.mode.mode}

    def summary():
        return metrics.summary(db, ctx.holder.version, ctx.mode.mode)

    def recent(limit=50):
        return [_ticket_out(r) for r in metrics.recent_tickets(db, limit)]

    @app.get("/api/health", response_model=Health)
    def _health():
        return health()

    @app.post("/api/classify", response_model=ClassifyResult)
    def classify(req: ClassifyRequest):
        if not req.text.strip():
            raise HTTPException(422, "text must not be empty")
        return ctx.router.classify(req.text)

    @app.get("/api/metrics/summary", response_model=MetricsSummary)
    def _summary():
        return summary()

    @app.get("/api/metrics/timeseries", response_model=list[TimePoint])
    def _timeseries(bucket: str = Query("tickets", pattern="^(tickets|minute)$"), size: int = 10):
        return metrics.timeseries(db, bucket, size)

    @app.get("/api/tickets/recent", response_model=list[TicketOut])
    def _recent(limit: int = Query(50, ge=1, le=1000)):
        return recent(limit)

    @app.get("/api/review_queue", response_model=list[ReviewItem])
    def _review():
        return metrics.review_queue(db)

    @app.get("/api/rounds", response_model=list[RoundOut])
    def _rounds():
        return db.list_rounds()

    @app.get("/api/eval/compare")
    def _compare():
        return metrics.eval_compare()

    @app.get("/api/snapshot")
    def _snapshot():
        return {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "health": health(), "summary": summary(),
                "timeseries": metrics.timeseries(db), "tickets": recent(50),
                "review_queue": metrics.review_queue(db), "rounds": db.list_rounds(),
                "eval_compare": metrics.eval_compare()}

    # ------------------------------------------------------------ training
    @app.post("/api/train/round")
    async def train_round(req: TrainRequest):
        try:
            from training.round import run_round_async  # type: ignore
        except Exception as e:
            raise HTTPException(501, f"training.round.run_round_async is not available yet ({e!r})")
        from backend.round_backend import AppRoundBackend
        job_id = uuid.uuid4().hex[:12]

        def on_event(e: dict):  # called from the training thread
            t = e.get("type")
            if t == "round_complete":
                ctx.jobs[job_id] = "done"
                events.publish("round_complete", {"job_id": job_id, **e})
            else:
                if t == "round_failed":
                    ctx.jobs[job_id] = f"error: {e.get('error')}"
                events.publish("train_progress", {"job_id": job_id, **e})

        ctx.jobs[job_id] = "running"
        try:
            run_round_async(AppRoundBackend(ctx), on_event=on_event, trainer_name=req.backend)
        except RuntimeError as e:  # a round is already running
            raise HTTPException(409, str(e))
        return {"job_id": job_id}

    # ------------------------------------------------------------ stream
    def demo_path():
        return os.environ.get("DEMO_PATH", "data/demo.jsonl")

    async def stream_loop(path: str, rate: float):
        gap = 60.0 / rate
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                    text = d["text"] if isinstance(d, dict) else str(d)
                except Exception:
                    text = line
                await asyncio.to_thread(ctx.router.classify, text)
                await asyncio.sleep(gap)
        ctx.stream_task = None

    @app.post("/api/stream/start")
    async def stream_start(req: StreamStart):
        if req.rate_per_min <= 0:
            raise HTTPException(422, "rate_per_min must be > 0")
        path = demo_path()
        if not os.path.exists(path):
            raise HTTPException(409, f"demo data file not found: {path} (set DEMO_PATH or create it)")
        if ctx.stream_task and not ctx.stream_task.done():
            ctx.stream_task.cancel()
        ctx.stream_rate = req.rate_per_min
        ctx.stream_task = asyncio.create_task(stream_loop(path, req.rate_per_min))
        return {"running": True, "rate_per_min": req.rate_per_min}

    @app.post("/api/stream/stop")
    async def stream_stop():
        was = bool(ctx.stream_task and not ctx.stream_task.done())
        if was:
            ctx.stream_task.cancel()
        ctx.stream_task = None
        return {"running": False, "was_running": was}

    # ------------------------------------------------------------ mode + events
    @app.post("/api/mode/offline")
    def mode_offline(req: OfflineRequest):
        ctx.mode.set_forced(req.offline)
        return {"offline": req.offline, "mode": ctx.mode.mode}

    @app.get("/api/events")
    async def sse():
        q = events.subscribe()

        async def gen():
            try:
                yield {"event": "mode", "data": json.dumps({"mode": ctx.mode.mode})}
                while True:
                    yield await q.get()
            finally:
                events.unsubscribe(q)

        return EventSourceResponse(gen(), ping=15)

    return app


def __getattr__(name):  # lazy module-level `app` so importing never touches the DB
    if name == "app":
        global _app
        try:
            return _app
        except NameError:
            _app = create_app()
            return _app
    raise AttributeError(name)

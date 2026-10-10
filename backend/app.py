"""FastAPI app. Run: uvicorn backend.app:app --port 8000  (from the repo root)."""
import asyncio
import inspect
import json
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from backend import archive, metrics
from backend.classifiers import BaseClassifier, make_classifier
from backend.db import DB
from backend.events import Broadcaster, train_payload
from backend.holder import ModelHolder
from backend.router import ModeState, Router
from backend.schemas import (CATEGORIES, TEAMS, ClassifyRequest, ClassifyResult, Health, MetricsSummary,
                             OfflineRequest, ReviewItem, RoundOut, StreamStart, TicketOut, TimePoint,
                             TrainRequest)
from backend import demo_api, round_backend, telemetry
from backend.demo_api import require_key
from common.teacher import load_env


class AppContext:
    """Passed to the training agent: ctx.db, ctx.holder, ctx.router, ctx.events, ctx.teacher."""

    def __init__(self, db: DB, holder: ModelHolder, teacher, events: Broadcaster):
        self.db, self.holder, self.teacher, self.events = db, holder, teacher, events
        self.telemetry = telemetry.Telemetry()
        events.on_publish = self.telemetry.count_event
        self.mode = ModeState(on_change=self._mode_changed)
        self.router = Router(db, holder, teacher, self.mode,
                             on_prediction=lambda d: events.publish("prediction", _ticket_out(d)))
        self.router.telemetry = self.telemetry
        self.stream_task: Optional[asyncio.Task] = None
        self.stream_rate: Optional[float] = None
        self.jobs: dict = {}

    def _mode_changed(self, m: str):
        self.telemetry.log("warning" if m == "offline" else "info", "mode", f"mode -> {m}",
                           forced=self.mode.forced, detected=self.mode.detected)
        self.events.publish("mode", {"mode": m})


def _ticket_out(d: dict) -> dict:
    d = dict(d)
    d.setdefault("category_name", CATEGORIES[d["category"]])
    d.setdefault("team", TEAMS[d["category"]])
    d.setdefault("created_at", datetime.now(timezone.utc).isoformat(timespec="milliseconds"))  # SSE payloads
    return d


def default_teacher():
    kind = os.environ.get("TEACHER", "real").lower()
    if kind == "fake":
        from backend.fakes import FakeTeacher
        return FakeTeacher()
    try:
        from common.teacher import Teacher
        return Teacher()
    except Exception as e:  # missing API key etc.
        print(f"[backend] teacher unavailable: {e!r}; low-confidence tickets go to review")
        return None


def create_app(db: Optional[DB] = None, classifier: Optional[BaseClassifier] = None, teacher="auto",
               probe_interval_s: Optional[float] = None, load_promoted: bool = True) -> FastAPI:
    load_env()  # DEMO_KEY, DB_PATH, CLASSIFIER, ... from .env (real environment variables win)
    db = db or DB()
    classifier = classifier or make_classifier()
    teacher = default_teacher() if teacher == "auto" else teacher
    events = Broadcaster()
    version = "base"
    if load_promoted:  # a restart keeps the promoted model instead of falling back to base
        classifier, version = round_backend.load_promoted(classifier, db)
    ctx = AppContext(db, ModelHolder(classifier, version), teacher, events)
    interval = probe_interval_s if probe_interval_s is not None else float(os.environ.get("HEALTH_PROBE_S", 10))

    async def probe_loop():
        while True:
            await asyncio.sleep(interval)
            if ctx.mode.detected:  # only probe while we believe the teacher is down
                await asyncio.to_thread(ctx.router.probe_teacher)

    @asynccontextmanager
    async def lifespan(app):
        events.bind_loop(asyncio.get_running_loop())
        ctx.telemetry.log("info", "startup", "backend ready", model=ctx.holder.version,
                          classifier=type(ctx.holder._clf).__name__, teacher=type(teacher).__name__ if teacher else None,
                          db=getattr(db, "path", None), threshold=round(ctx.router.threshold(), 4),
                          auth="on" if demo_api.demo_key() else "OFF")
        task = asyncio.create_task(probe_loop())
        yield
        task.cancel()
        if ctx.stream_task:
            ctx.stream_task.cancel()

    app = FastAPI(title="Understudy", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    app.add_middleware(telemetry.RequestTelemetry, tele=ctx.telemetry)
    app.state.ctx = ctx

    # ------------------------------------------------------------ reads
    def health():
        return {"status": "ok", "model_version": ctx.holder.version, "mode": ctx.mode.mode,
                "streaming": bool(ctx.stream_task and not ctx.stream_task.done())}

    def summary():
        return metrics.summary(db, ctx.holder.version, ctx.mode.mode)

    def recent(limit=50):
        return [_ticket_out(r) for r in metrics.recent_tickets(db, limit)]

    @app.get("/api/health", response_model=Health)
    def _health():
        return health()

    @app.post("/api/classify", response_model=ClassifyResult, dependencies=[Depends(require_key)])
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

    # ------------------------------------------------------------ reset + archive
    def _ticket_rows(snap):
        snap["tickets"] = [_ticket_out(t) for t in snap["tickets"]]
        return snap

    @app.post("/api/demo/reset", dependencies=[Depends(require_key)])
    def demo_reset():
        if any(v == "running" for v in ctx.jobs.values()):
            raise HTTPException(409, "a training round is running; reset after it finishes")
        if ctx.stream_task and not ctx.stream_task.done():
            ctx.stream_task.cancel()
        ctx.stream_task = None
        snap = archive.reset(db)
        ctx.telemetry.log("warning", "reset", "live data archived and reset", snapshot=snap["id"],
                          tickets=snap["tickets"])
        return {"snapshot": snap, "summary": summary()}

    @app.get("/api/snapshots")
    def snapshots():
        return archive.list_snapshots()

    @app.get("/api/snapshots/{sid}")
    def snapshot_detail(sid: str):
        snap = archive.open_snapshot(sid)
        if snap is None:
            raise HTTPException(404, "snapshot not found")
        return _ticket_rows(snap)

    # ------------------------------------------------------------ training
    @app.post("/api/train/round", dependencies=[Depends(require_key)])
    async def train_round(req: TrainRequest):
        try:
            from training.round import run_round_async  # type: ignore
        except Exception as e:
            raise HTTPException(501, f"training.round.run_round_async is not available yet ({e!r})")
        job_id = uuid.uuid4().hex[:12]
        previous = ctx.holder.version

        def on_event(e: dict):  # called from the training thread
            t = e.get("type")
            _log_round_event(e, job_id)
            if t == "round_complete":
                ctx.jobs[job_id] = "done"
                events.publish("round_complete", {"job_id": job_id, **e, "previous_model_version": previous})
            else:
                if t == "round_failed":
                    ctx.jobs[job_id] = f"error: {e.get('error')}"
                events.publish("train_progress", train_payload(e, job_id))

        ctx.jobs[job_id] = "running"
        try:
            run_round_async(round_backend.RoundBackend(ctx), on_event=on_event, trainer_name=req.backend)
        except RuntimeError as e:  # a round is already running
            ctx.jobs.pop(job_id, None)
            raise HTTPException(409, str(e))
        ctx.telemetry.log("info", "train", "training round requested", job_id=job_id, from_model=previous,
                          trainer=req.backend)
        return {"job_id": job_id}

    # ------------------------------------------------------------ stream
    def demo_path():
        return os.environ.get("DEMO_PATH", "data/demo.jsonl")

    async def stream_loop(path: str, rate: float):
        gap = 60.0 / rate
        n = 0
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
                n += 1
                await asyncio.sleep(gap)
        ctx.telemetry.log("info", "stream", "demo stream finished (end of file)", tickets=n)
        ctx.stream_task = None

    @app.post("/api/stream/start", dependencies=[Depends(require_key)])
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
        ctx.telemetry.log("info", "stream", "demo stream started", rate_per_min=req.rate_per_min, file=path)
        return {"running": True, "rate_per_min": req.rate_per_min}

    @app.post("/api/stream/stop", dependencies=[Depends(require_key)])
    async def stream_stop():
        was = bool(ctx.stream_task and not ctx.stream_task.done())
        if was:
            ctx.stream_task.cancel()
        ctx.stream_task = None
        ctx.telemetry.log("info", "stream", "demo stream stopped" if was else "stop requested (no stream running)")
        return {"running": False, "was_running": was}

    # ------------------------------------------------------------ mode + events
    @app.post("/api/mode/offline", dependencies=[Depends(require_key)])
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

    demo_api.install(app, ctx, events)
    telemetry.install(app, ctx)

    job_rounds: dict = {}  # job_id -> round number (round_failed events do not carry it)

    def _log_round_event(e: dict, job_id: str):
        t, tele = e.get("type"), ctx.telemetry
        rnd = job_rounds.setdefault(job_id, e.get("round")) if e.get("round") is not None else job_rounds.get(job_id, "?")
        if t == "round_start":
            tele.log("info", "train", f"round {rnd}: collecting", job_id=job_id, examples=e.get("examples"))
        elif t == "train_progress":
            if e.get("kind") == "val":
                tele.log("info", "train", f"round {rnd}: val step {e.get('step')}/{e.get('total_steps')}",
                         job_id=job_id, loss=e.get("loss"))
            else:
                tele.record("debug", "train", f"round {rnd}: train step {e.get('step')}/{e.get('total_steps')}",
                            job_id=job_id, loss=e.get("loss"))
        elif t == "round_complete":
            tele.log("info", "train", f"round {rnd}: complete", job_id=job_id, promoted=e.get("promoted"),
                     model=e.get("model_version"), f1=(e.get("eval") or {}).get("category_macro_f1"))
        elif t == "round_failed":
            tele.log("error", "train", f"round {rnd}: failed", job_id=job_id, error=str(e.get("error"))[:300])
        else:
            tele.log("info", "train", f"round {rnd}: {t}", job_id=job_id)
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

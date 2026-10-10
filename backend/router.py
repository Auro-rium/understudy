"""Confidence router: local model when confident, teacher otherwise, review queue when offline."""
import json
import os
import threading
import time
from typing import Callable, Optional

import httpx

from backend.db import DB
from backend.holder import ModelHolder
from backend.schemas import TEAMS, CATEGORIES
from backend.teacher_iface import (TEACHER_SYSTEM, TeacherUnavailable, parse_teacher_answer,
                                   teacher_prices)

NETWORK_ERRORS = (TeacherUnavailable, httpx.ConnectError, httpx.TimeoutException,
                  httpx.NetworkError, ConnectionError, TimeoutError)


class ModeState:
    """mode = offline if forced OR detected."""

    def __init__(self, on_change: Optional[Callable[[str], None]] = None):
        self._forced = False
        self._detected = False
        self._lock = threading.Lock()
        self.on_change = on_change

    @property
    def mode(self) -> str:
        return "offline" if (self._forced or self._detected) else "online"

    @property
    def forced(self):
        return self._forced

    @property
    def detected(self):
        return self._detected

    def _set(self, attr: str, value: bool):
        with self._lock:
            before = self.mode
            setattr(self, attr, value)
            after = self.mode
        if before != after and self.on_change:
            self.on_change(after)

    def set_forced(self, v: bool):
        self._set("_forced", bool(v))

    def set_detected(self, v: bool):
        self._set("_detected", bool(v))


def avg_teacher_cost(db: DB):
    """Average teacher cost per call. Returns (usd, source). source is 'ledger_average' when real teacher
    calls exist, else 'configured_estimate' (env TEACHER_COST_ESTIMATE_PER_CALL, default 0.0 = unknown)."""
    r = db.one("SELECT AVG(cost_usd) a, COUNT(*) n FROM cost_ledger WHERE kind='teacher'")
    if r and r["n"]:
        return float(r["a"]), "ledger_average"
    try:
        est = float(os.environ.get("TEACHER_COST_ESTIMATE_PER_CALL") or 0.0)
    except ValueError:
        est = 0.0
    if est > 0:
        return est, "configured_estimate"
    lab = _labeling_run_avg_cost()
    return (lab, "labeling_run_average") if lab else (0.0, "configured_estimate")


_LAB_CACHE: dict = {}


def _labeling_run_avg_cost() -> float:
    """Measured average cost per teacher call from the dataset-labeling run (data/labeled.jsonl keeps each
    call's real token cost). Lets the 'cloud-only' counterfactual exist before any live teacher call.
    LABELED_PATH=none disables it."""
    path = os.environ.get("LABELED_PATH", "data/labeled.jsonl")
    if path not in _LAB_CACHE:
        total, n = 0.0, 0
        try:
            with open(path) as f:
                for line in f:
                    try:
                        c = json.loads(line).get("label_cost_usd")
                    except ValueError:
                        continue
                    if isinstance(c, (int, float)) and c > 0:
                        total, n = total + c, n + 1
        except OSError:
            pass
        _LAB_CACHE[path] = total / n if n else 0.0
    return _LAB_CACHE[path]


class Router:
    def __init__(self, db: DB, holder: ModelHolder, teacher=None, mode: Optional[ModeState] = None,
                 on_prediction: Optional[Callable[[dict], None]] = None):
        self.db, self.holder, self.teacher = db, holder, teacher
        self.mode = mode or ModeState()
        self.on_prediction = on_prediction
        self.telemetry = None  # backend.telemetry.Telemetry, set by the app

    # ---- threshold
    def threshold(self, version: Optional[str] = None) -> float:
        return self.db.get_threshold(version or self.holder.version)

    def calibrate(self, val_rows, target: float = 0.95, version: Optional[str] = None) -> dict:
        """val_rows: iterable of (confidence, correct) pairs or dicts with those keys.
        Picks the LOWEST threshold t such that accuracy over rows with conf >= t is >= target.
        If none qualifies, threshold = 1.0000001 (accept nothing) and coverage = 0."""
        rows = []
        for r in val_rows:
            c, ok = (r["confidence"], r["correct"]) if isinstance(r, dict) else r
            rows.append((float(c), bool(ok)))
        version = version or self.holder.version
        best = None
        n = len(rows)
        for t in sorted({c for c, _ in rows}):
            acc_rows = [ok for c, ok in rows if c >= t]
            acc = sum(acc_rows) / len(acc_rows)
            if acc >= target:
                best = (t, len(acc_rows) / n, acc)
                break
        if best is None:
            best = (1.0000001, 0.0, None)
        thr, cov, acc = best
        self.db.set_threshold(version, thr, cov, acc)
        return {"model_version": version, "threshold": thr, "coverage": cov, "accuracy": acc,
                "target": target, "n": n}

    # ---- classification
    def classify(self, text: str, force_offline: Optional[bool] = None) -> dict:
        t0 = time.perf_counter()
        out, version = self.holder.classify(text)
        thr = self.db.get_threshold(version)
        letter, prio, conf = out.letter, out.priority, out.confidence
        source, cost = "local", 0.0
        teacher_rec = None
        tele = self.telemetry
        stages = dict(out.timings or {})
        offline = self.mode.mode == "offline" if force_offline is None else force_offline

        if conf < thr:
            if offline or self.teacher is None:
                source = "review"
            else:
                tt = time.perf_counter()
                try:
                    res = self.teacher.complete(TEACHER_SYSTEM, text, json_mode=True)
                    tl, tp = parse_teacher_answer(res.text)
                    pin, pout = teacher_prices()
                    cost = res.tokens_in * pin / 1e6 + res.tokens_out * pout / 1e6
                    letter, prio, source = tl, tp, "teacher"
                    teacher_rec = res
                    stages["teacher"] = (time.perf_counter() - tt) * 1000
                    if tele:
                        tele.observe_teacher("ok", stages["teacher"], res.tokens_in, res.tokens_out, cost)
                    if self.mode.detected:
                        self.mode.set_detected(False)
                except NETWORK_ERRORS as e:
                    if tele:
                        tele.observe_teacher("error", (time.perf_counter() - tt) * 1000,
                                             error=f"{type(e).__name__}: {str(e)[:160]}")
                    self.mode.set_detected(True)
                    source = "review"
                except ValueError as e:  # teacher answered but unparseable: do not train on it
                    if tele:
                        tele.observe_teacher("unparseable", (time.perf_counter() - tt) * 1000, error=str(e)[:160])
                    source = "review"

        latency_ms = (time.perf_counter() - t0) * 1000
        td = time.perf_counter()
        tid = self.db.insert_ticket(text=text, category=letter, priority=prio, source=source,
                                    confidence=conf, latency_ms=latency_ms, cost_usd=cost,
                                    model_version=version)
        self.db.insert_prediction(tid, version, out.letter, out.priority, conf)
        if source == "teacher":
            self.db.insert_training_example(ticket_id=tid, text=text, category=letter, priority=prio,
                                            source="teacher", tokens_in=teacher_rec.tokens_in,
                                            tokens_out=teacher_rec.tokens_out)
            self.db.add_ledger(tid, "teacher", teacher_rec.tokens_in, teacher_rec.tokens_out, cost)
        elif source == "review":
            self.db.add_review(tid, text)
        result = {"id": tid, "category": letter, "category_name": CATEGORIES[letter], "priority": prio,
                  "team": TEAMS[letter], "source": source, "confidence": conf,
                  "latency_ms": latency_ms, "cost_usd": cost, "model_version": version}
        if tele:
            stages["db_write"] = (time.perf_counter() - td) * 1000
            stages["classify_total"] = (time.perf_counter() - t0) * 1000
            try:
                tele.observe_classify(result, thr, stages, text, out.logits)
            except Exception:  # noqa: BLE001 - telemetry must never fail a ticket
                pass
        if self.on_prediction:
            try:
                self.on_prediction({**result, "text": text})
            except Exception:
                pass
        return result

    # ---- health probe
    def probe_teacher(self) -> bool:
        """Update detected-offline state from teacher.healthy(). Returns healthy flag."""
        if self.teacher is None:
            return False
        try:
            ok = bool(self.teacher.healthy())
        except Exception:
            ok = False
        self.mode.set_detected(not ok)
        return ok

"""Demo-facing extras: X-Demo-Key auth, hot model switching, OpenAI-compatible /v1 for Open WebUI.

DEMO_KEY (from .env) is required on every mutating endpoint. Unset -> auth is disabled (dev/tests);
a loud warning is printed at startup. GETs on /api/* stay open (the dashboard reads them).
"""
from __future__ import annotations

import gc
import hmac
import json
import os
import threading
import time
import uuid
from typing import Optional

from fastapi import Depends, Header, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

MODEL_PREFIX = "understudy-"


def demo_key() -> str:
    return os.environ.get("DEMO_KEY", "").strip()


def _ok(supplied: Optional[str]) -> bool:
    want = demo_key()
    return not want or (bool(supplied) and hmac.compare_digest(supplied, want))


def require_key(x_demo_key: Optional[str] = Header(None)):
    if not _ok(x_demo_key):
        raise HTTPException(401, "missing or wrong X-Demo-Key")


def require_key_or_bearer(x_demo_key: Optional[str] = Header(None), authorization: Optional[str] = Header(None)):
    """/v1/* accepts the key as X-Demo-Key or as an OpenAI-style `Authorization: Bearer <key>`."""
    bearer = authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else None
    if not demo_key() or (x_demo_key and _ok(x_demo_key)) or (bearer and _ok(bearer)):
        return
    raise HTTPException(401, "missing or wrong demo key")


class ActivateRequest(BaseModel):
    version: str


class ChatRequest(BaseModel):
    model: str = "understudy-base"
    messages: list
    stream: bool = False
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None

    model_config = {"extra": "allow"}


def _flatten(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # OpenAI content parts
        return "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") in (None, "text"))
    return str(content or "")


def install(app, ctx, events):
    import training.db_backend as dbb
    activate_lock = threading.Lock()

    def adapter_dir(version: str):
        return dbb.ADAPTERS / version

    def versions_view() -> dict:
        from backend import metrics
        f1 = {}
        try:
            for m in metrics.eval_compare().get("models", []):
                f1[m["name"]] = m.get("category_macro_f1")
        except Exception:
            pass
        rounds = ctx.db.list_rounds()
        out = [{"version": "base", "available": True, "promoted": False, "category_macro_f1": f1.get("base")}]
        for r in rounds:
            v = r["model_version"]
            out.append({"version": v, "available": (adapter_dir(v) / "adapters.safetensors").exists()
                        or (ctx.holder.version == v), "promoted": bool(r["promoted"]),
                        "category_macro_f1": r["eval"].get("category_macro_f1")})
        return {"active": ctx.holder.version, "versions": out}

    def activate(version: str) -> dict:
        if version != "base" and version not in {r["model_version"] for r in ctx.db.list_rounds()}:
            raise HTTPException(404, f"unknown model version {version!r}")
        if version != "base" and not (adapter_dir(version) / "adapters.safetensors").exists() \
                and not type(ctx.holder._clf).__name__.startswith("Fake"):
            raise HTTPException(404, f"adapter for {version} is not on disk")
        try:
            from training.round import _round_lock
            if _round_lock.locked():
                raise HTTPException(409, "a training round is running; try again after it finishes")
        except ImportError:
            pass
        with activate_lock:
            prev = ctx.holder.version
            if version == prev:
                return {"model_version": version, "previous_model_version": prev, "changed": False}
            t0 = time.time()
            try:  # built outside the holder lock: traffic keeps flowing until the pointer flips
                clf = (ctx.holder._clf.without_adapter() if version == "base"
                       else ctx.holder._clf.with_adapter(str(adapter_dir(version))))
                ctx.holder.swap(version, classifier=clf)
            except HTTPException:
                raise
            except Exception as e:  # noqa: BLE001
                raise HTTPException(500, f"could not load {version}: {e}")
            del clf
            gc.collect()
            try:
                import mlx.core as mx
                mx.clear_cache()
            except Exception:
                pass
            events.publish("model", {"model_version": version, "previous_model_version": prev})
            return {"model_version": version, "previous_model_version": prev, "changed": True,
                    "load_s": round(time.time() - t0, 2)}

    @app.get("/api/model/versions")
    def _versions():
        return versions_view()

    @app.post("/api/model/activate", dependencies=[Depends(require_key)])
    def _activate(req: ActivateRequest):
        return activate(req.version)

    # ------------------------------------------------------------ OpenAI-compatible
    def model_ids():
        return [MODEL_PREFIX + v["version"] for v in versions_view()["versions"] if v["available"]]

    @app.get("/v1/models", dependencies=[Depends(require_key_or_bearer)])
    def _models():
        now = int(time.time())
        return {"object": "list", "data": [{"id": m, "object": "model", "created": now, "owned_by": "understudy"}
                                           for m in model_ids()]}

    def err(status, msg, typ="invalid_request_error"):
        return JSONResponse({"error": {"message": msg, "type": typ}}, status_code=status)

    @app.post("/v1/chat/completions", dependencies=[Depends(require_key_or_bearer)])
    def _chat(req: ChatRequest):
        name = req.model
        if name not in model_ids():
            return err(404, f"model {name!r} not found; available: {model_ids()}")
        version = name[len(MODEL_PREFIX):]
        try:
            if version != ctx.holder.version:  # the version is process-wide: this also changes live triage
                activate(version)
            msgs = [{"role": m.get("role", "user"), "content": _flatten(m.get("content"))} for m in req.messages]
            (text, n_in, n_out), served = ctx.holder.use(
                lambda clf: clf.chat(msgs, req.max_tokens or 512, req.temperature if req.temperature is not None else 0.0))
        except HTTPException as e:
            return err(e.status_code, str(e.detail))
        except Exception as e:  # noqa: BLE001
            return err(500, f"generation failed: {e}", "server_error")
        cid, created, mname = f"chatcmpl-{uuid.uuid4().hex[:20]}", int(time.time()), MODEL_PREFIX + served
        usage = {"prompt_tokens": n_in, "completion_tokens": n_out, "total_tokens": n_in + n_out}
        if not req.stream:
            return {"id": cid, "object": "chat.completion", "created": created, "model": mname,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                                 "finish_reason": "stop"}], "usage": usage}

        def gen():  # generation above is complete; chunk it so UIs can render progressively
            def chunk(delta, finish=None):
                return "data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": created,
                                              "model": mname, "choices": [{"index": 0, "delta": delta,
                                                                           "finish_reason": finish}]}) + "\n\n"
            yield chunk({"role": "assistant", "content": ""})
            for i in range(0, len(text), 24):
                yield chunk({"content": text[i:i + 24]})
            yield chunk({}, "stop")
            yield "data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": created,
                                         "model": mname, "choices": [], "usage": usage}) + "\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")

    if not demo_key():
        print("[backend] WARNING: DEMO_KEY is not set; mutating endpoints are OPEN. Set it in .env before exposing the API.")

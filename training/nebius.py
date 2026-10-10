"""Nebius Token Factory fine-tuning backend (OpenAI-compatible /v1/files + /v1/fine_tuning/jobs).

API shape and caveats: docs/nebius.md. Flow:
  prepare(): split + write chat-format train.jsonl / valid.jsonl (shared prompt from training.prompt)
  train():   upload files -> create job -> poll (backoff, hard timeout) -> metrics -> download the
             last checkpoint into adapters/round_N -> cost from the API's trained_tokens.
A job is CANCELLED on timeout / KeyboardInterrupt / any error while it is still running, so an
orphan job cannot burn credit. Nothing here runs without NEBIUS_API_KEY (NotEnabled).

IMPORTANT: google/gemma-4-E4B-it is full-fine-tune only on Nebius (no LoRA), so there is no
adapter for our local mlx model; adapters/round_N/nebius_job.json records what was produced
(kind = lora_adapter | full_weights | remote_only) and the `ft_model` id for remote serving.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Callable, Optional

from common.teacher import load_env

from .base import NotEnabled, ProgressFn, Trainer, TrainResult
from .mlx_local import split_examples, to_chat_record
from .prompt import build_messages, format_answer

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1"

# name -> (required, default, description). Every env var this module reads.
ENV_VARS: dict = {
    "NEBIUS_API_KEY": (True, None, "Token Factory API key (Authorization: Bearer). Never logged."),
    "NEBIUS_BASE_URL": (False, DEFAULT_BASE_URL, "OpenAI-compatible base URL incl. /v1"),
    "NEBIUS_FT_MODEL": (False, "google/gemma-4-E4B-it",
                        "base model id to fine-tune (must be on the Nebius fine-tuning model list)"),
    "NEBIUS_FT_LORA": (False, "false", "true => LoRA, false => full fine-tune. Gemma 4 is FULL ONLY"),
    "NEBIUS_FT_EPOCHS": (False, "3", "n_epochs (1-20)"),
    "NEBIUS_FT_BATCH_SIZE": (False, "8", "batch_size (1-64)"),
    "NEBIUS_FT_LR": (False, "1e-5", "learning_rate"),
    "NEBIUS_FT_LORA_R": (False, "16", "lora_r (8-128), only when LoRA"),
    "NEBIUS_FT_LORA_ALPHA": (False, "32", "lora_alpha (>=8), only when LoRA"),
    "NEBIUS_FT_LORA_DROPOUT": (False, "0.0", "lora_dropout (0-1), only when LoRA"),
    "NEBIUS_FT_CONTEXT": (False, "8192", "context_length in tokens (min 8192 on Nebius)"),
    "NEBIUS_FT_PACKING": (False, "true", "pack short samples into one sequence"),
    "NEBIUS_FT_SEED": (False, "42", "job seed"),
    "NEBIUS_FT_SUFFIX": (False, "understudy", "suffix of the output model name (<=64 chars)"),
    "NEBIUS_FT_FROM_HF_REPO": (False, None, "OPTIONAL: HF repo to continue training from "
                               "(from_checkpoint.type=hf; schema-only, undocumented). Sends HF_TOKEN to Nebius"),
    "HF_TOKEN": (False, None, "HF token: tokenizer download for NEBIUS_DATA_FORMAT=pretokenized, and "
                 "from_checkpoint only when NEBIUS_FT_FROM_HF_REPO is set"),
    "NEBIUS_DATA_FORMAT": (False, "messages", "messages (server-side chat template; loss masking "
                           "undocumented) | pretokenized (we tokenize; answer-only loss via labels=-100)"),
    "NEBIUS_DOWNLOAD": (False, "1", "1 => download the last checkpoint's files; 0 => keep remote only"),
    "NEBIUS_PRICE_PER_M_TOKENS": (False, None, "USD per 1M trained tokens (not published; copy from your "
                                  "console). Unset => cost_usd 0.0 with a note"),
    "NEBIUS_POLL_S": (False, "15", "initial poll interval seconds (Nebius asks >=15), backs off to 60"),
    "NEBIUS_MAX_WAIT_MIN": (False, "180", "give up and CANCEL the job after this many minutes"),
}

_TERMINAL = {"succeeded", "failed", "cancelled"}
_LOSS_RX = re.compile(r"(?:step\D{0,3}(\d+))?.*?\b(train|valid|val|eval)(?:_|\s)?loss\W{0,3}([0-9]*\.?[0-9]+)", re.I)


def _env(name: str):
    v = os.environ.get(name)
    return v if v not in (None, "") else ENV_VARS[name][1]


def _flag(v) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


class NebiusError(RuntimeError):
    pass


class NebiusTrainer(Trainer):
    name = "nebius"

    def __init__(self, client=None, api_key: Optional[str] = None, base_url: Optional[str] = None,
                 model: Optional[str] = None, work_dir: Optional[str] = None,
                 adapters_dir: Optional[str] = None, tokenizer=None,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
                 **overrides):
        """`client`: httpx.Client or compatible (tests pass one built on MockTransport).
        `overrides`: hyperparameter/env overrides by lower-case suffix, e.g. epochs=1, lora=True,
        max_wait_min=0.1, data_format='pretokenized', price_per_m=2.0, download=False."""
        load_env()
        self.api_key = api_key if api_key is not None else (os.environ.get("NEBIUS_API_KEY") or "")
        if not self.api_key:
            raise NotEnabled("Nebius training needs NEBIUS_API_KEY (set it in .env; "
                             "see docs/nebius.md and `python scripts/nebius_probe.py`)")
        self.base_url = (base_url or _env("NEBIUS_BASE_URL")).rstrip("/")
        self.model = model or _env("NEBIUS_FT_MODEL")

        def o(key, env, cast=str):
            v = overrides.get(key)
            v = v if v is not None else _env(env)
            return None if v is None else cast(v)
        self.lora = bool(overrides["lora"]) if "lora" in overrides else _flag(_env("NEBIUS_FT_LORA"))
        self.epochs = o("epochs", "NEBIUS_FT_EPOCHS", int)
        self.batch_size = o("batch_size", "NEBIUS_FT_BATCH_SIZE", int)
        self.lr = o("lr", "NEBIUS_FT_LR", float)
        self.lora_r = o("lora_r", "NEBIUS_FT_LORA_R", int)
        self.lora_alpha = o("lora_alpha", "NEBIUS_FT_LORA_ALPHA", int)
        self.lora_dropout = o("lora_dropout", "NEBIUS_FT_LORA_DROPOUT", float)
        self.context = o("context", "NEBIUS_FT_CONTEXT", int)
        self.packing = (_flag(overrides["packing"]) if "packing" in overrides
                        else _flag(_env("NEBIUS_FT_PACKING")))
        self.seed = o("seed", "NEBIUS_FT_SEED", int)
        self.suffix = (o("suffix", "NEBIUS_FT_SUFFIX") or "")[:64]
        self.from_hf = o("from_hf_repo", "NEBIUS_FT_FROM_HF_REPO")
        self.data_format = o("data_format", "NEBIUS_DATA_FORMAT")
        self.download = (_flag(overrides["download"]) if "download" in overrides
                         else _flag(_env("NEBIUS_DOWNLOAD")))
        self.price_per_m = o("price_per_m", "NEBIUS_PRICE_PER_M_TOKENS", float)
        self.poll_s = o("poll_s", "NEBIUS_POLL_S", float)
        self.max_wait_s = o("max_wait_min", "NEBIUS_MAX_WAIT_MIN", float) * 60
        if self.data_format not in ("messages", "pretokenized"):
            raise ValueError(f"NEBIUS_DATA_FORMAT must be messages|pretokenized, got {self.data_format!r}")
        self.work_dir = Path(work_dir) if work_dir else Path(tempfile.mkdtemp(prefix="understudy_nebius_"))
        self.adapters_dir = Path(adapters_dir) if adapters_dir else ROOT / "adapters"
        self._tok = tokenizer
        self._sleep, self._clock = sleep, clock
        if client is None:
            import httpx
            client = httpx.Client(timeout=120.0)
        self.client = client
        self.n_train = 0

    # --- http ----------------------------------------------------------
    def _req(self, method: str, path: str, retry: bool = True, **kw):
        import httpx
        url = self.base_url + path
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"}
        last = None
        for attempt in range(4 if retry else 1):
            try:
                r = self.client.request(method, url, headers=headers, **kw)
            except (httpx.TransportError, httpx.TimeoutException) as e:
                last = f"{type(e).__name__}"
            else:
                if r.status_code in (429, 500, 502, 503, 504) and retry:
                    last = f"HTTP {r.status_code}"
                elif r.status_code >= 400:
                    raise NebiusError(f"{method} {path} -> HTTP {r.status_code}: {r.text[:300]}")
                else:
                    return r
            self._sleep(min(30.0, 2.0 ** attempt))
        raise NebiusError(f"{method} {path} failed: {last}")

    # --- data ----------------------------------------------------------
    def _tokenizer(self):
        if self._tok is None:
            from transformers import AutoTokenizer
            self._tok = AutoTokenizer.from_pretrained(self.model, token=_env("HF_TOKEN"))
        return self._tok

    def to_record(self, ex: dict) -> dict:
        if self.data_format == "messages":
            return to_chat_record(ex)
        tok = self._tokenizer()
        msgs = build_messages(ex["text"])
        answer = [{"role": "assistant", "content": format_answer(ex["category"], ex["priority"])}]

        def ids(m, gen):  # thinking off, same as serving (Qwen3/Gemma 4 templates add a think block otherwise)
            try:
                out = tok.apply_chat_template(m, add_generation_prompt=gen, tokenize=True, enable_thinking=False)
            except TypeError:
                out = tok.apply_chat_template(m, add_generation_prompt=gen, tokenize=True)
            return list(out["input_ids"] if hasattr(out, "keys") else out)  # BatchEncoding in transformers 5
        prompt, full = ids(msgs, True), ids(msgs + answer, False)
        if full[:len(prompt)] != prompt:
            raise NebiusError("chat template is not prefix-stable; cannot build answer-only labels")
        return {"input_ids": full, "labels": [-100] * len(prompt) + full[len(prompt):],
                "attention_mask": [1] * len(full)}

    def prepare(self, examples: list[dict]) -> str:
        train, val = split_examples(examples)
        d = self.work_dir / "data"
        d.mkdir(parents=True, exist_ok=True)
        for name, rows in (("train.jsonl", train), ("valid.jsonl", val)):
            if not rows:
                continue
            with open(d / name, "w") as f:
                for ex in rows:
                    f.write(json.dumps(self.to_record(ex), ensure_ascii=False) + "\n")
        self.n_train = len(train)
        return str(d)

    # --- job -----------------------------------------------------------
    def _upload(self, path: Path) -> str:
        with open(path, "rb") as f:
            r = self._req("POST", "/files", files={"file": (path.name, f.read(), "application/jsonl")},
                          data={"purpose": "fine-tune"})
        return r.json()["id"]

    def job_request(self, training_file: str, validation_file: Optional[str]) -> dict:
        hp = {"n_epochs": self.epochs, "batch_size": self.batch_size, "learning_rate": self.lr,
              "context_length": self.context, "packing": self.packing, "lora": self.lora}
        if self.lora:
            hp.update(lora_r=self.lora_r, lora_alpha=self.lora_alpha, lora_dropout=self.lora_dropout)
        body = {"model": self.model, "training_file": training_file, "hyperparameters": hp,
                "seed": self.seed, "suffix": self.suffix}
        if validation_file:
            body["validation_file"] = validation_file
        if self.from_hf:
            body["from_checkpoint"] = {"type": "hf", "repo": self.from_hf, "token": _env("HF_TOKEN")}
        return body

    def cancel(self, job_id: str) -> None:
        try:
            self._req("POST", f"/fine_tuning/jobs/{job_id}/cancel", retry=False)
        except Exception:  # best effort; never mask the original error
            pass

    @staticmethod
    def parse_metrics(ev: dict) -> list:
        """A job event -> [(kind 'train'|'val', step|None, loss)]. Shape of metrics events is not
        documented, so accept data={train_loss,valid_loss,step} or 'step 10 train_loss 1.2' text."""
        out, data = [], ev.get("data")
        if isinstance(data, dict):
            step = data.get("step", data.get("step_number"))
            for key, kind in (("train_loss", "train"), ("loss", "train"), ("valid_loss", "val"),
                              ("eval_loss", "val"), ("full_valid_loss", "val")):
                if isinstance(data.get(key), (int, float)):
                    out.append((kind, step, float(data[key])))
            if out:
                return out
        m = _LOSS_RX.search(ev.get("message") or "") if ev.get("type") in (None, "metrics") else None
        if m:
            out.append(("train" if m.group(2).lower() == "train" else "val",
                        int(m.group(1)) if m.group(1) else None, float(m.group(3))))
        return out

    def _poll_events(self, job_id: str, seen: set) -> list:
        evs, after = [], None
        for _ in range(5):
            r = self._req("GET", f"/fine_tuning/jobs/{job_id}/events",
                          params={"limit": 100, **({"after": after} if after else {})}).json()
            page = r.get("data") or []
            evs += [e for e in page if e.get("id") not in seen]
            if not (r.get("has_more") and page):
                break
            after = page[-1].get("id")
        seen.update(e.get("id") for e in evs)
        return sorted(evs, key=lambda e: e.get("created_at", 0))

    def _poll_checkpoints(self, job_id: str, ckpts: dict, rnd: int, total, on_progress,
                          train_curve: list, val_curve: list) -> None:
        """Checkpoints (one per epoch) carry the real loss metrics; job events are lifecycle only."""
        for c in self._req("GET", f"/fine_tuning/jobs/{job_id}/checkpoints").json().get("data") or []:
            if c.get("id") in ckpts:
                continue
            ckpts[c["id"]] = c
            m, step = c.get("metrics") or {}, c.get("step_number")
            for key, kind, curve in (("train_loss", "train", train_curve), ("valid_loss", "val", val_curve)):
                if isinstance(m.get(key), (int, float)):
                    curve.append((step, float(m[key])))
                    if on_progress:
                        on_progress({"type": "train_progress", "round": rnd, "kind": kind, "step": step,
                                     "total_steps": total, "loss": float(m[key])})

    def _wait(self, job_id: str, rnd: int, on_progress, train_curve: list, val_curve: list,
              ckpts: dict) -> dict:
        t0, wait, seen, last = self._clock(), self.poll_s, set(), ""
        while True:
            job = self._req("GET", f"/fine_tuning/jobs/{job_id}").json()
            status, total = job.get("status", ""), job.get("total_steps")
            if on_progress and status != last:
                on_progress({"type": "train_status", "round": rnd, "status": status,
                             "trained_steps": job.get("trained_steps"), "total_steps": total})
            last = status
            for ev in self._poll_events(job_id, seen):  # bonus: metrics events if Nebius ever emits them
                for kind, step, loss in self.parse_metrics(ev):
                    (train_curve if kind == "train" else val_curve).append((step, loss))
                    if on_progress:
                        on_progress({"type": "train_progress", "round": rnd, "kind": kind, "step": step,
                                     "total_steps": total, "loss": loss})
            self._poll_checkpoints(job_id, ckpts, rnd, total, on_progress, train_curve, val_curve)
            if status in _TERMINAL:
                return job
            if self._clock() - t0 > self.max_wait_s:
                raise TimeoutError(f"Nebius job {job_id} still '{status}' after "
                                   f"{self.max_wait_s / 60:.0f} min (NEBIUS_MAX_WAIT_MIN); cancelled")
            self._sleep(wait)
            wait = min(60.0, wait * 1.5)

    def _download(self, file_ids: list, out: Path) -> list:
        saved = []
        out.mkdir(parents=True, exist_ok=True)
        for fid in file_ids:
            name = os.path.basename(self._req("GET", f"/files/{fid}").json().get("filename") or fid)
            if name in ("", ".", ".."):
                name = fid
            with self.client.stream("GET", f"{self.base_url}/files/{fid}/content",
                                    headers={"Authorization": f"Bearer {self.api_key}"}) as r:
                if r.status_code >= 400:
                    raise NebiusError(f"download {fid} -> HTTP {r.status_code}")
                with open(out / name, "wb") as f:
                    for chunk in r.iter_bytes():
                        f.write(chunk)
            saved.append(name)
        return saved

    def train(self, round: int, data_dir: str, on_progress: Optional[ProgressFn] = None) -> TrainResult:
        d = Path(data_dir)
        out = self.adapters_dir / f"round_{round}"
        out.mkdir(parents=True, exist_ok=True)
        t0 = time.monotonic()
        train_curve, val_curve, notes, job_id, job, ckpts = [], [], [], None, {}, {}
        tf = self._upload(d / "train.jsonl")
        vp = d / "valid.jsonl"
        vf = self._upload(vp) if vp.is_file() else None
        try:
            job = self._req("POST", "/fine_tuning/jobs", retry=False,   # never auto-retry a billable create
                            json=self.job_request(tf, vf)).json()
            job_id = job["id"]
            job = self._wait(job_id, round, on_progress, train_curve, val_curve, ckpts)
        except BaseException:  # KeyboardInterrupt, timeout, API error: do not leave a billing orphan
            if job_id:
                self.cancel(job_id)
            raise
        if job.get("status") != "succeeded":
            err = job.get("error") or {}
            raise NebiusError(f"Nebius job {job_id} {job.get('status')}: {err.get('message') or err}")

        ordered = sorted(ckpts.values(), key=lambda c: c.get("step_number") or 0)
        last = ordered[-1] if ordered else {}
        files = last.get("result_files") or job.get("result_files") or []
        saved = self._download(files, out) if (self.download and files) else []
        kind = ("lora_adapter" if self.lora and "adapter_model.safetensors" in saved
                else "full_weights" if saved else "remote_only")
        tokens = job.get("trained_tokens")
        cost = 0.0
        if tokens and self.price_per_m:
            cost = tokens * self.price_per_m / 1e6
        else:
            notes.append("cost_usd=0.0: "
                         + ("API returned no trained_tokens" if not tokens else "NEBIUS_PRICE_PER_M_TOKENS unset"))
        meta = {"mode": kind, "job_id": job_id, "base_model": self.model, "lora": self.lora,
                "ft_model": last.get("fine_tuned_model_checkpoint"), "checkpoint_id": last.get("id"),
                "trained_tokens": tokens, "cost_usd": cost, "files": saved, "notes": notes,
                "loadable_by_local_mlx": False}  # a Gemma 4 FULL checkpoint needs mlx_lm convert; see docs
        (out / "nebius_job.json").write_text(json.dumps(meta, indent=2))
        return TrainResult(adapter_path=str(out), loss_curve=train_curve, val_curve=val_curve,
                           wall_time_s=time.monotonic() - t0, cost_usd=cost,
                           hardware="Nebius Token Factory (GPU type not reported by API)")

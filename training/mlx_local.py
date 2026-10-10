"""Local Apple-silicon LoRA via `python -m mlx_lm.lora` (subprocess)."""
from __future__ import annotations

import json
import os
import platform
import random
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

from .base import ProgressFn, Trainer, TrainResult
from .prompt import build_messages, format_answer

ROOT = Path(__file__).resolve().parent.parent
BASE_MODEL = "mlx-community/gemma-4-e4b-it-4bit"

# mlx_lm 0.32 (rich UI, plain text when piped):
#   "    10    2.345 ▼    1,234     1.2k"   (train)   "    50    val 2.101    0.52s"  (val)
# older mlx_lm: "Iter 10: Train loss 2.345, ..." / "Iter 50: Val loss 2.101, Val took 0.5s"
_TRAIN_OLD = re.compile(r"Iter\s+(\d+):\s+Train loss\s+([0-9.]+)")
_VAL_OLD = re.compile(r"Iter\s+(\d+):\s+Val loss\s+([0-9.]+)")
_VAL_NEW = re.compile(r"^\s*(\d+)\s+val\s+([0-9.]+)")
_TRAIN_NEW = re.compile(r"^\s*(\d+)\s+([0-9]+\.[0-9]+)\s*[▼▲]")


def parse_loss_line(line: str) -> Optional[dict]:
    """-> {'kind': 'train'|'val', 'step': int, 'loss': float} or None."""
    for rx, kind in ((_TRAIN_OLD, "train"), (_VAL_OLD, "val"), (_VAL_NEW, "val"), (_TRAIN_NEW, "train")):
        m = rx.search(line)
        if m:
            return {"kind": kind, "step": int(m.group(1)), "loss": float(m.group(2))}
    return None


def hardware_string() -> str:
    chip = ""
    try:
        chip = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True,
                              text=True, timeout=5).stdout.strip()
        mem = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True,
                             timeout=5).stdout.strip()
        if mem.isdigit():
            chip += f" {int(mem) // 2**30}GB"
    except Exception:
        pass
    return f"{platform.system()} {platform.machine()} {chip}".strip()


def split_examples(examples: list[dict], val_frac: float = 0.1, seed: int = 0):
    ex = list(examples)
    random.Random(seed).shuffle(ex)
    n_val = max(1, round(len(ex) * val_frac)) if len(ex) >= 2 else 0
    return ex[n_val:], ex[:n_val]


def to_chat_record(ex: dict) -> dict:
    msgs = build_messages(ex["text"]) + [
        {"role": "assistant", "content": format_answer(ex["category"], ex["priority"])}]
    return {"messages": msgs}


class MlxLocalTrainer(Trainer):
    name = "mlx_local"

    def __init__(self, model: str = BASE_MODEL, iters: Optional[int] = None, epochs: float = 3,
                 max_iters: int = 1500, num_layers: int = 8, learning_rate: float = 1e-4,
                 max_seq_length: int = 512, python: Optional[str] = None,
                 work_dir: Optional[str] = None, adapters_dir: Optional[str] = None,
                 cmd_override: Optional[list] = None):
        self.model, self.iters, self.epochs, self.max_iters = model, iters, epochs, max_iters
        self.num_layers, self.lr, self.max_seq = num_layers, learning_rate, max_seq_length
        self.python = python or os.environ.get("MLX_PYTHON") or sys.executable
        self.work_dir = Path(work_dir) if work_dir else Path(tempfile.mkdtemp(prefix="understudy_train_"))
        self.adapters_dir = Path(adapters_dir) if adapters_dir else ROOT / "adapters"
        self.cmd_override = cmd_override  # tests: replace the mlx_lm command
        self.n_train = 0

    def prepare(self, examples: list[dict]) -> str:
        train, val = split_examples(examples)
        d = self.work_dir / "data"
        d.mkdir(parents=True, exist_ok=True)
        for name, rows in (("train.jsonl", train), ("valid.jsonl", val or train[:1])):
            with open(d / name, "w") as f:
                for ex in rows:
                    f.write(json.dumps(to_chat_record(ex), ensure_ascii=False) + "\n")
        self.n_train = len(train)
        return str(d)

    def _iters(self) -> int:
        if self.iters:
            return self.iters
        return max(10, min(self.max_iters, int(self.n_train * self.epochs)))

    def command(self, data_dir: str, adapter_path: str) -> list:
        if self.cmd_override:
            return list(self.cmd_override)
        return [self.python, "-m", "mlx_lm.lora", "--train", "--model", self.model,
                "--data", data_dir, "--adapter-path", adapter_path,
                "--iters", str(self._iters()), "--batch-size", "1",
                "--num-layers", str(self.num_layers), "--max-seq-length", str(self.max_seq),
                "--learning-rate", str(self.lr), "--steps-per-report", "10",
                "--steps-per-eval", "50", "--save-every", "100", "--grad-checkpoint"]

    def train(self, round: int, data_dir: str, on_progress: Optional[ProgressFn] = None) -> TrainResult:
        adapter = self.adapters_dir / f"round_{round}"
        adapter.mkdir(parents=True, exist_ok=True)
        total = self._iters()
        t0 = time.monotonic()
        train_curve, val_curve, tail = [], [], []
        proc = subprocess.Popen(self.command(data_dir, str(adapter)), stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in proc.stdout:
            tail = (tail + [line.rstrip()])[-30:]
            ev = parse_loss_line(line)
            if not ev:
                continue
            (train_curve if ev["kind"] == "train" else val_curve).append((ev["step"], ev["loss"]))
            if on_progress:
                on_progress({"type": "train_progress", "round": round, "kind": ev["kind"],
                             "step": ev["step"], "total_steps": total, "loss": ev["loss"]})
        rc = proc.wait()
        if rc != 0:
            raise RuntimeError(f"mlx_lm.lora exited {rc}:\n" + "\n".join(tail))
        return TrainResult(adapter_path=str(adapter), loss_curve=train_curve,
                           val_curve=val_curve, wall_time_s=time.monotonic() - t0,
                           hardware=hardware_string(), cost_usd=0.0)  # electricity ignored

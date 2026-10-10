"""AWS QLoRA backend SKELETON (SageMaker training job / EC2 GPU). Disabled until GPU quota lands.

Enable with AWS_TRAIN_ENABLED=1. Flow when implemented:
  1. prepare(): write train.jsonl (chat format, same as mlx_local) and upload to S3.
  2. train(): launch a SageMaker training job running PEFT_TRAIN_SCRIPT (QLoRA on
     google/gemma-4-E4B-it, target only language_model q/o/gate/up/down [+k/v where present]).
  3. download adapter_model.safetensors + adapter_config.json, convert with
     scripts/spike_peft_to_mlx.py PEFT_DIR OUT_DIR  -> mlx_lm adapter dir (see convert_to_mlx).
  4. cost_usd = billed seconds * instance $/hr / 3600 (instance price from env AWS_TRAIN_USD_PER_HR).
Caveat (docs/spike.md): adapter trained on bf16/NF4 base then applied to the 4-bit MLX base must be
re-evaluated; the promotion gate in training/round.py does exactly that.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from .base import NotEnabled, ProgressFn, Trainer, TrainResult

ROOT = Path(__file__).resolve().parent.parent

PEFT_TRAIN_SCRIPT = r'''
# train_peft.py  (runs inside the SageMaker/EC2 container)
import json, sys, torch
from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer

MODEL = "google/gemma-4-E4B-it"
bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                         bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, quantization_config=bnb, device_map="auto")
model = prepare_model_for_kbit_training(model)
cfg = LoraConfig(r=8, lora_alpha=16, lora_dropout=0.0, task_type="CAUSAL_LM",
                 # restrict to the text tower; layers 38-41 have no k/v (KV-shared)
                 target_modules=r".*language_model.*layers\.\d+\.(self_attn\.(q|k|v|o)_proj|mlp\.(gate|up|down)_proj)")
model = get_peft_model(model, cfg)
ds = load_dataset("json", data_files={"train": "/opt/ml/input/data/train/train.jsonl",
                                      "validation": "/opt/ml/input/data/train/valid.jsonl"})
args = SFTConfig(output_dir="/opt/ml/model", num_train_epochs=3, per_device_train_batch_size=4,
                 gradient_accumulation_steps=2, learning_rate=2e-4, logging_steps=10,
                 eval_strategy="steps", eval_steps=50, bf16=True, max_length=512,
                 assistant_only_loss=True, report_to=[])
tr = SFTTrainer(model=model, args=args, train_dataset=ds["train"], eval_dataset=ds["validation"],
                processing_class=tok)
tr.train()
tr.save_model("/opt/ml/model")  # adapter_model.safetensors + adapter_config.json
json.dump(tr.state.log_history, open("/opt/ml/model/log_history.json", "w"))
'''


def convert_to_mlx(peft_dir: str, out_dir: str) -> None:
    """PEFT adapter -> mlx_lm adapter via scripts/spike_peft_to_mlx.py."""
    subprocess.run([sys.executable, str(ROOT / "scripts" / "spike_peft_to_mlx.py"),
                    peft_dir, out_dir], check=True)


class AwsTrainer(Trainer):
    name = "aws"

    def __init__(self):
        if os.environ.get("AWS_TRAIN_ENABLED") != "1":
            raise NotEnabled("AWS training is not enabled (GPU quota pending); set AWS_TRAIN_ENABLED=1")

    def prepare(self, examples: list[dict]) -> str:
        raise NotEnabled("AWS prepare/upload to S3 not implemented yet")

    def train(self, round: int, data_dir: str, on_progress: ProgressFn | None = None) -> TrainResult:
        raise NotEnabled("AWS SageMaker job launch not implemented yet")

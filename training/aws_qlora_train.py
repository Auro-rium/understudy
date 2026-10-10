"""QLoRA fine-tune of google/gemma-4-E4B-it on a CUDA GPU (runs ON the EC2 instance, not on the Mac).

Same task/prompt/answer format and answer-only loss as the local MLX runs, so scores are comparable.
STATUS: written but NOT yet run on a GPU (AWS access is blocked by an org SCP); expect to fix small
version issues (Gemma 4 model class, PEFT target names) on the first real run.

  python aws_qlora_train.py --train train.jsonl --val val.jsonl --out out/ [--epochs 3]
Needs: torch, transformers, peft, bitsandbytes, accelerate; env HF_TOKEN (gated model).
Outputs: out/adapter/ (PEFT adapter), out/loss_curve.json, out/train_meta.json.
"""
import argparse
import json
import time

import torch
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, Trainer,
                          TrainerCallback, TrainingArguments)

BASE = "google/gemma-4-E4B-it"
CATS = {"A": "payment_delay", "B": "payment_dispute", "C": "onboarding_kyc", "D": "task_assignment",
        "E": "app_technical", "F": "task_submission", "G": "account_status", "H": "other"}
# MUST equal backend/classifiers.py::CLASSIFIER_SYSTEM (train/serve consistency)
SYSTEM = ("You are a support-ticket triage model. Categories:\n"
          + "\n".join(f"{k}: {v}" for k, v in CATS.items())
          + "\nPriorities P1 (most urgent) to P4. Answer with exactly: <letter> <priority>, e.g. 'C P2'.")


def render(tok, msgs, generation_prompt):
    try:
        return tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=generation_prompt,
                                       enable_thinking=False)
    except TypeError:
        return tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=generation_prompt)


def encode(tok, row, max_len):
    prompt_msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": row["text"]}]
    answer = f"{row['category']} {row['priority']}"
    prompt = render(tok, prompt_msgs, True)
    full = render(tok, prompt_msgs + [{"role": "assistant", "content": answer}], False)
    p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
    f_ids = tok(full, add_special_tokens=False)["input_ids"][:max_len]
    labels = [-100] * min(len(p_ids), len(f_ids)) + f_ids[len(p_ids):]  # loss on the answer only
    return {"input_ids": f_ids, "labels": labels}


class Collate:
    def __init__(self, pad):
        self.pad = pad

    def __call__(self, batch):
        n = max(len(b["input_ids"]) for b in batch)
        ids = torch.full((len(batch), n), self.pad)
        lab = torch.full((len(batch), n), -100)
        att = torch.zeros((len(batch), n), dtype=torch.long)
        for i, b in enumerate(batch):
            k = len(b["input_ids"])
            ids[i, :k], lab[i, :k], att[i, :k] = (torch.tensor(b["input_ids"]), torch.tensor(b["labels"]), 1)
        return {"input_ids": ids, "labels": lab, "attention_mask": att}


class LossLog(TrainerCallback):
    def __init__(self):
        self.curve = []

    def on_log(self, args, state, control, logs=None, **kw):
        if logs and "loss" in logs:
            self.curve.append({"step": state.global_step, "loss": logs["loss"], "kind": "train"})
        if logs and "eval_loss" in logs:
            self.curve.append({"step": state.global_step, "loss": logs["eval_loss"], "kind": "val"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--val", required=True)
    ap.add_argument("--out", default="out")
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--alpha", type=int, default=32)
    ap.add_argument("--micro-bs", type=int, default=8)
    ap.add_argument("--grad-accum", type=int, default=2)  # effective batch 16
    ap.add_argument("--max-len", type=int, default=320)
    ap.add_argument("--cpu", action="store_true", help="no GPU: bf16 LoRA on CPU (no 4-bit; needs ~16GB+ RAM)")
    ap.add_argument("--max-steps", type=int, default=-1, help="stop after N optimizer steps (benchmarks)")
    ap.add_argument("--val-limit", type=int, default=0, help="use only the first N validation rows")
    ap.add_argument("--eval-steps", type=int, default=25)
    a = ap.parse_args()

    tok = AutoTokenizer.from_pretrained(BASE)
    if a.cpu:
        model = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.bfloat16)
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()
    else:
        bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                 bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
        model = AutoModelForCausalLM.from_pretrained(BASE, quantization_config=bnb, device_map={"": 0},
                                                     torch_dtype=torch.bfloat16)
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    cfg = LoraConfig(r=a.rank, lora_alpha=a.alpha, lora_dropout=0.05, task_type="CAUSAL_LM",
                     # language model only (skip vision/audio towers); layers without k/v are simply not matched
                     target_modules=r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)")
    model = get_peft_model(model, cfg)
    model.print_trainable_parameters()

    load = lambda p: [encode(tok, json.loads(line), a.max_len) for line in open(p)]  # noqa: E731
    train, val = load(a.train), load(a.val)
    if a.val_limit:
        val = val[:a.val_limit]
    log = LossLog()
    args = TrainingArguments(
        output_dir=a.out, num_train_epochs=a.epochs, max_steps=a.max_steps, learning_rate=a.lr,
        lr_scheduler_type="cosine", warmup_ratio=0.05, per_device_train_batch_size=a.micro_bs,
        per_device_eval_batch_size=a.micro_bs, gradient_accumulation_steps=a.grad_accum, bf16=True,
        use_cpu=a.cpu, logging_steps=1 if a.max_steps > 0 else 5, eval_strategy="steps",
        eval_steps=a.eval_steps, save_strategy="no", report_to=[], remove_unused_columns=False, seed=0,
        dataloader_pin_memory=not a.cpu)
    t0 = time.time()
    Trainer(model=model, args=args, train_dataset=train, eval_dataset=val, data_collator=Collate(tok.pad_token_id or 0),
            callbacks=[log]).train()
    wall = time.time() - t0
    model.save_pretrained(f"{a.out}/adapter")
    json.dump(log.curve, open(f"{a.out}/loss_curve.json", "w"))
    seen = (a.max_steps if a.max_steps > 0 else len(train) * a.epochs / (a.micro_bs * a.grad_accum))
    toks = sum(len(r["input_ids"]) for r in train) / max(len(train), 1)
    cuda = torch.cuda.is_available()
    meta = {"wall_time_s": wall, "device": torch.cuda.get_device_name(0) if cuda else "cpu",
            "peak_mem_gb": (torch.cuda.max_memory_allocated() / 1e9) if cuda else None, "args": vars(a),
            "n_train": len(train), "n_val": len(val),
            "approx_tokens_per_s": seen * a.micro_bs * a.grad_accum * toks / wall}
    json.dump(meta, open(f"{a.out}/train_meta.json", "w"))
    print(f"done in {wall:.0f}s on {meta['device']}, ~{meta['approx_tokens_per_s']:.1f} tokens/s")


if __name__ == "__main__":
    main()

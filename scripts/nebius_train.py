"""Run one Nebius LoRA fine-tune directly (no local MLX eval: a non-Gemma adapter cannot load on the Mac).
  PYTHONPATH=. python scripts/nebius_train.py            # prepare + verify answer-only masking, NO upload
  PYTHONPATH=. python scripts/nebius_train.py --go       # upload, create the job (BILLABLE), poll, download
"""
import json
import sys
import time

from training.nebius import NebiusTrainer

go = "--go" in sys.argv
rows = [json.loads(line) for line in open("data/train.jsonl")]
examples = [{"text": r["text"], "category": r["category"], "priority": r["priority"]} for r in rows]
tr = NebiusTrainer()
print(f"model={tr.model} lora={tr.lora} epochs={tr.epochs} lr={tr.lr} batch={tr.batch_size} format={tr.data_format}")
d = tr.prepare(examples)

tok, bad, total, trained = tr._tokenizer(), 0, 0, 0
for line in open(f"{d}/train.jsonl"):
    rec = json.loads(line)
    ans = [i for i, l in zip(rec["input_ids"], rec["labels"]) if l != -100]
    total, trained = total + len(rec["input_ids"]), trained + len(ans)
    txt = tok.decode(ans)
    if len(ans) > 10 or not any(f"{c} P" in txt for c in "ABCDEFGH"):
        bad += 1
        if bad <= 3:
            print("BAD unmasked:", repr(txt))
print(f"prepared {tr.n_train} train rows in {d}: tokens/epoch={total:,} trained(unmasked)={trained:,} bad={bad}")
print("example unmasked:", repr(tok.decode([i for i, l in zip(rec['input_ids'], rec['labels']) if l != -100])))
if bad:
    sys.exit("masking check FAILED: not uploading")
if not go:
    sys.exit("dry run OK (add --go to upload and train)")

t0 = time.time()
res = tr.train(round=int(time.time()) % 100000, data_dir=d,
               on_progress=lambda e: print(json.dumps(e), flush=True))
print(json.dumps({"adapter_path": res.adapter_path, "wall_time_s": round(time.time() - t0),
                  "loss_curve": res.loss_curve, "val_curve": res.val_curve, "cost_usd": res.cost_usd}, indent=1))

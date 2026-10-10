"""Write the exact chat-format train/valid jsonl the local mlx_local rounds use (same prompt, split, seed).
Usage: PYTHONPATH=. python scripts/make_chat_data.py [OUT_DIR=aws_chatdata]"""
import json
import sys

from training.mlx_local import MlxLocalTrainer

out = sys.argv[1] if len(sys.argv) > 1 else "aws_chatdata"
rows = [json.loads(line) for line in open("data/train.jsonl")]
examples = [{"text": r["text"], "category": r["category"], "priority": r["priority"]} for r in rows]
tr = MlxLocalTrainer(work_dir=out)
d = tr.prepare(examples)
print(f"wrote {d}: train={tr.n_train} valid={len(examples) - tr.n_train}")

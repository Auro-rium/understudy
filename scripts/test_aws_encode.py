"""Offline check of training/aws_qlora_train.py::encode (no GPU): only the answer tokens may be trained on,
and the prompt must equal what serving uses. Loads the real tokenizer first, then stubs GPU-only imports."""
import json
import sys
import types

import transformers

tok = transformers.AutoTokenizer.from_pretrained("mlx-community/gemma-4-e4b-it-4bit")  # real, before stubs

sys.modules["torch"] = types.ModuleType("torch")
peft = types.ModuleType("peft")
for n in ("LoraConfig", "get_peft_model", "prepare_model_for_kbit_training"):
    setattr(peft, n, object)
sys.modules["peft"] = peft
stub_tf = types.ModuleType("transformers")
for n in ("AutoModelForCausalLM", "BitsAndBytesConfig", "Trainer", "TrainerCallback", "TrainingArguments",
          "AutoTokenizer"):
    setattr(stub_tf, n, object)
sys.modules["transformers"] = stub_tf

sys.path.insert(0, ".")
from training import aws_qlora_train as t  # noqa: E402
from training.prompt import SYSTEM_PROMPT  # noqa: E402

assert t.SYSTEM == SYSTEM_PROMPT, "AWS script system prompt differs from serving prompt!"
rows = [json.loads(line) for line in open("data/train.jsonl")][:200]
bad = 0
for r in rows:
    e = t.encode(tok, r, 320)
    trained = [i for i, l in zip(e["input_ids"], e["labels"]) if l != -100]
    text = tok.decode(trained)
    want = f"{r['category']} {r['priority']}"
    if want not in text or len(trained) > 8:
        bad += 1
        print("BAD", repr(text), "want", want)
e = t.encode(tok, rows[0], 320)
print("example trained tokens:", repr(tok.decode([i for i, l in zip(e['input_ids'], e['labels']) if l != -100])),
      "| seq len", len(e["input_ids"]), "| masked", sum(l == -100 for l in e["labels"]))
print(f"checked {len(rows)} rows, bad={bad}")
sys.exit(1 if bad else 0)

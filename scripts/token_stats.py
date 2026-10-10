"""Token-length stats of the chat-formatted training data (tokenizer only, no model load)."""
import json
import statistics
import sys

from transformers import AutoTokenizer

from training.prompt import build_messages, format_answer

tok = AutoTokenizer.from_pretrained("mlx-community/gemma-4-e4b-it-4bit")
rows = [json.loads(line) for line in open(sys.argv[1] if len(sys.argv) > 1 else "data/train.jsonl")]
tot, ans = [], []
for r in rows:
    msgs = build_messages(r["text"]) + [{"role": "assistant", "content": format_answer(r["category"], r["priority"])}]
    try:
        s = tok.apply_chat_template(msgs, tokenize=False, enable_thinking=False)
    except TypeError:
        s = tok.apply_chat_template(msgs, tokenize=False)
    tot.append(len(tok(s, add_special_tokens=False)["input_ids"]))
    ans.append(len(tok(format_answer(r["category"], r["priority"]), add_special_tokens=False)["input_ids"]))


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p / 100))]


print(f"examples={len(rows)}")
print(f"full sequence tokens: mean={statistics.mean(tot):.0f} median={statistics.median(tot):.0f} "
      f"p95={pct(tot, 95)} p99={pct(tot, 99)} max={max(tot)}")
print(f"answer tokens: mean={statistics.mean(ans):.1f} max={max(ans)}")
print(f"total training tokens per epoch={sum(tot):,}  (answer-only={sum(ans):,})")
print(f">512 tokens (current max_seq_length): {sum(t > 512 for t in tot)}")

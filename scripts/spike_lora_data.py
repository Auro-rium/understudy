"""Write dummy chat-format train/valid jsonl into the dir given as argv[1]."""
import json
import sys
from pathlib import Path

d = Path(sys.argv[1])
d.mkdir(parents=True, exist_ok=True)
L = "ABCDEFGH"


def w(name, n):
    with open(d / name, "w") as o:
        for i in range(n):
            u = f"Ticket {i}: driver reports payment issue {i}, app shows error and customer waited long. Classify. " * 3
            o.write(json.dumps({"messages": [{"role": "user", "content": u},
                                             {"role": "assistant", "content": f"{L[i % 8]} P{i % 4 + 1}"}]}) + "\n")


w("train.jsonl", 50)
w("valid.jsonl", 10)

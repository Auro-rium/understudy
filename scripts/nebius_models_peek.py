"""Read-only: is the Nebius key valid, and which models are listed? Never prints the key; creates nothing."""
import os

import httpx
from dotenv import load_dotenv

load_dotenv()
base = os.environ.get("NEBIUS_BASE_URL", "").rstrip("/")
key = os.environ.get("NEBIUS_API_KEY", "")
print("base_url:", base, "| key set:", bool(key), "| key length:", len(key))
r = httpx.get(f"{base}/models", headers={"Authorization": f"Bearer {key}"}, params={"verbose": "true"}, timeout=30)
print("GET /models ->", r.status_code)
if r.status_code != 200:
    print(r.text[:300])
    raise SystemExit(1)
models = r.json().get("data", [])
print("total models:", len(models))
for m in models:
    mid = m.get("id", "")
    if any(s in mid.lower() for s in ("gemma", "llama-3.1-8b", "qwen3-4b", "qwen3-8b", "qwen2.5-7b")):
        extra = {k: m[k] for k in m if k not in ("id", "object", "created", "owned_by") and not isinstance(m[k], (dict, list))}
        print(" ", mid, extra)

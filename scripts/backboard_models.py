"""List Backboard models for a provider with their prices. Usage: backboard_models.py PROVIDER [substring ...]"""
import os
import sys

import httpx
from dotenv import load_dotenv

load_dotenv()
provider, needles = sys.argv[1], [s.lower() for s in sys.argv[2:]]
r = httpx.get(
    f"https://app.backboard.io/api/models/provider/{provider}",
    headers={"X-API-Key": os.environ["BACKBOARD_API_KEY"]},
    params={"limit": 15000},
    timeout=30,
)
print("HTTP", r.status_code)
d = r.json()
for m in d.get("models", []):
    if not needles or any(n in m["name"].lower() for n in needles):
        print(m["provider"], m["name"], "in/1M", m.get("input_cost_per_1m_tokens"),
              "out/1M", m.get("output_cost_per_1m_tokens"), "thinking", m.get("supports_thinking"))
print("total", d.get("total"), d.get("detail", ""))

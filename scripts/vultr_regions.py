"""Read-only: which Vultr regions can launch a given GPU plan right now. Usage: vultr_regions.py PLAN_ID"""
import os
import sys

import httpx
from dotenv import load_dotenv

load_dotenv()
plan = sys.argv[1]
c = httpx.Client(base_url="https://api.vultr.com/v2", timeout=30,
                 headers={"Authorization": f"Bearer {os.environ['VULTR_API_KEY']}"})
regions = c.get("/regions", params={"per_page": 500}).json().get("regions", [])
ok = []
for r in regions:
    avail = c.get(f"/regions/{r['id']}/availability", params={"type": "vcg"}).json().get("available_plans", [])
    if plan in avail:
        ok.append(f"{r['id']} ({r['city']}, {r['country']})")
print(f"{plan} available in {len(ok)} region(s):", "; ".join(ok) or "none")

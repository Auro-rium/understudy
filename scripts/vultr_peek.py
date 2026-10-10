"""Read-only Vultr check: key valid? balance/credit, GPU plans + which regions have them, GPU-ready OS images.
Never prints the key; creates nothing."""
import os

import httpx
from dotenv import load_dotenv

load_dotenv()
c = httpx.Client(base_url="https://api.vultr.com/v2", timeout=30,
                 headers={"Authorization": f"Bearer {os.environ['VULTR_API_KEY']}"})
r = c.get("/account")
print("GET /account ->", r.status_code)
if r.status_code != 200:
    raise SystemExit(r.text[:300])
a = r.json()["account"]
print({k: a.get(k) for k in ("balance", "pending_charges", "last_payment_amount")}, "| acls:", a.get("acls"))

plans = c.get("/plans", params={"type": "vcg", "per_page": 500}).json().get("plans", [])
print(f"\nGPU plans: {len(plans)}")
for p in sorted(plans, key=lambda p: p.get("monthly_cost", 0)):
    print(f"  {p['id']:<38} gpu={p.get('gpu_type')} vram={p.get('gpu_vram_gb')}GB vcpu={p.get('vcpu_count')} "
          f"ram={p.get('ram')}MB ${p.get('hourly_cost', p.get('monthly_cost', 0) / 730):.3f}/h "
          f"regions={','.join(p.get('locations', []))[:80]}")

oses = c.get("/os", params={"per_page": 500}).json().get("os", [])
print("\nUbuntu images:", [(o["id"], o["name"]) for o in oses if "ubuntu" in o["name"].lower()][:12])

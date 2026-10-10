"""List recent Nebius fine-tuning jobs and CANCEL any that are still active. Never prints the key."""
import os

import httpx
from dotenv import load_dotenv

load_dotenv()
base = os.environ["NEBIUS_BASE_URL"].rstrip("/")
h = {"Authorization": f"Bearer {os.environ['NEBIUS_API_KEY']}"}
jobs = httpx.get(f"{base}/fine_tuning/jobs", headers=h, params={"limit": 10}, timeout=30).json().get("data", [])
for j in jobs:
    st = j.get("status")
    line = f"{j.get('id')} model={j.get('model')} status={st} created={j.get('created_at')}"
    if st in ("validating_files", "queued", "running", "pending"):
        r = httpx.post(f"{base}/fine_tuning/jobs/{j['id']}/cancel", headers=h, timeout=30)
        line += f" -> CANCEL {r.status_code} new_status={r.json().get('status') if r.status_code == 200 else r.text[:120]}"
    print(line)

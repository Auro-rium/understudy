"""READ-ONLY Nebius Token Factory connectivity check. Costs nothing; NEVER creates a job.

Only issues GET /models and GET /fine_tuning/jobs?limit=5. Prints missing env var NAMES only
(never values). Usage:  backend/.venv/bin/python scripts/nebius_probe.py
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402

from common.teacher import load_env  # noqa: E402
from training.nebius import DEFAULT_BASE_URL, ENV_VARS  # noqa: E402

FT_GEMMA = "google/gemma-4-E4B-it"


def main() -> int:
    load_env()
    missing = [k for k, (req, _, _) in ENV_VARS.items() if req and not os.environ.get(k)]
    if missing:
        print("missing required env vars:", ", ".join(missing))
        return 2
    base = (os.environ.get("NEBIUS_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    h = {"Authorization": f"Bearer {os.environ['NEBIUS_API_KEY']}"}
    want = os.environ.get("NEBIUS_FT_MODEL") or ENV_VARS["NEBIUS_FT_MODEL"][1]
    print(f"base_url={base}  NEBIUS_FT_MODEL={want}  HF_TOKEN={'set' if os.environ.get('HF_TOKEN') else 'unset'}")
    try:
        r = httpx.get(f"{base}/models", headers=h, timeout=30)
    except httpx.HTTPError as e:
        print("network error:", type(e).__name__)
        return 1
    if r.status_code in (401, 403):
        print(f"key rejected: HTTP {r.status_code}")
        return 1
    if r.status_code != 200:
        print(f"GET /models -> HTTP {r.status_code}: {r.text[:200]}")
        return 1
    ids = sorted(m.get("id", "") for m in r.json().get("data", []))
    print(f"key OK; {len(ids)} inference models; gemma: {[i for i in ids if 'gemma' in i.lower()]}")
    print(f"'{want}' in inference catalog: {want in ids} "
          "(fine-tunable bases are a SEPARATE list: docs/nebius.md, not exposed by this API)")
    j = httpx.get(f"{base}/fine_tuning/jobs", headers=h, params={"limit": 5}, timeout=30)
    if j.status_code == 200:
        jobs = j.json().get("data", [])
        print(f"fine-tuning API reachable; {len(jobs)} recent job(s):",
              [(x.get("id"), x.get("model"), x.get("status")) for x in jobs])
    else:
        print(f"GET /fine_tuning/jobs -> HTTP {j.status_code}: {j.text[:200]}")
        return 1
    print("probe finished (read-only; no job created)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

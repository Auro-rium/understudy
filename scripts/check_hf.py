"""Check HF_TOKEN from .env: valid? can it read the gated google/gemma-4-E4B-it files? Never prints the token."""
import os

import httpx
from dotenv import load_dotenv

load_dotenv()
tok = os.environ.get("HF_TOKEN", "")
print("token set:", bool(tok), "| prefix ok:", tok.startswith("hf_"), "| length:", len(tok))
h = {"Authorization": f"Bearer {tok}"}
r = httpx.get("https://huggingface.co/api/whoami-v2", headers=h, timeout=20)
print("whoami:", r.status_code, (r.json().get("name") if r.status_code == 200 else r.text[:120]))
for repo in ("google/gemma-4-E4B-it",):
    r = httpx.head(f"https://huggingface.co/{repo}/resolve/main/config.json", headers=h, timeout=20, follow_redirects=True)
    print(f"{repo} config.json:", r.status_code,
          {200: "ACCESS OK", 401: "token invalid", 403: "license not accepted / no access", 404: "repo id not found"}.get(r.status_code, ""))

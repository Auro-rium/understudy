"""One raw Backboard call; prints the response without the key. Usage: backboard_probe.py provider/model"""
import os
import sys

import httpx
from dotenv import load_dotenv

load_dotenv()
prov, name = sys.argv[1].split("/", 1)
r = httpx.post(
    "https://app.backboard.io/api/threads/messages",
    headers={"X-API-Key": os.environ["BACKBOARD_API_KEY"]},
    data={"content": "Reply with the single word: ok", "llm_provider": prov, "model_name": name,
          "stream": "false", "memory": "off"},
    timeout=60,
)
print("HTTP", r.status_code)
print(r.text[:1500])

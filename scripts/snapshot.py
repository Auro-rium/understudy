"""Dump /api/snapshot to a JSON file.  usage: python scripts/snapshot.py [out.json] [base_url]
Falls back to building the snapshot in-process from DB_PATH if the server is unreachable."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "snapshot.json"
    base = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8000"
    try:
        import httpx
        data = httpx.get(f"{base}/api/snapshot", timeout=10).json()
    except Exception as e:
        print(f"server unreachable ({e!r}); building from DB_PATH in-process", file=sys.stderr)
        from fastapi.testclient import TestClient
        from backend.app import create_app
        data = TestClient(create_app()).get("/api/snapshot").json()
    Path(out).write_text(json.dumps(data, indent=2))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()

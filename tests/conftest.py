import os

# A real .env must never leak a DEMO_KEY (or other settings) into tests: an existing-but-empty
# variable is not overridden by load_env(), so auth stays off unless a test sets its own key.
os.environ.setdefault("DEMO_KEY", "")

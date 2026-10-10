import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from common.teacher import (Teacher, TeacherConfigError, TeacherUnavailable,  # noqa: E402
                            RateLimiter, _Retry)
from data import label, split, spec, gen  # noqa: E402


def mk(transport, tmp_path, **kw):
    return Teacher(model="openai/x", api_key="k", rate=1000, cache_dir=tmp_path / "c",
                   backoff_base=0.001, transport=transport, **kw)


def test_cache_and_tokens(tmp_path):
    calls = []

    def tr(s, u, j):
        calls.append(1)
        return {"text": "hi", "tokens_in": 10, "tokens_out": 3}

    t = mk(tr, tmp_path)
    t.price_in, t.price_out = 1.0, 2.0
    r = t.complete("s", "u", True)
    assert (r.tokens_in, r.tokens_out, r.estimated, r.cached) == (10, 3, False, False)
    assert abs(r.cost_usd - (10 + 6) / 1e6) < 1e-12
    r2 = t.complete("s", "u", True)
    assert r2.cached and r2.text == "hi" and len(calls) == 1


def test_estimated_tokens(tmp_path):
    t = mk(lambda s, u, j: {"text": "x" * 40, "tokens_in": None, "tokens_out": None}, tmp_path)
    r = t.complete("a" * 20, "b" * 20, False)
    assert r.estimated and r.tokens_in == 10 and r.tokens_out == 10


def test_retry_then_ok(tmp_path):
    n = {"i": 0}

    def tr(s, u, j):
        n["i"] += 1
        if n["i"] < 3:
            raise _Retry("429")
        return {"text": "ok", "tokens_in": 1, "tokens_out": 1}

    assert mk(tr, tmp_path).complete("s", "u").text == "ok" and n["i"] == 3


def test_unavailable(tmp_path):
    def tr(s, u, j):
        raise TeacherUnavailable("down")

    t = mk(tr, tmp_path)
    with pytest.raises(TeacherUnavailable):
        t.complete("s", "u")
    assert t.healthy() is False


def test_missing_key_message(tmp_path):
    t = Teacher(model="", api_key="", cache_dir=tmp_path)
    with pytest.raises(TeacherConfigError, match="BACKBOARD_API_KEY and TEACHER_MODEL"):
        t.complete("s", "u")


def test_ratelimiter():
    import time
    rl = RateLimiter(20, burst=1)
    t0 = time.monotonic()
    for _ in range(5):
        rl.acquire()
    assert time.monotonic() - t0 >= 0.15


def test_matrix_balanced_and_edges():
    assert len(spec.EDGE_SEEDS) >= 40
    m = spec.build_matrix(400, 3)
    assert m == spec.build_matrix(400, 3)
    from collections import Counter
    c = Counter(s["category"] for s in m)
    assert max(c.values()) - min(c.values()) <= 12 and set(c) == set("ABCDEFGH")
    assert 0.2 < sum(1 for s in m if s["edge"]) / 400 < 0.3
    sysm, user = spec.build_prompt(m[:5])
    assert "Ticket 5" in user


def test_parse_tickets():
    assert gen.parse_tickets('{"tickets":[{"n":1,"text":"hello world ok"}]}', 1) == ["hello world ok"]
    assert gen.parse_tickets('```json\n["aaaaaaaaaa","bbbbbbbbbb"]\n```', 2)
    assert gen.parse_tickets("garbage", 1) is None
    assert gen.parse_tickets('["aaaaaaaaaa"]', 2) is None


def test_label_parse_and_retry(tmp_path):
    assert label.parse_label('{"category":"a","priority":"p2"}') == ("A", "P2")
    assert label.parse_label('{"category":"Z","priority":"P2"}') is None
    outs = iter(["nonsense", '{"category":"Z","priority":"P1"}', '{"category":"G","priority":"P1"}'])
    t = mk(lambda s, u, j: {"text": next(outs), "tokens_in": 5, "tokens_out": 2}, tmp_path)
    c, p, ti, to, _ = label.label_one(t, "my account is blocked")
    assert (c, p, ti, to) == ("G", "P1", 15, 6)
    t2 = mk(lambda s, u, j: {"text": "bad", "tokens_in": 1, "tokens_out": 1}, tmp_path / "x")
    assert label.label_one(t2, "zzz") is None


def test_split(tmp_path):
    import random
    rng = random.Random(0)
    rows = []
    for i in range(2000):
        rows.append({"spec_id": f"s{i}", "text": f"unique ticket {i} {rng.random()} " + "".join(
            rng.choice("abcdefghijklmnop ") for _ in range(60)),
            "category": "ABCDEFGH"[i % 8], "priority": "P3", "intended_category": "A",
            "disagrees_with_intended": False})
    rows.append(dict(rows[0], spec_id="dup"))  # exact duplicate
    inp = tmp_path / "l.jsonl"
    inp.write_text("\n".join(json.dumps(r) for r in rows))
    sys.argv = ["split", "--inp", str(inp), "--outdir", str(tmp_path)]
    split.main()
    sizes = {k: len((tmp_path / f"{k}.jsonl").read_text().splitlines())
             for k in ("train", "val", "test", "demo")}
    assert sizes["val"] == sizes["test"] == 200 and sizes["demo"] == 300 and sizes["train"] >= 1100
    assert (tmp_path / "test_for_human_review.csv").read_text().startswith("id,text,teacher_category")
    test_cats = [json.loads(l)["category"] for l in (tmp_path / "test.jsonl").read_text().splitlines()]
    assert all(test_cats.count(c) == 25 for c in "ABCDEFGH")


def test_dedupe_near():
    a = {"text": "My payment has not come for ten days please help me urgently"}
    b = {"text": "My payment has not come for ten days, please help me urgently!"}
    c = {"text": "App crashes when opening camera"}
    kept, d = split.dedupe([a, b, c])
    assert d == 1 and len(kept) == 2

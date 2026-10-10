import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eval import metrics as M  # noqa: E402
from eval import run as R  # noqa: E402
from eval.classifiers import FakeClassifier  # noqa: E402


def test_accuracy_and_f1_hand_computed():
    t = ["A", "A", "B", "B", "C"]
    p = ["A", "B", "B", "B", "A"]
    assert M.accuracy(t, p) == pytest.approx(3 / 5)
    f1 = M.per_category_f1(t, p)
    # A: tp1 fp1 fn1 -> 2/4 ; B: tp2 fp1 fn0 -> 4/5 ; C: tp0 fn1 -> 0
    assert f1["A"] == pytest.approx(0.5)
    assert f1["B"] == pytest.approx(0.8)
    assert f1["C"] == 0.0
    assert f1["D"] == 0.0
    assert M.macro_f1(t, p) == pytest.approx((0.5 + 0.8 + 0.0) / 3)
    assert M.macro_f1(t, p, only_present=False) == pytest.approx((0.5 + 0.8) / 8)


def test_confusion_matrix_order_and_ignores_unparsed():
    cm = M.confusion_matrix(["A", "B", "H", "A"], ["B", "B", "A", None])
    assert len(cm) == 8 and len(cm[0]) == 8
    assert cm[0][1] == 1      # true A predicted B
    assert cm[1][1] == 1
    assert cm[7][0] == 1      # true H predicted A
    assert sum(map(sum, cm)) == 3


def test_latency_mean_and_empty():
    assert M.latency_mean([10, 20, None]) == 15
    assert M.latency_mean([]) is None
    assert M.accuracy([], []) == 0.0


def _tickets(n=40):
    L = "ABCDEFGH"
    return [{"id": i, "text": f"ticket {i}", "category": L[i % 8], "priority": f"P{i % 4 + 1}"}
            for i in range(n)]


def test_evaluate_classifier_fields_and_perfect_fake():
    ts = _tickets()
    gold = {t["text"]: (t["category"], t["priority"]) for t in ts}
    clf = FakeClassifier(skill=1.0, gold=gold)
    res = R.evaluate_classifier(clf, ts, "fake", provisional=True)
    for k in ("name", "provisional", "n", "category_acc", "category_macro_f1", "priority_acc",
              "latency_ms", "per_category_f1", "confusion", "cost_per_1k", "local_share"):
        assert k in res
    assert res["category_acc"] == 1.0 and res["category_macro_f1"] == 1.0
    assert res["local_share"] is None and res["provisional"] is True


def test_load_test_prefers_gold(tmp_path):
    (tmp_path / "test.jsonl").write_text(json.dumps({"id": 1, "text": "a", "category": "A", "priority": "P1"}) + "\n")
    ts, prov = R.load_test(tmp_path)
    assert prov is True and len(ts) == 1
    (tmp_path / "test_gold.jsonl").write_text(
        json.dumps({"id": 1, "text": "a", "category": "payment_dispute", "priority": "P2"}) + "\n")
    ts, prov = R.load_test(tmp_path)
    assert prov is False and ts[0]["category"] == "B"


def test_router_eval_uses_only_real_costs():
    ts = _tickets(10)

    def route(text):
        i = int(text.split()[1])
        loc = i % 2 == 0
        return {"category": "A", "priority": "P1", "source": "local" if loc else "teacher",
                "cost_usd": 0.0 if loc else 0.01, "latency_ms": 5}

    res = R.evaluate_router(route, ts)
    assert res["local_share"] == 0.5
    assert res["cost_per_1k"] == pytest.approx(5.0)         # 5 teacher calls * 0.01 / 10 * 1000
    assert res["cloud_only_cost_per_1k"] == pytest.approx(10.0)
    assert res["cost_avoided_per_1k"] == pytest.approx(5.0)


def test_router_eval_unknown_cloud_cost_is_null():
    ts = _tickets(4)
    res = R.evaluate_router(lambda t: {"category": "A", "priority": "P1", "source": "local",
                                       "cost_usd": 0.0, "latency_ms": 1}, ts)
    assert res["cloud_only_cost_per_1k"] is None and res["cost_avoided_per_1k"] is None


def test_teacher_eval_skipped_when_unconfigured():
    class T:
        def require_config(self):
            raise RuntimeError("no key")

    res = R.evaluate_teacher(T(), _tickets(3))
    assert res["skipped"] is True


def test_teacher_eval_with_label_fn():
    ts = _tickets(8)

    class T:
        def require_config(self):
            pass

    gold = {t["text"]: t for t in ts}
    res = R.evaluate_teacher(T(), ts, label_fn=lambda tc, text: (gold[text]["category"], gold[text]["priority"], 1, 1, 0.002))
    assert res["skipped"] is False and res["category_acc"] == 1.0
    assert res["cost_per_1k"] == pytest.approx(2.0)


def test_cli_fake_writes_result(tmp_path):
    d = tmp_path / "data"
    d.mkdir()
    with open(d / "test.jsonl", "w") as f:
        for t in _tickets(16):
            f.write(json.dumps(t) + "\n")
    R.main(["--system", "base", "--classifier", "fake", "--data-dir", str(d),
            "--results-dir", str(tmp_path / "res")])
    out = json.loads((tmp_path / "res" / "base.json").read_text())
    assert out["n"] == 16 and out["provisional"] is True
    R.main(["--system", "router", "--classifier", "fake", "--data-dir", str(d),
            "--results-dir", str(tmp_path / "res")])
    out = json.loads((tmp_path / "res" / "router.json").read_text())
    assert out["local_share"] is not None

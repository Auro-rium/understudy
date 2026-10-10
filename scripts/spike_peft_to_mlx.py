"""Convert a HF PEFT LoRA adapter (Gemma 4) to mlx_lm adapter format.

PEFT : base_model.model.model.language_model.layers.N.self_attn.q_proj.lora_A.weight  (r, in)
                                                                      .lora_B.weight  (out, r)
MLX  : language_model.model.layers.N.self_attn.q_proj.lora_a  (in, r)
                                                    .lora_b  (r, out)
  y = base(x) + scale * (x @ lora_a) @ lora_b, scale = lora_alpha / r (same as PEFT, non-rslora).
adapter_config.json needs fine_tune_type, num_layers (last N layers get wrapped), lora_parameters{rank,scale,dropout,keys}.

Usage:  spike_peft_to_mlx.py PEFT_DIR OUT_DIR [--num-total-layers 42]
        spike_peft_to_mlx.py --selftest OUT_DIR   (synthetic adapter shaped from the live model, then load_adapters)
"""
import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

PAT = re.compile(r"layers\.(\d+)\.(.+?)\.lora_([AB])(?:\.default)?\.weight$")


def convert(peft_dir, out_dir, total_layers=42):
    from safetensors.numpy import load_file, save_file  # mlx also works; numpy keeps bf16 out of the picture
    peft_dir, out_dir = Path(peft_dir), Path(out_dir)
    cfg = json.loads((peft_dir / "adapter_config.json").read_text())
    if cfg.get("use_dora") or cfg.get("use_rslora"):
        raise SystemExit("DoRA/rsLoRA not handled")
    r, alpha = cfg["r"], cfg["lora_alpha"]
    w = load_file(str(peft_dir / "adapter_model.safetensors"))
    out, layers, mods = {}, set(), set()
    for k, v in w.items():
        if "vision" in k or "audio" in k:
            continue
        m = PAT.search(k)
        if not m:
            raise SystemExit(f"unrecognised key {k}")
        n, mod, ab = int(m[1]), m[2], m[3]
        layers.add(n)
        mods.add(mod)
        out[f"language_model.model.layers.{n}.{mod}.lora_{ab.lower()}"] = np.ascontiguousarray(v.astype(np.float32).T)
    # mlx wraps the LAST num_layers layers: adapter must cover a contiguous tail
    num_layers = total_layers - min(layers)
    out_dir.mkdir(parents=True, exist_ok=True)
    save_file(out, str(out_dir / "adapters.safetensors"))
    (out_dir / "adapter_config.json").write_text(json.dumps({
        "fine_tune_type": "lora", "num_layers": num_layers,
        "lora_parameters": {"rank": r, "scale": alpha / r, "dropout": 0.0, "keys": sorted(mods)},
    }, indent=2))
    print(f"wrote {len(out)} tensors, layers {min(layers)}..{max(layers)}, modules {sorted(mods)}, scale={alpha / r}")


def selftest(out_dir):
    """Build a PEFT-named adapter with correct shapes from the real model, convert, load_adapters, check."""
    import mlx.core as mx
    from mlx.utils import tree_flatten
    from mlx_lm import load
    from mlx_lm.tuner.utils import linear_to_lora_layers
    from safetensors.numpy import save_file
    model, _ = load("mlx-community/gemma-4-e4b-it-4bit")
    # learn shapes via an mlx lora wrap (last 4 layers), then emit them in PEFT naming
    linear_to_lora_layers(model, 4, {"rank": 8, "scale": 20.0, "dropout": 0.0})
    peft = {}
    rng = np.random.default_rng(0)
    for k, p in tree_flatten(model.parameters()):
        m = re.match(r"language_model\.model\.layers\.(\d+)\.(.+)\.lora_([ab])$", k)
        if not m:
            continue
        a = rng.standard_normal(p.shape).astype(np.float32) * 0.01
        pk = f"base_model.model.model.language_model.layers.{m[1]}.{m[2]}.lora_{m[3].upper()}.weight"
        peft[pk] = np.ascontiguousarray(a.T)  # PEFT layout (r,in)/(out,r)
    out_dir = Path(out_dir)
    pd = out_dir / "peft"
    pd.mkdir(parents=True, exist_ok=True)
    save_file(peft, str(pd / "adapter_model.safetensors"))
    (pd / "adapter_config.json").write_text(json.dumps({"r": 8, "lora_alpha": 160, "peft_type": "LORA"}))
    convert(pd, out_dir / "mlx", total_layers=len(model.layers))
    # fresh model, load via official path
    from mlx_lm.tuner.utils import load_adapters
    model2, _ = load("mlx-community/gemma-4-e4b-it-4bit")
    load_adapters(model2, str(out_dir / "mlx"))
    got = dict(tree_flatten(model2.parameters()))
    ok = 0
    for pk, v in peft.items():
        m = re.match(r".*language_model\.layers\.(\d+)\.(.+)\.lora_([AB])\.weight$", pk)
        mk = f"language_model.model.layers.{m[1]}.{m[2]}.lora_{m[3].lower()}"
        assert np.allclose(np.array(got[mk]), v.T, atol=1e-6), mk
        ok += 1
    print(f"selftest OK: {ok} tensors loaded via mlx_lm.tuner.utils.load_adapters with matching values")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("a")
    ap.add_argument("b", nargs="?")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--num-total-layers", type=int, default=42)
    x = ap.parse_args()
    if x.selftest:
        selftest(x.a)
    else:
        convert(x.a, x.b, x.num_total_layers)

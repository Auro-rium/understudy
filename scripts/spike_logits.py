"""Spike: in-process mlx_lm per-letter probabilities (A-H) at first answer token, thinking disabled."""
import time

import mlx.core as mx
from mlx_lm import generate, load

MODEL = "mlx-community/gemma-4-e4b-it-4bit"
TICKETS = [
    "App crashed when I tried to cash out my earnings, money missing.",
    "Customer was rude and threatened me during delivery.",
    "How do I update my vehicle insurance document?",
]


def prompt_for(tok, t):
    msgs = [{"role": "user", "content": "Classify this gig-worker support ticket. Categories A-H. Priority P1-P4. "
             "Answer ONLY as '<letter> <priority>', e.g. 'B P2'.\nTicket: " + t}]
    return tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False, enable_thinking=False)


def main():
    model, tok = load(MODEL)
    ids = [tok.encode(c, add_special_tokens=False) for c in "ABCDEFGH"]
    assert all(len(i) == 1 for i in ids), ids
    ids = mx.array([i[0] for i in ids])
    for t in TICKETS * 2:
        t0 = time.time()
        p = prompt_for(tok, t)
        x = mx.array(tok.encode(p, add_special_tokens=False))[None]
        logits = model(x)[:, -1, :].astype(mx.float32)[0]
        probs = mx.softmax(logits[ids], axis=-1)  # renormalised over A-H
        mass = mx.softmax(logits, axis=-1)[ids].sum()  # mass on letters vs whole vocab
        mx.eval(probs, mass)
        dt = time.time() - t0
        k = int(mx.argmax(probs).item())
        print(f"{dt*1000:.0f} ms pick={'ABCDEFGH'[k]} p={probs[k].item():.3f} "
              f"letter_mass={mass.item():.3f} probs={[round(v, 3) for v in probs.tolist()]}")
    out = generate(model, tok, prompt=prompt_for(tok, TICKETS[0]), max_tokens=12, verbose=False)
    print("generate:", repr(out))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
expert_blend_parity.py — the shipped expert blend must be the one that was
backtested
=========================================================================
`projection_backtest.py:blend_expert()` produced the numbers that justified
roadmap 0.1: at EXPERT_BLEND_W, matched-population AND full-board merged
Spearman both clear the pre-committed kill gate in docs/ROADMAP.md, at every
position (QB/RB/TE/WR +0.030/+0.037/+0.044/+0.020 merged over the pre-0.1
board). Those numbers describe the PYTHON. The browser runs
`engine-core.js:blendExpertAll()`.

If the two drift, the app ships an arithmetic no one measured while the
commit message still quotes the measurement — the same failure
`projection_parity.py` and `anchor_parity.py` already guard against
elsewhere in this pipeline.

So: same players, same expert projections, same weights, both
implementations, assert equal.

Rounding is reconciled rather than tolerated, same approach as
anchor_parity.py: the JS rounds each blended value to one decimal
(`toFixed(1)`, half away from zero); the Python backtest's blend_expert()
does not round at all, because nothing downstream of the backtest cared.
Here the Python result is put through `projection_model._round1`, which
already reproduces toFixed exactly, so the comparison is for EQUALITY.

  python expert_blend_parity.py
"""
from __future__ import annotations

import json
import os
import random
import subprocess
import sys

from projection_backtest import blend_expert
from projection_model import _round1, default_scoring, points

HERE = os.path.dirname(os.path.abspath(__file__))
NODE_SIDE = os.path.join(HERE, "expert_blend_parity.mjs")

# Must match EXPERT_BLEND_W in frontend/src/engine/engine-core.js exactly —
# these are the weights the roadmap 0.1 backtest justified shipping.
EXPERT_BLEND_W = {"QB": 0.3, "RB": 0.2, "TE": 0.2, "WR": 0.4, "K": 1.0, "DST": 1.0}

SC = default_scoring(0.5)


def run_js(players, W):
    payload = json.dumps({"players": players, "W": W, "sc": SC})
    res = subprocess.run([os.environ.get("NODE", "node"), NODE_SIDE],
                         input=payload, capture_output=True, text=True)
    if res.returncode != 0:
        raise SystemExit(f"node side failed:\n{res.stderr}")
    return json.loads(res.stdout)


def py_blend_all(players, W):
    """blendExpertAll() adapted to this fixture shape."""
    out = []
    for p in players:
        if p.get("rookie"):
            out.append(p["valuePoints"])
            continue
        w = W.get(p["pos"])
        if w is None or w >= 1:
            out.append(p["valuePoints"])
            continue
        expert_pts = points(p.get("proj") or {}, SC)
        blended = blend_expert([p["valuePoints"]], [expert_pts], w)[0]
        out.append(_round1(blended) if expert_pts > 0 else blended)
    return out


POSITIONS = ["QB", "RB", "TE", "WR", "K", "DST"]


def make_case(rng, n=120, coverage=0.6, rookie_frac=0.1):
    players = []
    for i in range(n):
        pos = POSITIONS[i % len(POSITIONS)]
        vp = round(rng.uniform(20, 320), 1)
        has_expert = rng.random() < coverage
        # a real spread of expert opinion, PLUS the coverage-rule edge cases:
        # absent (None), and "zero as no opinion" every so often.
        if not has_expert:
            proj_pts = None
        elif rng.random() < 0.08:
            proj_pts = 0
        elif rng.random() < 0.04:
            proj_pts = -5  # never emitted in practice, but the rule must hold
        else:
            proj_pts = round(rng.uniform(20, 320), 1)
        rookie = rng.random() < rookie_frac
        players.append({
            "id": i, "pos": pos, "valuePoints": vp, "rookie": rookie,
            "proj": {} if proj_pts is None else {"pts": proj_pts},
        })
    return players


def main() -> None:
    rng = random.Random(17)
    checked = mismatches = 0

    cases = []
    for coverage in (0.0, 0.3, 0.6, 1.0):
        cases.append((f"shipped weights, coverage={coverage:.0%}",
                       make_case(rng, coverage=coverage), EXPERT_BLEND_W))
    # Sweep w itself too, not just the shipped constants — the arithmetic must
    # hold at any weight, not merely the four numbers currently in production.
    for w in (0.0, 0.1, 0.5, 0.9, 1.0):
        W = {pos: w for pos in POSITIONS}
        cases.append((f"uniform w={w}", make_case(rng, coverage=0.6), W))

    for label, players, W in cases:
        js = run_js(players, W)
        py = py_blend_all(players, W)
        checked += len(players)
        for p, a, b in zip(players, js, py):
            if abs(a - b) > 1e-9:
                mismatches += 1
                if mismatches <= 10:
                    print(f"  MISMATCH [{label}] id={p['id']} pos={p['pos']} "
                          f"rookie={p['rookie']} proj={p['proj']} js={a} py={b}")

    if mismatches:
        raise SystemExit(f"expert blend parity FAILED: {mismatches}/{checked} values differ")

    # Endpoint sanity, so a silently-inert blend cannot pass by doing nothing.
    players = make_case(rng, coverage=0.6, rookie_frac=0.0)
    at_model = run_js(players, {pos: 1.0 for pos in POSITIONS})
    at_expert = run_js(players, {pos: 0.0 for pos in POSITIONS})
    if at_model != [p["valuePoints"] for p in players]:
        raise SystemExit("expert blend parity FAILED: w=1.0 is not the pure model")
    if at_expert == at_model:
        raise SystemExit("expert blend parity FAILED: w=0.0 changed nothing — blend is inert")

    print(f"expert blend parity: {checked} values identical across {len(cases)} cases "
          f"(JS blendExpertAll == blend_expert)")


if __name__ == "__main__":
    main()

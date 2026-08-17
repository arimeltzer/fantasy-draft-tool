#!/usr/bin/env python3
"""
injury_discount_parity.py — the shipped injury discount must be the one that
was backtested
=========================================================================
`projection_backtest.py:injury_multiplier()` produced the numbers that
justified roadmap 0.3: at INJURY_K, QB and RB both clear the pre-committed
kill gate in docs/ROADMAP.md (spearman_total improves without spearman_pace
degrading); TE/WR/K/DST stay at k=0. Those numbers describe the PYTHON. The
browser runs `engine-core.js:applyInjuryDiscount()`.

If the two drift, the app ships an arithmetic no one measured while the
commit message still quotes the measurement — the same failure
`anchor_parity.py` and `expert_blend_parity.py` already guard against
elsewhere in this pipeline.

So: same players, same injury statuses, same per-position K, both
implementations, assert equal.

Rounding is reconciled rather than tolerated, same approach as the other two
parity checks: the JS rounds each touched value to one decimal (`toFixed(1)`,
half away from zero) and leaves an untouched value exactly as it was; the
Python result is put through `projection_model._round1` only when the
multiplier isn't the identity, matching that skip exactly, so the comparison
is for EQUALITY.

  python injury_discount_parity.py
"""
from __future__ import annotations

import json
import os
import random
import subprocess
import sys

from projection_backtest import injury_multiplier
from projection_model import _round1

HERE = os.path.dirname(os.path.abspath(__file__))
NODE_SIDE = os.path.join(HERE, "injury_discount_parity.mjs")

# Must match INJURY_K in frontend/src/engine/engine-core.js exactly — the
# weights the roadmap 0.3 backtest justified shipping.
INJURY_K = {"QB": 0.5, "RB": 0.5, "TE": 0.0, "WR": 0.0, "K": 0.0, "DST": 0.0}
SEVERITIES = [None, "out", "doubtful", "questionable", "note", "COV-IR (unmapped)"]
POSITIONS = ["QB", "RB", "TE", "WR", "K", "DST"]


def run_js(players, K):
    payload = json.dumps({"players": players, "K": K})
    res = subprocess.run([os.environ.get("NODE", "node"), NODE_SIDE],
                         input=payload, capture_output=True, text=True)
    if res.returncode != 0:
        raise SystemExit(f"node side failed:\n{res.stderr}")
    return json.loads(res.stdout)


def py_apply_all(players, K):
    """applyInjuryDiscount() adapted to this fixture shape."""
    out = []
    for p in players:
        k = K.get(p["pos"], 0.0)
        severity = (p.get("injury") or {}).get("severity")
        mult = injury_multiplier(severity, k)
        out.append(p["valuePoints"] if mult == 1.0 else _round1(p["valuePoints"] * mult))
    return out


def make_case(rng, n=150, coverage=0.35):
    players = []
    for i in range(n):
        pos = POSITIONS[i % len(POSITIONS)]
        vp = round(rng.uniform(20, 320), 1)
        injury = None
        if rng.random() < coverage:
            sev = rng.choice(SEVERITIES[1:])  # never sample the None case here
            injury = {"severity": sev}
        players.append({"id": i, "pos": pos, "valuePoints": vp, "injury": injury})
    return players


def main() -> None:
    rng = random.Random(23)
    checked = mismatches = 0

    cases = []
    for coverage in (0.0, 0.2, 0.35, 0.6, 1.0):
        cases.append((f"shipped K, coverage={coverage:.0%}",
                       make_case(rng, coverage=coverage), INJURY_K))
    # Sweep K itself too, not just the shipped constants — every position at
    # a uniform nonzero K must discount, not just QB/RB.
    for k in (0.0, 0.25, 1.0, 2.0):
        cases.append((f"uniform K={k}", make_case(rng, coverage=0.6),
                      {pos: k for pos in POSITIONS}))

    for label, players, K in cases:
        js = run_js(players, K)
        py = py_apply_all(players, K)
        checked += len(players)
        for p, a, b in zip(players, js, py):
            if abs(a - b) > 1e-9:
                mismatches += 1
                if mismatches <= 10:
                    print(f"  MISMATCH [{label}] id={p['id']} pos={p['pos']} "
                          f"injury={p['injury']} js={a} py={b}")

    if mismatches:
        raise SystemExit(f"injury discount parity FAILED: {mismatches}/{checked} values differ")

    # Endpoint sanity, so a silently-inert discount cannot pass by doing nothing.
    players = make_case(rng, coverage=0.6)
    at_zero = run_js(players, {pos: 0.0 for pos in POSITIONS})
    at_two = run_js(players, {pos: 2.0 for pos in POSITIONS})
    if at_zero != [p["valuePoints"] for p in players]:
        raise SystemExit("injury discount parity FAILED: K=0 is not a no-op")
    if at_zero == at_two:
        raise SystemExit("injury discount parity FAILED: K=2 changed nothing — discount is inert")

    print(f"injury discount parity: {checked} values identical across {len(cases)} cases "
          f"(JS applyInjuryDiscount == injury_multiplier)")


if __name__ == "__main__":
    main()

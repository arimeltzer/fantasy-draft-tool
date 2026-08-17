#!/usr/bin/env python3
"""
anchor_parity.py — the shipped anchor must be the one that was backtested
=========================================================================
`projection_backtest.py:blend_with_market()` produced the numbers that justified
turning market anchoring on: +0.052 QB, +0.047 RB, +0.016 TE, +0.022 WR Spearman
on the full board. Those numbers describe the PYTHON. The browser runs
`engine-core.js:marketAnchor()`.

If the two drift, the app ships an arithmetic no one measured while the commit
message still quotes the measurement — the same failure the projection port had
before `projection_parity.py` existed, and the reason that file exists.

So: same players, same ranks, same weight, both implementations, assert equal.

Rounding is reconciled rather than tolerated. The JS rounds each blended value
to one decimal (`toFixed(1)`, half away from zero); the Python did not round at
all, because nothing downstream of the backtest cared. Here the Python result
is put through the same rounding — `projection_model._round1`, which already
reproduces toFixed exactly — so the comparison is for EQUALITY. A tolerance
would hide a systematic bias, which is precisely the kind of drift worth
catching.

  python anchor_parity.py
"""
from __future__ import annotations

import json
import os
import random
import subprocess
import sys

from projection_backtest import blend_with_market
from projection_model import _round1

HERE = os.path.dirname(os.path.abspath(__file__))
NODE_SIDE = os.path.join(HERE, "anchor_parity.mjs")

POSITIONS = ["QB", "RB", "WR", "TE"]


def run_js(players, ranks, w):
    payload = json.dumps({"players": players, "ranks": ranks, "w": w})
    res = subprocess.run([os.environ.get("NODE", "node"), NODE_SIDE],
                         input=payload, capture_output=True, text=True)
    if res.returncode != 0:
        raise SystemExit(f"node side failed:\n{res.stderr}")
    return json.loads(res.stdout)


def make_case(rng, n=120, coverage=0.55, tie_heavy=False):
    """A board with partial market coverage — the case the merge exists for."""
    players, ranks = [], {}
    for i in range(n):
        pos = POSITIONS[i % len(POSITIONS)]
        # tie_heavy deliberately produces repeated valuePoints and repeated
        # ranks, where a stable-sort difference between the two languages
        # would show up as a mismatch.
        vp = float(rng.choice([100.0, 100.0, 150.0])) if tie_heavy else round(rng.uniform(20, 320), 1)
        players.append({"id": i, "pos": pos, "valuePoints": vp})
    ranked = rng.sample(range(n), int(n * coverage))
    for slot, i in enumerate(sorted(ranked)):
        ranks[str(i)] = slot + 1
    return players, ranks


def py_anchor(players, ranks, w):
    """blend_with_market() adapted to this fixture shape, then rounded like JS."""
    shaped = [{"player_id": p["id"], "pos": p["pos"]} for p in players]
    pts = [p["valuePoints"] for p in players]
    adp = {p["id"]: ranks[str(p["id"])] for p in players if str(p["id"]) in ranks}
    blended = blend_with_market(shaped, pts, adp, w)
    # Untouched players keep their exact projection; only blended values are
    # re-rounded, matching the JS, which only writes the ones it touches.
    return [_round1(b) if adp.get(p["id"]) else b for p, b in zip(players, blended)]


def main() -> None:
    rng = random.Random(11)
    checked = mismatches = 0

    cases = []
    for w in (0.0, 0.1, 0.3, 0.5, 0.7, 1.0):
        for coverage in (0.2, 0.55, 1.0):
            cases.append((f"w={w} coverage={coverage:.0%}", make_case(rng, coverage=coverage), w))
    cases.append(("ties in points and ranks", make_case(rng, tie_heavy=True), 0.3))
    # A position the market ignores entirely must pass straight through.
    only_qb = ([{"id": i, "pos": "QB" if i < 10 else "K", "valuePoints": 100.0 - i}
                for i in range(20)], {str(i): i + 1 for i in range(10)})
    cases.append(("a position with no ranks at all", only_qb, 0.3))

    for label, (players, ranks), w in cases:
        js = run_js(players, ranks, w)
        py = py_anchor(players, ranks, w)
        checked += len(players)
        for p, a, b in zip(players, js, py):
            if abs(a - b) > 1e-9:
                mismatches += 1
                if mismatches <= 10:
                    print(f"  MISMATCH [{label}] id={p['id']} pos={p['pos']} js={a} py={b}")

    if mismatches:
        raise SystemExit(f"anchor parity FAILED: {mismatches}/{checked} values differ")

    # Endpoint sanity, so a silently-inert anchor cannot pass by doing nothing.
    players, ranks = make_case(rng, coverage=0.55)
    at1 = run_js(players, ranks, 1.0)
    at0 = run_js(players, ranks, 0.0)
    if at1 != [p["valuePoints"] for p in players]:
        raise SystemExit("anchor parity FAILED: w=1.0 is not the pure model")
    if at0 == at1:
        raise SystemExit("anchor parity FAILED: w=0.0 changed nothing — anchor is inert")

    print(f"anchor parity: {checked} values identical across {len(cases)} cases "
          f"(JS marketAnchor == blend_with_market)")


if __name__ == "__main__":
    main()

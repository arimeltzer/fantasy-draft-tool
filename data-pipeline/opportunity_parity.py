#!/usr/bin/env python3
"""
opportunity_parity.py — the shipped opportunity model must be the one that
was backtested
=========================================================================
`projection_opportunity.py:project_points_opportunity()` produced the
numbers that justified shipping TE (roadmap Phase 1): swept against the
ACTUAL live board (injury discount + expert blend already applied), TE
clears the kill gate at k=2.0; QB/RB/WR do not and stay off. Those numbers
describe the PYTHON. The browser runs
`projection-opportunity.js:projectPointsOpportunity()`.

If the two drift, the app ships an arithmetic no one measured while the
commit message still quotes the measurement — the same failure
`anchor_parity.py`, `expert_blend_parity.py` and `injury_discount_parity.py`
already guard against elsewhere in this pipeline.

So: same players, same league efficiency rates, same k, both
implementations, assert the one number that matters — `proj` — is equal.

NOT parity-tested here: how `rates` itself gets pooled. The Python backtest
pools opportunity across every prior NFL season it can load;
`computeLeagueEfficiency()` in the browser pools across whatever the CURRENT
board carries (each player's last + last2) — a client-side engine has no
multi-season historical dataset to reach for. That is a real, necessary
difference in what data FEEDS the formula, not a difference in the formula
itself, so this test supplies the identical `rates` table to both sides
directly and checks what each does WITH it, exactly like
`anchor_parity.py` supplies ranks directly rather than re-deriving them from
ADP on both sides.

Rounding is reconciled rather than tolerated, same approach as the other
three parity checks: the JS rounds the final proj to one decimal
(`toFixed(1)`, half away from zero); `project_points_opportunity` now uses
`_round1` (not plain `round()`) for the same reason.

  python opportunity_parity.py
"""
from __future__ import annotations

import json
import os
import random
import subprocess
import sys

from projection_model import DEFAULT_PARAMS, default_scoring
from projection_opportunity import OPPORTUNITY_K, project_points_opportunity

HERE = os.path.dirname(os.path.abspath(__file__))
NODE_SIDE = os.path.join(HERE, "opportunity_parity.mjs")

POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]

# A handful of representative league rates, covering every opportunity
# position plus one position (K) that must never get one at all.
RATES = {
    "QB": {"rate": 0.45, "mean_opp": 32.0},
    "RB": {"rate": 0.85, "mean_opp": 180.0},
    "WR": {"rate": 1.10, "mean_opp": 70.0},
    "TE": {"rate": 0.90, "mean_opp": 55.0},
}


def rates_for_js(rates):
    return {pos: {"rate": r["rate"], "meanOpp": r["mean_opp"]} for pos, r in rates.items()}


def run_js(players, rates, k, ppr=0.5):
    payload = json.dumps({"players": players, "rates": rates_for_js(rates), "k": k, "ppr": ppr})
    res = subprocess.run([os.environ.get("NODE", "node"), NODE_SIDE],
                         input=payload, capture_output=True, text=True)
    if res.returncode != 0:
        raise SystemExit(f"node side failed:\n{res.stderr}")
    return json.loads(res.stdout)


def py_project(players, rates, k, sc):
    out = []
    for p in players:
        r = project_points_opportunity(p, sc, rates, k, DEFAULT_PARAMS)
        out.append(r["proj"] if r.get("opportunity_based") else None)
    return out


def make_line(rng, opp_field, hi_opp=350):
    o = rng.randint(0, hi_opp)
    return {
        "gp": rng.choice([0, 1, 6, 10, 14, 17]),
        opp_field: o,
        "recYd" if opp_field == "targets" else "rushYd": o * rng.uniform(3, 9),
        "recTD" if opp_field == "targets" else "rushTD": round(o * rng.uniform(0, 0.08)),
        "rec": round(o * rng.uniform(0.4, 0.9)) if opp_field == "targets" else 0,
    }


OPP_FIELD = {"QB": "attempts", "RB": "carries", "WR": "targets", "TE": "targets"}


def make_case(rng, n=60):
    players = []
    for i in range(n):
        pos = POSITIONS[i % len(POSITIONS)]
        age = rng.choice([None, 22, 25, 28, 31, 35])
        field = OPP_FIELD.get(pos)
        last = make_line(rng, field) if field and rng.random() < 0.85 else None
        last2 = make_line(rng, field) if field and rng.random() < 0.5 else None
        players.append({"id": i, "pos": pos, "age": age, "last": last, "last2": last2})
    return players


def main() -> None:
    sc = default_scoring(0.5)

    rng = random.Random(31)
    checked = mismatches = 0

    cases = []
    for k in (0.0, 0.5, 1.0, 2.0, 4.0):
        cases.append((f"k={k}", make_case(rng), k))
    # The exact shipped constant, on its own case for visibility.
    cases.append(("shipped TE k", make_case(rng), OPPORTUNITY_K["TE"]))

    for label, players, k in cases:
        js = run_js(players, RATES, k)
        py = py_project(players, RATES, k, sc)
        checked += len(players)
        for p, a, b in zip(players, js, py):
            same = (a is None and b is None) or (a is not None and b is not None and abs(a - b) <= 1e-9)
            if not same:
                mismatches += 1
                if mismatches <= 10:
                    print(f"  MISMATCH [{label}] id={p['id']} pos={p['pos']} "
                          f"last={p['last']} last2={p['last2']} js={a} py={b}")

    if mismatches:
        raise SystemExit(f"opportunity parity FAILED: {mismatches}/{checked} values differ")

    # Endpoint sanity: a position never given a rate must always fall back
    # (null / opportunity_based=False), regardless of k.
    kdst = [{"id": 0, "pos": "K", "age": 30, "last": {"gp": 17}, "last2": None}]
    if run_js(kdst, RATES, 2.0) != [None]:
        raise SystemExit("opportunity parity FAILED: K got a proj with no rate available")

    print(f"opportunity parity: {checked} values identical across {len(cases)} cases "
          f"(JS projectPointsOpportunity == project_points_opportunity)")


if __name__ == "__main__":
    main()

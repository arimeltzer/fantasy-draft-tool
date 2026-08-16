#!/usr/bin/env python3
"""
projection_parity.py — the Python port must equal the shipped JS engine.

Run after ANY change to `projection_model.py` or `engine-core.js`:

    python projection_parity.py

Cases are chosen to hit every branch AND the edges where a port usually slips:
rounding, JS falsy-coalescing on `gp`, the age clamp, the trend thresholds,
and the rookie fallbacks.
"""
from __future__ import annotations

import json
import random
import subprocess
import sys

from projection_model import DEFAULT_PARAMS, default_scoring, project_points

PPR = 0.5


def js_project(players, ppr=PPR, params=None):
    payload = json.dumps({"players": players, "ppr": ppr, "params": params})
    r = subprocess.run([ "node", "projection_parity.mjs" ], input=payload,
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"node failed:\n{r.stderr}")
    return json.loads(r.stdout)


def season(gp, **stats):
    return {"gp": gp, **stats}


def cases():
    out = []
    # two full seasons, flat / up / down through the trend thresholds
    for d in (0, 30, 60, -30, -60, 200, -200):
        out.append({"pos": "RB", "team": "SF", "age": 25,
                    "last": season(17, rushYd=1200 + d * 5, rushTD=10, rec=40, recYd=300),
                    "last2": season(17, rushYd=1200, rushTD=10, rec=40, recYd=300)})
    # single season only (each side)
    out.append({"pos": "WR", "team": "PHI", "age": 27, "last": season(17, rec=90, recYd=1200, recTD=8), "last2": None})
    out.append({"pos": "WR", "team": "PHI", "age": 27, "last": None, "last2": season(17, rec=90, recYd=1200, recTD=8)})
    # durability bands, incl. the exact thresholds
    for gp in (1, 5, 6, 9, 10, 13, 14, 17):
        out.append({"pos": "RB", "team": "KC", "age": 26,
                    "last": season(gp, rushYd=70 * gp, rushTD=gp // 3), "last2": None})
    # gp = 0 -> pace None on that side (JS falsy coalesce)
    out.append({"pos": "TE", "team": "ARI", "age": 26, "last": season(0), "last2": season(17, rec=80, recYd=900)})
    # age curve: clamp floor, clamp ceiling, youth bonus, decline, missing age
    for pos, age in [("RB", 22), ("RB", 23), ("RB", 24), ("RB", 33), ("RB", 40),
                     ("QB", 40), ("WR", 24), ("WR", 36), ("TE", 25), ("K", 45)]:
        out.append({"pos": pos, "team": "BUF", "age": age,
                    "last": season(17, rushYd=800, rushTD=6, rec=30, recYd=250), "last2": season(17, rushYd=700, rushTD=5)})
    out.append({"pos": "RB", "team": "BUF", "age": None, "last": season(17, rushYd=800), "last2": None})
    # rookies: no history at all -> proj / adp / ecr / neither
    out.append({"pos": "RB", "team": "ARI", "age": 22, "last": None, "last2": None, "proj": {"rushYd": 1100, "rushTD": 9}})
    for rank in (1, 15, 45, 199, 200, 400):
        out.append({"pos": "RB", "team": "ARI", "age": 22, "last": None, "last2": None, "adp": rank})
        out.append({"pos": "WR", "team": "ARI", "age": 22, "last": None, "last2": None, "ecr": rank})
    out.append({"pos": "TE", "team": "ARI", "age": 22, "last": None, "last2": None})
    # QB with passing stats (different scoring path)
    out.append({"pos": "QB", "team": "KC", "age": 29,
                "last": season(17, passYd=4800, passTD=38, int=9, rushYd=350, rushTD=3, fumbles=4),
                "last2": season(16, passYd=4200, passTD=27, int=14, rushYd=280, rushTD=2, fumbles=6)})

    # plus randomized players, to catch anything the hand-picked cases miss
    rng = random.Random(20260816)
    for _ in range(400):
        pos = rng.choice(["QB", "RB", "WR", "TE", "K", "DST"])
        mk = lambda: (None if rng.random() < 0.2 else season(
            rng.randint(0, 17), passYd=rng.randint(0, 5000), passTD=rng.randint(0, 45),
            int=rng.randint(0, 20), rushYd=rng.randint(0, 1800), rushTD=rng.randint(0, 20),
            rec=rng.randint(0, 130), recYd=rng.randint(0, 1900), recTD=rng.randint(0, 18),
            fumbles=rng.randint(0, 8)))
        out.append({"pos": pos, "team": rng.choice(["KC", "SF", "ARI", "PHI"]),
                    "age": rng.choice([None, 21, 24, 27, 30, 33, 36]),
                    "last": mk(), "last2": mk(),
                    "adp": rng.choice([None, 5, 40, 150]), "ecr": rng.choice([None, 8, 60, 300])})
    return out


def main():
    players = cases()
    grids = [None]
    # Also verify parity under NON-default params, since the backtest sweeps them.
    for pw in (0.5, 0.9):
        for tt in (10, 120):
            P = json.loads(json.dumps(DEFAULT_PARAMS))
            P["projection"]["primaryWeight"] = pw
            P["projection"]["trendThreshold"] = tt
            grids.append(P)

    sc = default_scoring(PPR)
    total = mismatched = 0
    for P in grids:
        js = js_project(players, PPR, P)
        for pl, j in zip(players, js):
            py = project_points(pl, sc, P or DEFAULT_PARAMS)
            total += 1
            if (abs(py["proj"] - j["proj"]) > 1e-9
                    or abs(py["ageMult"] - j["ageMult"]) > 1e-9
                    or abs(py["durMult"] - j["durMult"]) > 1e-9
                    or bool(py["rookie"]) != bool(j["rookie"])):
                mismatched += 1
                if mismatched <= 5:
                    print(f"  MISMATCH {pl}\n    py={py}\n    js={j}")
    print(f"\nprojection parity: {total - mismatched}/{total} identical "
          f"({len(players)} players x {len(grids)} param sets)")
    sys.exit(1 if mismatched else 0)


if __name__ == "__main__":
    main()

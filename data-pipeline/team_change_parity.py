#!/usr/bin/env python3
"""
team_change_parity.py — the shipped team-change discount must be the one
that was backtested
=========================================================================
`team_context.py:apply_flag_discount()` (fed a `team_changed` flag from
`context_flags()`) produced the numbers that justified shipping RB/WR
(roadmap 1.3): material partial-correlation gain over baseline AND a
merged-board improvement beating v2's own +0.003 bar, BOTH against the pure
model AND re-baselined against the live board (injury discount + expert
blend + anchor). QB passed the former but not the latter; TE/coach_change/
qb_change/pace never cleared the merge bar at all and stay off. The k=0.25
that first shipped for both RB and WR was the best of a grid that hadn't
turned over yet — a two-pass re-sweep (to 0.5, then to 0.9) found RB's real
peak at k=0.4 and WR's much larger real peak at k=0.7 (the single largest
effect size anywhere in this phase, decaying smoothly and monotonically on
both sides — a found peak, not a guess). Those numbers describe the
PYTHON. The browser runs `team-context.js:applyTeamChangeDiscount()`.

If the two drift, the app ships an arithmetic no one measured while the
commit message still quotes the measurement — the same failure
`anchor_parity.py`, `expert_blend_parity.py`, `injury_discount_parity.py`
and `opportunity_parity.py` already guard against elsewhere in this
pipeline.

UNLIKE those four, the shipped JS reads `last.team` directly off the player
object rather than a precomputed flags table — team_context.py's own
`context_flags()` exists for the BACKTEST's harder problem (deriving
team_prev/team_now from season-indexed lookups across years); the shipped
board already carries the current team (`player.team`) and last season's
team (`player.last.team`, added to `ingest_nflverse.py`'s output for
exactly this) on the row itself, so there is no equivalent lookup step to
parity-test. What IS shared and DOES need parity is the actual discount
arithmetic once "changed or not" is known — `apply_flag_discount()` — so
this drives that function directly with a `team_changed` flag computed the
same way `context_flags()` computes it (prev != now, both present), and
compares against the shipped JS's own team_prev/team_now/team_changed check.

Rounding is reconciled rather than tolerated, same approach as the other
four parity checks: the JS rounds a touched value to one decimal
(`toFixed(1)`, half away from zero) and leaves an untouched value exactly as
it was; the Python result goes through `projection_model._round1` only when
the multiplier isn't the identity, matching that skip exactly, so the
comparison is for EQUALITY.

  python team_change_parity.py
"""
from __future__ import annotations

import json
import os
import random
import subprocess

from projection_model import _round1
from team_context import apply_flag_discount

HERE = os.path.dirname(os.path.abspath(__file__))
NODE_SIDE = os.path.join(HERE, "team_change_parity.mjs")

# Must match TEAM_CHANGE_K in frontend/src/engine/team-context.js exactly —
# the weights the roadmap 1.3 backtest justified shipping. Both are found
# peaks: RB at 0.4, WR at 0.7 (large, but the cleanest/largest effect
# measured anywhere in this phase).
TEAM_CHANGE_K = {"QB": 0.0, "RB": 0.4, "WR": 0.7, "TE": 0.0, "K": 0.0, "DST": 0.0}
POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]
TEAMS = ["MIA", "NYJ", "DAL", "SF", "KC", "DEN", "", None]


def run_js(players, K):
    payload = json.dumps({"players": players, "K": K})
    res = subprocess.run([os.environ.get("NODE", "node"), NODE_SIDE],
                         input=payload, capture_output=True, text=True)
    if res.returncode != 0:
        raise SystemExit(f"node side failed:\n{res.stderr}")
    return json.loads(res.stdout)


def py_apply_all(players, K):
    """apply_flag_discount(), fed the SAME team_changed condition
    context_flags() uses (prev != now, both present) — driven per position
    group since apply_flag_discount() takes one shared k per call and the
    shipped weight is per-position, then rounded exactly like the JS's
    `toFixed(1)`: only a value that actually changed is rounded, so an
    untouched player's float representation can't drift from the JS's."""
    flags_by_id = {}
    for p in players:
        team_now = p.get("team")
        team_prev = (p.get("last") or {}).get("team")
        changed = (team_prev != team_now) if (team_prev and team_now) else False
        flags_by_id[p["id"]] = {"team_changed": changed}

    fake_players = [{"player_id": p["id"]} for p in players]
    projs = [p["valuePoints"] for p in players]
    out = list(projs)
    for pos in {p["pos"] for p in players}:
        k = K.get(pos, 0.0)
        idxs = [i for i, p in enumerate(players) if p["pos"] == pos]
        sub_out = apply_flag_discount(
            [projs[i] for i in idxs], [fake_players[i] for i in idxs], flags_by_id, "team_changed", k)
        for local_i, i in enumerate(idxs):
            raw = sub_out[local_i]
            out[i] = raw if raw == projs[i] else _round1(raw)
    return out


def make_case(rng, n=150, move_rate=0.4, missing_last_rate=0.15):
    players = []
    for i in range(n):
        pos = POSITIONS[i % len(POSITIONS)]
        vp = round(rng.uniform(20, 320), 1)
        team = rng.choice(TEAMS[:6])
        if rng.random() < missing_last_rate:
            last = None
        elif rng.random() < move_rate:
            others = [t for t in TEAMS[:6] if t != team]
            last = {"gp": 17, "team": rng.choice(others)}
        else:
            last = {"gp": 17, "team": team}
        players.append({"id": i, "pos": pos, "team": team, "valuePoints": vp, "last": last})
    return players


def main() -> None:
    rng = random.Random(41)
    checked = mismatches = 0

    cases = []
    for move_rate in (0.0, 0.2, 0.4, 0.7, 1.0):
        cases.append((f"shipped K, move_rate={move_rate:.0%}",
                       make_case(rng, move_rate=move_rate), TEAM_CHANGE_K))
    # Sweep k itself too, not just the shipped constants — every position at
    # a uniform nonzero k must discount a mover, not just RB/WR.
    for k in (0.0, 0.1, 0.5, 1.0):
        cases.append((f"uniform k={k}", make_case(rng, move_rate=0.5),
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
                          f"team={p['team']} last={p['last']} js={a} py={b}")

    if mismatches:
        raise SystemExit(f"team-change discount parity FAILED: {mismatches}/{checked} values differ")

    # Endpoint sanity, so a silently-inert discount cannot pass by doing nothing.
    players = make_case(rng, move_rate=0.5)
    at_zero = run_js(players, {pos: 0.0 for pos in POSITIONS})
    at_half = run_js(players, {pos: 0.5 for pos in POSITIONS})
    if at_zero != [p["valuePoints"] for p in players]:
        raise SystemExit("team-change discount parity FAILED: K=0 is not a no-op")
    if at_zero == at_half:
        raise SystemExit("team-change discount parity FAILED: K=0.5 changed nothing — discount is inert")

    print(f"team-change discount parity: {checked} values identical across {len(cases)} cases "
          f"(JS applyTeamChangeDiscount == apply_flag_discount)")


if __name__ == "__main__":
    main()

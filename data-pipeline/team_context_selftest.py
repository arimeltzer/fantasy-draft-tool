#!/usr/bin/env python3
"""
team_context_selftest.py — pins team_context.py's pure logic to known answers
================================================================================
Offline, no nflverse, no API key. Run before trusting the sweep in
projection_backtest.py that consumes these functions.

  python team_context_selftest.py
"""
from __future__ import annotations

from types import SimpleNamespace

from team_context import (
    apply_flag_discount, apply_pace, context_flags,
    team_coach_by_season, team_pace_by_season, team_qb_by_season,
)

FAILS = []


def check(label, cond, detail=""):
    print(f"  {'ok  ' if cond else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    if not cond:
        FAILS.append(label)


def row(**kw):
    return SimpleNamespace(**kw)


print("team_qb_by_season")
rows = [
    row(season=2023, pos="QB", team="CLE", player_id="flacco", attempts=300),
    row(season=2023, pos="QB", team="CLE", player_id="dtr", attempts=120),
    row(season=2023, pos="QB", team="CLE", player_id="mop_up", attempts=5),   # below threshold
    row(season=2023, pos="RB", team="CLE", player_id="chubb", attempts=0),    # not a QB
    row(season=2023, pos="QB", team="", player_id="no_team", attempts=200),   # no team
]
qb = team_qb_by_season(rows)
check("attempts leader wins", qb[(2023, "CLE")] == "flacco")
check("below-MIN_QB_ATTEMPTS rows can't win, but do not corrupt the winner",
      qb.get((2023, "CLE")) != "mop_up")
check("a team with no qualifying QB has no entry", (2023, "") not in qb)

print("\nteam_coach_by_season")
sched_rows = [
    (2022, "MIA", "Mike McDaniel", "NE", "Bill Belichick"),
    (2022, "MIA", "Mike McDaniel", "BUF", "Sean McDermott"),
    (2022, "MIA", "Mike McDaniel", "NYJ", "Robert Saleh"),
    (2015, "IND", "Chuck Pagano", "DEN", "Gary Kubiak"),
]
coach = team_coach_by_season(sched_rows)
check("modal coach wins", coach[(2022, "MIA")] == "Mike McDaniel")
check("a coach seen once still registers", coach[(2015, "IND")] == "Chuck Pagano")

print("\nteam_pace_by_season")
pace = team_pace_by_season([(2023, "CLE", 500, 400, 40, 17)])
check("plays = attempts + carries + sacks, over games",
      abs(pace[(2023, "CLE")] - (500 + 400 + 40) / 17) < 1e-9)
check("a team with 0 games played is skipped, not divide-by-zero",
      (2023, "BYE") not in team_pace_by_season([(2023, "BYE", 10, 10, 0, 0)]))

print("\ncontext_flags")
qb_by_team = {(2022, "CLE"): "brissett", (2022, "HOU"): "mills", (2023, "CLE"): "flacco"}
coach_by_team = {(2022, "MIA"): "old_coach", (2023, "MIA"): "new_coach",
                 (2022, "CLE"): "stefanski", (2023, "CLE"): "stefanski"}
pace_by_team = {(2022, "CLE"): 65.0, (2022, "HOU"): 60.0, (2022, "MIA"): 62.5}

f_same_team = context_flags("WR", "CLE", "CLE", 2023, qb_by_team, coach_by_team, pace_by_team)
check("no team move -> team_changed False", f_same_team["team_changed"] is False)
check("QB signal uses ONLY season Y-1 on both sides (zero look-ahead): "
      "same team, same Y-1 QB -> qb_changed False", f_same_team["qb_changed"] is False)
check("coach unchanged -> coach_changed False", f_same_team["coach_changed"] is False)
check("pace_ratio computed from team_now's Y-1 pace vs the Y-1 league mean",
      f_same_team["pace_ratio"] is not None)

f_moved = context_flags("WR", "HOU", "CLE", 2023, qb_by_team, coach_by_team, pace_by_team)
check("team move -> team_changed True", f_moved["team_changed"] is True)
check("moved to a team with a different Y-1 QB -> qb_changed True",
      f_moved["qb_changed"] is True)

f_qb_pos = context_flags("QB", "HOU", "CLE", 2023, qb_by_team, coach_by_team, pace_by_team)
check("qb_changed is only computed for RB/WR/TE, never QB itself",
      f_qb_pos["qb_changed"] is None)

f_rookie = context_flags("RB", None, "CLE", 2023, qb_by_team, coach_by_team, pace_by_team)
check("no prior team (rookie) -> every flag is None, not False",
      f_rookie["team_changed"] is None and f_rookie["qb_changed"] is None
      and f_rookie["coach_changed"] is None)

f_coach = context_flags("TE", "MIA", "MIA", 2023, qb_by_team, coach_by_team, pace_by_team)
check("same team, coach fired -> coach_changed True", f_coach["coach_changed"] is True)

print("\napply_flag_discount / apply_pace")
players = [{"player_id": "a"}, {"player_id": "b"}, {"player_id": "c"}]
flags = {"a": {"team_changed": True}, "b": {"team_changed": False}}  # c: no entry at all
projs = [100.0, 100.0, 100.0]
out = apply_flag_discount(projs, players, flags, "team_changed", 0.1)
check("flagged True is discounted by exactly k", abs(out[0] - 90.0) < 1e-9)
check("flagged False is untouched", out[1] == 100.0)
check("missing/unknown is untouched, not treated as False-that-happens-to-match",
      out[2] == 100.0)
check("k=0 reproduces the input exactly (the sweep's own baseline arm)",
      apply_flag_discount(projs, players, flags, "team_changed", 0.0) == projs)

pace_flags = {"a": {"pace_ratio": 1.2}, "b": {"pace_ratio": 0.8}}
pout = apply_pace(projs, players, pace_flags, k=1.0)
check("pace_ratio > 1 scales the projection up at k=1", abs(pout[0] - 120.0) < 1e-9)
check("pace_ratio < 1 scales the projection down at k=1", abs(pout[1] - 80.0) < 1e-9)
check("no pace_ratio -> untouched", pout[2] == 100.0)
check("k=0 reproduces the input exactly regardless of pace_ratio",
      apply_pace(projs, players, pace_flags, k=0.0) == projs)

print(f"\nteam_context_selftest: {'FAILED: ' + ', '.join(FAILS) if FAILS else 'all checks passed'}")
if FAILS:
    raise SystemExit(1)

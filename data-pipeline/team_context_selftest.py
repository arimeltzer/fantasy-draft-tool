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
    apply_flag_discount, apply_pace, apply_team_change_quality, context_flags,
    league_quality_stats, team_coach_by_season, team_pace_by_season,
    team_qb_by_season, team_quality_by_season,
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

print("\nteam_quality_by_season / league_quality_stats")
quality_rows = [
    (2023, "SF", 100.0, 60.0, 500, 400, 30, 16),   # (100+60)/930 plays
    (2023, "NYJ", -150.0, -100.0, 500, 400, 30, 16),
    (2023, "AVG", 0.0, 0.0, 500, 400, 30, 16),
]
quality = team_quality_by_season(quality_rows)
check("epa/play = (passing_epa + rushing_epa) / plays, receiving_epa NOT added in",
      abs(quality[(2023, "SF")] - (100.0 + 60.0) / 930) < 1e-9)
check("a bad offense reads negative", quality[(2023, "NYJ")] < 0)
mean, sd = league_quality_stats(quality, 2023)
check("league mean/stdev computed across the season's teams", mean is not None and sd is not None)
check("a single-team season has no spread to z-score against",
      league_quality_stats({(2023, "ONLY"): 0.05}, 2023) == (None, None))

print("\ncontext_flags")
# CLE: same team, but a NEW starter actually took over in Y (the case
# team_changed structurally can't see). HOU: same team, SAME starter both
# years -- the null case that must stay False.
qb_by_team = {(2022, "CLE"): "brissett", (2023, "CLE"): "flacco",
              (2022, "HOU"): "mills", (2023, "HOU"): "mills"}
coach_by_team = {(2022, "MIA"): "old_coach", (2023, "MIA"): "new_coach",
                 (2022, "CLE"): "stefanski", (2023, "CLE"): "stefanski"}
pace_by_team = {(2022, "CLE"): 65.0, (2022, "HOU"): 60.0, (2022, "MIA"): 62.5}
quality_by_team = {(2022, "CLE"): 0.05, (2022, "HOU"): -0.10, (2022, "MIA"): 0.02,
                    (2022, "NYJ"): -0.20, (2022, "DAL"): 0.10}

f_same_team_new_qb = context_flags("WR", "CLE", "CLE", 2023, qb_by_team, coach_by_team, pace_by_team)
check("no team move -> team_changed False", f_same_team_new_qb["team_changed"] is False)
check("QB signal compares the player's OWN Y-1 QB against team_now's Y "
      "starter (mirrors coach_changed's proxy, not a Y-1-vs-Y-1 comparison "
      "that would trivially always read False here): same team, DIFFERENT "
      "Y starter -> qb_changed True, the one case team_changed can't see",
      f_same_team_new_qb["qb_changed"] is True)
check("coach unchanged -> coach_changed False", f_same_team_new_qb["coach_changed"] is False)
check("pace_ratio computed from team_now's Y-1 pace vs the Y-1 league mean",
      f_same_team_new_qb["pace_ratio"] is not None)

f_same_team_same_qb = context_flags("WR", "HOU", "HOU", 2023, qb_by_team, coach_by_team, pace_by_team)
check("same team, SAME starter both years -> qb_changed False",
      f_same_team_same_qb["qb_changed"] is False)

f_moved = context_flags("WR", "HOU", "CLE", 2023, qb_by_team, coach_by_team, pace_by_team)
check("team move -> team_changed True", f_moved["team_changed"] is True)
check("moved to a team whose Y starter differs from the player's own Y-1 QB "
      "-> qb_changed True", f_moved["qb_changed"] is True)

f_qb_pos = context_flags("QB", "HOU", "CLE", 2023, qb_by_team, coach_by_team, pace_by_team)
check("qb_changed is only computed for RB/WR/TE, never QB itself",
      f_qb_pos["qb_changed"] is None)

f_rookie = context_flags("RB", None, "CLE", 2023, qb_by_team, coach_by_team, pace_by_team)
check("no prior team (rookie) -> every flag is None, not False",
      f_rookie["team_changed"] is None and f_rookie["qb_changed"] is None
      and f_rookie["coach_changed"] is None)

f_coach = context_flags("TE", "MIA", "MIA", 2023, qb_by_team, coach_by_team, pace_by_team)
check("same team, coach fired -> coach_changed True", f_coach["coach_changed"] is True)

check("quality_z is None when no quality table is passed at all",
      f_moved["quality_z"] is None)

f_quality = context_flags("WR", "HOU", "DAL", 2023, qb_by_team, coach_by_team, pace_by_team,
                           quality_by_team)
check("quality_z is computed once a quality table is supplied",
      f_quality["quality_z"] is not None)
check("moving to a well-above-average offense (DAL) -> positive quality_z",
      f_quality["quality_z"] > 0)

f_quality_bad = context_flags("WR", "CLE", "NYJ", 2023, qb_by_team, coach_by_team, pace_by_team,
                               quality_by_team)
check("moving to a well-below-average offense (NYJ) -> negative quality_z",
      f_quality_bad["quality_z"] < 0)

check("QUALITY_Z_CLAMP actually bounds an extreme value",
      context_flags("WR", "HOU", "DAL", 2023, qb_by_team, coach_by_team, pace_by_team,
                     {**quality_by_team, (2022, "DAL"): 50.0})["quality_z"] <= 2.0)

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

print("\napply_team_change_quality")
tcq_players = [{"player_id": "avg_mover"}, {"player_id": "good_mover"},
               {"player_id": "bad_mover"}, {"player_id": "stayed"},
               {"player_id": "moved_no_quality"}]
tcq_flags = {
    "avg_mover": {"team_changed": True, "quality_z": 0.0},
    "good_mover": {"team_changed": True, "quality_z": 2.0},
    "bad_mover": {"team_changed": True, "quality_z": -2.0},
    "stayed": {"team_changed": False, "quality_z": 1.5},
    "moved_no_quality": {"team_changed": True},   # no quality_z key at all
}
tcq_projs = [100.0] * 5
tcq_out = apply_team_change_quality(tcq_projs, tcq_players, tcq_flags, k=0.1)
by_id = dict(zip((p["player_id"] for p in tcq_players), tcq_out))
check("quality_z=0 (average destination) reproduces the flat (1-k) discount exactly",
      abs(by_id["avg_mover"] - 90.0) < 1e-9)
check("a strongly above-average destination shrinks the discount below flat",
      by_id["good_mover"] > by_id["avg_mover"])
check("a strongly below-average destination deepens the discount below flat",
      by_id["bad_mover"] < by_id["avg_mover"])
check("a player who stayed put is untouched regardless of quality_z",
      by_id["stayed"] == 100.0)
check("a mover with no quality_z on record falls back to the flat discount, "
      "not to 'untouched'", abs(by_id["moved_no_quality"] - 90.0) < 1e-9)

extreme_out = apply_team_change_quality(
    [100.0], [{"player_id": "x"}], {"x": {"team_changed": True, "quality_z": 2.0}}, k=10.0)
check("QUALITY_MULT_FLOOR/CEIL bound an absurd k rather than inverting the projection",
      0.0 <= extreme_out[0] <= 200.0)

check("k=0 reproduces the input exactly (the sweep's own baseline arm)",
      apply_team_change_quality(tcq_projs, tcq_players, tcq_flags, k=0.0) == tcq_projs)

print(f"\nteam_context_selftest: {'FAILED: ' + ', '.join(FAILS) if FAILS else 'all checks passed'}")
if FAILS:
    raise SystemExit(1)

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
    apply_flag_discount, apply_pace, apply_team_change_nuance, apply_team_change_quality,
    commitment_by_player_season, context_flags, league_commitment_stats, league_quality_stats,
    team_coach_by_season, team_dropbacks_by_season, team_pace_by_season, team_pass_pro_by_season,
    team_qb_by_season, team_quality_by_season, team_run_block_by_season,
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

print("\nteam_run_block_by_season / team_dropbacks_by_season / team_pass_pro_by_season")
run_block_rows = [
    (2023, "BAL", 250.0, 100),   # 2.5 ybc/carry
    (2023, "TB", 150.0, 100),    # 1.5 ybc/carry -- worse blocking
]
run_block = team_run_block_by_season(run_block_rows)
check("yards before contact per carry, credited to blocking not the runner",
      abs(run_block[(2023, "BAL")] - 2.5) < 1e-9)
check("a worse-blocking team reads lower", run_block[(2023, "TB")] < run_block[(2023, "BAL")])
check("zero carries doesn't divide-by-zero",
      (2023, "BYE") not in team_run_block_by_season([(2023, "BYE", 10.0, 0)]))

dropbacks = team_dropbacks_by_season([(2023, "BAL", 500, 30)])
check("dropbacks = attempts + sacks_suffered", dropbacks[(2023, "BAL")] == 530)

pass_pro = team_pass_pro_by_season(
    [(2023, "BAL", 100.0), (2023, "BAL", 20.0)],  # two QBs on the same team, summed
    {(2023, "BAL"): 530, (2023, "TB"): 200})
check("times_pressured summed across a team's passers, over dropbacks",
      abs(pass_pro[(2023, "BAL")] - 120.0 / 530) < 1e-9)
check("a team missing from dropbacks_by_team has no reading (can't divide by nothing)",
      (2023, "TB") not in team_pass_pro_by_season([(2023, "TB", 50.0)], {(2023, "BAL"): 530}))

print("\ncommitment_by_player_season / league_commitment_stats")
contract_rows = [
    (2022, "00-001", "WR", 0.086),   # Kirk-sized JAX deal
    (2022, "00-002", "WR", 0.010),   # a minimum-ish deal, same season/pos
    (2022, "00-003", "RB", 0.045),   # different position -- own group
    (2022, "00-001", "WR", 0.040),   # a second, SMALLER row same player/season -- larger wins
]
commitment = commitment_by_player_season(contract_rows)
check("the LARGEST apy_cap_pct wins when a player has two rows the same season",
      abs(commitment[(2022, "00-001")][0] - 0.086) < 1e-9)
check("position is carried alongside the value for later position-scoped z-scoring",
      commitment[(2022, "00-001")][1] == "WR")
mean_wr, sd_wr = league_commitment_stats(commitment, 2022, "WR")
check("commitment stats are computed within (season, position), not across positions",
      mean_wr is not None and abs(mean_wr - (0.086 + 0.010) / 2) < 1e-9)
check("a position with fewer than 2 signings that season has no spread",
      league_commitment_stats(commitment, 2022, "RB") == (None, None))

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

check("Z_CLAMP actually bounds an extreme value",
      context_flags("WR", "HOU", "DAL", 2023, qb_by_team, coach_by_team, pace_by_team,
                     {**quality_by_team, (2022, "DAL"): 50.0})["quality_z"] <= 2.0)

run_block_by_team = {(2022, "CLE"): 2.0, (2022, "HOU"): 3.0, (2022, "DAL"): 3.5,
                     (2022, "NYJ"): 1.5, (2022, "MIA"): 2.2}
pass_pro_by_team = {(2022, "CLE"): 0.20, (2022, "HOU"): 0.30, (2022, "DAL"): 0.10,
                    (2022, "NYJ"): 0.35, (2022, "MIA"): 0.18}

f_oline_none = context_flags("RB", "HOU", "CLE", 2023, qb_by_team, coach_by_team, pace_by_team)
check("oline_z is None when no oline tables are passed at all",
      f_oline_none["oline_z"] is None)

f_rb_good_line = context_flags("RB", "HOU", "DAL", 2023, qb_by_team, coach_by_team, pace_by_team,
                               None, run_block_by_team, pass_pro_by_team)
check("RB moving to a good run-blocking team -> positive oline_z, from run_block not pass_pro",
      f_rb_good_line["oline_z"] is not None and f_rb_good_line["oline_z"] > 0)

f_wr_good_line = context_flags("WR", "HOU", "DAL", 2023, qb_by_team, coach_by_team, pace_by_team,
                               None, run_block_by_team, pass_pro_by_team)
check("WR/QB/TE read pass_pro instead — DAL allows the LOWEST pressure rate -> positive oline_z",
      f_wr_good_line["oline_z"] is not None and f_wr_good_line["oline_z"] > 0)

f_wr_bad_line = context_flags("WR", "CLE", "NYJ", 2023, qb_by_team, coach_by_team, pace_by_team,
                              None, run_block_by_team, pass_pro_by_team)
check("NYJ allows the HIGHEST pressure rate -> negative oline_z for a pass-catcher",
      f_wr_bad_line["oline_z"] is not None and f_wr_bad_line["oline_z"] < 0)

commitment_by_player = {(2023, "wr_big"): (0.09, "WR"), (2023, "wr_small"): (0.01, "WR"),
                        (2023, "wr_mid"): (0.03, "WR")}
f_commit_none = context_flags("WR", "HOU", "CLE", 2023, qb_by_team, coach_by_team, pace_by_team)
check("commitment_z is None when no commitment table is passed at all",
      f_commit_none["commitment_z"] is None)

f_big_deal = context_flags("WR", "HOU", "CLE", 2023, qb_by_team, coach_by_team, pace_by_team,
                           None, None, None, commitment_by_player, player_id="wr_big")
check("a big new contract -> positive commitment_z",
      f_big_deal["commitment_z"] is not None and f_big_deal["commitment_z"] > 0)

f_no_new_deal = context_flags("WR", "HOU", "CLE", 2023, qb_by_team, coach_by_team, pace_by_team,
                              None, None, None, commitment_by_player, player_id="someone_else")
check("no contract on record that season (e.g. a trade, not free agency) -> commitment_z None",
      f_no_new_deal["commitment_z"] is None)

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
check("NUANCE_MULT_FLOOR/CEIL bound an absurd k rather than inverting the projection",
      0.0 <= extreme_out[0] <= 200.0)

check("k=0 reproduces the input exactly (the sweep's own baseline arm)",
      apply_team_change_quality(tcq_projs, tcq_players, tcq_flags, k=0.0) == tcq_projs)

print("\napply_team_change_nuance (generic — oline_z and commitment_z, not just quality_z)")
check("apply_team_change_quality IS apply_team_change_nuance with signal_key='quality_z'",
      apply_team_change_quality(tcq_projs, tcq_players, tcq_flags, k=0.1)
      == apply_team_change_nuance(tcq_projs, tcq_players, tcq_flags, "quality_z", k=0.1))

nuance_players = [{"player_id": "good_line"}, {"player_id": "bad_line"}, {"player_id": "big_deal"}]
nuance_flags = {
    "good_line": {"team_changed": True, "oline_z": 1.5},
    "bad_line": {"team_changed": True, "oline_z": -1.5},
    "big_deal": {"team_changed": True, "commitment_z": 2.0},
}
nuance_projs = [100.0] * 3
oline_out = apply_team_change_nuance(nuance_projs, nuance_players, nuance_flags, "oline_z", k=0.2)
by_nuance = dict(zip((p["player_id"] for p in nuance_players), oline_out))
check("a good-oline mover is discounted LESS than the flat (1-k) rate",
      by_nuance["good_line"] > 80.0)
check("a bad-oline mover is discounted MORE than the flat rate",
      by_nuance["bad_line"] < 80.0)

commit_out = apply_team_change_nuance(nuance_projs, nuance_players, nuance_flags, "commitment_z", k=0.2)
by_commit = dict(zip((p["player_id"] for p in nuance_players), commit_out))
check("a big-contract mover is discounted less using commitment_z as the signal",
      by_commit["big_deal"] > 80.0)
check("a mover with no commitment_z at all (only has oline_z) falls back to the "
      "flat discount when signal_key='commitment_z'",
      abs(by_commit["good_line"] - 80.0) < 1e-9)

print(f"\nteam_context_selftest: {'FAILED: ' + ', '.join(FAILS) if FAILS else 'all checks passed'}")
if FAILS:
    raise SystemExit(1)

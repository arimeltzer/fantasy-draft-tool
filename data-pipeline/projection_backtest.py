#!/usr/bin/env python3
"""
projection_backtest.py — does the SHIPPED projection beat a naive baseline?
==========================================================================
Replaces `backtest_parameters.py`, which scored a degenerate formula the app
never runs (see docs/PROJECTION_BACKTEST.md).

WHAT IT MEASURES
  For each test season Y, build every player the way the app does at draft time
  — `last` = season Y-1, `last2` = season Y-2, age as of Y — run the real
  `projectPoints()` (via `projection_model.py`, parity-checked against the JS),
  then compare the projected ORDER to what actually happened in Y.

WHY RANK CORRELATION
  A draft board is a ranking. Being uniformly 15% low costs nothing if the order
  holds; MAE/RMSE punish that heavily and reward a well-calibrated model that
  orders players badly. Spearman is the metric that matches the use.
  Top-N hit rate is reported alongside because that is what the first few rounds
  actually turn on.

TWO TARGETS, deliberately both
  total — actual season points. What you really got, so missed games count
          against the player. This is the honest draft-day target.
  pace  — actual per-game x 17. Measures talent projection with availability
          removed. The gap between the two is the cost of injuries.

BASELINES
  pace1  — last season's per-game pace. The "just use last year" strawman.
  adp    — FantasyPros preseason consensus, i.e. the market. Only scored on the
           players it actually ranks (see POPULATIONS).

POPULATIONS, because which players you score decides the answer
  matched_adp — only players the market ranks. The only fair model-vs-market
                comparison; the market wins here at every position.
  all         — every player with prior-season history, which is the board the
                app must actually produce. ADP has no opinion on ~50% of it, so
                the market cannot be scored here at all. The question becomes
                whether anchoring the covered slice to the market beats the
                model we already ship — the COVERAGE MERGE.

DIAGNOSTIC: `disagreement_signal()` asks whether the model's disagreements with
the market carry any information. If they do not, no blend weight can help, and
the fix has to be in the model rather than in the mixing.

CAVEAT, stated because it bounds every number below: players are scored only if
they appear in season Y. Someone who was projected well and then never played is
excluded rather than counted as a miss, so all correlations here flatter every
model equally, the shipped one included.

RUN
  pip install nflreadpy pandas scipy numpy pyarrow
  python projection_backtest.py --out ./backtest_results
"""
from __future__ import annotations

import argparse
import json
import math
import os
from datetime import date
from itertools import product

import pandas as pd
from scipy import stats

# nflreadpy is imported lazily inside the loaders. Everything else here —
# blend_with_market, disagreement_signal, score — is pure arithmetic, and
# `anchor_parity.py` has to import them to check the shipped JS against them.
# A module-level import would have made that check drag a season-data library
# (and polars, and pyarrow) into a job that never touches the network.

from projection_model import DEFAULT_PARAMS, default_scoring, points as _model_points, \
    project_points, rookie_projection, with_overrides
from outcome_distribution import (
    CONDITIONINGS, QUANTILE_METHODS, age_bucket, covers, crps_empirical,
    expected_coverage, fit_residuals, lookup_ratios, pit, rank_tier, residual_ratio,
)
from projection_opportunity import league_efficiency, project_points_opportunity
from projection_v2 import league_rates, stabilize_player
from rookie_capital import draft_capital_by_player, rookie_capital_curve, rookie_capital_projection
from team_context import (
    apply_flag_discount, apply_pace, apply_team_change_nuance, context_flags, team_qb_by_season,
)

# Prior strength for v2's touchdown shrinkage, as a multiple of a typical
# season's workload. 0 must reproduce the shipped model exactly (checked).
V2_K = [0.0, 0.25, 0.5, 1.0, 2.0, 4.0]

# Roadmap 1.3: team continuity / workload signals. team_change, qb_change and
# coach_change are direct fractional discounts (k IS the fraction, unlike
# V2_K/OPP_K which scale a fitted shrinkage prior) — 0 must reproduce the
# shipped model exactly, same as every other sweep here. pace_ratio is
# already a ratio to league average, so its k scales how much of that ratio
# passes through (k=1 is a full linear pass-through).
# Extended TWICE past the originally-shipped grid's top (0.25) — that sweep
# was still climbing at 0.25 when TEAM_CHANGE_K shipped, so 0.25 was the
# best OF WHAT WAS TRIED, not a found optimum. The first re-run (to 0.5)
# found RB's real peak (0.4, shipped) but WR was STILL climbing at 0.5, so
# this second extension pushes further to actually locate WR's peak rather
# than repeat the same mistake with a bigger number.
TEAM_CHANGE_K = [0.0, 0.02, 0.05, 0.08, 0.12, 0.18, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
QB_CHANGE_K = [0.0, 0.02, 0.05, 0.08, 0.12, 0.18, 0.25]
COACH_CHANGE_K = [0.0, 0.02, 0.05, 0.08, 0.12, 0.18, 0.25]
PACE_K = [0.0, 0.25, 0.5, 1.0, 1.5, 2.0]

# Follow-up to the shipped flat TEAM_CHANGE_K: does nuancing the discount
# with WHERE a player landed (destination offensive quality, z-scored) beat
# the flat version? At quality_z=0 this reproduces the flat discount exactly
# (see apply_team_change_quality), so k=0 in THIS grid is the pure model
# with no team-change adjustment at all, same convention as TEAM_CHANGE_K.
# Extended past 0.25 on purpose — the original TEAM_CHANGE_K sweep was still
# climbing at its top value (0.25) when it was shipped, so the true optimum
# was never actually found; this grid checks whether it's out past there.
TEAM_CHANGE_QUALITY_K = [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]

# Second follow-up: two MORE targeted nuances than whole-team EPA — O-line
# (run block for RB, pass pro for QB/WR/TE) and contract commitment (does
# the SIZE of the deal a mover signed predict how big a discount he needs).
# Same grid shape and k=0 convention as TEAM_CHANGE_QUALITY_K.
TEAM_CHANGE_OLINE_K = [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]
TEAM_CHANGE_COMMITMENT_K = [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]

# Prior strength for the opportunity model's efficiency shrinkage (roadmap
# 1.1/1.2), same units as V2_K. Unlike V2_K, k=0 here is NOT the shipped
# model (see projection_opportunity.project_points_opportunity) — it's the
# two-stage model's own unshrunk arm.
OPP_K = [0.0, 0.25, 0.5, 1.0, 2.0, 4.0]

# Phase 1 gate thresholds (docs/ROADMAP.md), fixed at module level so both the
# original gate and the re-baselined one below read the identical bar.
MATERIAL_EPS = 0.03   # absolute partial-correlation increase required
MERGE_EPS = 0.003     # the v2 attempt's own number; must be EXCEEDED, not matched

# The ACTUAL constants shipped in engine-core.js — kept in sync by hand, same
# as GATE_MATCHED/GATE_MERGED below. Used to re-baseline Phase 1 against what
# is really live (injury discount + expert blend + anchor), not the pre-
# Phase-0 pure model every other sweep in this file compares against. That
# choice is right for judging an idea's OWN marginal contribution in
# isolation (how v2, 0.1 and 0.3 were each judged) but wrong for judging
# whether a NEW idea is worth shipping ON TOP of what already shipped.
EXPERT_SHIPPED_W = {"QB": 0.3, "RB": 0.2, "TE": 0.2, "WR": 0.4, "K": 1.0, "DST": 1.0}
INJ_SHIPPED_K = {"QB": 0.5, "RB": 0.5, "TE": 0.0, "WR": 0.0, "K": 0.0, "DST": 0.0}


def apply_injury_shipped(pop, projs, injury_by_player, K=INJ_SHIPPED_K):
    """injury_multiplier(), per-position K, applied across a population —
    the list-shaped equivalent of engine-core.js applyInjuryDiscount()."""
    out = list(projs)
    for i, p in enumerate(pop):
        k = K.get(p["pos"], 0.0)
        if k <= 0:
            continue
        severity = injury_by_player.get(p["player_id"])
        out[i] = projs[i] * injury_multiplier(severity, k)
    return out


def apply_expert_shipped(pop, projs, expert_by_player, W=EXPERT_SHIPPED_W):
    """blend_expert(), per-position W, applied across a population — the
    list-shaped equivalent of engine-core.js blendExpertAll(). Unlike the
    0.1 sweep (one shared w per run, position read out of score()'s
    breakdown), this applies each position's OWN shipped weight in a single
    pass, because that is what the live board actually does."""
    out = list(projs)
    for i, p in enumerate(pop):
        w = W.get(p["pos"])
        if w is None or w >= 1:
            continue
        e = expert_by_player.get(p["player_id"])
        out[i] = blend_expert([projs[i]], [e], w)[0]
    return out

try:
    from adp_probe import fetch_adp          # needs FANTASYPROS_API_KEY
    from fantasypros import fetch_injuries, fetch_projections
    from fantasypros import norm as fp_norm
except Exception:                             # probe/key absent -> ADP skipped
    fetch_adp = None
    fetch_injuries = None
    fetch_projections = None
    fp_norm = None

# Roadmap 0.3: expected games missed by injury severity, out of a full
# season. `injury_probe.py` found real per-season signal mainly at the "out"
# tier (IR/PUP/Suspended/OUT/COV-IR) -- doubtful/questionable are too rare in
# a week-0 report to calibrate a games-missed number from directly, so those
# two are set as a conservative fraction of "out" rather than fit. K scales
# the whole table for the sweep; K=0 must reproduce the shipped model exactly.
INJURY_GAMES_MISSED = {"out": 6.0, "doubtful": 2.0, "questionable": 0.5}
INJ_K = [0.0, 0.5, 1.0, 1.5, 2.0]


def injury_multiplier(severity, K, G=17):
    """Discount for expected games missed, same shape as durabilityMult."""
    if not severity or K <= 0:
        return 1.0
    missed = INJURY_GAMES_MISSED.get(severity, 0.0) * K
    return max(0.0, (G - missed) / G)

# Blend weights on OUR model when mixing in the experts' projection (0.1).
EXPERT_W = [round(x / 10, 1) for x in range(0, 11)]
# The weight the app actually ships (engine-core.js MARKET_ANCHOR_W).
MARKET_ANCHOR_W = 0.3

FANTASY_POS = {"QB", "RB", "WR", "TE"}
PPR = 0.5

# nflverse season-total column -> engine `last`/`last2` field.
COMP = {
    "passing_yards": "passYd", "passing_tds": "passTD", "interceptions": "int",
    "rushing_yards": "rushYd", "rushing_tds": "rushTD",
    "receptions": "rec", "receiving_yards": "recYd", "receiving_tds": "recTD",
}

# Volume, carried alongside the scoring components. These are NOT worth points,
# so `points()` ignores them; they exist so v2 can shrink a touchdown rate
# against the opportunities that produced it.
VOLUME = {"carries": "carries", "targets": "targets", "attempts": "attempts"}


def _pd(df):
    return df.to_pandas() if hasattr(df, "to_pandas") else df


def _col(df, *names):
    for n in names:
        if n in df.columns:
            return n
    return None


def load_seasons(years) -> pd.DataFrame:
    """One row per (season, player): the engine's season line + games played."""
    import nflreadpy as nfl
    frames = []
    for y in years:
        print(f"  loading {y}…", end=" ", flush=True)
        df = _pd(nfl.load_player_stats(y, summary_level="reg"))
        pos_c = _col(df, "position", "pos")
        df = df[df[pos_c].isin(FANTASY_POS)].copy()
        gp_c = _col(df, "games", "games_played")
        id_c = _col(df, "player_id", "gsis_id")
        name_c = _col(df, "player_display_name", "player_name")
        team_c = _col(df, "team", "recent_team")

        keep = pd.DataFrame({
            "season": y,
            "player_id": df[id_c],
            "name": df[name_c],
            "pos": df[pos_c],
            "team": df[team_c] if team_c else "",
            "gp": df[gp_c].fillna(0).astype(int),
        })
        for src, dst in {**COMP, **VOLUME}.items():
            keep[dst] = df[src].fillna(0) if src in df.columns else 0
        fum = 0
        for c in ("rushing_fumbles_lost", "receiving_fumbles_lost", "sack_fumbles_lost"):
            if c in df.columns:
                fum = fum + df[c].fillna(0)
        keep["fumbles"] = fum
        frames.append(keep)
        print(f"{len(keep)} rows")
    return pd.concat(frames, ignore_index=True)


def load_ages(years) -> dict:
    """(season, player_id) -> age on Sept 1 of that season."""
    import nflreadpy as nfl
    ages = {}
    for y in years:
        try:
            r = _pd(nfl.load_rosters(y))
        except Exception as e:
            print(f"  ! rosters {y} unavailable ({e}); ages blank for that year")
            continue
        id_c = _col(r, "gsis_id", "player_id")
        b_c = _col(r, "birth_date")
        if not id_c or not b_c:
            continue
        ref = date(y, 9, 1)
        for pid, bd in zip(r[id_c], pd.to_datetime(r[b_c], errors="coerce")):
            if pid and pd.notna(bd):
                ages[(y, pid)] = round(
                    (ref - bd.date()).days / 365.25, 1)
    return ages


def load_team_context(years):
    """(coach_by_team, pace_by_team, quality_by_team, ts) for roadmap 1.3 —
    see team_context.py for what each is and why it's read the way it is.
    All are independent of load_seasons()/load_ages(); the QB-starter
    signal reuses load_seasons()'s own player rows instead of a fourth
    network call. `ts` (the raw team_stats frame) is returned too so
    load_oline_context() can reuse it for dropbacks instead of re-fetching."""
    import nflreadpy as nfl
    import team_context as tc

    sched = _pd(nfl.load_schedules(list(years)))
    coach_rows = (
        (int(r.season), r.home_team, r.home_coach, r.away_team, r.away_coach)
        for r in sched.itertuples()
    )
    coach_by_team = tc.team_coach_by_season(coach_rows)

    ts = _pd(nfl.load_team_stats(list(years), summary_level="reg"))
    pace_rows = (
        (int(r.season), r.team, r.attempts, r.carries,
         getattr(r, "sacks_suffered", 0), r.games)
        for r in ts.itertuples()
    )
    pace_by_team = tc.team_pace_by_season(pace_rows)

    quality_rows = (
        (int(r.season), r.team, r.passing_epa, r.rushing_epa, r.attempts,
         r.carries, getattr(r, "sacks_suffered", 0), r.games)
        for r in ts.itertuples()
    )
    quality_by_team = tc.team_quality_by_season(quality_rows)
    return coach_by_team, pace_by_team, quality_by_team, ts


# PFR advanced stats only cover 2018-2025 — nflreadpy raises for a mixed
# request outside that range, so the year list has to be pre-filtered
# rather than caught after the fact.
PFR_ADVSTATS_MIN_YEAR = 2018
PFR_ADVSTATS_MAX_YEAR = 2025


def load_oline_context(years, ts):
    """(run_block_by_team, pass_pro_by_team) for the roadmap 1.3 second
    follow-up — see team_context.py for what each is and why. `ts` is the
    team_stats frame load_team_context() already fetched (for dropbacks);
    passed in rather than re-fetched. Real coverage gap, not a bug: PFR
    advanced stats only go back to 2018, so years before that return
    nothing for either dict (context_flags() reads that as "no signal",
    same as every other missing-data case in this pipeline)."""
    import nflreadpy as nfl
    import team_context as tc

    pfr_years = [y for y in years if PFR_ADVSTATS_MIN_YEAR <= y <= PFR_ADVSTATS_MAX_YEAR]
    if not pfr_years:
        print(f"  ! no seasons in {PFR_ADVSTATS_MIN_YEAR}-{PFR_ADVSTATS_MAX_YEAR} range — "
              "oline signals will be empty for this run")
        return {}, {}

    rush = _pd(nfl.load_pfr_advstats(pfr_years, stat_type="rush"))
    run_block_rows = (
        (int(r.season), r.team, r.rushing_yards_before_contact, r.carries)
        for r in rush.itertuples()
    )
    run_block_by_team = tc.team_run_block_by_season(run_block_rows)

    dropback_rows = (
        (int(r.season), r.team, r.attempts, getattr(r, "sacks_suffered", 0))
        for r in ts.itertuples()
    )
    dropbacks_by_team = tc.team_dropbacks_by_season(dropback_rows)

    pass_df = _pd(nfl.load_pfr_advstats(pfr_years, stat_type="pass"))
    pressure_rows = (
        (int(r.season), r.team, r.times_pressured)
        for r in pass_df.itertuples()
    )
    pass_pro_by_team = tc.team_pass_pro_by_season(pressure_rows, dropbacks_by_team)
    return run_block_by_team, pass_pro_by_team


def load_commitment_context():
    """commitment_by_player, roadmap 1.3 second follow-up — see
    team_context.py. load_contracts() is a full historical table (no year
    filter accepted/needed); every contract a player ever signed, keyed by
    year_signed."""
    import nflreadpy as nfl
    import team_context as tc

    contracts = _pd(nfl.load_contracts())
    rows = (
        (int(r.year_signed), r.gsis_id, r.position, r.apy_cap_pct)
        for r in contracts.itertuples()
        if pd.notna(r.gsis_id) and pd.notna(r.year_signed) and pd.notna(r.apy_cap_pct)
    )
    return tc.commitment_by_player_season(rows)


def load_draft_capital(years):
    """draft_capital_by_player, roadmap 1.4 — see rookie_capital.py.
    load_draft_picks() is one row per pick, PFR-sourced via nflverse;
    filtered to the four skill positions this pipeline scores at all."""
    import nflreadpy as nfl

    picks = _pd(nfl.load_draft_picks(years))
    pos_c = _col(picks, "position", "pos")
    picks = picks[picks[pos_c].isin(FANTASY_POS)]
    rows = (
        (r.gsis_id, getattr(r, "round"), r.pick)
        for r in picks.itertuples()
        if pd.notna(r.gsis_id) and pd.notna(getattr(r, "round"))
    )
    return draft_capital_by_player(rows)


def load_draft_seasons(years) -> dict:
    """{gsis_id: draft season} — the ONE nflverse season out of a drafted
    player's whole career that is actually their rookie season. Needed only
    to fit rookie_capital_curve() (a player keeps their draft round for
    every later season too, so `data` x `capital_by_player` alone would
    silently pool a veteran's 3rd/4th/5th-year output in as if it were a
    rookie pace). Not part of the shipped feature itself, which only needs
    round/pick, never the draft year."""
    import nflreadpy as nfl

    picks = _pd(nfl.load_draft_picks(years))
    out: dict = {}
    for r in picks.itertuples():
        gid = r.gsis_id
        if pd.notna(gid) and pd.notna(r.season):
            out.setdefault(gid, int(r.season))
    return out


def rookie_history_rows(data: pd.DataFrame, capital_by_player: dict,
                        draft_season_by_player: dict) -> list[tuple]:
    """(season, pos, round, pace) — one row per player's actual ROOKIE
    season only (pinned by draft_season_by_player, see its docstring),
    reusing whatever's already in `data` rather than a second network load.
    Used ONLY to fit rookie_capital_curve(), never to score a test year
    directly. Pace uses the SAME (points/gp * 17) unit projectPoints()
    blends on, so the curve's output slots directly into
    project_points()'s "proj"."""
    sc = default_scoring(PPR)
    out = []
    for r in data.itertuples():
        cap = capital_by_player.get(r.player_id)
        draft_season = draft_season_by_player.get(r.player_id)
        if not cap or draft_season is None or r.season != draft_season or not r.gp:
            continue
        pace = (_model_points(season_line(r), sc) / r.gp) * DEFAULT_PARAMS["projectedGames"]
        out.append((r.season, r.pos, cap[0], pace))
    return out


def season_line(row) -> dict:
    return {"gp": int(row.gp),
            **{v: float(getattr(row, v)) for v in COMP.values()},
            **{v: float(getattr(row, v, 0) or 0) for v in VOLUME.values()},
            "fumbles": float(row.fumbles)}


def build_players(data: pd.DataFrame, ages: dict, year: int) -> list[dict]:
    """Every player as the app would see them drafting for `year`."""
    prev = {r.player_id: r for r in data[data.season == year - 1].itertuples()}
    prev2 = {r.player_id: r for r in data[data.season == year - 2].itertuples()}
    actual = {r.player_id: r for r in data[data.season == year].itertuples()}

    out = []
    for pid, act in actual.items():
        p1, p2 = prev.get(pid), prev2.get(pid)
        if p1 is None and p2 is None:
            continue          # true rookie: no history AND no market rank here
        out.append({
            "player_id": pid,
            "name": act.name,
            "pos": act.pos,
            "team": act.team,
            "age": ages.get((year, pid)),
            "last": season_line(p1) if p1 is not None else None,
            "last2": season_line(p2) if p2 is not None else None,
            "_actual": act,
        })
    return out


def build_vanished(data: pd.DataFrame, ages: dict, year: int) -> list[dict]:
    """Players with season Y-1 / Y-2 history who produced NO season-Y stats
    line at all (roadmap 2.1).

    `build_players` iterates over players who APPEAR in year Y, so a player who
    was drafted and then never played is silently absent rather than counted as
    a zero. For a rank correlation that is a documented, evenly-applied caveat
    (see the module docstring). For an outcome DISTRIBUTION it is a real
    problem: it truncates precisely the left tail the distribution exists to
    describe. These are those players, with `_actual = None` meaning an outcome
    of zero. The caller is expected to keep only the ones the market ranked
    (season-Y ADP) — a player nobody was drafting is not a bust anyone
    suffered."""
    prev = {r.player_id: r for r in data[data.season == year - 1].itertuples()}
    prev2 = {r.player_id: r for r in data[data.season == year - 2].itertuples()}
    appeared = set(data[data.season == year].player_id)

    out = []
    for pid in set(prev) | set(prev2):
        if pid in appeared:
            continue
        p1, p2 = prev.get(pid), prev2.get(pid)
        src = p1 if p1 is not None else p2
        out.append({
            "player_id": pid,
            "name": src.name,
            "pos": src.pos,
            "team": src.team,
            "age": ages.get((year, pid)),
            "last": season_line(p1) if p1 is not None else None,
            "last2": season_line(p2) if p2 is not None else None,
            "_actual": None,          # produced nothing: outcome is 0
        })
    return out


def build_rookies(data: pd.DataFrame, ages: dict, capital_by_player: dict, year: int) -> list[dict]:
    """The exact complement `build_players` excludes: true rookies (no
    season Y-1 AND no season Y-2 history), tagged with their draft round/pick
    if `load_draft_picks` has one on record (roadmap 1.4). `last`/`last2`
    stay None — same as what `build_players` would have given them, and what
    `rookie_projection()`/`project_points()` already branch on."""
    prev = {r.player_id: r for r in data[data.season == year - 1].itertuples()}
    prev2 = {r.player_id: r for r in data[data.season == year - 2].itertuples()}
    actual = {r.player_id: r for r in data[data.season == year].itertuples()}

    out = []
    for pid, act in actual.items():
        if prev.get(pid) is not None or prev2.get(pid) is not None:
            continue
        cap = capital_by_player.get(pid)
        out.append({
            "player_id": pid,
            "name": act.name,
            "pos": act.pos,
            "team": act.team,
            "age": ages.get((year, pid)),
            "last": None,
            "last2": None,
            "capital_round": cap[0] if cap else None,
            "capital_pick": cap[1] if cap else None,
            "_actual": act,
        })
    return out


def score(players: list[dict], projections: list[float], sc: dict) -> dict:
    """Rank correlation + top-N hit rate, against both targets."""
    rows = []
    for p, proj in zip(players, projections):
        act = p["_actual"]
        line = season_line(act)
        total = _points(line, sc)
        pace = (total / act.gp) * DEFAULT_PARAMS["projectedGames"] if act.gp > 0 else 0.0
        rows.append({"pos": p["pos"], "proj": proj, "total": total, "pace": pace})
    df = pd.DataFrame(rows)

    out = {}
    for pos, sub in df.groupby("pos"):
        if len(sub) < 10:
            continue
        res = {"n": len(sub)}
        for target in ("total", "pace"):
            rho = stats.spearmanr(sub["proj"], sub[target]).statistic
            res[f"spearman_{target}"] = round(float(rho), 4)
            for n in (12, 24, 36):
                if len(sub) >= n:
                    top_proj = set(sub.nlargest(n, "proj").index)
                    top_act = set(sub.nlargest(n, target).index)
                    res[f"hit{n}_{target}"] = round(len(top_proj & top_act) / n, 3)
        out[pos] = res
    return out


def blend_with_market(players, model_pts, adp_by_player, w):
    """Blend the model's projected POINTS with the market's opinion.

    Points space, not rank space, deliberately: `valuePoints` feeds VBD,
    replacement level, tiers and auction dollars. A rank-only blend would score
    well here and break everything downstream.

    The market's rank is converted to points by RANK TRANSFER — if ADP says a
    player is the 7th-best RB, he receives the points the model assigns to its
    OWN 7th-best RB. That uses no information from the season being predicted,
    keeps the output on the model's own scale, and preserves the position's
    points-vs-rank shape (which is what VBD cares about).

    COVERAGE. The market ranks only some players; the model ranks all of them.
    The ladder is therefore built from the RANKED players only, so the transfer
    is a permutation WITHIN that subset: every ranked player is reshuffled among
    the point values ranked players already held, and unranked players keep
    their model points and their position in the distribution untouched. Reading
    the market's k-th rank off a ladder that included unranked players would
    hand out slots those players already occupy — inflating the covered group
    and quietly demoting everyone the market ignores.

    When every player is ranked (the matched population) the two constructions
    coincide, so this does not move the matched numbers.

    w = 1.0 is the pure model; w = 0.0 is the model's point distribution
    reordered by ADP — which must score like ADP, and is asserted below.
    """
    by_pos = {}
    for i, p in enumerate(players):
        by_pos.setdefault(p["pos"], []).append(i)

    out = list(model_pts)
    for pos, idxs in by_pos.items():
        have_adp = [i for i in idxs if adp_by_player.get(players[i]["player_id"])]
        if not have_adp:
            continue
        # The model's own points for the RANKED players, best first: the ladder
        # the market's rank is read against.
        ladder = sorted((model_pts[i] for i in have_adp), reverse=True)
        # Market order within the position.
        market_order = sorted(have_adp, key=lambda i: adp_by_player[players[i]["player_id"]])
        for slot, i in enumerate(market_order):
            implied = ladder[min(slot, len(ladder) - 1)]
            out[i] = w * model_pts[i] + (1 - w) * implied
    return out


def _partial_spearman(x, y, z):
    """Correlation of x and y with z held constant, on ranks.

    The naive version of this diagnostic — correlate (market - model) against
    (market - actual) — is broken: both sides carry +market, so they correlate
    positively no matter what the model says. Scored that way a pure random
    model reads +0.39 and an INVERTED model reads ~0. The shared term has to
    come out, which is exactly what a partial correlation does; its null is 0.
    """
    rxy = stats.spearmanr(x, y).statistic
    rxz = stats.spearmanr(x, z).statistic
    ryz = stats.spearmanr(y, z).statistic
    denom = math.sqrt(max(0.0, (1 - rxz ** 2) * (1 - ryz ** 2)))
    if denom < 1e-12 or any(v != v for v in (rxy, rxz, ryz)):
        return float("nan")
    return (rxy - rxz * ryz) / denom



def blend_expert(model_pts, expert_pts, w):
    """Blend our projection with the experts', in POINTS space.

    Deliberately NOT rank transfer. `marketAnchor` already borrows an ORDER
    from the market, and re-borrowing an order from a second market source
    would mostly re-learn what anchoring already knows. What an expert
    projection carries that a rank does not is MAGNITUDE — how much better, not
    merely better — and that only survives a blend done on the numbers.

    Both sides are scored through the same `points()` with the same scoring, so
    they are already on one scale; no rescaling is applied, because rescaling
    the experts onto our mean would throw away the part of their estimate most
    likely to be better than ours.

    w = 1.0 is our model; w = 0.0 is the experts. Players the experts do not
    cover keep our projection untouched — the same coverage rule the market
    anchor uses, and for the same reason.
    """
    return [
        w * m + (1 - w) * e if (e is not None and e > 0) else m
        for m, e in zip(model_pts, expert_pts)
    ]


def disagreement_signal(pop, model_pts, adp_by_player, sc):
    """Does the model know anything the market does not?

    This is the question that decides whether ANY blend can work, and it is not
    the same as "is the model good" — a model can rank players well purely by
    agreeing with the market, and adding it to the market would then buy you
    nothing. What matters is the INCREMENTAL signal: of the part of a player's
    finish the market failed to anticipate, does the model's disagreement with
    the market predict any of it?

    That quantity is the partial Spearman correlation between the model's
    ranking and the actual finish, controlling for ADP. Its null is 0.

      > 0  the model carries real information the market lacks. A blend can
           help, and the only open question is the weight.
      ~ 0  the model's disagreements are noise. No weight will help, because
           there is nothing to weight — the fix has to go into the model.
      < 0  the model is reliably wrong exactly where it departs from consensus.

    Reported twice: over everyone, and over BIG disagreements only (>= 10 ranks
    apart), because a model can carry signal in aggregate and still be wrong on
    the loud calls — and the loud calls are the ones that change a draft.
    """
    by_pos = {}
    for i, p in enumerate(pop):
        if adp_by_player.get(p["player_id"]):
            by_pos.setdefault(p["pos"], []).append(i)

    out = {}
    for pos, idxs in by_pos.items():
        if len(idxs) < 15:
            continue
        act_pts = {i: _points(season_line(pop[i]["_actual"]), sc) for i in idxs}
        # rank 0 = best, in each of the three orderings
        mkt = {i: r for r, i in enumerate(sorted(idxs, key=lambda i: adp_by_player[pop[i]["player_id"]]))}
        mdl = {i: r for r, i in enumerate(sorted(idxs, key=lambda i: -model_pts[i]))}
        act = {i: r for r, i in enumerate(sorted(idxs, key=lambda i: -act_pts[i]))}

        # Negated so that "higher = better player" in all three, making a
        # positive correlation mean "agrees with reality" rather than the
        # reverse — the sign of this number is the whole result.
        X = [-mdl[i] for i in idxs]
        Y = [-act[i] for i in idxs]
        Z = [-mkt[i] for i in idxs]
        res = {"n": len(idxs),
               "partial_model": round(_partial_spearman(X, Y, Z), 4),
               # for context: how much the market alone explains, and how much
               # the model overlaps it (a model that just echoes ADP has
               # nothing left to contribute no matter how good it looks solo)
               "rho_market": round(float(stats.spearmanr(Z, Y).statistic), 4),
               "rho_model": round(float(stats.spearmanr(X, Y).statistic), 4),
               "rho_model_market": round(float(stats.spearmanr(X, Z).statistic), 4)}

        big = [k for k, i in enumerate(idxs) if abs(mkt[i] - mdl[i]) >= 10]
        res["n_big"] = len(big)
        if len(big) >= 10:
            res["partial_model_big"] = round(
                _partial_spearman([X[k] for k in big], [Y[k] for k in big], [Z[k] for k in big]), 4)
        out[pos] = res
    return out


def _points(line, sc):
    from projection_model import points
    return points(line, sc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="./backtest_results")
    ap.add_argument("--first", type=int, default=2017, help="first TEST season")
    ap.add_argument("--last", type=int, default=2025, help="last TEST season")
    ap.add_argument("--no-expert", action="store_true",
                    help="skip the expert-projection blend (roadmap 0.1)")
    ap.add_argument("--no-adp", action="store_true",
                    help="skip the ADP baseline even when a FantasyPros key is present")
    ap.add_argument("--no-injury", action="store_true",
                    help="skip the injury-discount sweep (roadmap 0.3)")
    ap.add_argument("--no-team-context", action="store_true",
                    help="skip the team-context sweep (roadmap 1.3)")
    ap.add_argument("--no-rookie-capital", action="store_true",
                    help="skip the rookie draft-capital sweep (roadmap 1.4)")
    ap.add_argument("--no-distributions", action="store_true",
                    help="skip the outcome-distribution calibration (roadmap 2.1)")
    args = ap.parse_args()

    test_years = list(range(args.first, args.last + 1))
    need = sorted({y for t in test_years for y in (t - 2, t - 1, t)})
    # Roadmap 1.4: fitting rookie_capital_curve() needs many more rookie
    # classes than the t-2..t window every other feature in this file uses —
    # a per-position, per-round mean is noisy on 2-3 draft classes. Widened
    # here (not a second load_seasons call) so the one load_seasons(need)
    # below already covers both purposes with no duplicate network fetch.
    ROOKIE_HIST_START = 2005
    need = sorted(set(need) | set(range(max(ROOKIE_HIST_START, args.first - 15), args.first)))
    print(f"Loading NFL data {need[0]}–{need[-1]}…")
    data = load_seasons(need)
    print(f"Loaded {len(data)} player-seasons")
    if data.empty:
        raise SystemExit("No data loaded — fix the loader before reading anything below.")
    print("Loading ages from rosters…")
    ages = load_ages(test_years)
    print(f"  {len(ages)} player-ages")

    use_team_context = not args.no_team_context
    qb_by_team = coach_by_team = pace_by_team = quality_by_team = {}
    run_block_by_team = pass_pro_by_team = commitment_by_player = {}
    team_by_ps = {}
    if use_team_context:
        print("Loading team context (coaches + pace + quality) from schedules/team stats…")
        coach_by_team, pace_by_team, quality_by_team, ts = load_team_context(need)
        qb_by_team = team_qb_by_season(data.itertuples())
        team_by_ps = {(r.season, r.player_id): r.team for r in data.itertuples()}
        print(f"  {len(coach_by_team)} team-seasons with a coach, "
              f"{len(pace_by_team)} with a pace, {len(quality_by_team)} with an offensive "
              f"quality reading, {len(qb_by_team)} with a starting QB")

        print("Loading O-line context (PFR advanced stats, 2018+ only)…")
        run_block_by_team, pass_pro_by_team = load_oline_context(need, ts)
        print(f"  {len(run_block_by_team)} team-seasons with run-block data, "
              f"{len(pass_pro_by_team)} with pass-protection data")

        print("Loading commitment context (contracts)…")
        commitment_by_player = load_commitment_context()
        print(f"  {len(commitment_by_player)} player-seasons with a signed contract on record")

    use_rookie_capital = not args.no_rookie_capital
    capital_by_player = {}
    rookie_curve_rows = []
    if use_rookie_capital:
        print("Loading draft capital (round/pick) from PFR via nflverse…")
        capital_by_player = load_draft_capital(need)
        draft_season_by_player = load_draft_seasons(need)
        rookie_curve_rows = rookie_history_rows(data, capital_by_player, draft_season_by_player)
        print(f"  {len(capital_by_player)} drafted skill players on record, "
              f"{len(rookie_curve_rows)} rookie-season pace rows to fit rookie_capital_curve() from")

    sc = default_scoring(PPR)

    # The parameters the SHIPPED model actually uses.
    GRID = {
        "primaryWeight": [0.5, 0.6, 0.7, 0.8, 1.0],
        "trendThreshold": [25, 50, 100, 10_000],   # 10k = trend logic disabled
    }
    combos = [dict(zip(GRID, v)) for v in product(*GRID.values())]

    use_adp = bool(fetch_adp) and not args.no_adp and os.getenv("FANTASYPROS_API_KEY")
    use_expert = bool(fetch_projections) and not args.no_expert and os.getenv("FANTASYPROS_API_KEY")
    use_injury = bool(fetch_injuries) and not args.no_injury and os.getenv("FANTASYPROS_API_KEY")
    if not use_adp:
        print("\n! ADP baseline SKIPPED (no FANTASYPROS_API_KEY or --no-adp). "
              "The model-vs-market comparison is the point; run this where the key lives.")

    use_distributions = not args.no_distributions
    per_year = []
    dist_rows = []         # roadmap 2.1: (year, pos, proj, actual, rank, age, bust)
    dis_rows = []          # model-vs-market disagreement diagnostic
    coverage = []          # (year, ranked, total) — how much of the board ADP covers
    for year in test_years:
        players = build_players(data, ages, year)
        if not players:
            continue
        rookies = build_rookies(data, ages, capital_by_player, year) if use_rookie_capital else []

        # League scoring rates for v2, from seasons STRICTLY BEFORE the test
        # year — the only ones a drafter would have had. Reading the test
        # season here would leak the answer into the "prediction".
        rates = league_rates((r.pos, season_line(r))
                             for r in data[data.season < year].itertuples())
        # Same no-lookahead discipline for the opportunity model's league
        # efficiency rate (roadmap 1.1/1.2).
        opp_rates = league_efficiency((r.pos, season_line(r), sc)
                                      for r in data[data.season < year].itertuples())

        # ── the matched population ────────────────────────────────────
        # Comparing the model to the market is only meaningful over players
        # BOTH can rank. ADP covers different (fewer) players than nflverse
        # history does, so scoring each on its own population would compare
        # two different exams and call it a result.
        # The experts' own projection for this season, matched onto our players
        # the same way ADP is. `projection_probe.py` established these are real
        # per-season preseason numbers rather than hindsight; without that check
        # this would be the most flattering and most worthless input available.
        expert_by_player = {}
        if use_expert:
            try:
                ep = fetch_projections(year, scoring="HALF")
            except Exception as e:  # noqa: BLE001 — a dead season is not fatal
                print(f"  ! expert projections {year}: {type(e).__name__}: {e}")
                ep = {}
            for p in players:
                line = ep.get((fp_norm(p["name"]), p["pos"]))
                if line:
                    v = _points(line, sc)
                    if v > 0:
                        expert_by_player[p["player_id"]] = v
            print(f"  {year}: {len(expert_by_player)} players with an expert projection")

        # Roadmap 0.3: that season's week-0 injury report. `injury_probe.py`
        # verified this is a real, dated report (not stale/echoed) for 6 of 7
        # tested seasons -- the precondition for sweeping it here at all.
        injury_by_player = {}
        if use_injury:
            try:
                inj = fetch_injuries(year, week=0)
            except Exception as e:  # noqa: BLE001 — a dead season is not fatal
                print(f"  ! injuries {year}: {type(e).__name__}: {e}")
                inj = {}
            for p in players:
                row = inj.get((fp_norm(p["name"]), p["pos"]))
                if row:
                    injury_by_player[p["player_id"]] = row["severity"]
            print(f"  {year}: {len(injury_by_player)} players with a reported injury")

        adp_by_player = {}
        if use_adp:
            adp = fetch_adp(year, rank_type="ADP") or fetch_adp(year, rank_type="DRAFT")
            for p in players:
                v = adp.get((fp_norm(p["name"]), p["pos"]))
                if v:
                    adp_by_player[p["player_id"]] = v

        populations = [("all", players)]
        if adp_by_player:
            matched = [p for p in players if p["player_id"] in adp_by_player]
            populations.append(("matched_adp", matched))
            coverage.append((year, len(matched), len(players)))
            print(f"  {year}: {len(players)} players, {len(matched)} also have ADP")
        else:
            print(f"  {year}: {len(players)} players")

        for pop_name, pop in populations:
            if len(pop) < 40:
                continue

            base = []
            for p in pop:
                last = p["last"] or p["last2"]
                base.append((_points(last, sc) / last["gp"]) * 17 if last and last["gp"] else 0.0)
            for pos, m in score(pop, base, sc).items():
                per_year.append({"year": year, "population": pop_name,
                                 "model": "baseline_pace", "pos": pos, **m})

            if pop_name == "matched_adp":
                # ADP ascends (1 = best); negate so a good ranking scores positive.
                adp_scores = [-adp_by_player[p["player_id"]] for p in pop]
                for pos, m in score(pop, adp_scores, sc).items():
                    per_year.append({"year": year, "population": pop_name,
                                     "model": "adp_market", "pos": pos, **m})

            # ── roadmap 0.3: injury-aware expected games ──────────────
            # Applied to the PURE model (same stage durabilityMult already
            # lives in), scored solo -- this is a model correction, not a
            # market blend, so there is no "merged" arm the way 0.1 had one.
            if injury_by_player:
                shipped_projs = [project_points(p, sc, DEFAULT_PARAMS)["proj"] for p in pop]
                for k in INJ_K:
                    inj_projs = [proj * injury_multiplier(injury_by_player.get(p["player_id"]), k)
                                 for p, proj in zip(pop, shipped_projs)]
                    for pos, m in score(pop, inj_projs, sc).items():
                        per_year.append({"year": year, "population": pop_name,
                                         "model": "injury", "variant": f"k{k}",
                                         "inj_k": k, "pos": pos, **m})

            for combo in combos:
                P = with_overrides(**combo)
                projs = [project_points(p, sc, P)["proj"] for p in pop]
                label = f"pw{combo['primaryWeight']}_tt{combo['trendThreshold']}"
                for pos, m in score(pop, projs, sc).items():
                    per_year.append({"year": year, "population": pop_name,
                                     "model": "shipped", "variant": label,
                                     **combo, "pos": pos, **m})

            # ── model (x) market blend, swept ─────────────────────────
            # On `all` this IS the coverage merge: ranked players get pulled
            # toward the market, everyone the market ignores keeps the model.
            if adp_by_player:
                base_projs = [project_points(p, sc, DEFAULT_PARAMS)["proj"] for p in pop]
                for w in [round(x / 10, 1) for x in range(0, 11)]:
                    blended = blend_with_market(pop, base_projs, adp_by_player, w)
                    for pos, m in score(pop, blended, sc).items():
                        per_year.append({"year": year, "population": pop_name,
                                         "model": "blend", "variant": f"w{w}",
                                         "blend_w": w, "pos": pos, **m})

                # ── roadmap 0.1: OUR model (x) the EXPERTS' projection ────
                # Two numbers are reported per weight. `expert` is the blend on
                # its own, which answers "is this a better projection". `+mkt`
                # is that blend then market-anchored exactly as the app ships,
                # which answers the only question that matters — whether the
                # BOARD improves. v2 taught the difference: it moved the first
                # and not the second, and was correctly not shipped.
                if expert_by_player:
                    ex = [expert_by_player.get(p["player_id"]) for p in pop]
                    for w in EXPERT_W:
                        eb = blend_expert(base_projs, ex, w)
                        for pos, m in score(pop, eb, sc).items():
                            per_year.append({"year": year, "population": pop_name,
                                             "model": "expert", "variant": f"w{w}",
                                             "blend_w": w, "pos": pos, **m})
                        merged = blend_with_market(pop, eb, adp_by_player, MARKET_ANCHOR_W)
                        for pos, m in score(pop, merged, sc).items():
                            per_year.append({"year": year, "population": pop_name,
                                             "model": "expert_mkt", "variant": f"w{w}",
                                             "blend_w": w, "pos": pos, **m})

                if pop_name == "all":
                    for pos, m in disagreement_signal(pop, base_projs, adp_by_player, sc).items():
                        dis_rows.append({"year": year, "variant": "shipped", "k": 0.0,
                                         "pos": pos, **m})

            # ── v2: touchdowns shrunk toward the league rate ──────────
            # Scored on its own AND on the partial, because those answer
            # different questions: solo score says "is it a better model",
            # the partial says "does it add anything the market lacks" —
            # and only the second one makes a blend worth more.
            for k in V2_K:
                v2 = [project_points(stabilize_player(p, rates, k), sc, DEFAULT_PARAMS)["proj"]
                      for p in pop]
                for pos, m in score(pop, v2, sc).items():
                    per_year.append({"year": year, "population": pop_name,
                                     "model": "v2", "variant": f"k{k}", "k": k,
                                     "pos": pos, **m})
                if pop_name == "all" and adp_by_player and k > 0:
                    for pos, m in disagreement_signal(pop, v2, adp_by_player, sc).items():
                        dis_rows.append({"year": year, "variant": f"v2_k{k}", "k": k,
                                         "pos": pos, **m})
                    # the merge that matters: does a better model raise the ceiling?
                    for w in (0.2, 0.3, 0.4, 0.5):
                        for pos, m in score(pop, blend_with_market(pop, v2, adp_by_player, w), sc).items():
                            per_year.append({"year": year, "population": pop_name,
                                             "model": "v2_blend", "variant": f"k{k}_w{w}",
                                             "k": k, "blend_w": w, "pos": pos, **m})

            # ── roadmap 1.1/1.2: volume x shrunk efficiency ────────────
            # Same solo/partial/merged treatment as v2, because the phase
            # kill gate needs exactly those three numbers: is it a better
            # model, does it carry information the market lacks, and does
            # merging it with the market raise the board's ceiling.
            for k in OPP_K:
                opp = [project_points_opportunity(p, sc, opp_rates, k, DEFAULT_PARAMS)["proj"]
                       for p in pop]
                for pos, m in score(pop, opp, sc).items():
                    per_year.append({"year": year, "population": pop_name,
                                     "model": "opp", "variant": f"k{k}", "opp_k": k,
                                     "pos": pos, **m})
                if pop_name == "all" and adp_by_player:
                    for pos, m in disagreement_signal(pop, opp, adp_by_player, sc).items():
                        dis_rows.append({"year": year, "variant": f"opp_k{k}", "opp_k": k,
                                         "pos": pos, **m})
                    for w in (0.2, 0.3, 0.4, 0.5):
                        for pos, m in score(pop, blend_with_market(pop, opp, adp_by_player, w), sc).items():
                            per_year.append({"year": year, "population": pop_name,
                                             "model": "opp_blend", "variant": f"k{k}_w{w}",
                                             "opp_k": k, "blend_w": w, "pos": pos, **m})

            # ── roadmap 1.3: team continuity signals ────────────────────
            # Team change, QB change, coach change, pace — each swept and
            # judged INDEPENDENTLY, per the roadmap's own instruction
            # ("measure each feature's incremental contribution before
            # adding it"), so one real signal can't hide behind three noise
            # ones or vice versa. Same solo/partial/merged treatment as v2
            # and the opportunity model — applied to the PURE shipped model,
            # not stacked on the opportunity model/injury discount/expert
            # blend, so each idea's own marginal contribution is isolated
            # the same way every other sweep in this file measures it.
            if use_team_context:
                shipped_for_tc = [project_points(p, sc, DEFAULT_PARAMS)["proj"] for p in pop]
                flags_by_player = {
                    p["player_id"]: context_flags(
                        p["pos"], team_by_ps.get((year - 1, p["player_id"])),
                        team_by_ps.get((year, p["player_id"])), year,
                        qb_by_team, coach_by_team, pace_by_team, quality_by_team,
                        run_block_by_team, pass_pro_by_team, commitment_by_player,
                        player_id=p["player_id"])
                    for p in pop
                }
                tc_features = (
                    ("team_change", TEAM_CHANGE_K,
                     lambda projs, k: apply_flag_discount(projs, pop, flags_by_player, "team_changed", k)),
                    ("qb_change", QB_CHANGE_K,
                     lambda projs, k: apply_flag_discount(projs, pop, flags_by_player, "qb_changed", k)),
                    ("coach_change", COACH_CHANGE_K,
                     lambda projs, k: apply_flag_discount(projs, pop, flags_by_player, "coach_changed", k)),
                    ("pace", PACE_K,
                     lambda projs, k: apply_pace(projs, pop, flags_by_player, k)),
                    # Follow-up: does nuancing the flat team_change discount
                    # with destination offensive quality beat the flat
                    # version? k=0 here is the pure model (no adjustment at
                    # all), same convention as the other four.
                    ("team_change_quality", TEAM_CHANGE_QUALITY_K,
                     lambda projs, k: apply_team_change_nuance(projs, pop, flags_by_player, "quality_z", k)),
                    # Second follow-up: more TARGETED nuances than whole-team
                    # EPA — O-line (run block RB / pass pro QB-WR-TE) and
                    # contract commitment (does the SIZE of the deal predict
                    # how big a discount is actually needed).
                    ("team_change_oline", TEAM_CHANGE_OLINE_K,
                     lambda projs, k: apply_team_change_nuance(projs, pop, flags_by_player, "oline_z", k)),
                    ("team_change_commitment", TEAM_CHANGE_COMMITMENT_K,
                     lambda projs, k: apply_team_change_nuance(projs, pop, flags_by_player, "commitment_z", k)),
                )
                for feat_name, K_grid, apply_fn in tc_features:
                    for k in K_grid:
                        adj = apply_fn(shipped_for_tc, k)
                        for pos, m in score(pop, adj, sc).items():
                            per_year.append({"year": year, "population": pop_name,
                                             "model": feat_name, "variant": f"k{k}", "ctx_k": k,
                                             "pos": pos, **m})
                        if pop_name == "all" and adp_by_player and k > 0:
                            for pos, m in disagreement_signal(pop, adj, adp_by_player, sc).items():
                                dis_rows.append({"year": year, "variant": f"{feat_name}_k{k}",
                                                 "ctx_k": k, "pos": pos, **m})
                            for w in (0.2, 0.3, 0.4, 0.5):
                                for pos, m in score(pop, blend_with_market(pop, adj, adp_by_player, w), sc).items():
                                    per_year.append({"year": year, "population": pop_name,
                                                     "model": f"{feat_name}_blend", "variant": f"k{k}_w{w}",
                                                     "ctx_k": k, "blend_w": w, "pos": pos, **m})

            # ── re-baseline: does the opportunity model beat what is ──
            # ACTUALLY shipping right now (injury discount + expert blend +
            # anchor), not the pre-Phase-0 pure model every sweep above
            # compares against? Only meaningful on "all" with every input
            # available, and only at MARKET_ANCHOR_W — that is the one
            # number the live board actually produces.
            if pop_name == "all" and adp_by_player and expert_by_player and injury_by_player:
                shipped_stack = apply_expert_shipped(
                    pop, apply_injury_shipped(pop, base_projs, injury_by_player), expert_by_player)
                shipped_stack_merged = blend_with_market(pop, shipped_stack, adp_by_player, MARKET_ANCHOR_W)
                for pos, m in score(pop, shipped_stack_merged, sc).items():
                    per_year.append({"year": year, "population": pop_name,
                                     "model": "shipped_stack", "variant": "current",
                                     "pos": pos, **m})

                for k in OPP_K:
                    opp_k = [project_points_opportunity(p, sc, opp_rates, k, DEFAULT_PARAMS)["proj"]
                             for p in pop]
                    opp_stack = apply_expert_shipped(
                        pop, apply_injury_shipped(pop, opp_k, injury_by_player), expert_by_player)
                    opp_stack_merged = blend_with_market(pop, opp_stack, adp_by_player, MARKET_ANCHOR_W)
                    for pos, m in score(pop, opp_stack_merged, sc).items():
                        per_year.append({"year": year, "population": pop_name,
                                         "model": "opp_stack", "variant": f"k{k}", "opp_k": k,
                                         "pos": pos, **m})

                # ── re-baseline: does team_change beat what is ACTUALLY ──
                # shipping right now? Only for team_change — the only 1.3
                # feature that cleared the pure-model gate at all (see the
                # ROADMAP 1.3 KILL GATE below); qb_change/coach_change/pace
                # never beat v2's +0.003 merge bar even against the easier
                # bare-model comparison, so the harder live-stack bar can't
                # help them either. Same lesson roadmap 1.1/1.2 learned: a
                # feature's apparent gain against the bare model can be
                # signal the expert blend/injury discount were already
                # extracting.
                if use_team_context:
                    for k in TEAM_CHANGE_K:
                        tc_adj = apply_flag_discount(shipped_for_tc, pop, flags_by_player, "team_changed", k)
                        tc_stack = apply_expert_shipped(
                            pop, apply_injury_shipped(pop, tc_adj, injury_by_player), expert_by_player)
                        tc_stack_merged = blend_with_market(pop, tc_stack, adp_by_player, MARKET_ANCHOR_W)
                        for pos, m in score(pop, tc_stack_merged, sc).items():
                            per_year.append({"year": year, "population": pop_name,
                                             "model": "team_change_stack", "variant": f"k{k}", "ctx_k": k,
                                             "pos": pos, **m})

                    # Same re-baseline for the quality-nuanced version — the
                    # question that actually matters here is not "beats the
                    # pure model" but "beats what SHIPS today" (the flat 0.25
                    # discount, already live for RB/WR), which is why this
                    # stack is worth building even though team_change_quality
                    # is a brand-new idea, not yet shipped in any form.
                    for k in TEAM_CHANGE_QUALITY_K:
                        tcq_adj = apply_team_change_nuance(shipped_for_tc, pop, flags_by_player, "quality_z", k)
                        tcq_stack = apply_expert_shipped(
                            pop, apply_injury_shipped(pop, tcq_adj, injury_by_player), expert_by_player)
                        tcq_stack_merged = blend_with_market(pop, tcq_stack, adp_by_player, MARKET_ANCHOR_W)
                        for pos, m in score(pop, tcq_stack_merged, sc).items():
                            per_year.append({"year": year, "population": pop_name,
                                             "model": "team_change_quality_stack", "variant": f"k{k}",
                                             "ctx_k": k, "pos": pos, **m})

                    # Same re-baseline for the second follow-up (oline /
                    # commitment) — same reasoning as the quality stack
                    # above: the bar that matters is "beats what SHIPS
                    # today", not "beats the pure model".
                    for k in TEAM_CHANGE_OLINE_K:
                        tco_adj = apply_team_change_nuance(shipped_for_tc, pop, flags_by_player, "oline_z", k)
                        tco_stack = apply_expert_shipped(
                            pop, apply_injury_shipped(pop, tco_adj, injury_by_player), expert_by_player)
                        tco_stack_merged = blend_with_market(pop, tco_stack, adp_by_player, MARKET_ANCHOR_W)
                        for pos, m in score(pop, tco_stack_merged, sc).items():
                            per_year.append({"year": year, "population": pop_name,
                                             "model": "team_change_oline_stack", "variant": f"k{k}",
                                             "ctx_k": k, "pos": pos, **m})

                    for k in TEAM_CHANGE_COMMITMENT_K:
                        tcc_adj = apply_team_change_nuance(shipped_for_tc, pop, flags_by_player, "commitment_z", k)
                        tcc_stack = apply_expert_shipped(
                            pop, apply_injury_shipped(pop, tcc_adj, injury_by_player), expert_by_player)
                        tcc_stack_merged = blend_with_market(pop, tcc_stack, adp_by_player, MARKET_ANCHOR_W)
                        for pos, m in score(pop, tcc_stack_merged, sc).items():
                            per_year.append({"year": year, "population": pop_name,
                                             "model": "team_change_commitment_stack", "variant": f"k{k}",
                                             "ctx_k": k, "pos": pos, **m})

        # ── roadmap 1.4: rookie draft-capital model ───────────────────────
        # Rookies are a population of their own (build_players() excludes
        # them on purpose — no last/last2 to project from), so they are
        # scored here rather than folded into "all"/"matched_adp" above,
        # which are both defined over RETURNING players only. ADP/expert/
        # injury matching reuses the `adp`/`ep`/`inj` dicts already fetched
        # for `players` this year — no extra network call.
        if use_rookie_capital and rookies:
            adp_by_rookie = {}
            if use_adp:
                for p in rookies:
                    v = adp.get((fp_norm(p["name"]), p["pos"]))
                    if v:
                        adp_by_rookie[p["player_id"]] = v

            # The market projection a rookie already has, if any — exactly
            # what rookie_projection()'s market_pts short-circuit reads.
            if use_expert:
                for p in rookies:
                    line = ep.get((fp_norm(p["name"]), p["pos"]))
                    if line:
                        v = _points(line, sc)
                        if v > 0:
                            p["proj"] = {"pts": v}

            injury_by_rookie = {}
            if use_injury:
                for p in rookies:
                    row = inj.get((fp_norm(p["name"]), p["pos"]))
                    if row:
                        injury_by_rookie[p["player_id"]] = row["severity"]

            # Fit the curve from every OTHER season's rookies only — zero
            # lookahead, same discipline `rates`/`opp_rates` use above.
            curve = rookie_capital_curve(
                (pos, rnd, pace) for (s, pos, rnd, pace) in rookie_curve_rows if s < year)

            PP = DEFAULT_PARAMS["projection"]
            baseline_vals, capital_vals = [], []
            for p in rookies:
                baseline_vals.append(rookie_projection(p, sc, PP))
                capital_vals.append(rookie_capital_projection(p["pos"], p.get("capital_round"), curve))

            # Candidate REPLACES the ADP/ECR-curve fallback only — a rookie
            # with a real market projection (market_pts > 0 inside
            # rookie_projection) is untouched either way, matching the
            # roadmap's own framing ("rookies currently get an ADP-curve
            # fallback"), not a blend layered on top of expert coverage.
            candidate_vals = []
            for p, base, cap in zip(rookies, baseline_vals, capital_vals):
                market_pts = _points(p.get("proj") or {}, sc)
                candidate_vals.append(cap if (market_pts <= 0 and cap is not None) else base)

            for pos, m in score(rookies, baseline_vals, sc).items():
                per_year.append({"year": year, "population": "rookies",
                                 "model": "rookie_baseline", "variant": "current", "pos": pos, **m})
            for pos, m in score(rookies, candidate_vals, sc).items():
                per_year.append({"year": year, "population": "rookies",
                                 "model": "rookie_capital", "variant": "current", "pos": pos, **m})

            if adp_by_rookie:
                for pos, m in disagreement_signal(rookies, candidate_vals, adp_by_rookie, sc).items():
                    dis_rows.append({"year": year, "variant": "rookie_capital",
                                     "population": "rookies", "pos": pos, **m})
                for pos, m in disagreement_signal(rookies, baseline_vals, adp_by_rookie, sc).items():
                    dis_rows.append({"year": year, "variant": "rookie_baseline",
                                     "population": "rookies", "pos": pos, **m})

            # ── the merge that matters: the FULL board, rookies alongside
            # returning players, anchored TOGETHER in one ladder per
            # position — exactly what useBoard.ts's marketAnchor() actually
            # does (a rookie with real ADP, e.g. a top-10 pick, is ranked
            # among veterans at the position, not in an isolated
            # rookie-only ladder built separately from them).
            if adp_by_player:
                base_projs_players = [project_points(p, sc, DEFAULT_PARAMS)["proj"] for p in players]
                combined_pop = players + rookies
                combined_adp = {**adp_by_player, **adp_by_rookie}

                merged_baseline = blend_with_market(
                    combined_pop, base_projs_players + baseline_vals, combined_adp, MARKET_ANCHOR_W)
                for pos, m in score(combined_pop, merged_baseline, sc).items():
                    per_year.append({"year": year, "population": "rookies_merged",
                                     "model": "rookie_baseline_merged", "variant": "current",
                                     "pos": pos, **m})

                merged_candidate = blend_with_market(
                    combined_pop, base_projs_players + candidate_vals, combined_adp, MARKET_ANCHOR_W)
                for pos, m in score(combined_pop, merged_candidate, sc).items():
                    per_year.append({"year": year, "population": "rookies_merged",
                                     "model": "rookie_capital_merged", "variant": "current",
                                     "pos": pos, **m})

                # Re-baseline against the ACTUAL live board (injury discount
                # + expert blend already applied on the returning-player
                # side, matching every other roadmap-1.x re-baseline in this
                # file). Expert blend is deliberately SKIPPED for rookies
                # here, mirroring blendExpertAll()'s own rookie skip in
                # engine-core.js: rookie_projection() already used
                # player.proj at the model stage, so blending it in again
                # would double-count the same number.
                if injury_by_player and expert_by_player:
                    shipped_players = apply_expert_shipped(
                        players, apply_injury_shipped(players, base_projs_players, injury_by_player),
                        expert_by_player)
                    inj_baseline_rookies = apply_injury_shipped(rookies, baseline_vals, injury_by_rookie)
                    inj_candidate_rookies = apply_injury_shipped(rookies, candidate_vals, injury_by_rookie)

                    merged_baseline_stack = blend_with_market(
                        combined_pop, shipped_players + inj_baseline_rookies, combined_adp, MARKET_ANCHOR_W)
                    for pos, m in score(combined_pop, merged_baseline_stack, sc).items():
                        per_year.append({"year": year, "population": "rookies_merged",
                                         "model": "rookie_baseline_stack", "variant": "current",
                                         "pos": pos, **m})

                    merged_candidate_stack = blend_with_market(
                        combined_pop, shipped_players + inj_candidate_rookies, combined_adp, MARKET_ANCHOR_W)
                    for pos, m in score(combined_pop, merged_candidate_stack, sc).items():
                        per_year.append({"year": year, "population": "rookies_merged",
                                         "model": "rookie_capital_stack", "variant": "current",
                                         "pos": pos, **m})

        # ── roadmap 2.1: rows for the outcome-distribution fit/eval ───────
        # Collected here, evaluated AFTER the loop, because the fit for test
        # year Y may only use years STRICTLY BEFORE Y (an expanding window) —
        # the same no-lookahead rule `rates`/`opp_rates`/the rookie curve get.
        # The projection these residuals are measured against is the LIVE
        # BOARD's own number (stack + market anchor), not the pure model: a
        # distribution around a number the app never displays would describe
        # nothing anyone sees.
        if use_distributions and adp_by_player and expert_by_player and injury_by_player:
            vanished = [p for p in build_vanished(data, ages, year)
                        if adp.get((fp_norm(p["name"]), p["pos"]))]
            dist_pop = players + vanished
            dist_adp, dist_expert, dist_injury = {}, {}, {}
            for p in dist_pop:
                key = (fp_norm(p["name"]), p["pos"])
                v = adp.get(key)
                if v:
                    dist_adp[p["player_id"]] = v
                line = ep.get(key)
                if line:
                    ev = _points(line, sc)
                    if ev > 0:
                        dist_expert[p["player_id"]] = ev
                row = inj.get(key)
                if row:
                    dist_injury[p["player_id"]] = row["severity"]

            dist_base = [project_points(p, sc, DEFAULT_PARAMS)["proj"] for p in dist_pop]
            dist_stack = apply_expert_shipped(
                dist_pop, apply_injury_shipped(dist_pop, dist_base, dist_injury), dist_expert)
            dist_final = blend_with_market(dist_pop, dist_stack, dist_adp, MARKET_ANCHOR_W)

            # Projected rank WITHIN position, off the same number the board
            # would rank on — that is what the tiers are meant to condition on.
            order = {}
            by_pos_idx = {}
            for i, p in enumerate(dist_pop):
                by_pos_idx.setdefault(p["pos"], []).append(i)
            for pos_, idxs in by_pos_idx.items():
                for r, i in enumerate(sorted(idxs, key=lambda i: -dist_final[i]), start=1):
                    order[i] = r

            for i, p in enumerate(dist_pop):
                act = p["_actual"]
                actual_total = _points(season_line(act), sc) if act is not None else 0.0
                dist_rows.append({
                    "year": year, "pos": p["pos"], "proj": dist_final[i],
                    "actual": actual_total, "rank": order[i], "age": p["age"],
                    "bust": act is None,
                })
            print(f"  {year}: {len(players)} returning + {len(vanished)} market-ranked "
                  f"no-shows for the 2.1 distribution rows")

    df = pd.DataFrame(per_year)
    for c in ("blend_w", "k", "inj_k", "opp_k", "ctx_k"):
        if c not in df.columns:
            df[c] = float("nan")
    os.makedirs(args.out, exist_ok=True)
    df.to_csv(f"{args.out}/projection_backtest_by_year.csv", index=False)

    agg = (df.groupby(["population", "model", "variant", "pos"], dropna=False)
             .agg(spearman_total=("spearman_total", "mean"),
                  spearman_pace=("spearman_pace", "mean"),
                  hit24_total=("hit24_total", "mean"),
                  # carried through the groupby so the sweeps can be ordered
                  blend_w=("blend_w", "first"),
                  k=("k", "first"),
                  inj_k=("inj_k", "first"),
                  opp_k=("opp_k", "first"),
                  ctx_k=("ctx_k", "first"),
                  n_years=("year", "nunique"))
             .reset_index()
             .sort_values(["pos", "spearman_total"], ascending=[True, False]))
    agg.to_csv(f"{args.out}/projection_backtest_summary.csv", index=False)

    for pop in [p for p in ("all", "matched_adp") if p in set(agg["population"])]:
        title = ("ALL players with prior-season history"
                 if pop == "all" else
                 "MATCHED population — only players the market also ranks")
        print(f"\n=== {title} ===")
        print("mean Spearman vs actual season TOTAL, over test years")
        if pop == "all" and coverage:
            cov = sum(r / t for _, r, t in coverage) / len(coverage)
            print(f"ADP covers {cov:.0%} of this population on average — the blend can only"
                  f" move that share; the rest is the model alone.")
        pa = agg[agg["population"] == pop]
        for posn in sorted(pa["pos"].unique()):
            sub = pa[pa["pos"] == posn]
            basel = sub[sub["model"] == "baseline_pace"]
            ship = sub[(sub["model"] == "shipped") & (sub["variant"] == "pw0.7_tt50")]
            mkt = sub[sub["model"] == "adp_market"]
            print(f"\n  {posn}  (n_years={int(sub.n_years.max())})")
            if len(basel):
                print(f"    last-season pace : {basel.iloc[0].spearman_total:.4f}")
            if len(mkt):
                print(f"    ADP (the market) : {mkt.iloc[0].spearman_total:.4f}   "
                      f"top24 hit {mkt.iloc[0].hit24_total:.3f}")
            if len(ship):
                s0 = ship.iloc[0]
                edge = (s0.spearman_total - mkt.iloc[0].spearman_total) if len(mkt) else None
                print(f"    SHIPPED model    : {s0.spearman_total:.4f}   "
                      f"top24 hit {s0.hit24_total:.3f}"
                      + (f"   vs market {edge:+.4f}" if edge is not None else ""))

            bl = sub[sub["model"] == "blend"].sort_values("blend_w")
            if len(bl) and len(ship):
                # Reference differs by population, on purpose. Where the market
                # ranks everyone, the market is the bar to clear. Where it does
                # not, ADP has no score to compare against and the honest
                # question is whether anchoring the covered slice beats the
                # model we already ship.
                ref_s = mkt.iloc[0].spearman_total if len(mkt) else s0.spearman_total
                ref_label = "market" if len(mkt) else " model"
                best = bl.loc[bl.spearman_total.idxmax()]
                # Endpoint check: w=1 must reproduce the model, and (matched
                # only) w=0 must reproduce the market. If either drifts, the
                # blend is wrong and nothing between them means anything.
                w1 = bl[bl.blend_w == 1.0]
                w0 = bl[bl.blend_w == 0.0]
                if len(w1) and abs(w1.iloc[0].spearman_total - s0.spearman_total) > 1e-6:
                    print(f"    !! w=1.0 ({w1.iloc[0].spearman_total:.4f}) != shipped "
                          f"({s0.spearman_total:.4f}) — blend is not interpolating the model")
                if len(mkt) and len(w0) and abs(w0.iloc[0].spearman_total - ref_s) > 0.02:
                    print(f"    !! w=0.0 ({w0.iloc[0].spearman_total:.4f}) != market "
                          f"({ref_s:.4f}) — blend is not interpolating ADP")
                head = ("blend model⊕market (w = weight on MODEL)" if len(mkt) else
                        "coverage merge: market where ranked, model elsewhere")
                print(f"    {head}:")
                for _, r in bl.iterrows():
                    star = "  <-- best" if r.variant == best.variant else ""
                    print(f"      w={r.blend_w:<4} {r.spearman_total:.4f}"
                          f"  (vs {ref_label} {r.spearman_total - ref_s:+.4f})"
                          f"  top24 {r.hit24_total:.3f}{star}")

    # ── roadmap 0.1: the experts' projection, judged against its gate ─────
    ex_all = agg[(agg["population"] == "all") & (agg["model"] == "expert")]
    ex_mkt = agg[(agg["population"] == "all") & (agg["model"] == "expert_mkt")]
    ex_matched = agg[(agg["population"] == "matched_adp") & (agg["model"] == "expert")]
    if len(ex_all):
        # The bar, fixed in docs/ROADMAP.md BEFORE this was run.
        GATE_MATCHED = {"QB": 0.497, "RB": 0.551, "TE": 0.472, "WR": 0.594}
        GATE_MERGED = {"QB": 0.7554, "RB": 0.7364, "TE": 0.7240, "WR": 0.7564}

        print("\n=== ROADMAP 0.1 — OUR MODEL (x) THE EXPERTS' PROJECTION ===")
        print("w = weight on OUR model. w=1.0 is today's board; w=0.0 is the experts.")
        print("`solo` = the blend alone. `merged` = that blend market-anchored at "
              f"w={MARKET_ANCHOR_W}, i.e. what would actually ship.")
        verdict = {}
        for posn in sorted(ex_all["pos"].unique()):
            sa = ex_all[ex_all["pos"] == posn].sort_values("blend_w")
            sm = ex_mkt[ex_mkt["pos"] == posn].sort_values("blend_w")
            base_solo = sa[sa.blend_w == 1.0].iloc[0].spearman_total if len(sa[sa.blend_w == 1.0]) else float("nan")
            print(f"\n  {posn}   (today: solo {base_solo:.4f}, merged {GATE_MERGED.get(posn, float('nan')):.4f})")
            for _, r in sa.iterrows():
                m = sm[sm.blend_w == r.blend_w]
                mv = m.iloc[0].spearman_total if len(m) else float("nan")
                print(f"    w={r.blend_w:<4} solo {r.spearman_total:.4f}   merged {mv:.4f}")
            best = sm.loc[sm.spearman_total.idxmax()] if len(sm) else None
            mt = ex_matched[ex_matched["pos"] == posn]
            best_matched = mt.spearman_total.max() if len(mt) else float("nan")
            verdict[posn] = {
                "best_merged": float(best.spearman_total) if best is not None else float("nan"),
                "best_merged_w": float(best.blend_w) if best is not None else float("nan"),
                "best_matched": float(best_matched),
            }

        print("\n  --- KILL GATE (set in docs/ROADMAP.md before this ran) ---")
        pass_matched = pass_merged = True
        for posn in sorted(verdict):
            v = verdict[posn]
            gm, gg = GATE_MATCHED.get(posn), GATE_MERGED.get(posn)
            okm = v["best_matched"] > gm if gm else False
            okg = v["best_merged"] > gg if gg else False
            pass_matched &= okm
            pass_merged &= okg
            print(f"    {posn}  matched {v['best_matched']:.4f} vs {gm:.4f} "
                  f"{'PASS' if okm else 'FAIL'}   |   merged {v['best_merged']:.4f} "
                  f"vs {gg:.4f} {'PASS' if okg else 'FAIL'} (at w={v['best_merged_w']})")
        print(f"\n  matched-population gate: {'PASS' if pass_matched else 'FAIL'}")
        print(f"  full-board merged gate : {'PASS' if pass_merged else 'FAIL'}")
        if pass_matched and pass_merged:
            print("  -> SHIP IT. Both halves of the gate cleared.")
        else:
            print("  -> DO NOT SHIP on these numbers. The gate was set in advance")
            print("     precisely so this decision is not made after seeing them.")

    # ── roadmap 0.3: injury-aware expected games, judged against its gate ─
    inj_all = agg[(agg["population"] == "all") & (agg["model"] == "injury")]
    if len(inj_all):
        # Gate fixed here, before reading the sweep below (docs/ROADMAP.md 0.3
        # only specified the SHAPE of the bar, not a number): total must
        # improve, pace must not degrade. 0.002 treats anything smaller than
        # that as noise in either direction — the same order of magnitude as
        # the rounding already visible between repeated runs elsewhere here.
        GATE_EPS = 0.002
        print("\n=== ROADMAP 0.3 — INJURY-AWARE EXPECTED GAMES ===")
        print("k scales INJURY_GAMES_MISSED; k=0 is the shipped model (no discount).")
        print("total = the target that counts missed games (the point of this feature).")
        print("pace  = per-game rate with availability removed — must NOT move, or the")
        print("        discount is really just re-discovering durabilityMult.")
        inj_verdict = {}
        for posn in sorted(inj_all["pos"].unique()):
            s = inj_all[inj_all["pos"] == posn].sort_values("inj_k")
            base = s[s.inj_k == 0.0]
            if not len(base):
                continue
            b_total, b_pace = base.iloc[0].spearman_total, base.iloc[0].spearman_pace
            print(f"\n  {posn}   (shipped: total {b_total:.4f}, pace {b_pace:.4f})")
            for _, r in s.iterrows():
                print(f"    k={r.inj_k:<4} total {r.spearman_total:.4f} "
                      f"({r.spearman_total - b_total:+.4f})   pace {r.spearman_pace:.4f} "
                      f"({r.spearman_pace - b_pace:+.4f})")
            # Best k among those that do not degrade pace past the gate.
            safe = s[s.spearman_pace >= b_pace - GATE_EPS]
            best = safe.loc[safe.spearman_total.idxmax()] if len(safe) else None
            inj_verdict[posn] = {
                "base_total": b_total, "base_pace": b_pace,
                "best_k": float(best.inj_k) if best is not None else float("nan"),
                "best_total": float(best.spearman_total) if best is not None else float("nan"),
                "best_pace": float(best.spearman_pace) if best is not None else float("nan"),
            }

        print("\n  --- KILL GATE (docs/ROADMAP.md 0.3: improve total, don't degrade pace) ---")
        passed = {}
        for posn in sorted(inj_verdict):
            v = inj_verdict[posn]
            improves_total = v["best_total"] > v["base_total"] + GATE_EPS
            holds_pace = v["best_pace"] >= v["base_pace"] - GATE_EPS
            ok = improves_total and holds_pace and v["best_k"] > 0
            passed[posn] = ok
            print(f"    {posn}  k={v['best_k']}  total {v['best_total']:.4f} vs "
                  f"{v['base_total']:.4f} ({'better' if improves_total else 'NOT better'})   "
                  f"pace {v['best_pace']:.4f} vs {v['base_pace']:.4f} "
                  f"({'held' if holds_pace else 'DEGRADED'})   {'PASS' if ok else 'FAIL'}")
        if passed and all(passed.values()):
            print("  -> SHIP IT for every position. Both conditions cleared everywhere.")
        elif any(passed.values()):
            ship = [p for p, ok in passed.items() if ok]
            skip = [p for p, ok in passed.items() if not ok]
            print(f"  -> PARTIAL. Ship for {', '.join(ship)} only; {', '.join(skip)} keep "
                  f"durabilityMult alone rather than ship a discount that didn't earn it there.")
        else:
            print("  -> DO NOT SHIP. No position cleared both halves of the gate. The gate")
            print("     was set in advance precisely so this decision is not made after")
            print("     seeing the numbers.")

    # ── v2: did shrinking touchdowns help, and did it help the BLEND? ─────
    v2a = agg[(agg["population"] == "all") & (agg["model"] == "v2")]
    if len(v2a):
        print("\n=== v2: TOUCHDOWN REGRESSION (full board) ===")
        print("k = prior strength, as multiples of a typical season's workload.")
        print("k=0 is the shipped model. Two columns, because they answer different")
        print("questions: solo = is it a better model, merged = does the market-anchored")
        print("board get better, which is the one that ships.")
        vb = agg[(agg["population"] == "all") & (agg["model"] == "v2_blend")]
        for posn in sorted(v2a["pos"].unique()):
            s = v2a[v2a["pos"] == posn].sort_values("k")
            base = s[s.k == 0.0]
            b0 = base.iloc[0].spearman_total if len(base) else float("nan")
            print(f"\n  {posn}   (shipped solo {b0:.4f})")
            for _, r in s.iterrows():
                m = vb[(vb["pos"] == posn) & (vb["k"] == r.k)]
                best = f"{m.spearman_total.max():.4f}" if len(m) else "   —  "
                bw = (f" @w{m.loc[m.spearman_total.idxmax()].blend_w}") if len(m) else ""
                print(f"    k={r.k:<5} solo {r.spearman_total:.4f} ({r.spearman_total - b0:+.4f})"
                      f"   merged {best}{bw}")
        # the shipped model's own best merge, for the comparison that matters
        mb = agg[(agg["population"] == "all") & (agg["model"] == "blend")]
        if len(mb):
            print("\n  shipped model's best merge, for reference:")
            for posn in sorted(mb["pos"].unique()):
                s = mb[mb["pos"] == posn]
                r = s.loc[s.spearman_total.idxmax()]
                print(f"    {posn}  {r.spearman_total:.4f} @w{r.blend_w}")

    if dis_rows:
        dis = pd.DataFrame(dis_rows)
        dis.to_csv(f"{args.out}/projection_disagreement.csv", index=False)
        print("\n=== DOES THE MODEL KNOW ANYTHING THE MARKET DOESN'T? ===")
        print("partial Spearman(model, actual | ADP) — the model's signal with the")
        print("market's share removed. Null is 0. > 0 means a blend has something to")
        print("work with; ~0 means the disagreements are noise and no weight helps.")
        for posn in sorted(dis["pos"].unique()):
            ps = dis[dis["pos"] == posn]
            s = ps[ps["variant"] == "shipped"]
            print(f"\n  {posn}  (n_years={s['year'].nunique()}, ~{s['n'].mean():.0f} ranked players/yr)")
            print(f"    model vs actual    : {s['rho_model'].mean():+.4f}")
            print(f"    market vs actual   : {s['rho_market'].mean():+.4f}")
            print(f"    model vs market    : {s['rho_model_market'].mean():+.4f}"
                  f"   (overlap — how much the model just echoes ADP)")
            print(f"    PARTIAL (model|ADP): {s['partial_model'].mean():+.4f}   <-- the one that matters")
            if s["partial_model_big"].notna().any():
                b = s[s["partial_model_big"].notna()]
                print(f"    big calls (>=10 rk): {b['partial_model_big'].mean():+.4f}"
                      f"   (~{b['n_big'].mean():.0f} players/yr)")
            v2v = sorted(v for v in ps["variant"].unique() if v.startswith("v2_"))
            if v2v:
                print("    v2 partials — the number a model tweak has to move:")
                for v in v2v:
                    r = ps[ps["variant"] == v]
                    print(f"      {v:<10} partial {r['partial_model'].mean():+.4f}"
                          f"   overlap {r['rho_model_market'].mean():+.4f}")
            ov = sorted(v for v in ps["variant"].unique() if v.startswith("opp_k"))
            if ov:
                print("    opportunity-model partials — the number 1.1/1.2 has to move:")
                for v in ov:
                    r = ps[ps["variant"] == v]
                    print(f"      {v:<10} partial {r['partial_model'].mean():+.4f}"
                          f"   overlap {r['rho_model_market'].mean():+.4f}")

    # ── roadmap 1.1/1.2: volume x shrunk efficiency, judged against the ───
    # phase kill gate ───────────────────────────────────────────────────
    oppa = agg[(agg["population"] == "all") & (agg["model"] == "opp")]
    if len(oppa) and dis_rows:
        # MATERIAL_EPS/MERGE_EPS fixed at module level, before reading the
        # sweep below. The roadmap only specified the SHAPE of the bar for
        # the first one ("materially" above baseline) — not an exact number.
        print("\n=== ROADMAP 1.1/1.2 — VOLUME x SHRUNK EFFICIENCY ===")
        print("k = efficiency shrinkage strength. Unlike v2/the injury discount, k=0")
        print("here is NOT the shipped model — it's the two-stage model's own unshrunk arm.")
        print(f"Gate: partial correlation must clear baseline by more than {MATERIAL_EPS}, AND")
        print(f"merged must beat the shipped model's best merge by more than {MERGE_EPS} "
              "(v2's own bar).")

        mb = agg[(agg["population"] == "all") & (agg["model"] == "blend")]
        ob = agg[(agg["population"] == "all") & (agg["model"] == "opp_blend")]
        dp_all = pd.DataFrame(dis_rows)
        verdict = {}
        for posn in sorted(oppa["pos"].unique()):
            s = oppa[oppa["pos"] == posn].sort_values("opp_k")
            base = s[s.opp_k == 0.0]
            b0 = base.iloc[0].spearman_total if len(base) else float("nan")
            print(f"\n  {posn}   (unshrunk k=0 solo {b0:.4f})")
            for _, r in s.iterrows():
                m = ob[(ob["pos"] == posn) & (ob["opp_k"] == r.opp_k)]
                best = f"{m.spearman_total.max():.4f}" if len(m) else "   —  "
                bw = (f" @w{m.loc[m.spearman_total.idxmax()].blend_w}") if len(m) else ""
                print(f"    k={r.opp_k:<5} solo {r.spearman_total:.4f}   merged {best}{bw}")

            best_merged_row = ob[ob["pos"] == posn]
            best_merged = float(best_merged_row.spearman_total.max()) if len(best_merged_row) else float("nan")
            shipped_merged_row = mb[mb["pos"] == posn]
            shipped_merged = (float(shipped_merged_row.spearman_total.max())
                              if len(shipped_merged_row) else float("nan"))

            dp = dp_all[dp_all["pos"] == posn]
            base_partial = dp[dp["variant"] == "shipped"]["partial_model"].mean()
            opp_variants = [v for v in dp["variant"].unique() if v.startswith("opp_k")]
            best_partial = (dp[dp["variant"].isin(opp_variants)]["partial_model"].max()
                            if opp_variants else float("nan"))

            verdict[posn] = {"base_partial": base_partial, "best_partial": best_partial,
                             "shipped_merged": shipped_merged, "best_merged": best_merged}

        print("\n  --- PHASE 1 KILL GATE (material partial gain AND merge beats v2's +0.003) ---")
        passed = {}
        for posn in sorted(verdict):
            v = verdict[posn]
            partial_ok = v["best_partial"] > v["base_partial"] + MATERIAL_EPS
            merge_ok = v["best_merged"] > v["shipped_merged"] + MERGE_EPS
            ok = partial_ok and merge_ok
            passed[posn] = ok
            print(f"    {posn}  partial {v['best_partial']:+.4f} vs {v['base_partial']:+.4f} "
                  f"({'material' if partial_ok else 'NOT material'})   "
                  f"merged {v['best_merged']:.4f} vs {v['shipped_merged']:.4f} "
                  f"({'beats v2' if merge_ok else 'does NOT beat v2'})   {'PASS' if ok else 'FAIL'}")
        if passed and all(passed.values()):
            print("  -> SHIP IT for every position.")
        elif any(passed.values()):
            ship = [p for p, ok in passed.items() if ok]
            skip = [p for p, ok in passed.items() if not ok]
            print(f"  -> PARTIAL. Ship for {', '.join(ship)} only; {', '.join(skip)} stay on "
                  "the shipped model rather than a replacement that didn't earn it there.")
        else:
            print("  -> DO NOT SHIP. No position cleared both halves of the phase gate. The")
            print("     gate was set in advance precisely so this decision is not made after")
            print("     seeing the numbers.")

    # ── re-baseline: same merge gate, against what is ACTUALLY shipping ───
    # right now (injury discount + expert blend + anchor) instead of the
    # pre-Phase-0 pure model. Every other verdict in this file — v2, 0.1,
    # 0.3, and the PHASE 1 KILL GATE above — is deliberately scored against
    # the bare model, because that isolates each idea's OWN marginal
    # contribution the same way every time, which is what let v2 be killed
    # on a clean, reproducible number and RB above be compared apples-to-
    # apples against it. This block answers a different, narrower question:
    # if the board today already has 0.1 and 0.3, does swapping in the
    # opportunity model on top of THAT still help, or does it double up on
    # signal those two already captured?
    ssa = agg[(agg["population"] == "all") & (agg["model"] == "shipped_stack")]
    osa = agg[(agg["population"] == "all") & (agg["model"] == "opp_stack")]
    if len(ssa) and len(osa):
        print("\n=== RE-BASELINED — OPPORTUNITY MODEL vs THE CURRENT LIVE BOARD ===")
        print("shipped_stack = project_points -> injury discount -> expert blend -> anchor,")
        print("at the EXACT weights shipped in engine-core.js. Same MERGE_EPS as above (0.003),")
        print("now measured against this instead of the pre-Phase-0 model.")
        restacked = {}
        for posn in sorted(osa["pos"].unique()):
            base_row = ssa[ssa["pos"] == posn]
            if not len(base_row):
                continue
            base = float(base_row.iloc[0].spearman_total)
            s = osa[osa["pos"] == posn].sort_values("opp_k")
            print(f"\n  {posn}   (current live board: {base:.4f})")
            for _, r in s.iterrows():
                print(f"    k={r.opp_k:<5} {r.spearman_total:.4f}  ({r.spearman_total - base:+.4f})")
            best = s.loc[s.spearman_total.idxmax()]
            restacked[posn] = {"base": base, "best": float(best.spearman_total), "best_k": float(best.opp_k)}

        print("\n  --- RE-BASELINED VERDICT (same +0.003 bar, honest baseline) ---")
        restacked_pass = {}
        for posn in sorted(restacked):
            v = restacked[posn]
            ok = v["best"] > v["base"] + MERGE_EPS
            restacked_pass[posn] = ok
            print(f"    {posn}  k={v['best_k']}  {v['best']:.4f} vs live {v['base']:.4f} "
                  f"({v['best'] - v['base']:+.4f})   {'PASS' if ok else 'FAIL'}")
        ship2 = [p for p, ok in restacked_pass.items() if ok]
        skip2 = [p for p, ok in restacked_pass.items() if not ok]
        print(f"\n  -> Against the live board: ship for {', '.join(ship2) or '(none)'}"
              f"{'; ' + ', '.join(skip2) + ' do not clear it here' if skip2 else ''}.")

    # ── roadmap 1.3: team continuity signals, each judged against the ─────
    # phase kill gate INDEPENDENTLY — one feature clearing it does not carry
    # the others, the same reason 0.3 and 1.1/1.2 report per position rather
    # than as a single phase-wide verdict.
    tc_feature_names = ["team_change", "qb_change", "coach_change", "pace", "team_change_quality",
                        "team_change_oline", "team_change_commitment"]
    tca = agg[(agg["population"] == "all") & (agg["model"].isin(tc_feature_names))]
    if len(tca) and dis_rows:
        print("\n=== ROADMAP 1.3 — TEAM CONTEXT (team/QB/coach change, pace) ===")
        print("Each feature discounts (team/QB/coach change) or scales (pace) the PURE")
        print("shipped model directly — not stacked on the opportunity model, injury")
        print("discount or expert blend — so its own marginal contribution is isolated")
        print("the same way v2 and 1.1/1.2 were each measured. k=0 reproduces the shipped")
        print(f"model exactly. Gate: partial correlation must clear baseline by more than "
              f"{MATERIAL_EPS}, AND merged must beat the shipped model's best merge by more "
              f"than {MERGE_EPS} (v2's own bar) — same as roadmap 1.1/1.2.")

        dp_all = pd.DataFrame(dis_rows)
        mb = agg[(agg["population"] == "all") & (agg["model"] == "blend")]
        tc_verdict = {}
        for feat in tc_feature_names:
            fa = agg[(agg["population"] == "all") & (agg["model"] == feat)]
            fb = agg[(agg["population"] == "all") & (agg["model"] == f"{feat}_blend")]
            if not len(fa):
                continue
            print(f"\n  --- {feat} ---")
            for posn in sorted(fa["pos"].unique()):
                if feat == "qb_change" and posn == "QB":
                    continue  # structurally N/A — context_flags() never sets
                    # qb_changed for a QB's own row (see team_context.py); a
                    # QB's "quarterback" is himself, already covered by
                    # team_change. Every k reproduces k=0 exactly here, which
                    # would report as a correctly-failed but meaningless row.
                s = fa[fa["pos"] == posn].sort_values("ctx_k")
                base = s[s.ctx_k == 0.0]
                b0 = base.iloc[0].spearman_total if len(base) else float("nan")
                print(f"\n    {posn}   (shipped solo {b0:.4f})")
                for _, r in s.iterrows():
                    m = fb[(fb["pos"] == posn) & (fb["ctx_k"] == r.ctx_k)]
                    best = f"{m.spearman_total.max():.4f}" if len(m) else "   —  "
                    bw = (f" @w{m.loc[m.spearman_total.idxmax()].blend_w}") if len(m) else ""
                    print(f"      k={r.ctx_k:<5} solo {r.spearman_total:.4f} "
                          f"({r.spearman_total - b0:+.4f})   merged {best}{bw}")

                best_merged_row = fb[fb["pos"] == posn]
                best_merged = (float(best_merged_row.spearman_total.max())
                               if len(best_merged_row) else float("nan"))
                shipped_merged_row = mb[mb["pos"] == posn]
                shipped_merged = (float(shipped_merged_row.spearman_total.max())
                                  if len(shipped_merged_row) else float("nan"))

                dp = dp_all[dp_all["pos"] == posn]
                base_partial = dp[dp["variant"] == "shipped"]["partial_model"].mean()
                variants = [v for v in dp["variant"].unique() if v.startswith(f"{feat}_k")]
                best_partial = (dp[dp["variant"].isin(variants)]["partial_model"].max()
                                if variants else float("nan"))

                tc_verdict[(feat, posn)] = {
                    "base_partial": base_partial, "best_partial": best_partial,
                    "shipped_merged": shipped_merged, "best_merged": best_merged,
                }

        print("\n  --- ROADMAP 1.3 KILL GATE (same bar as 1.1/1.2) ---")
        tc_passed = {}
        for (feat, posn), v in sorted(tc_verdict.items()):
            partial_ok = v["best_partial"] > v["base_partial"] + MATERIAL_EPS
            merge_ok = v["best_merged"] > v["shipped_merged"] + MERGE_EPS
            ok = partial_ok and merge_ok
            tc_passed[(feat, posn)] = ok
            print(f"    {feat:<12} {posn}  partial {v['best_partial']:+.4f} vs "
                  f"{v['base_partial']:+.4f} ({'material' if partial_ok else 'NOT material'})   "
                  f"merged {v['best_merged']:.4f} vs {v['shipped_merged']:.4f} "
                  f"({'beats v2' if merge_ok else 'does NOT beat v2'})   {'PASS' if ok else 'FAIL'}")
        if tc_passed and any(tc_passed.values()):
            ship = [f"{feat}/{posn}" for (feat, posn), ok in tc_passed.items() if ok]
            print(f"\n  -> PASS for: {', '.join(ship)}. Everything else stays off (shipped")
            print("     model unchanged there) rather than a feature that didn't earn it.")
        else:
            print("\n  -> DO NOT SHIP any of team_change/qb_change/coach_change/pace. No")
            print("     position cleared both halves of the gate. The gate was set in advance")
            print("     precisely so this decision is not made after seeing the numbers.")

        # ── re-baseline: does team_change survive against what is ACTUALLY
        # shipping (injury discount + expert blend + anchor) rather than the
        # pre-Phase-0 pure model above? Same lesson 1.1/1.2 learned — only
        # run for positions team_change already passed the pure-model gate
        # for; a position that failed the easier bar has no chance against
        # the harder one.
        tcsa = agg[(agg["population"] == "all") & (agg["model"] == "team_change_stack")]
        if len(tcsa) and len(ssa):
            print("\n=== RE-BASELINED — team_change vs THE CURRENT LIVE BOARD ===")
            print("Same shipped_stack (project_points -> injury discount -> expert blend ->")
            print("anchor) computed above for the opportunity model. Same +0.003 bar, now")
            print("measured against what is actually live instead of the pre-Phase-0 model.")
            tc_restacked = {}
            pure_pass = {posn for (feat, posn), ok in tc_passed.items() if feat == "team_change" and ok}
            for posn in sorted(tcsa["pos"].unique()):
                if posn not in pure_pass:
                    continue
                base_row = ssa[ssa["pos"] == posn]
                if not len(base_row):
                    continue
                base = float(base_row.iloc[0].spearman_total)
                s = tcsa[tcsa["pos"] == posn].sort_values("ctx_k")
                print(f"\n  {posn}   (current live board: {base:.4f})")
                for _, r in s.iterrows():
                    print(f"    k={r.ctx_k:<5} {r.spearman_total:.4f}  ({r.spearman_total - base:+.4f})")
                best = s.loc[s.spearman_total.idxmax()]
                tc_restacked[posn] = {"base": base, "best": float(best.spearman_total),
                                       "best_k": float(best.ctx_k)}

            print("\n  --- RE-BASELINED VERDICT (same +0.003 bar, honest baseline) ---")
            tc_restacked_pass = {}
            for posn in sorted(tc_restacked):
                v = tc_restacked[posn]
                ok = v["best"] > v["base"] + MERGE_EPS
                tc_restacked_pass[posn] = ok
                print(f"    {posn}  k={v['best_k']}  {v['best']:.4f} vs live {v['base']:.4f} "
                      f"({v['best'] - v['base']:+.4f})   {'PASS' if ok else 'FAIL'}")
            ship3 = [p for p, ok in tc_restacked_pass.items() if ok]
            skip3 = [p for p, ok in tc_restacked_pass.items() if not ok]
            print(f"\n  -> Against the live board: ship team_change for {', '.join(ship3) or '(none)'}"
                  f"{'; ' + ', '.join(skip3) + ' do not clear it here' if skip3 else ''}.")

        # ── follow-up: does nuancing the flat discount with destination ──
        # offensive quality beat the flat discount itself — not just the
        # pure model, and not just doing nothing? Two reference points per
        # position: the live board with no team-change adjustment at all
        # (shipped_stack), and the live board with the FLAT discount already
        # applied where it ships today (team_change_stack's own best k) —
        # the second is the bar that actually decides whether nuancing is
        # worth shipping on top of what's already there.
        tcqsa = agg[(agg["population"] == "all") & (agg["model"] == "team_change_quality_stack")]
        if len(tcqsa) and len(ssa):
            print("\n=== team_change_quality vs THE CURRENT LIVE BOARD (incl. shipped team_change) ===")
            quality_pure_pass = {posn for (feat, posn), ok in tc_passed.items()
                                 if feat == "team_change_quality" and ok}
            tcq_restacked = {}
            for posn in sorted(tcqsa["pos"].unique()):
                if posn not in quality_pure_pass:
                    continue
                base_row = ssa[ssa["pos"] == posn]
                if not len(base_row):
                    continue
                base_bare = float(base_row.iloc[0].spearman_total)
                # the currently-shipped reference: team_change_stack's own
                # best k for this position, if any; else just the bare board.
                shipped_ref = tc_restacked.get(posn, {}).get("best", base_bare)
                s = tcqsa[tcqsa["pos"] == posn].sort_values("ctx_k")
                print(f"\n  {posn}   (live, no team_change: {base_bare:.4f}   "
                      f"live, flat team_change: {shipped_ref:.4f})")
                for _, r in s.iterrows():
                    print(f"    k={r.ctx_k:<5} {r.spearman_total:.4f}  "
                          f"(vs no-adj {r.spearman_total - base_bare:+.4f})  "
                          f"(vs flat {r.spearman_total - shipped_ref:+.4f})")
                best = s.loc[s.spearman_total.idxmax()]
                tcq_restacked[posn] = {"base_bare": base_bare, "shipped_ref": shipped_ref,
                                       "best": float(best.spearman_total), "best_k": float(best.ctx_k)}

            print("\n  --- team_change_quality VERDICT (must beat the FLAT discount already shipped) ---")
            tcq_pass = {}
            for posn in sorted(tcq_restacked):
                v = tcq_restacked[posn]
                ok = v["best"] > v["shipped_ref"] + MERGE_EPS
                tcq_pass[posn] = ok
                print(f"    {posn}  k={v['best_k']}  {v['best']:.4f} vs flat-shipped "
                      f"{v['shipped_ref']:.4f} ({v['best'] - v['shipped_ref']:+.4f})   "
                      f"{'PASS' if ok else 'FAIL'}")
            ship4 = [p for p, ok in tcq_pass.items() if ok]
            skip4 = [p for p, ok in tcq_pass.items() if not ok]
            print(f"\n  -> Quality-nuancing beats the flat discount for: {', '.join(ship4) or '(none)'}"
                  f"{'; ' + ', '.join(skip4) + ' stay on the flat discount' if skip4 else ''}.")

        # ── same re-baseline for the second follow-up: O-line (run block ──
        # RB / pass pro QB-WR-TE) and contract commitment.
        for label, model_name, feat_name in (
            ("O-line", "team_change_oline_stack", "team_change_oline"),
            ("commitment", "team_change_commitment_stack", "team_change_commitment"),
        ):
            stacked = agg[(agg["population"] == "all") & (agg["model"] == model_name)]
            if not (len(stacked) and len(ssa)):
                continue
            print(f"\n=== {feat_name} vs THE CURRENT LIVE BOARD (incl. shipped team_change) ===")
            pure_pass_set = {posn for (feat, posn), ok in tc_passed.items()
                             if feat == feat_name and ok}
            restacked = {}
            for posn in sorted(stacked["pos"].unique()):
                if posn not in pure_pass_set:
                    continue
                base_row = ssa[ssa["pos"] == posn]
                if not len(base_row):
                    continue
                base_bare = float(base_row.iloc[0].spearman_total)
                shipped_ref = tc_restacked.get(posn, {}).get("best", base_bare)
                s = stacked[stacked["pos"] == posn].sort_values("ctx_k")
                print(f"\n  {posn}   (live, no team_change: {base_bare:.4f}   "
                      f"live, flat team_change: {shipped_ref:.4f})")
                for _, r in s.iterrows():
                    print(f"    k={r.ctx_k:<5} {r.spearman_total:.4f}  "
                          f"(vs no-adj {r.spearman_total - base_bare:+.4f})  "
                          f"(vs flat {r.spearman_total - shipped_ref:+.4f})")
                best = s.loc[s.spearman_total.idxmax()]
                restacked[posn] = {"base_bare": base_bare, "shipped_ref": shipped_ref,
                                   "best": float(best.spearman_total), "best_k": float(best.ctx_k)}

            print(f"\n  --- {feat_name} VERDICT (must beat the FLAT discount already shipped) ---")
            passed_here = {}
            for posn in sorted(restacked):
                v = restacked[posn]
                ok = v["best"] > v["shipped_ref"] + MERGE_EPS
                passed_here[posn] = ok
                print(f"    {posn}  k={v['best_k']}  {v['best']:.4f} vs flat-shipped "
                      f"{v['shipped_ref']:.4f} ({v['best'] - v['shipped_ref']:+.4f})   "
                      f"{'PASS' if ok else 'FAIL'}")
            ship_here = [p for p, ok in passed_here.items() if ok]
            skip_here = [p for p, ok in passed_here.items() if not ok]
            print(f"\n  -> {label} nuance beats the flat discount for: {', '.join(ship_here) or '(none)'}"
                  f"{'; ' + ', '.join(skip_here) + ' stay on the flat discount' if skip_here else ''}.")

    # ── roadmap 1.4: rookie draft-capital model, judged against its gate ──
    rka = agg[(agg["population"] == "rookies") &
              (agg["model"].isin(["rookie_baseline", "rookie_capital"]))]
    if len(rka) and dis_rows:
        print("\n=== ROADMAP 1.4 — ROOKIE DRAFT-CAPITAL MODEL ===")
        print("rookie_baseline = today's shipped ADP/ECR-curve fallback (rookie_projection()).")
        print("rookie_capital  = draft round -> empirical rookie-year pace, fit leave-one-")
        print("                  year-out, REPLACING the fallback only where no market")
        print("                  projection covers the player (matches the roadmap's own")
        print("                  framing — not a blend layered on top of expert coverage).")
        print(f"Gate (docs/ROADMAP.md 1.4, set before running): partial correlation vs ADP")
        print(f"must clear baseline by more than {MATERIAL_EPS}, AND the FULL BOARD merged")
        print(f"(rookies anchored together with returning players, restricted to the rookie")
        print(f"population, vs the ACTUAL live board — injury discount + expert blend on")
        print(f"the returning-player side) must beat it by more than {MERGE_EPS} (v2's bar).")

        dp = pd.DataFrame(dis_rows)
        rm = agg[agg["population"] == "rookies_merged"]
        verdict = {}
        for posn in sorted(rka["pos"].unique()):
            base = rka[(rka["pos"] == posn) & (rka["model"] == "rookie_baseline")]
            cap = rka[(rka["pos"] == posn) & (rka["model"] == "rookie_capital")]
            b0 = float(base.spearman_total.iloc[0]) if len(base) else float("nan")
            c0 = float(cap.spearman_total.iloc[0]) if len(cap) else float("nan")

            bpr = dp[(dp["pos"] == posn) & (dp["variant"] == "rookie_baseline")]
            cpr = dp[(dp["pos"] == posn) & (dp["variant"] == "rookie_capital")]
            base_partial = float(bpr["partial_model"].mean()) if len(bpr) else float("nan")
            cap_partial = float(cpr["partial_model"].mean()) if len(cpr) else float("nan")

            print(f"\n  {posn}   solo: baseline {b0:.4f}   capital {c0:.4f} ({c0 - b0:+.4f})")
            print(f"        partial vs ADP (n={len(bpr)} yrs base / {len(cpr)} yrs cap): "
                  f"baseline {base_partial:+.4f}   capital {cap_partial:+.4f}")

            base_m = rm[(rm["pos"] == posn) & (rm["model"] == "rookie_baseline_merged")]
            cap_m = rm[(rm["pos"] == posn) & (rm["model"] == "rookie_capital_merged")]
            base_s = rm[(rm["pos"] == posn) & (rm["model"] == "rookie_baseline_stack")]
            cap_s = rm[(rm["pos"] == posn) & (rm["model"] == "rookie_capital_stack")]
            bm = float(base_m.spearman_total.iloc[0]) if len(base_m) else float("nan")
            cm = float(cap_m.spearman_total.iloc[0]) if len(cap_m) else float("nan")
            bs = float(base_s.spearman_total.iloc[0]) if len(base_s) else float("nan")
            cs = float(cap_s.spearman_total.iloc[0]) if len(cap_s) else float("nan")
            print(f"        merged, pure model : baseline {bm:.4f}   capital {cm:.4f} ({cm - bm:+.4f})")
            print(f"        merged, LIVE board : baseline {bs:.4f}   capital {cs:.4f} ({cs - bs:+.4f})")

            partial_ok = (base_partial == base_partial and cap_partial == cap_partial and
                          cap_partial > base_partial + MATERIAL_EPS)
            merge_ref = bs if bs == bs else bm       # prefer the live-board bar; fall back
            merge_cand = cs if cs == cs else cm      # to the pure-model merge if injury/expert
            merge_ok = (merge_ref == merge_ref and merge_cand == merge_cand and  # data was thin
                        merge_cand > merge_ref + MERGE_EPS)
            verdict[posn] = {"partial_ok": partial_ok, "merge_ok": merge_ok,
                             "merge_ref": merge_ref, "merge_cand": merge_cand}

        print("\n  --- ROADMAP 1.4 KILL GATE ---")
        ship, skip = [], []
        for posn in sorted(verdict):
            v = verdict[posn]
            ok = v["partial_ok"] and v["merge_ok"]
            (ship if ok else skip).append(posn)
            print(f"    {posn}  partial {'material' if v['partial_ok'] else 'NOT material'}   "
                  f"merged {v['merge_cand']:.4f} vs {v['merge_ref']:.4f} "
                  f"({'beats live board' if v['merge_ok'] else 'does NOT beat live board'})   "
                  f"{'PASS' if ok else 'FAIL'}")
        print(f"\n  -> PASS for: {', '.join(ship) or '(none)'}."
              + (f" {', '.join(skip)} stay on the ADP/ECR-curve fallback." if skip else ""))

    # ── roadmap 2.1: per-player outcome distributions, judged against the ──
    # calibration + sharpness gate fixed in docs/ROADMAP.md before this ran ──
    if dist_rows:
        # Evaluating CRPS against a cell of several thousand ratios, for every
        # player x year x conditioning x population, is the one genuinely hot
        # loop in this file. Thinning each cell to at most this many evenly
        # spaced order statistics is quantile thinning of an already-sorted
        # sample — it preserves the distribution's shape (that is what an
        # order statistic IS) rather than subsampling it randomly.
        MAX_EVAL_SAMPLE = 1000
        COVERAGE_LEVELS = (0.50, 0.80, 0.90)
        COVERAGE_BAND = (0.75, 0.85)     # the gate, for the 80% interval
        CRPS_REL_EPS = 0.01              # a conditioning variable must earn 1%

        def _thin(vals):
            if len(vals) <= MAX_EVAL_SAMPLE:
                return vals
            step = (len(vals) - 1) / (MAX_EVAL_SAMPLE - 1)
            return [vals[int(round(i * step))] for i in range(MAX_EVAL_SAMPLE)]

        dfr = pd.DataFrame(dist_rows)
        dfr["tier"] = [rank_tier(r) for r in dfr["rank"]]
        dfr["agebucket"] = [age_bucket(a if pd.notna(a) else None) for a in dfr["age"]]
        years_sorted = sorted(dfr["year"].unique())

        print("\n=== ROADMAP 2.1 — PER-PLAYER OUTCOME DISTRIBUTIONS ===")
        print("Empirical: the predictive distribution is the player's own live-board")
        print("projection times the historical sample of actual/projected ratios from a")
        print("matched cell (position, projected-rank tier, age bucket), fit on seasons")
        print("STRICTLY BEFORE the one being scored — an expanding window, so the first")
        print("test year has nothing to fit on and is not evaluated.")
        print(f"Gate: 80% interval coverage in {COVERAGE_BAND}, AND each conditioning")
        print(f"variable must improve held-out CRPS by more than {CRPS_REL_EPS:.0%} relative.")
        print("CRPS is a proper scoring rule — it is what stops a trivially wide interval")
        print("from passing a coverage-only test. Lower is better.")

        dist_verdict = {}
        for variant, keep_busts in (("survivors", False), ("with_busts", True)):
            sub = dfr if keep_busts else dfr[~dfr["bust"]]
            print(f"\n  ── population: {variant} "
                  f"({'includes' if keep_busts else 'excludes'} market-ranked players who "
                  f"produced no season-Y line) — {len(sub)} player-seasons ──")

            recs = []
            for cond in CONDITIONINGS:
                cache = {}
                for yi, year in enumerate(years_sorted):
                    if yi == 0:
                        continue                     # nothing strictly before it
                    hist = sub[sub["year"] < year]
                    fitted = fit_residuals(
                        (r.pos, r.tier, r.agebucket, residual_ratio(r.actual, r.proj))
                        for r in hist.itertuples())
                    cache.clear()
                    for r in sub[sub["year"] == year].itertuples():
                        ck = (r.pos, r.tier, r.agebucket)
                        if ck not in cache:
                            vals, _ = lookup_ratios(fitted, r.pos, r.tier, r.agebucket, cond)
                            # Coverage and PIT are O(1)/O(log n) on the sorted
                            # ratios, so they use the FULL cell — the whole
                            # point of the type6/type7 diagnostic is how the
                            # estimator behaves at the cell's real size, and
                            # thinning would silently change that size. Only
                            # CRPS, which is O(n), works off a thinned copy.
                            cache[ck] = (vals, _thin(vals)) if vals else None
                        cached = cache[ck]
                        if not cached or r.proj is None or r.proj <= 0:
                            continue
                        ratios, ratios_thin = cached
                        # Everything here is scale-equivariant in proj, so it is
                        # computed on the RATIOS against actual/proj rather than
                        # by materialising proj * every ratio: identical numbers,
                        # no per-player list construction.
                        z = r.actual / r.proj
                        rec = {"cond": cond, "year": year, "pos": r.pos,
                               "crps": r.proj * crps_empirical(ratios_thin, z),
                               "pit": pit(ratios, z), "proj": r.proj,
                               "cell_n": len(ratios)}
                        for lv in COVERAGE_LEVELS:
                            for qm in QUANTILE_METHODS:
                                rec[f"cov{int(lv * 100)}_{qm}"] = covers(ratios, lv, z, qm)
                        recs.append(rec)

            if not recs:
                print("    ! no evaluable rows — skipping this population")
                continue
            ev = pd.DataFrame(recs)

            for posn in sorted(ev["pos"].unique()):
                print(f"\n    {posn}")
                prev_crps = None
                accepted = None
                for cond in CONDITIONINGS:
                    e = ev[(ev["pos"] == posn) & (ev["cond"] == cond)]
                    if not len(e):
                        continue
                    crps = float(e["crps"].mean())
                    if prev_crps is None:
                        earns, delta = True, 0.0      # the baseline conditioning
                    else:
                        delta = (prev_crps - crps) / prev_crps
                        earns = delta > CRPS_REL_EPS
                    if earns:
                        accepted, prev_crps = cond, crps
                    c6 = float(e["cov80_type6"].mean())
                    c7 = float(e["cov80_type7"].mean())
                    print(f"      {cond:<14} n={len(e):<5} CRPS {crps:7.2f} "
                          f"({'baseline' if delta == 0.0 else f'{delta:+.1%} vs prev'}"
                          f"{'' if delta == 0.0 else (', earns it' if earns else ', DOES NOT earn it')})"
                          f"   cov80 type6 {c6:.3f} / type7 {c7:.3f}")

                fin = ev[(ev["pos"] == posn) & (ev["cond"] == accepted)]
                cov = {f"cov{int(lv * 100)}_{qm}": float(fin[f"cov{int(lv * 100)}_{qm}"].mean())
                       for lv in COVERAGE_LEVELS for qm in QUANTILE_METHODS}
                med_pit = float(fin["pit"].mean())
                med_n = float(fin["cell_n"].median())
                # What the estimator ALONE predicts the type6-over-type7 gain
                # should be at this cell size: 1.6/(n+1). If the observed gain
                # matches and the remaining shortfall does not close, the
                # shortfall is the model's, not the estimator's.
                pred_gain = (expected_coverage(med_n, 0.80, "type6")
                             - expected_coverage(med_n, 0.80, "type7"))
                obs_gain = cov["cov80_type6"] - cov["cov80_type7"]
                print(f"      -> model: {accepted}   median cell n={med_n:.0f}   "
                      f"cov80 {cov['cov80_type6']:.3f} (type6)   mean PIT {med_pit:.3f} "
                      f"(0.5 = unbiased; <0.5 = board systematically OPTIMISTIC)")
                print(f"         estimator check: type6-over-type7 gain {obs_gain:+.4f} "
                      f"observed vs {pred_gain:+.4f} predicted at n={med_n:.0f}")

                # Per-year, to test whether the thin-fit early years of the
                # expanding window are what drags coverage down.
                per_yr = (fin.groupby("year")
                             .agg(n=("cov80_type6", "size"),
                                  cell_n=("cell_n", "median"),
                                  c6=("cov80_type6", "mean"),
                                  c7=("cov80_type7", "mean"))
                             .reset_index())
                print("         by year (does a thin fit under-cover?):")
                for _, yr in per_yr.iterrows():
                    print(f"           {int(yr.year)}  players={int(yr.n):<4} fit cell n="
                          f"{int(yr.cell_n):<5} cov80 type6 {yr.c6:.3f} / type7 {yr.c7:.3f}")

                dist_verdict[(variant, posn)] = {
                    "cond": accepted, "pit": med_pit, "crps": prev_crps,
                    "n": len(fin), "med_n": med_n,
                    "obs_gain": obs_gain, "pred_gain": pred_gain, **cov}

        print(f"\n  --- ROADMAP 2.1 KILL GATE (cov80 within {COVERAGE_BAND}) ---")
        for variant in ("survivors", "with_busts"):
            rows_ = {k[1]: v for k, v in dist_verdict.items() if k[0] == variant}
            if not rows_:
                continue
            passed = {}
            print(f"\n    population: {variant}")
            for posn in sorted(rows_):
                v = rows_[posn]
                ok = COVERAGE_BAND[0] <= v["cov80_type6"] <= COVERAGE_BAND[1]
                was_ok = COVERAGE_BAND[0] <= v["cov80_type7"] <= COVERAGE_BAND[1]
                passed[posn] = ok
                moved = "" if ok == was_ok else ("  <- FIXED by type6" if ok
                                                 else "  <- BROKEN by type6")
                print(f"      {posn}  model={v['cond']:<14} cov80 {v['cov80_type6']:.3f} "
                      f"(was {v['cov80_type7']:.3f} under type7)  "
                      f"(cov50 {v['cov50_type6']:.3f} / cov90 {v['cov90_type6']:.3f})  "
                      f"{'PASS' if ok else 'FAIL'}{moved}")
            good = [p for p, ok in passed.items() if ok]
            bad = [p for p, ok in passed.items() if not ok]
            print(f"      -> calibrated for: {', '.join(good) or '(none)'}"
                  + (f"; NOT calibrated for {', '.join(bad)}" if bad else ""))

        print("\n  Note: nothing is wired into the frontend on this step regardless of the")
        print("  above — docs/ROADMAP.md 2.1 says the calibration check must pass BEFORE")
        print("  anything consumes the distributions, and 2.2 is what would consume them.")

    print(f"\n✓ wrote {args.out}/projection_backtest_summary.csv and _by_year.csv")


if __name__ == "__main__":
    main()

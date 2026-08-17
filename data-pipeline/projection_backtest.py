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

from projection_model import DEFAULT_PARAMS, default_scoring, project_points, with_overrides
from projection_opportunity import league_efficiency, project_points_opportunity
from projection_v2 import league_rates, stabilize_player

# Prior strength for v2's touchdown shrinkage, as a multiple of a typical
# season's workload. 0 must reproduce the shipped model exactly (checked).
V2_K = [0.0, 0.25, 0.5, 1.0, 2.0, 4.0]

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

        keep = pd.DataFrame({
            "season": y,
            "player_id": df[id_c],
            "name": df[name_c],
            "pos": df[pos_c],
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
            "team": "",
            "age": ages.get((year, pid)),
            "last": season_line(p1) if p1 is not None else None,
            "last2": season_line(p2) if p2 is not None else None,
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
    args = ap.parse_args()

    test_years = list(range(args.first, args.last + 1))
    need = sorted({y for t in test_years for y in (t - 2, t - 1, t)})
    print(f"Loading NFL data {need[0]}–{need[-1]}…")
    data = load_seasons(need)
    print(f"Loaded {len(data)} player-seasons")
    if data.empty:
        raise SystemExit("No data loaded — fix the loader before reading anything below.")
    print("Loading ages from rosters…")
    ages = load_ages(test_years)
    print(f"  {len(ages)} player-ages")

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

    per_year = []
    dis_rows = []          # model-vs-market disagreement diagnostic
    coverage = []          # (year, ranked, total) — how much of the board ADP covers
    for year in test_years:
        players = build_players(data, ages, year)
        if not players:
            continue

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

    df = pd.DataFrame(per_year)
    for c in ("blend_w", "k", "inj_k", "opp_k"):
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

    print(f"\n✓ wrote {args.out}/projection_backtest_summary.csv and _by_year.csv")


if __name__ == "__main__":
    main()

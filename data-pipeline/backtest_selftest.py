#!/usr/bin/env python3
"""
backtest_selftest.py — guards the backtest's own machinery
==========================================================
The failures this file exists to catch do not raise. They produce a plausible
number that means something other than what the header says, and get read as a
result. That has already happened twice here:

  1. the model was compared to the market on two DIFFERENT populations, which
     made it look ~0.10 Spearman better when it is in fact worse;
  2. the disagreement diagnostic correlated (market - model) against
     (market - actual), which share the market term — scored that way a random
     model reads +0.39 and an INVERTED model reads ~0.

So every construction in the backtest gets pinned to inputs whose right answer
is known a priori: a null that must read 0, an identity that must be exact, an
inversion that must flip sign. Runs offline in under a second — no nflverse, no
API key. Run it before trusting any backtest output.

  python backtest_selftest.py
"""
from __future__ import annotations

import random
from types import SimpleNamespace

from projection_backtest import COMP, blend_with_market, disagreement_signal, injury_multiplier
from projection_model import default_scoring

SC = default_scoring(0.5)
FAILS = []


def check(label, cond, detail=""):
    print(f"  {'ok  ' if cond else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    if not cond:
        FAILS.append(label)


def approx(a, b, tol):
    return a == a and abs(a - b) <= tol


def actual(pts):
    """A season line worth exactly `pts` fantasy points (carried as rush yards)."""
    return SimpleNamespace(gp=17, fumbles=0.0,
                           **{**{v: 0.0 for v in COMP.values()}, "rushYd": pts * 10})


# ── blend_with_market: the coverage merge ──────────────────────────────────
# Six RBs, only three of whom the market ranks. The merge must reshuffle the
# ranked players AMONG THEMSELVES and leave the rest alone; if the rank ladder
# is built from all six instead, the ranked players get handed point values the
# unranked ones already hold, inflating the covered slice.
print("blend_with_market (coverage merge)")
players = [{"player_id": n, "pos": "RB"} for n in "ABCDEF"]
model = [100, 90, 80, 70, 60, 50]
adp = {"C": 1, "A": 2, "F": 3}          # ranked model pts: 100, 80, 50

w1 = blend_with_market(players, model, adp, 1.0)
check("w=1.0 is the pure model, exactly", w1 == model, str(w1))

w0 = blend_with_market(players, model, adp, 0.0)
by = dict(zip("ABCDEF", w0))
check("ranked group is a permutation of its own point values",
      sorted(by[n] for n in adp) == [50, 80, 100],
      str({n: by[n] for n in "ACF"}))
check("market order is respected (C > A > F)", by["C"] > by["A"] > by["F"])
check("unranked players are untouched",
      all(by[n] == model[i] for i, n in enumerate("ABCDEF") if n not in adp))
check("w=0.5 sits between the endpoints",
      all(min(a, b) - 1e-9 <= m <= max(a, b) + 1e-9
          for a, b, m in zip(model, w0, blend_with_market(players, model, adp, 0.5))))

# A position the market ignores entirely must pass straight through.
qb = [{"player_id": f"q{i}", "pos": "QB"} for i in range(4)]
check("position with no ADP at all is passed through",
      blend_with_market(qb, [40, 30, 20, 10], {}, 0.0) == [40, 30, 20, 10])

# ── disagreement_signal: the incremental-signal diagnostic ─────────────────
print("\ndisagreement_signal (partial Spearman, null must be 0)")
random.seed(7)
N = 200
truth = [random.uniform(50, 300) for _ in range(N)]
pop = [{"player_id": i, "pos": "RB", "_actual": actual(truth[i])} for i in range(N)]
order = sorted(range(N), key=lambda i: -(truth[i] + random.gauss(0, 60)))
ADP = {i: r + 1 for r, i in enumerate(order)}


def partial(model_pts):
    return disagreement_signal(pop, model_pts, ADP, SC)["RB"]["partial_model"]


perfect = partial(truth)
noise = partial([random.random() for _ in range(N)])
inverted = partial([-t for t in truth])
partly = partial([t + random.gauss(0, 60) for t in truth])

check("a perfect model reads +1", approx(perfect, 1.0, 1e-6), f"{perfect:+.4f}")
check("a PURE-NOISE model reads 0 (the null)", abs(noise) < 0.10, f"{noise:+.4f}")
check("an inverted model reads -1", approx(inverted, -1.0, 1e-6), f"{inverted:+.4f}")
check("a partly-informative model lands strictly between",
      0.10 < partly < 0.99, f"{partly:+.4f}")
check("signal is ordered: noise < partial < perfect", noise < partly < perfect + 1e-9)

# A model that merely echoes the market carries no incremental information; the
# partial is undefined (0/0) rather than large, and must not read as signal.
echo = partial([-ADP[i] for i in range(N)])
check("a model that just echoes ADP is nan, never a big number",
      echo != echo or abs(echo) < 0.10, f"{echo:+.4f}")

# ── projection_v2: touchdown shrinkage ─────────────────────────────────────
print("\nprojection_v2 (touchdown shrinkage)")
from projection_v2 import league_rates, stabilize_line, stabilize_player   # noqa: E402

# League: 10 TDs per 100 carries, 5 per 100 targets.
rows = [("RB", {"carries": 100.0, "rushTD": 10.0, "targets": 100.0, "recTD": 5.0})
        for _ in range(20)]
R = league_rates(rows)
check("league rate is TDs per opportunity",
      approx(R[("RB", "rush")]["rate"], 0.10, 1e-9) and approx(R[("RB", "rec")]["rate"], 0.05, 1e-9))
check("mean_opp is per-player, not the pooled total",
      approx(R[("RB", "rush")]["mean_opp"], 100.0, 1e-9), str(R[("RB", "rush")]["mean_opp"]))

lucky = {"carries": 100.0, "rushTD": 20.0, "targets": 0.0, "recTD": 0.0}
check("k=0 changes nothing (the shipped model, exactly)",
      stabilize_line(lucky, "RB", R, 0.0) == lucky)

k1 = stabilize_line(lucky, "RB", R, 1.0)
check("shrinkage pulls a lucky season toward the league rate",
      15.0 - 1e-9 <= k1["rushTD"] < 20.0, f"20.0 -> {k1['rushTD']:.2f}")
check("k=1 with equal workload lands exactly halfway",
      approx(k1["rushTD"], 15.0, 1e-9), f"{k1['rushTD']:.4f}")
check("more shrinkage moves further toward league average",
      stabilize_line(lucky, "RB", R, 4.0)["rushTD"] < k1["rushTD"])
check("volume itself is never touched", k1["carries"] == lucky["carries"])

unlucky = stabilize_line({"carries": 100.0, "rushTD": 2.0}, "RB", R, 1.0)
check("an unlucky season is pulled UP, not just down",
      2.0 < unlucky["rushTD"] <= 10.0, f"2.0 -> {unlucky['rushTD']:.2f}")

big = stabilize_line({"carries": 400.0, "rushTD": 40.0}, "RB", R, 1.0)
small = stabilize_line({"carries": 25.0, "rushTD": 5.0}, "RB", R, 1.0)
check("a big sample is shrunk proportionally less than a small one",
      (40.0 - big["rushTD"]) / 40.0 < (5.0 - small["rushTD"]) / 5.0,
      f"400 carries {(40.0 - big['rushTD']) / 40.0:.1%} vs 25 carries {(5.0 - small['rushTD']) / 5.0:.1%}")

check("a stat the position never records is left alone",
      stabilize_line({"carries": 0.0, "rushTD": 3.0}, "RB", R, 1.0)["rushTD"] == 3.0)
check("an unknown position falls through untouched",
      stabilize_line(lucky, "P", R, 1.0) == lucky)

orig = {"carries": 100.0, "rushTD": 20.0}
player = {"pos": "RB", "last": orig, "last2": None}
out = stabilize_player(player, R, 1.0)
check("stabilize_player does not mutate the caller's line", orig["rushTD"] == 20.0)
check("stabilize_player handles a missing prior season", out["last2"] is None)
check("stabilize_player rewrites the season it does have", out["last"]["rushTD"] < 20.0)


# ── blend_expert: our projection x the experts' ────────────────────────────
# Roadmap 0.1. The coverage rule is the one that matters: a player the experts
# do not cover must keep OUR number untouched, or the blend quietly rewrites
# half the board toward zero.
print("\nblend_expert (roadmap 0.1)")
from projection_backtest import blend_expert   # noqa: E402

model = [100.0, 200.0, 300.0, 400.0]
expert = [200.0, None, 0.0, 500.0]   # covered, absent, zero-as-absent, covered

check("w=1.0 is our model, exactly", blend_expert(model, expert, 1.0) == model)
check("w=0.0 takes the experts where they have an opinion",
      blend_expert(model, expert, 0.0)[0] == 200.0)
check("...and keeps ours where they do not",
      blend_expert(model, expert, 0.0)[1] == 200.0)
check("a zero expert projection counts as no opinion, not as zero points",
      blend_expert(model, expert, 0.0)[2] == 300.0)
half = blend_expert(model, expert, 0.5)
check("w=0.5 is the midpoint on covered players", half[0] == 150.0, str(half[0]))
check("...and unchanged on uncovered ones", half[1] == 200.0 and half[2] == 300.0)
check("magnitude is preserved, not just order",
      blend_expert([100.0], [900.0], 0.5)[0] == 500.0,
      "a rank transfer would have returned 100.0 here")
check("empty input is handled", blend_expert([], [], 0.5) == [])

# ── injury_multiplier: roadmap 0.3 ──────────────────────────────────────────
print("\ninjury_multiplier (roadmap 0.3)")
check("k=0 is a no-op regardless of severity",
      injury_multiplier("out", 0.0) == 1.0 and injury_multiplier("questionable", 0.0) == 1.0)
check("no reported severity is a no-op at any k",
      injury_multiplier(None, 1.0) == 1.0 and injury_multiplier("", 2.0) == 1.0)
check("an unrecognized severity (e.g. 'note') is a no-op",
      injury_multiplier("note", 1.0) == 1.0)
check("'out' at k=1 discounts exactly 6 of 17 games",
      approx(injury_multiplier("out", 1.0), (17 - 6) / 17, 1e-9),
      f"{injury_multiplier('out', 1.0):.4f}")
check("k scales the table linearly",
      approx(injury_multiplier("out", 2.0), (17 - 12) / 17, 1e-9))
check("severities order the same way the games-missed table does",
      injury_multiplier("out", 1.0) < injury_multiplier("doubtful", 1.0) < injury_multiplier("questionable", 1.0))
check("the multiplier never goes negative even at an absurd k",
      injury_multiplier("out", 100.0) == 0.0, f"{injury_multiplier('out', 100.0)}")

# ── projection_opportunity: two-stage volume x efficiency (roadmap 1.1/1.2) ─
print("\nprojection_opportunity (volume x shrunk efficiency)")
from projection_model import DEFAULT_PARAMS as OPP_P, project_points  # noqa: E402
from projection_opportunity import (                            # noqa: E402
    league_efficiency, opportunity, project_points_opportunity, project_volume,
)

check("opportunity sums the right fields per position",
      opportunity({"carries": 15, "targets": 5}, "RB") == 20.0 and
      opportunity({"targets": 8, "carries": 99}, "WR") == 8.0 and
      opportunity({"attempts": 30, "carries": 4}, "QB") == 34.0)
check("a position with no opportunity concept reads 0",
      opportunity({"carries": 15}, "K") == 0.0)
check("a missing line reads 0", opportunity(None, "RB") == 0.0)

vol_two = project_volume(
    {"pos": "RB", "last": {"gp": 17, "carries": 200, "targets": 40},
     "last2": {"gp": 17, "carries": 200, "targets": 40}}, OPP_P)
check("flat two-season volume pace is the raw total (no trend shift)",
      approx(vol_two, 240.0, 1e-6), f"{vol_two}")

vol_none = project_volume({"pos": "RB", "last": None, "last2": None}, OPP_P)
check("no prior-season volume -> None (rookie handling stays with the shipped model)",
      vol_none is None)

vol_k = project_volume({"pos": "K", "last": {"gp": 17, "carries": 0}, "last2": None}, OPP_P)
check("a position with no opportunity concept -> None", vol_k is None)

vol_hurt = project_volume(
    {"pos": "RB", "last": {"gp": 5, "carries": 60, "targets": 10}, "last2": None}, OPP_P)
vol_healthy = project_volume(
    {"pos": "RB", "last": {"gp": 17, "carries": 204, "targets": 34}, "last2": None}, OPP_P)
check("a short season is durability-discounted even at the same per-game pace",
      vol_hurt < vol_healthy, f"{vol_hurt:.1f} vs {vol_healthy:.1f}")

rates_rows = [("RB", {"carries": 200.0, "targets": 0.0, "rushYd": 1000.0, "rushTD": 8.0}, SC)
              for _ in range(10)]
rates = league_efficiency(rates_rows)
check("league_efficiency computes points-per-opportunity",
      approx(rates["RB"]["rate"], (1000.0 * 0.1 + 8.0 * 6) / 200.0, 1e-9),
      str(rates.get("RB")))
check("mean_opp is per-player, not the pooled total",
      approx(rates["RB"]["mean_opp"], 200.0, 1e-9))

lucky = {"pos": "RB", "age": 25,
         "last": {"gp": 17, "carries": 100, "targets": 0, "rushYd": 500, "rushTD": 12},
         "last2": None}
p_k0 = project_points_opportunity(lucky, SC, rates, 0.0, OPP_P)
check("k=0 uses the player's own unshrunk rate exactly",
      approx(p_k0["efficiency"], p_k0["own_efficiency"], 1e-9), str(p_k0))
p_k4 = project_points_opportunity(lucky, SC, rates, 4.0, OPP_P)
check("more shrinkage pulls a lucky rate toward the league average",
      abs(p_k4["efficiency"] - rates["RB"]["rate"]) < abs(p_k0["efficiency"] - rates["RB"]["rate"]),
      f"k0={p_k0['efficiency']:.4f} k4={p_k4['efficiency']:.4f} league={rates['RB']['rate']:.4f}")
check("opportunity_based is flagged true when the stage actually ran", p_k0["opportunity_based"])

big_sample = {"pos": "RB", "age": 25,
              "last": {"gp": 17, "carries": 400, "targets": 0, "rushYd": 2000, "rushTD": 40},
              "last2": None}
small_sample = {"pos": "RB", "age": 25,
                "last": {"gp": 17, "carries": 25, "targets": 0, "rushYd": 125, "rushTD": 5},
                "last2": None}
big_k1 = project_points_opportunity(big_sample, SC, rates, 1.0, OPP_P)
small_k1 = project_points_opportunity(small_sample, SC, rates, 1.0, OPP_P)
big_move = abs(big_k1["efficiency"] - big_k1["own_efficiency"])
small_move = abs(small_k1["efficiency"] - small_k1["own_efficiency"])
check("a big sample is shrunk proportionally less than a small one",
      big_move < small_move, f"400 carries moved {big_move:.4f}, 25 carries moved {small_move:.4f}")

kicker = {"pos": "K", "age": 28, "last": {"gp": 17}, "last2": None}
fb = project_points_opportunity(kicker, SC, rates, 1.0, OPP_P)
check("a position with no opportunity concept falls back to the shipped model, untouched",
      not fb["opportunity_based"] and fb["proj"] == project_points(kicker, SC, OPP_P)["proj"])

no_vol_rb = {"pos": "RB", "age": 24, "last": None, "last2": None, "adp": 40}
fb2 = project_points_opportunity(no_vol_rb, SC, rates, 1.0, OPP_P)
check("a true rookie (no prior volume) falls back to the shipped model's rookie handling",
      not fb2["opportunity_based"] and fb2["proj"] == project_points(no_vol_rb, SC, OPP_P)["proj"])

print()
if FAILS:
    raise SystemExit(f"backtest selftest: {len(FAILS)} FAILED — {', '.join(FAILS)}")
print("backtest selftest: all checks passed")

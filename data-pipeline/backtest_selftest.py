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

from projection_backtest import COMP, blend_with_market, disagreement_signal
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

print()
if FAILS:
    raise SystemExit(f"backtest selftest: {len(FAILS)} FAILED — {', '.join(FAILS)}")
print("backtest selftest: all checks passed")

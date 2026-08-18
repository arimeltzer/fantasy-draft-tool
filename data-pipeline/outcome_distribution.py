"""
outcome_distribution.py — per-player outcome distributions (roadmap 2.1)
=======================================================================
The board currently hands every consumer a POINT estimate. A championship is
won by maximizing P(finish 1st), which is convex in outcomes — variance has
option value a mean cannot express — so every later phase needs a
distribution, not a number.

CONSTRUCTION: empirical, not parametric. The roadmap is explicit ("fit
empirically from historical residuals... not a parametric guess"), and it is
right to be: fantasy outcomes are strongly right-skewed (a WR's downside is
bounded at zero, his upside is not) and no symmetric family reproduces that.
So the predictive distribution for a player is his own projection times the
EMPIRICAL sample of `actual / projected` ratios from comparable historical
player-seasons:

    predictive_sample = proj * [r_1, r_2, ... r_n]   (r from a matched cell)

RATIO, not absolute residual, because the errors are heteroscedastic by
construction — a player projected at 300 points misses by more absolute points
than one projected at 40, and pooling those on an absolute scale would hand
the deep bench a comically wide interval and the elite a comically narrow one.

CONDITIONING is hierarchical with a coverage rule, the same shape every other
stage in this pipeline uses (`MIN_ROUND_N` in rookie_capital, `MIN_QB_ATTEMPTS`
in team_context): try the finest cell, fall back to a coarser one when the fine
cell has fewer than `MIN_CELL_N` samples. Tail quantiles need bodies; a 10th
percentile estimated off 6 observations is noise wearing a number's clothes.

Which variables actually condition anything is a QUESTION, not an assumption —
`pos`, `pos+rank`, and `pos+rank+age` are fit as three separate models so the
backtest can require each added variable to earn its place on held-out CRPS.
The roadmap naming age is not evidence that age helps.
"""
from __future__ import annotations

import bisect

# A cell needs this many historical ratios before its own empirical quantiles
# are trusted; below it, fall back to the next coarser conditioning. Set for
# the TAILS, not the median — the 10th/90th percentiles are what an 80%
# interval is made of, and those are the least stable part of a small sample.
MIN_CELL_N = 40

# Purely a numerical guard on the ratio's denominator, NOT a modeling choice:
# a player projected for 2.0 points who scores 40 produces a ratio of 20 that
# would swamp any cell it landed in. Rank tiers (below) are what actually
# separate the deep bench from the elite.
MIN_PROJ_FOR_RATIO = 10.0

# Projected rank WITHIN position. The error distribution's SHAPE — not just its
# scale, which `proj` already carries — differs by tier: the RB1's realistic
# downside is a season-ending injury, the RB40's is simply never getting
# touches, and those are not the same shape.
RANK_TIERS = ((6, "1-6"), (12, "7-12"), (24, "13-24"), (48, "25-48"), (float("inf"), "49+"))

AGE_BUCKETS = ((24.0, "<=24"), (28.0, "25-28"), (float("inf"), ">=29"))

# The three conditioning models, coarsest first. Order matters: `lookup_ratios`
# walks BACKWARD along this list, so index 0 must be the always-available
# fallback.
CONDITIONINGS = ("pos", "pos_rank", "pos_rank_age")


def rank_tier(rank) -> str:
    """Projected rank (1 = best at the position) -> tier label."""
    if rank is None:
        return "unknown"
    for hi, label in RANK_TIERS:
        if rank <= hi:
            return label
    return RANK_TIERS[-1][1]


def age_bucket(age) -> str:
    """Age -> bucket label. A missing age is its OWN bucket rather than being
    quietly folded into a real one — the coverage rule everywhere else in this
    pipeline (a missing signal falls back, it never masquerades as a value)."""
    if age is None:
        return "unknown"
    for hi, label in AGE_BUCKETS:
        if age <= hi:
            return label
    return AGE_BUCKETS[-1][1]


def residual_ratio(actual, proj):
    """actual / proj, or None when proj is too small to divide by safely.
    Deliberately NOT clipped: clipping the tail would hide exactly the
    behaviour a distribution exists to describe."""
    if proj is None or proj < MIN_PROJ_FOR_RATIO:
        return None
    if actual is None:
        return None
    return actual / proj


def _keys_for(pos, tier, age_b):
    """The cell key at each conditioning level, coarsest first — parallel to
    CONDITIONINGS by index."""
    return (("pos", pos),
            ("pos_rank", pos, tier),
            ("pos_rank_age", pos, tier, age_b))


def fit_residuals(rows) -> dict:
    """rows: iterable of (pos, tier, age_bucket, ratio). Returns
    {cell_key: sorted list of ratios} at all three conditioning levels at once
    (a row contributes to its `pos` cell AND its `pos_rank` cell AND its
    `pos_rank_age` cell), so one pass builds every model the gate compares.

    The caller is responsible for passing only rows from seasons strictly
    before the one being predicted — the same no-lookahead discipline
    `league_rates`/`opp_rates`/`rookie_capital_curve` are given."""
    acc: dict = {}
    for pos, tier, age_b, ratio in rows:
        if ratio is None or pos is None:
            continue
        for key in _keys_for(pos, tier, age_b):
            acc.setdefault(key, []).append(ratio)
    return {k: sorted(v) for k, v in acc.items()}


def lookup_ratios(fitted: dict, pos, tier, age_b, conditioning: str):
    """The finest cell at or below `conditioning` that clears MIN_CELL_N.

    Returns (sorted_ratios, key_used), or (None, None) when even the coarsest
    cell is too thin — the caller then has no distribution for that player and
    must say so rather than invent one."""
    if conditioning not in CONDITIONINGS:
        raise ValueError(f"unknown conditioning {conditioning!r}")
    depth = CONDITIONINGS.index(conditioning)
    for key in reversed(_keys_for(pos, tier, age_b)[: depth + 1]):
        vals = fitted.get(key)
        if vals is not None and len(vals) >= MIN_CELL_N:
            return vals, key
    return None, None


def predictive_sample(proj, ratios):
    """proj * each historical ratio — the player's empirical predictive
    distribution, already sorted because `ratios` is (proj >= 0 keeps order)."""
    if proj is None or not ratios:
        return None
    return [proj * r for r in ratios]


def quantile(sorted_sample, q: float) -> float:
    """Linear-interpolated empirical quantile. `q` in [0, 1]."""
    if not sorted_sample:
        raise ValueError("empty sample")
    if len(sorted_sample) == 1:
        return sorted_sample[0]
    pos = q * (len(sorted_sample) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(sorted_sample) - 1)
    frac = pos - lo
    return sorted_sample[lo] * (1 - frac) + sorted_sample[hi] * frac


def interval(sorted_sample, width: float) -> tuple:
    """The central interval of the given nominal width (0.8 -> 10th..90th)."""
    tail = (1.0 - width) / 2.0
    return quantile(sorted_sample, tail), quantile(sorted_sample, 1.0 - tail)


def covers(sorted_sample, width: float, actual) -> bool:
    lo, hi = interval(sorted_sample, width)
    return lo <= actual <= hi


def crps_empirical(sorted_sample, actual) -> float:
    """Continuous Ranked Probability Score against an empirical predictive
    sample, computed EXACTLY rather than by quantile approximation.

        CRPS(F, y) = E|X - y| - 0.5 * E|X - X'|,   X, X' iid ~ F

    The second term is the sample's Gini mean difference, which for a sorted
    sample has the closed form (2/n^2) * sum_i (2i - n - 1) * x_(i), so the
    whole thing is O(n) on an already-sorted sample.

    Lower is better. CRPS is a PROPER scoring rule: it is minimised by
    reporting your true belief, and it penalises a needlessly wide
    distribution — which is the entire reason it is here. Interval coverage
    alone is gameable by widening; this is not.
    """
    n = len(sorted_sample)
    if n == 0:
        raise ValueError("empty sample")
    mae = sum(abs(x - actual) for x in sorted_sample) / n
    gini = sum((2 * (i + 1) - n - 1) * x for i, x in enumerate(sorted_sample)) / (n * n)
    return mae - gini


def pit(sorted_sample, actual) -> float:
    """Probability integral transform: the fraction of the predictive sample at
    or below the actual outcome. If the distributions are calibrated these are
    uniform on [0, 1] across players — a strictly stronger check than any
    single interval, and the one that shows WHERE a miscalibration lives
    (piling up near 0 means the model is systematically too optimistic)."""
    if not sorted_sample:
        raise ValueError("empty sample")
    return bisect.bisect_right(sorted_sample, actual) / len(sorted_sample)

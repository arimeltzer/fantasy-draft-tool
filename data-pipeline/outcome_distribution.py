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


def in_window(row_year: int, test_year: int, window) -> bool:
    """Is a historical season usable for predicting `test_year` under a rolling
    window of `window` seasons? (roadmap 2.1 follow-up c)

    Two conditions, and both are load-bearing: strictly BEFORE the test year
    (no lookahead, the rule every stage in this pipeline follows) and no more
    than `window` seasons back. `window=None` is the flat pool over all prior
    seasons — the original 2.1 behaviour, and the baseline arm of the sweep.

    Boundary: `window=3` predicting 2025 admits 2022, 2023, 2024 — three
    seasons, the most recent three, not four.
    """
    if row_year >= test_year:
        return False
    if window is None:
        return True
    return row_year >= test_year - window


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


# Which empirical-quantile definition to use (Hyndman-Fan taxonomy). This is
# NOT a cosmetic choice when the number being computed is an interval whose
# coverage is the thing under test:
#
#   type7 (`q*(n-1)`, 0-indexed — numpy/R's default, and what 2.1 first shipped)
#     puts the nominal-80% interval between order statistics spanning
#     `0.8*(n-1)` gaps out of the `n+1` gaps a future observation can land in,
#     so its EXPECTED coverage is 0.8*(n-1)/(n+1) — 0.761 at n=40, 0.784 at
#     n=100, 0.796 at n=450. Always short, worst when the cell is thin.
#
#   type6 (`q*(n+1)`, 1-indexed — Weibull plotting position) spans 0.8*(n+1)
#     of those same n+1 gaps, so its expected coverage is exactly 0.80 for
#     EVERY n. That property is precisely what an interval-calibration gate
#     measures, which makes it the correct estimator here rather than merely a
#     different one.
#
# The difference is +1.6/(n+1) of coverage, so it is worth real points on a
# thin cell and almost nothing on a fat one — which is exactly what makes it a
# usable diagnostic for whether an under-covering position is a small-sample
# artifact or genuinely mis-specified.
QUANTILE_METHODS = ("type6", "type7")


def quantile(sorted_sample, q: float, method: str = "type6") -> float:
    """Linear-interpolated empirical quantile. `q` in [0, 1].

    See QUANTILE_METHODS above for why the default is type6 and not the more
    familiar type7."""
    if not sorted_sample:
        raise ValueError("empty sample")
    n = len(sorted_sample)
    if n == 1:
        return sorted_sample[0]
    if method == "type7":
        pos = q * (n - 1)
    elif method == "type6":
        # 1-indexed q*(n+1) -> 0-indexed, clamped: an empirical distribution
        # has no mass outside its own extremes, so the deepest this can reach
        # is the sample min/max.
        pos = q * (n + 1) - 1.0
    else:
        raise ValueError(f"unknown quantile method {method!r}")
    pos = max(0.0, min(pos, n - 1.0))
    lo = int(pos)
    hi = min(lo + 1, n - 1)
    frac = pos - lo
    return sorted_sample[lo] * (1 - frac) + sorted_sample[hi] * frac


def interval(sorted_sample, width: float, method: str = "type6") -> tuple:
    """The central interval of the given nominal width (0.8 -> 10th..90th)."""
    tail = (1.0 - width) / 2.0
    return (quantile(sorted_sample, tail, method),
            quantile(sorted_sample, 1.0 - tail, method))


def covers(sorted_sample, width: float, actual, method: str = "type6") -> bool:
    lo, hi = interval(sorted_sample, width, method)
    return lo <= actual <= hi


def expected_coverage(n: int, width: float, method: str = "type6") -> float:
    """The coverage this estimator is expected to achieve for a FUTURE draw,
    from a fit of size n, under the ideal case where the cell is correctly
    specified and the sample is iid from it.

    Used to state, in advance, how much of an observed coverage shortfall is
    attributable to the estimator rather than to the model — the difference
    between the two methods is the whole basis of that diagnostic."""
    if method == "type6":
        return width
    if method == "type7":
        return width * (n - 1) / (n + 1)
    raise ValueError(f"unknown quantile method {method!r}")


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

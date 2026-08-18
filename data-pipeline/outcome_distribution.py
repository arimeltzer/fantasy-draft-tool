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

# Per-position override of the tier boundaries above (roadmap 2.1 follow-up
# (e)). Only QB has one: (d) found the shared 7-12 bucket straddles a real
# ~2.5x width jump between ADP 7-9 and ADP 10-12, a plausible reason
# `pos_rank` never earned its CRPS bar for QB under the shared layout. ONE
# split point, not a fitted curve — (d)'s own tier-by-tier detail was too
# noisy at n=20-40/cell to trust a finer shape, the same discipline
# `MIN_CELL_N` and the collapsed snake-slot configs (roadmap 0.2) already
# follow. Every other position is absent from this dict and falls through to
# the shared `RANK_TIERS` unchanged.
RANK_TIERS_BY_POS = {
    "QB": ((9, "1-9"), (float("inf"), "10+")),
}

AGE_BUCKETS = ((24.0, "<=24"), (28.0, "25-28"), (float("inf"), ">=29"))

# The three conditioning models, coarsest first. Order matters: `lookup_ratios`
# walks BACKWARD along this list, so index 0 must be the always-available
# fallback.
CONDITIONINGS = ("pos", "pos_rank", "pos_rank_age")


def rank_tier(rank, pos=None) -> str:
    """Projected rank (1 = best at the position) -> tier label.

    `pos` selects a position-specific layout from RANK_TIERS_BY_POS when one
    is registered there (currently QB only, roadmap 2.1 follow-up (e));
    every other position — including `pos=None`, which every pre-(e) caller
    still passes — falls through to the shared RANK_TIERS unchanged."""
    if rank is None:
        return "unknown"
    tiers = RANK_TIERS_BY_POS.get(pos, RANK_TIERS)
    for hi, label in tiers:
        if rank <= hi:
            return label
    return tiers[-1][1]


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


# ── weekly conditioning (roadmap 2.2a) ───────────────────────────────
# A SEASON distribution conditions on age; a WEEKLY one conditions on the
# defense faced, which has no season-level analogue. Kept as its own ladder
# rather than a fourth level on CONDITIONINGS so the 2.1 season fit is
# untouched — mixing them would silently change what `pos_rank_age` means.
WEEKLY_CONDITIONINGS = ("pos", "pos_rank", "pos_rank_opp")

# Defense strength faced, as tertiles of prior-season fantasy points allowed to
# the position. Prior season only — a rating built from the season being
# predicted would be lookahead, the same rule `league_rates`/`opp_rates` follow.
OPP_BUCKETS = ("soft", "neutral", "tough")


def opp_bucket(rating, cuts):
    """Defense rating -> bucket label. `cuts` is (lo, hi) tertile boundaries.

    A missing rating is its OWN bucket rather than being folded into
    "neutral" — the coverage rule the rest of this module follows (a missing
    signal falls back, it never masquerades as a value). A team with no prior
    season on record (an expansion team, or the first year of the backtest)
    genuinely has no reading, and pretending it is average would be a guess."""
    if rating is None or cuts is None:
        return "unknown"
    lo, hi = cuts
    if rating <= lo:
        return "soft"
    if rating >= hi:
        return "tough"
    return "neutral"


def _keys_for(pos, tier, age_b):
    """The cell key at each conditioning level, coarsest first — parallel to
    CONDITIONINGS by index."""
    return (("pos", pos),
            ("pos_rank", pos, tier),
            ("pos_rank_age", pos, tier, age_b))


def _weekly_keys_for(pos, tier, opp_b):
    """Weekly analogue of `_keys_for`, parallel to WEEKLY_CONDITIONINGS.

    The key prefixes are distinct ("wpos..." not "pos...") so a weekly cell can
    never collide with a season cell if both ever share a fitted dict."""
    return (("wpos", pos),
            ("wpos_rank", pos, tier),
            ("wpos_rank_opp", pos, tier, opp_b))


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


def fit_weekly_residuals(rows) -> dict:
    """rows: iterable of (pos, tier, opp_bucket, ratio). Weekly analogue of
    `fit_residuals` — same accumulation, weekly key ladder.

    BYES MUST ALREADY BE EXCLUDED by the caller. A bye is deterministic and
    known in August, so it is not an outcome the distribution should describe;
    an INACTIVE week is stochastic and belongs in as a real zero. That
    distinction is the whole reason this fit is trustworthy for lineup
    decisions, and it cannot be enforced here — the schedule is the caller's."""
    acc: dict = {}
    for pos, tier, opp_b, ratio in rows:
        if ratio is None or pos is None:
            continue
        for key in _weekly_keys_for(pos, tier, opp_b):
            acc.setdefault(key, []).append(ratio)
    return {k: sorted(v) for k, v in acc.items()}


def lookup_weekly_ratios(fitted: dict, pos, tier, opp_b, conditioning: str):
    """Weekly analogue of `lookup_ratios`: finest cell at or below
    `conditioning` clearing MIN_CELL_N, else fall back, else (None, None)."""
    if conditioning not in WEEKLY_CONDITIONINGS:
        raise ValueError(f"unknown weekly conditioning {conditioning!r}")
    depth = WEEKLY_CONDITIONINGS.index(conditioning)
    for key in reversed(_weekly_keys_for(pos, tier, opp_b)[: depth + 1]):
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


# ── player-season FORM FACTOR (roadmap 2.2a follow-up) ─────────────────
# 2.2a fit weekly ratios as i.i.d. draws from one pooled cell and found the
# implied season variance collapses to ~0.3x the real thing: summing 17
# INDEPENDENT weeks throws away the fact that a player's own weeks, within a
# season, are correlated (health, role, matchup quality all move together for
# the SAME player). This decomposes ratio = form x residual: `form` drawn once
# per player-season (how good was his season, overall), `residual` drawn
# independently week to week (this week's luck, uncorrelated with next
# week's). Both pools stay EMPIRICAL — raw historical values resampled, no
# assumed shape — same discipline every other pool in this module follows.

# A player-season needs this many played weeks (byes already excluded) before
# its own mean is trusted as a `form` read rather than being mostly
# week-to-week noise wearing a season number's clothes — the same reasoning
# MIN_CELL_N applies to a tail quantile, applied here to a mean instead.
MIN_WEEKS_FOR_FORM = 6


def player_season_form(ratios):
    """Mean of one player-season's own weekly ratios — the empirical estimate
    of that player-season's `form` multiplier. None below MIN_WEEKS_FOR_FORM:
    a player-season admitted with too few weeks would also mechanically
    produce near-zero residuals around its own barely-sampled mean, polluting
    the residual pool with fake precision."""
    if not ratios or len(ratios) < MIN_WEEKS_FOR_FORM:
        return None
    return sum(ratios) / len(ratios)


def weekly_residuals_from_form(ratios, form):
    """Each week's ratio divided by its own player-season's form — the
    within-season component, independent BY CONSTRUCTION of how good the
    season was overall. Empty/None inputs yield no residuals rather than a
    divide-by-zero guess."""
    if not ratios or not form:
        return []
    return [r / form for r in ratios]


def fit_form_pool(rows) -> dict:
    """rows: iterable of (pos, form). Returns {pos: sorted [form, ...]} — the
    empirical distribution of player-season form multipliers. Conditioning is
    held at `pos` only (roadmap 2.2a's own sweep found nothing finer earned
    its place for the positions this applies to), so this is a flat pool per
    position rather than a fallback ladder like `fit_residuals`."""
    acc: dict = {}
    for pos, form in rows:
        if form is None or pos is None:
            continue
        acc.setdefault(pos, []).append(form)
    return {k: sorted(v) for k, v in acc.items()}


def fit_residual_pool(rows) -> dict:
    """rows: iterable of (pos, residual). Returns {pos: sorted [residual, ...]}
    — the empirical within-season week-to-week distribution, same flat-per-
    position shape as `fit_form_pool` and for the same reason."""
    acc: dict = {}
    for pos, resid in rows:
        if resid is None or pos is None:
            continue
        acc.setdefault(pos, []).append(resid)
    return {k: sorted(v) for k, v in acc.items()}


def simulate_season_ratios(proj_weeks, form_pool, resid_pool, rng, n_draws=2000):
    """Monte Carlo season composition: for each of `n_draws`, draw ONE `form`
    (shared across the whole simulated season) and one INDEPENDENT `residual`
    per week in `proj_weeks` (the player's own per-week projections for weeks
    actually played — byes already excluded by the caller), multiply and sum,
    then divide by the season's total projection.

    Returns a SORTED list of simulated season ratios, directly usable by
    quantile()/interval()/covers() — the same machinery 2.1's direct season
    fit already uses, so the two are comparable on equal footing.

    `rng` is an explicit random.Random instance (not the global module),
    so a caller can seed it for a reproducible test or an independent stream
    per player."""
    if not proj_weeks or not form_pool or not resid_pool:
        return []
    total_proj = sum(proj_weeks)
    if total_proj <= 0:
        return []
    n_form, n_resid = len(form_pool), len(resid_pool)
    out = []
    for _ in range(n_draws):
        form = form_pool[rng.randrange(n_form)]
        season_total = sum(
            wp * form * resid_pool[rng.randrange(n_resid)] for wp in proj_weeks)
        out.append(season_total / total_proj)
    return sorted(out)

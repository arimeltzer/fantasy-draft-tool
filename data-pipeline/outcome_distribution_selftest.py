"""Fixture tests for outcome_distribution.py — python3 outcome_distribution_selftest.py"""
import random

from outcome_distribution import (
    CONDITIONINGS,
    MIN_CELL_N,
    expected_coverage,
    MIN_PROJ_FOR_RATIO,
    age_bucket,
    covers,
    crps_empirical,
    fit_residuals,
    in_window,
    interval,
    lookup_ratios,
    pit,
    predictive_sample,
    quantile,
    rank_tier,
    residual_ratio,
)

checks = []


def check(label, cond, extra=""):
    checks.append((label, bool(cond), extra))


# ── bucketing ────────────────────────────────────────────────────────
check("rank 1 is the top tier", rank_tier(1) == "1-6")
check("rank 6 is still the top tier (boundary is inclusive)", rank_tier(6) == "1-6")
check("rank 7 falls to the next tier", rank_tier(7) == "7-12")
check("a very deep rank lands in the last tier", rank_tier(400) == "49+")
check("a missing rank is its OWN bucket, not silently tier 1",
      rank_tier(None) == "unknown")

check("a 23-year-old is young", age_bucket(23) == "<=24")
check("age boundary is inclusive", age_bucket(24.0) == "<=24")
check("a 26-year-old is prime", age_bucket(26) == "25-28")
check("a 33-year-old is old", age_bucket(33) == ">=29")
check("a missing age is its OWN bucket, not folded into a real one",
      age_bucket(None) == "unknown")

# ── residual_ratio ───────────────────────────────────────────────────
check("ratio is actual/proj", residual_ratio(150.0, 100.0) == 1.5)
check("a total bust is a ratio of 0, not a dropped row",
      residual_ratio(0.0, 100.0) == 0.0)
check("a projection below the numerical guard yields no ratio",
      residual_ratio(40.0, MIN_PROJ_FOR_RATIO - 0.1) is None)
check("a projection at the guard is usable", residual_ratio(40.0, MIN_PROJ_FOR_RATIO) is not None)
check("a huge overperformance is NOT clipped (the tail is the point)",
      residual_ratio(500.0, 20.0) == 25.0)

# ── fit_residuals / lookup_ratios ────────────────────────────────────
# One row contributes to all three conditioning levels at once.
rows = [("RB", "1-6", "25-28", 1.0 + i * 0.01) for i in range(MIN_CELL_N)]
fitted = fit_residuals(rows)
check("a row lands in its pos cell", ("pos", "RB") in fitted)
check("...and its pos_rank cell", ("pos_rank", "RB", "1-6") in fitted)
check("...and its pos_rank_age cell", ("pos_rank_age", "RB", "1-6", "25-28") in fitted)
check("cells are stored sorted", fitted[("pos", "RB")] == sorted(fitted[("pos", "RB")]))
check("a None ratio is skipped, not stored as a value",
      len(fit_residuals([("RB", "1-6", "25-28", None)]).get(("pos", "RB"), [])) == 0)

vals, key = lookup_ratios(fitted, "RB", "1-6", "25-28", "pos_rank_age")
check("a well-sampled fine cell is used at full conditioning",
      key == ("pos_rank_age", "RB", "1-6", "25-28"))

# A thin fine cell must fall back rather than report noisy tails.
thin = fit_residuals(
    [("RB", "1-6", "25-28", 1.0)] * (MIN_CELL_N - 1)          # thin at every level
    + [("RB", "7-12", "25-28", 1.2)] * MIN_CELL_N              # fattens ONLY the pos cell
)
vals, key = lookup_ratios(thin, "RB", "1-6", "25-28", "pos_rank_age")
check("a fine cell below MIN_CELL_N falls back to a coarser one",
      key == ("pos", "RB"), f"got {key}")
check("...and the fallback cell is the fat one", len(vals) >= MIN_CELL_N)

check("asking for less conditioning than available honours the request",
      lookup_ratios(fitted, "RB", "1-6", "25-28", "pos")[1] == ("pos", "RB"))
check("a position with no history at all yields no distribution, not a guess",
      lookup_ratios(fitted, "QB", "1-6", "25-28", "pos_rank_age") == (None, None))
try:
    lookup_ratios(fitted, "RB", "1-6", "25-28", "nonsense")
    check("an unknown conditioning name raises", False)
except ValueError:
    check("an unknown conditioning name raises", True)
check("CONDITIONINGS is coarsest-first (index 0 is the always-available fallback)",
      CONDITIONINGS[0] == "pos")

# ── predictive_sample ────────────────────────────────────────────────
ps = predictive_sample(100.0, [0.5, 1.0, 1.5])
check("predictive sample is proj x each ratio", ps == [50.0, 100.0, 150.0])
check("no ratios -> no sample", predictive_sample(100.0, []) is None)

# ── quantile / interval / covers ─────────────────────────────────────
s = [float(i) for i in range(101)]        # 0..100
check("median of 0..100 is 50 under either method",
      abs(quantile(s, 0.5, "type6") - 50.0) < 1e-9
      and abs(quantile(s, 0.5, "type7") - 50.0) < 1e-9)
# The two definitions differ in the TAILS and agree at the centre, which is
# the whole reason the choice matters for an interval-coverage gate and not
# for a median. n=101: type7 puts q at 0.1*100=10.0, type6 at 0.1*102-1=9.2.
check("type7's 10th percentile of 0..100 is 10 (the definition 2.1 first shipped)",
      abs(quantile(s, 0.10, "type7") - 10.0) < 1e-9)
check("type6 reaches FURTHER into the tail on the same sample",
      abs(quantile(s, 0.10, "type6") - 9.2) < 1e-9)
lo7, hi7 = interval(s, 0.80, "type7")
lo6, hi6 = interval(s, 0.80, "type6")
check("type7's 80% interval is the 10th..90th percentile",
      abs(lo7 - 10.0) < 1e-9 and abs(hi7 - 90.0) < 1e-9)
check("type6's 80% interval is strictly wider on both sides",
      lo6 < lo7 and hi6 > hi7)
check("an outcome inside the interval is covered", covers(s, 0.80, 50.0))
check("an outcome below the interval is NOT covered", not covers(s, 0.80, 5.0))
check("an outcome above the interval is NOT covered", not covers(s, 0.80, 95.0))
check("interval endpoints count as covered", covers(s, 0.80, 10.0) and covers(s, 0.80, 90.0))
check("a single-point sample degenerates gracefully", quantile([7.0], 0.9) == 7.0)

# ── crps_empirical ───────────────────────────────────────────────────
# Hand-computed: F puts mass 0.5 at 0 and 0.5 at 2; y = 1.
#   CRPS = int (F(t) - 1{t>=y})^2 dt = 0.25*1 + 0.25*1 = 0.5
check("CRPS matches a hand-computed two-point case",
      abs(crps_empirical([0.0, 2.0], 1.0) - 0.5) < 1e-12,
      f"got {crps_empirical([0.0, 2.0], 1.0)}")
# A point mass reduces to absolute error.
check("a point-mass forecast reduces CRPS to absolute error",
      abs(crps_empirical([5.0], 8.0) - 3.0) < 1e-12)
check("CRPS is 0 for a point mass on the truth",
      abs(crps_empirical([5.0], 5.0)) < 1e-12)
# Properness in the direction that matters for this gate: a needlessly WIDE
# distribution centred on the truth scores worse than a tight one.
tight = sorted(100.0 + 2.0 * (i - 50) / 50 for i in range(101))
wide = sorted(100.0 + 80.0 * (i - 50) / 50 for i in range(101))
check("a needlessly wide distribution scores WORSE than a sharp one on the truth",
      crps_empirical(wide, 100.0) > crps_empirical(tight, 100.0),
      f"wide {crps_empirical(wide, 100.0):.3f} vs tight {crps_empirical(tight, 100.0):.3f}")
# ...but a sharp distribution in the WRONG place scores worse than a wide one
# that covers the truth. This is the pair of facts that makes CRPS the right
# metric here: coverage alone rewards only the second, MAE only the first.
sharp_wrong = sorted(20.0 + 2.0 * (i - 50) / 50 for i in range(101))
check("a sharp but WRONG distribution scores worse than a wide one containing the truth",
      crps_empirical(sharp_wrong, 100.0) > crps_empirical(wide, 100.0))

# ── pit ──────────────────────────────────────────────────────────────
check("PIT of the median is ~0.5", abs(pit(s, 50.0) - 0.505) < 0.02)
check("an outcome below everything has PIT 0", pit(s, -1.0) == 0.0)
check("an outcome above everything has PIT 1", pit(s, 1e9) == 1.0)

# ── end-to-end: a calibrated generator must come back calibrated ─────
# The strongest test available without real data: draw outcomes from the SAME
# ratio distribution the cells are fit from, and confirm the 80% interval
# actually covers ~80%. If this fails, the machinery is wrong regardless of
# what the real backtest says.
rng = random.Random(7)
truth = [rng.lognormvariate(0.0, 0.5) for _ in range(4000)]
fit = fit_residuals(("WR", "1-6", "25-28", r) for r in truth)
ratios, _ = lookup_ratios(fit, "WR", "1-6", "25-28", "pos_rank_age")
hits = 0
trials = 3000
for _ in range(trials):
    proj = rng.uniform(50, 300)
    actual = proj * rng.lognormvariate(0.0, 0.5)
    if covers(predictive_sample(proj, ratios), 0.80, actual):
        hits += 1
cov = hits / trials
check("a correctly-specified generator yields ~80% coverage end to end",
      0.77 <= cov <= 0.83, f"coverage {cov:.3f}")

check("MIN_CELL_N is the documented value", MIN_CELL_N == 40)

# ── in_window (roadmap 2.1 follow-up c) ──────────────────────────────
check("the test year itself is never usable (no lookahead)",
      not in_window(2025, 2025, None) and not in_window(2025, 2025, 3))
check("a FUTURE season is never usable", not in_window(2026, 2025, None))
check("window=None admits every prior season", in_window(2005, 2025, None))
check("window=3 predicting 2025 admits 2022 (the third season back)",
      in_window(2022, 2025, 3))
check("window=3 predicting 2025 EXCLUDES 2021 (a fourth season back)",
      not in_window(2021, 2025, 3))
check("window=3 admits exactly three seasons, not four",
      sum(in_window(y, 2025, 3) for y in range(2000, 2026)) == 3)
check("window=1 admits exactly the immediately prior season",
      in_window(2024, 2025, 1) and not in_window(2023, 2025, 1)
      and sum(in_window(y, 2025, 1) for y in range(2000, 2026)) == 1)

# ── quantile method: the coverage property that makes type6 the right one ──
# This is the claim the 2.1 follow-up rests on, so it is pinned by simulation
# rather than asserted in a comment: fit an interval from n samples, then ask
# how often a FRESH draw from the same distribution lands inside it.
check("expected_coverage is exact for type6 at every n",
      all(abs(expected_coverage(n, 0.80, "type6") - 0.80) < 1e-12
          for n in (40, 100, 450, 5000)))
check("expected_coverage for type7 reproduces the known 0.8(n-1)/(n+1) deficit",
      abs(expected_coverage(40, 0.80, "type7") - 0.8 * 39 / 41) < 1e-12
      and abs(expected_coverage(450, 0.80, "type7") - 0.8 * 449 / 451) < 1e-12)
check("the type7 deficit shrinks as the cell fattens (so it is a THIN-cell problem)",
      expected_coverage(40, 0.80, "type7") < expected_coverage(450, 0.80, "type7")
      < expected_coverage(5000, 0.80, "type7") < 0.80)


def _mc_coverage(n, method, trials=4000, seed=11):
    r = random.Random(seed)
    hits = 0
    for _ in range(trials):
        fit = sorted(r.lognormvariate(0, 0.5) for _ in range(n))
        if covers(fit, 0.80, r.lognormvariate(0, 0.5), method):
            hits += 1
    return hits / trials


mc6_40 = _mc_coverage(40, "type6")
mc7_40 = _mc_coverage(40, "type7")
check("simulation: type6 hits nominal 80% coverage on a thin (n=40) cell",
      0.78 <= mc6_40 <= 0.82, f"{mc6_40:.3f}")
check("simulation: type7 under-covers on the same cell, near its predicted 0.761",
      abs(mc7_40 - expected_coverage(40, 0.80, "type7")) < 0.02, f"{mc7_40:.3f}")
check("simulation: type6 beats type7 on a thin cell by roughly the predicted 1.6/(n+1)",
      abs((mc6_40 - mc7_40) - 1.6 / 41) < 0.015, f"gain {mc6_40 - mc7_40:.3f}")

mc6_400 = _mc_coverage(400, "type6", trials=1500)
mc7_400 = _mc_coverage(400, "type7", trials=1500)
check("simulation: on a FAT cell the two methods nearly agree — the fix buys "
      "little where the sample is already large",
      abs(mc6_400 - mc7_400) < 0.02, f"{mc6_400:.3f} vs {mc7_400:.3f}")

check("a low quantile on a thin sample clamps at the sample minimum rather than "
      "extrapolating past it", quantile([1.0, 2.0, 3.0], 0.01, "type6") == 1.0)
check("a high quantile clamps at the sample maximum",
      quantile([1.0, 2.0, 3.0], 0.99, "type6") == 3.0)
try:
    quantile([1.0, 2.0], 0.5, "type99")
    check("an unknown quantile method raises", False)
except ValueError:
    check("an unknown quantile method raises", True)

failed = [label for label, ok, _ in checks if not ok]
for label, ok, extra in checks:
    print(f"  {'ok' if ok else 'FAIL'}    {label}" + (f"   {extra}" if extra else ""))
if failed:
    raise SystemExit(f"\n{len(failed)}/{len(checks)} checks FAILED: {failed}")
print(f"\noutcome_distribution_selftest: all {len(checks)} checks passed")

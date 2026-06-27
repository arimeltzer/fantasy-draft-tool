# SOS Parameter Tuning — Empirical Results

**TL;DR.** The Strength-of-Schedule parameters in
`frontend/src/engine/strength-of-schedule.js` were educated guesses. They are
now tuned against **10 seasons of real NFL outcomes (2015–2024)**, fully
out-of-sample, via `sos_backtest.py`. The headline finding is that
**schedule is a real but small signal** — which vindicates the engine's
"secondary signal, hard cap" philosophy — and that the old defaults slightly
over-trusted last year's defenses (especially TE) and over-weighted the fantasy
playoff weeks.

| Param | Old (guess) | New (empirical) | Why |
|---|---|---|---|
| `yoyRetention` | `0.35` (scalar) | `{ QB: 0.30, RB: 0.30, WR: 0.26, TE: 0.11 }` | MSE-optimal shrink = regression slope of this-year softness on last-year, per position. TE defense barely repeats. |
| `sosWeight` | `0.5` | `0.8` | Game-level calibrated response of production to predicted softness (slope 0.81). |
| `cap` | `0.06` | `0.04` | Real full-season spread is ≤3% (p99 ≈ 2%); the cap is a guardrail that should rarely bind. |
| `playoffWeight` | `1.5` | `1.2` | Weeks 15–17 softness is *less* predictable from last year (r 0.10) than the full season (r 0.27). |
| `iterations` | `12` | `12` | Unchanged — converges; not an accuracy knob. |

## Method (leak-free, out-of-sample)

1. Build half-PPR **position-vs-defense game logs** for every regular-season
   game 2015–2024 (points each position group scored against each defense).
2. For each consecutive pair of seasons `Y-1 → Y`:
   - **predictor** = `adjustedDefenseRatings(Y-1)` — the opponent-adjusted
     (SRS-style) softness the engine would know going into year `Y`.
   - **truth** = `adjustedDefenseRatings(Y)` — what actually happened, computed
     only from year-`Y` games (so it is genuinely out of sample vs. `Y-1`).
3. Pool all **1,152 (team × position × year)** observations and estimate each
   parameter from the data.

The Python SOS math is a **verified port** of the shipping JS engine
(`sos_engine.py::validate_port()` reproduces `demo()` to ~1e-6), so the backtest
measures exactly what runs in the app.

## Findings

### 1. `yoyRetention` — how much last year's defense carries over

`yoyRetention` is a pure positive scalar on each rating, so it cannot change
rank/correlation skill — it sets the **magnitude**. The MSE-optimal magnitude is
the through-origin regression slope `β* = Σ(xy)/Σ(x²)` of this-year softness on
last-year's. Per position:

| Pos | retention (β*) | Pearson r | Spearman ρ | R² | n |
|---|---|---|---|---|---|
| QB | 0.299 | 0.306 | 0.312 | 0.094 | 288 |
| RB | 0.298 | 0.305 | 0.317 | 0.093 | 288 |
| WR | 0.256 | 0.266 | 0.262 | 0.071 | 288 |
| TE | 0.105 | 0.107 | 0.122 | 0.011 | 288 |
| **All** | **0.258** | **0.266** | **0.267** | **0.071** | 1152 |

Defensive fantasy-points-allowed is only weakly autocorrelated (r ≈ 0.27
overall), and **TE defense is essentially noise year to year** (r ≈ 0.11). The
old scalar `0.35` over-retained across the board and badly over-retained TE.
Adopted the per-position object form (which the engine already supports).

### 2. Prior-year (`Y-2`) blend — not worth it

Adding the season-before-last as a second predictor raised R² from 0.074 to
0.075 (**+0.001**); its coefficient was 0.026 vs 0.258 for last year. Last
season alone is sufficient — no multi-year blend needed.

### 3. `sosWeight` — how hard schedule should nudge value

Game-level fractional calibration (regress `groupPts/leagueAvg − 1` on
predicted `softness/leagueAvg`, n = 18,911 games) gives a slope of **0.81**.
That is the unbiased response size, so `sosWeight = 0.8`. The per-game R² is
tiny (r = 0.06) — single games are noise — but the slope is the right point
estimate, and the naturally small schedule `rel` keeps the effect modest.

### 4. `cap` — a guardrail, not a lever

At the tuned weights, the distribution of **full-season** schedule multiplier
deviations is:

| p50 | p90 | p95 | p99 | max |
|---|---|---|---|---|
| 0.5% | 1.2% | 1.5% | 2.1% | 3.0% |

A whole season of schedule moves a player **≤3%** even at calibrated weights —
opponents average out over 17 games. The old `±6%` cap never bound; `±4%` keeps
it a pure guardrail against pathological inputs while never clipping real signal.
**This is the most important qualitative result: SOS is correctly a secondary
signal and must not outweigh talent.**

### 5. `playoffWeight` — weeks 15–17 are noisier, not sharper

Last year's ratings predict full-season softness at r = 0.27 but predict the
specific **playoff weeks (15–17)** softness at only r = 0.10. Up-weighting those
weeks therefore adds noise rather than accuracy. Kept a *mild* tilt (`1.2`) as a
strategy nod to when leagues are won, lowered from the noisy `1.5`.

## What is NOT tuned here (and why)

The **projection** parameters (`priorWeight`, `regressionStrength` in
`valuation-engine.js`) cannot be empirically tuned from game logs alone: the
real engine blends a *forward projection* (FantasyPros ECR) with last season,
and we have no archived projections for past years. `backtest_parameters.py`
substitutes "last-year pace × constant" as a stand-in, so its parameters only
rescale a single predictor and don't meaningfully move the accuracy metrics
(the grid rows come out identical). It has been repaired to run against the
current `nflreadpy` API, but tuning those knobs needs a season-by-season archive
of projections — a future data-collection task.

## Reproduce

```bash
cd data-pipeline
pip install nflreadpy pandas pyarrow scipy numpy
python sos_engine.py        # verify the port matches the JS engine
python sos_backtest.py --start 2015 --end 2024 --out ./data/sos_backtest
```

Raw output: `data/sos_backtest/sos_results.json` (git-ignored; weekly data is
cached under `data/sos_backtest/weekly_cache/`).

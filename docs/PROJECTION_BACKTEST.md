# Projection backtest — what it actually measures (2026-08)

`data-pipeline/backtest_parameters.py` claims to validate "the fantasy valuation
algorithm against 10 years of real outcomes". Run it before believing that.

## It had never run

Two bugs, both of which produced an empty dataset that the script then swallowed:

1. `nfl.load_player_stats(y, summary_level="season")` — not a valid level. The
   API accepts `week | reg | post | reg+post`.
2. Season games live in the `games` column; the loader looked for
   `games_played`/`gp`, so `_col()` returned `None` and `df[None]` raised
   `KeyError(None)` — printed as the uninformative `SKIP (None)`.

Each year was caught by a bare `except` that printed `SKIP` and continued, so
the run reached the aggregation step with zero rows and died there on a
confusing `KeyError: 'position'`. Both are fixed, and an empty load now stops
immediately rather than producing a meaningless grid.

## The parameters it tunes are not used by the app

`GRID` searches `priorWeight` and `regressionStrength`. Both are declared in
`engine-core.js DEFAULT_PARAMS` and typed in `engine-core.d.ts` — and **read by
nothing**. The shipped `projectPoints()` blends two seasons with
`projection.primaryWeight` / `primaryWeightUp` / `primaryWeightDown` /
`trendThreshold`, applies `durability` and age curves, and never consults either
tuned parameter.

## Its design cannot inform ranking

```python
pace_17    = fp * (17 / gp)
correction = prior_weight * (1 - reg_strength) * pace_17
projection = pace_17 + correction
```

The projection is `pace_17 × (1 + w(1−r))` — a positive scalar multiple of the
baseline. Scaling every player by the same constant cannot reorder them, so
**rank correlation is identical for every combination in the grid**, confirmed
in the output: exactly one Spearman value per position across all 25 combos.
A draft board is a ranking, so the grid search cannot say anything useful about
the thing that matters. (The source comment concedes as much: "simplified; real
impl blends against prior projection".)

## Results (2015–2025, 10 test years)

| pos | Spearman (all combos) | best MAE at | best R² |
|-----|----------------------|-------------|---------|
| QB  | 0.508 | priorWeight 0.0, reg 0.0 | −7.59 |
| RB  | 0.493 | priorWeight 0.0, reg 0.0 | −2.77 |
| WR  | 0.567 | priorWeight 0.0, reg 0.0 | −2.22 |
| TE  | 0.558 | priorWeight 0.0, reg 0.0 | −0.76 |

Two things to take from this:

- **Best is always 0.0 / 0.0** — the grid's verdict on its own correction term is
  "don't apply it". The shipped 0.35 / 0.25 are worse by this measure, which is
  moot only because nothing reads them.
- **R² is negative everywhere**, i.e. worse than predicting the mean. That is the
  scalar inflation inflating error, not evidence about the real model.

## The number worth keeping

Spearman **0.49–0.57** is what a naive "last season's pace" ranking achieves.
That is the baseline any real projection model has to beat. Nothing in the app
has been measured against it.

## To make this test the real thing

Port `projectPoints()` (the two-season weighted blend with trend detection,
durability and age curves) into the harness and grid over the parameters it
actually uses, scoring on **rank correlation** rather than MAE/RMSE. Only then
does "validated against 10 years" mean what it says.

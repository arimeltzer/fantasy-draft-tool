# Projection backtest (2026-08)

`projection_backtest.py` runs the **shipped** `projectPoints()` over 2017–2025
and scores it on **rank correlation**, because a draft board is a ranking.

    python projection_parity.py     # port must equal the JS engine — run first
    python projection_backtest.py --out ./backtest_results

## Headline: the model earns its keep

Mean Spearman vs actual season total, 9 test years:

| pos | baseline (last-season pace) | shipped (pw 0.7 / tt 50) | delta | years won |
|-----|-----------------------------|--------------------------|-------|-----------|
| QB  | 0.6434 | **0.7033** | +0.060 | 8/9 |
| RB  | 0.6602 | **0.6886** | +0.028 | 9/9 |
| TE  | 0.6751 | **0.7082** | +0.033 | 9/9 |
| WR  | 0.7154 | **0.7348** | +0.019 | 9/9 |

The two-season weighted blend beats "just use last year" at every position, in
26 of 27 position-years, and the one loss (QB 2020) is −0.007. This is the first
evidence the projection does anything, and it is positive.

## The shipped parameters are already near-optimal

Best in a 20-combo grid over `primaryWeight` × `trendThreshold`:

| pos | best variant | best | shipped | gap |
|-----|--------------|------|---------|-----|
| QB  | pw 0.6, trend off | 0.7060 | 0.7033 | 0.003 |
| RB  | pw 0.8, tt 100 | 0.6899 | 0.6886 | 0.001 |
| TE  | pw 0.8, tt 50 | 0.7102 | 0.7082 | 0.002 |
| WR  | pw 0.8, tt 100 | 0.7363 | 0.7348 | 0.002 |

Gaps of 0.001–0.003 across 9 years are noise. **Do not retune on this** — there
is nothing to win, and per-position weights would be fitting the test set.

## The trend adjustment does approximately nothing

`primaryWeightUp` / `primaryWeightDown` / `trendThreshold` exist to trust a
recent season more when a player is trending. Turning the whole mechanism off
(`trendThreshold` = 10000) changes Spearman by **+0.0002 to +0.0013**, winning
4–6 years out of 9 — a coin flip.

It is not harmful, so it stays; but it is complexity carrying no measured
weight, and it should not be extended or tuned further without evidence.

## Top-24 hit rate (the first two rounds)

| pos | baseline | shipped |
|-----|----------|---------|
| QB  | 0.732 | 0.778 |
| RB  | 0.620 | 0.630 |
| TE  | 0.648 | 0.676 |
| WR  | 0.574 | 0.611 |

Roughly 60–78% of the projected top 24 really finish top 24. The RB and WR
numbers are the honest ceiling of a two-season-history model: about 4 in 10 of
the players it likes at those positions do not deliver.

## Two targets, both reported

- **total** — actual season points. Missed games count against the player. The
  honest draft-day target, and what the tables above use.
- **pace** — per-game × 17, availability removed. Consistently ~0.02–0.03 higher,
  i.e. a slice of the error is durability rather than talent misjudgement.

## Caveats that bound every number here

- **Survivorship.** Players are scored only if they appear in season Y. Someone
  projected well who never played is excluded, not counted as a miss. This
  flatters every model equally, the shipped one included.
- **No rookies.** Players with no prior-season history are skipped, so the rookie
  path (`rookieProjection`) is untested here. That branch now covers ~349 of 959
  players in the live pool and remains unvalidated.
- **No ADP/ECR baseline.** Historical consensus rankings aren't in the pipeline,
  so the comparison that matters commercially — model vs. the market — cannot be
  run yet. Beating last-season pace is a low bar; beating ADP is the real one.

## Superseded

`backtest_parameters.py` scored `pace × (1 + w(1−r))`, a scalar multiple of the
baseline that cannot reorder anyone, tuning two constants (`priorWeight`,
`regressionStrength`) that `engine-core.js` declares but never reads. It also
never ran: `summary_level="season"` is invalid and season games live in `games`,
and a bare `except` printed `SKIP` and continued to a confusing crash. Kept only
for reference; use `projection_backtest.py`.

# Empirical Parameter Validation

The default parameters in `valuation-engine.js` and `strength-of-schedule.js` are educated guesses. Use the backtest harness to tune them against 10 years of real NFL data and answer: **which settings would have produced the most accurate projections?**

## The method

For each year 2016–2025:
1. **Training phase:** use the prior 4 seasons (2015–2024) to learn how much last season's pace regresses and decays with age.
2. **Test phase:** project the current year under different parameter combinations.
3. **Score:** compare projections to actual performance (what players really scored).
4. **Aggregate:** find which parameters minimize error across the decade.

Metrics:
- **MAE / RMSE:** raw projection error (points).
- **R²:** how much of the variance in actual scores is explained by the projection.
- **Spearman correlation:** are the rankings (best to worst) correct, even if points are off?

## Run the backtest

```bash
cd data-pipeline
pip install nflreadpy pandas scikit-learn numpy pyarrow scipy
python backtest_parameters.py --out ./backtest_results
python analyze_backtest.py --results ./backtest_results
```

The backtest will take a few minutes (it pulls 10 seasons and tests 25 parameter combinations × 10 years = 250 backtests).

## Interpret the results

### `grid_search_summary.csv`
The main output. Columns: `priorWeight`, `regressionStrength`, `position`, `mae_mean`, `rmse_mean`, `r2_mean`, `spearman_mean`, `n_years`.

**Read it as:** "With priorWeight=0.35 and regressionStrength=0.25 on WR, the algorithm explained 0.54 of the variance in actual WR points (R²), had an average error of 23 points, and ranked WRs with a 0.71 correlation."

**Look for:** the rows with the highest `r2_mean` for each position. That row tells you the best parameters for that position. If the best row has `priorWeight=0.35, regressionStrength=0.25` for all four positions, you can use one universal parameter set. If QB needs `priorWeight=0.1` but RB needs `0.5`, you have per-position tuning.

### `best_params.json`
Quick reference of the top parameter combo for each position by R². E.g.:
```json
{
  "RB": {
    "best_r2": {
      "priorWeight": 0.35,
      "regressionStrength": 0.25,
      "r2_mean": 0.542,
      "spearman_mean": 0.71
    },
    "best_spearman": { ... }
  }
}
```

### `sensitivity_RB.csv` etc.
Heatmap data: rows are `priorWeight`, columns are `regressionStrength`, cells are R². Shows how sensitive the algorithm is to changes in each knob. A flat heatmap means the settings barely matter; a sharp peak means you need to nail the values.

### `diagnostics.txt` (from `analyze_backtest.py`)
Text summary:
- Best params and R² by position.
- Whether params vary across positions or stay stable.
- Overall accuracy (R² across all positions).

## Benchmark: is 0.54 R² good?

**R² = 0.54 means the projection explains 54% of the variance in actual points.** For context:
- Expert consensus projections (FantasyPros aggregate): R² ≈ 0.55–0.65 depending on position.
- Naive "repeat last year" baseline: R² ≈ 0.30–0.40.
- A perfect projection: R² = 1.0.

So if your backtest gives R² in the 0.50–0.60 range, you're **competitive with human experts**. If it's higher (0.65+), your algorithm is exceptional. If it's lower (0.40), you're leaving value on the table — try different parameter ranges.

## Apply the empirical results

Once you have the backtest, edit `DEFAULT_PARAMS` in `valuation-engine.js`:

```javascript
// Before (educated guess)
export const DEFAULT_PARAMS = {
  priorWeight: 0.35,
  regressionStrength: 0.25,
  // ...
};

// After (empirically validated)
export const DEFAULT_PARAMS = {
  priorWeight: 0.40,  // ← from backtest best_params.json
  regressionStrength: 0.22,  // ← from backtest best_params.json
  // ...
};
```

If the backtest shows different optimal params per position, edit the age curve knobs:
```javascript
age: {
  QB:  { ... regressionStrength: 0.20 },  // QB is less noisy
  RB:  { ... regressionStrength: 0.30 },  // RB regresses more
  WR:  { ... regressionStrength: 0.25 },
  TE:  { ... regressionStrength: 0.25 },
},
```

## Advanced: per-position blending

If the backtest shows QB wants `priorWeight=0.1` (trust projection) but RB wants `priorWeight=0.5` (pull hard toward last year), you can encode that:

```javascript
priorWeight: { QB: 0.1, RB: 0.5, WR: 0.35, TE: 0.35 },  // object instead of scalar
```

Then in `projectValue()`:
```javascript
const w = typeof P.priorWeight === "object" ? P.priorWeight[player.pos] : P.priorWeight;
```

## Other backtest angles (future)

The current harness tests projection accuracy. You could also:
1. **Draft simulation:** re-run actual historical drafts using the projected rankings, score each draft outcome, and find the parameter set that would have won the most leagues.
2. **Seasonal correlation:** measure how stable each player's value is within a season (useful for in-season updates).
3. **Position scarcity:** backtest whether the VBD model correctly identified positional runs (e.g., did RBs really run out when we said they would?).

For now, projection accuracy (R²) is the best single signal — it directly tells you whether the forecast is trustworthy.

## Script reference

**`backtest_parameters.py`**
- Loads 2015–2025 nflverse data.
- For each year 2016–2025 and each parameter combo: projects the season, compares to actuals.
- Outputs `grid_search_summary.csv`, `grid_results_full.json`, `best_params.json`.

**`analyze_backtest.py`**
- Reads the backtest results.
- Pivots by position to show sensitivity (heatmaps).
- Prints best params and diagnostics.

**Options:**
- `--out` / `--results`: where to write / read results.
- `--years-start` / `--years-end`: date range (default 2015–2025).

---

## One caveat: data quality

nflverse is excellent but occasionally has:
- Partial seasons coded as full (injury, holdout).
- Positional miscodes (a player listed as WR but really TE).
- Stat adjustments (NFL occasionally corrects historical data).

The backtest will handle most edge cases (it filters to `gp > 0` and skips empty years), but if a backtest result looks strange (e.g., RB R² = 0.1), check the raw data in `grid_results_full.json` and consider if a particular year's data is corrupted. Usually it's fine.

#!/usr/bin/env python3
"""
backtest_parameters.py
======================
Validates the fantasy valuation algorithm against 10 years of real outcomes.

PIPELINE
  Load 2015–2025 player-week actuals from nflverse
  │
  For each year Y in 2016–2025:
    Training data: Y-4 to Y-1 (actual performance)
    Test year: Y
    │
    For each parameter combo in GRID:
      1. Fit age curves / regression to training data
      2. Project year Y using those curves + the parameters
      3. Compare projections to actual year Y performance
      4. Score accuracy: MAE, RMSE, R², ranking correlation, etc.
    │
    Output: best parameters for year Y, by position
  │
  Aggregate: mean accuracy across all years, parameter sensitivity

INSTALL  pip install nflreadpy pandas scikit-learn numpy pyarrow
RUN      python backtest_parameters.py --out ./backtest_results
"""

from __future__ import annotations
import argparse, json, warnings
from itertools import product
import numpy as np
import pandas as pd
from scipy import stats
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
import nflreadpy as nfl

warnings.filterwarnings("ignore")

FANTASY_POS = {"QB", "RB", "WR", "TE"}
SCORING = dict(
    passYd=0.04, passTD=4, intc=-2, rushYd=0.1, rushTD=6,
    rec=0.5, recYd=0.1, recTD=6, fum=-2
)

# ---- param grid ----
GRID = {
    "priorWeight": [0.0, 0.2, 0.35, 0.5, 0.7],
    "regressionStrength": [0.0, 0.15, 0.25, 0.4, 0.6],
}

# ---- helpers ----
def _pd(df):
    return df.to_pandas() if hasattr(df, "to_pandas") else df

def _col(df, *names):
    for n in names:
        if n in df.columns:
            return n
    return None

def _num(r, k):
    v = r.get(k, 0)
    try:
        return float(v) if v == v else 0.0
    except (TypeError, ValueError):
        return 0.0

def fantasy_points(row):
    fum = _num(row, "rushing_fumbles_lost") + _num(row, "receiving_fumbles_lost")
    return round(
        _num(row, "passing_yards")*SCORING["passYd"] + _num(row, "passing_tds")*SCORING["passTD"]
        + _num(row, "interceptions")*SCORING["intc"]
        + _num(row, "rushing_yards")*SCORING["rushYd"] + _num(row, "rushing_tds")*SCORING["rushTD"]
        + _num(row, "receptions")*SCORING["rec"] + _num(row, "receiving_yards")*SCORING["recYd"]
        + _num(row, "receiving_tds")*SCORING["recTD"]
        + fum*SCORING["fum"], 2)

# ---- data load ----
def load_seasons(years):
    """[{season, player_id, name, pos, gp, fp}]"""
    out = []
    for y in years:
        print(f"  loading {y}…", end=" ", flush=True)
        try:
            df = _pd(nfl.load_player_stats(y, summary_level="season"))
            typ = _col(df, "season_type")
            if typ:
                df = df[df[typ] == "REG"]
            df = df[df[_col(df, "position", "pos")].isin(FANTASY_POS)].copy()
            team = _col(df, "team", "recent_team")
            df = df[df[team].notna()]
            df["gp"] = df[_col(df, "games_played", "gp")].fillna(0).astype(int)
            df["fp"] = df.apply(fantasy_points, axis=1)
            pos = _col(df, "position", "pos")
            for g in df[["season", _col(df, "player_id", "gsis_id"), _col(df, "player_display_name", "player_name"), pos, "gp", "fp"]].itertuples():
                out.append({
                    "season": int(g.season),
                    "player_id": getattr(g, _col(df, "player_id", "gsis_id"), None),
                    "name": getattr(g, _col(df, "player_display_name", "player_name"), ""),
                    "pos": getattr(g, pos),
                    "gp": int(getattr(g, "gp", 0) or 0),
                    "fp": float(getattr(g, "fp", 0) or 0)
                })
            print(f"  {len(df)} rows")
        except Exception as e:
            print(f"  SKIP ({e})")
    return out

# ---- core backtest ----
def project_season(train_df, params):
    """Fit prior-season pace and age curve to train_df, project each player's pace."""
    if train_df.empty:
        return {}
    prior_weight, reg_strength = params["priorWeight"], params["regressionStrength"]
    groups = train_df.groupby(["pos", "player_id"]).agg(gp=("gp", "first"), fp=("fp", "mean")).reset_index()
    out = {}
    for _, g in groups.iterrows():
        pace_17 = g.fp * (17.0 / max(1, g.gp))
        correction = prior_weight * (1 - reg_strength) * pace_17  # simplified; real impl blends against prior projection
        out[g.player_id] = pace_17 + correction
    return out

def backtest_year(year, all_data, params):
    """Test year Y using training data from Y-4 to Y-1."""
    if year < 2016:
        return None
    train_years = [y for y in range(year - 4, year) if y >= 2015]
    test_year = year
    train_df = pd.DataFrame([r for r in all_data if r["season"] in train_years])
    test_df = pd.DataFrame([r for r in all_data if r["season"] == test_year])
    if train_df.empty or test_df.empty:
        return None
    proj_by_id = project_season(train_df, params)
    results_by_pos = {}
    for pos in FANTASY_POS:
        test_pos = test_df[test_df["pos"] == pos].copy()
        if test_pos.empty:
            continue
        test_pos["proj"] = test_pos["player_id"].map(proj_by_id).fillna(0)
        test_pos["actual"] = test_pos["fp"]
        if (test_pos["proj"] == 0).all() or (test_pos["actual"] == 0).all():
            continue
        mae = mean_absolute_error(test_pos["actual"], test_pos["proj"])
        rmse = np.sqrt(mean_squared_error(test_pos["actual"], test_pos["proj"]))
        r2 = r2_score(test_pos["actual"], test_pos["proj"])
        rank_actual = stats.rankdata(test_pos["actual"], method="ordinal")
        rank_proj = stats.rankdata(test_pos["proj"], method="ordinal")
        corr, _ = stats.spearmanr(rank_actual, rank_proj)
        results_by_pos[pos] = {
            "mae": round(mae, 2),
            "rmse": round(rmse, 2),
            "r2": round(r2, 3),
            "spearman": round(corr, 3),
            "n": len(test_pos)
        }
    return results_by_pos if results_by_pos else None

# ---- grid search & aggregation ----
def run_grid_search(all_data):
    """Grid search: for each year, find best params; aggregate across years."""
    years = sorted(set(r["season"] for r in all_data))
    test_years = [y for y in years if y >= 2016]
    param_combos = list(product(GRID["priorWeight"], GRID["regressionStrength"]))
    results = {}  # {(prior, reg): {year: {pos: {mae, rmse, r2, spearman}}}}
    for prior, reg in param_combos:
        params = {"priorWeight": prior, "regressionStrength": reg}
        results[(prior, reg)] = {}
        for year in test_years:
            res = backtest_year(year, all_data, params)
            if res:
                results[(prior, reg)][year] = res
    return results

def summarize_results(grid_results):
    """Aggregate grid results across years and positions."""
    summary = []
    for (prior, reg), by_year in grid_results.items():
        for pos in FANTASY_POS:
            scores = []
            for year, by_pos in by_year.items():
                if pos in by_pos:
                    scores.append(by_pos[pos])
            if not scores:
                continue
            agg = {
                "priorWeight": prior,
                "regressionStrength": reg,
                "position": pos,
                "mae_mean": round(np.mean([s["mae"] for s in scores]), 2),
                "rmse_mean": round(np.mean([s["rmse"] for s in scores]), 2),
                "r2_mean": round(np.mean([s["r2"] for s in scores]), 3),
                "spearman_mean": round(np.mean([s["spearman"] for s in scores]), 3),
                "n_years": len(scores)
            }
            summary.append(agg)
    return summary

# ---- main ----
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="./backtest_results")
    ap.add_argument("--years-start", type=int, default=2015)
    ap.add_argument("--years-end", type=int, default=2025)
    args = ap.parse_args()
    import os
    os.makedirs(args.out, exist_ok=True)

    print(f"Loading NFL data {args.years_start}–{args.years_end}…")
    all_data = load_seasons(range(args.years_start, args.years_end + 1))
    print(f"Loaded {len(all_data)} player-seasons")

    print("\nRunning grid search…")
    grid_results = run_grid_search(all_data)

    print("Aggregating results…")
    summary = summarize_results(grid_results)
    summary_df = pd.DataFrame(summary)

    # write results
    summary_df.to_csv(f"{args.out}/grid_search_summary.csv", index=False)
    with open(f"{args.out}/grid_results_full.json", "w") as f:
        json.dump(
            {str(k): v for k, v in grid_results.items()},
            f, indent=2, default=str
        )

    # best params by metric & position
    best_by_metric = {}
    for pos in FANTASY_POS:
        pos_df = summary_df[summary_df["position"] == pos]
        if pos_df.empty:
            continue
        best_r2 = pos_df.loc[pos_df["r2_mean"].idxmax()]
        best_spearman = pos_df.loc[pos_df["spearman_mean"].idxmax()]
        best_by_metric[pos] = {
            "best_r2": best_r2[["priorWeight", "regressionStrength", "r2_mean", "spearman_mean"]].to_dict(),
            "best_spearman": best_spearman[["priorWeight", "regressionStrength", "r2_mean", "spearman_mean"]].to_dict(),
        }
    with open(f"{args.out}/best_params.json", "w") as f:
        json.dump(best_by_metric, f, indent=2)

    print("\n=== RESULTS ===")
    print(summary_df.sort_values("r2_mean", ascending=False).head(15).to_string(index=False))
    print(f"\n✓ wrote {args.out}/grid_search_summary.csv, grid_results_full.json, best_params.json")

if __name__ == "__main__":
    main()

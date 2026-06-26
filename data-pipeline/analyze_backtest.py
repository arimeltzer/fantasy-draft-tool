#!/usr/bin/env python3
"""
analyze_backtest.py
===================
Post-backtest analysis: sensitivity charts, diagnostics, parameter recommendations.

RUN      python analyze_backtest.py --results ./backtest_results
OUTPUT
  sensitivity_by_position.csv    heatmap data: priorWeight × regressionStrength
  diagnostics.txt                text summary + recommended parameters
  (+ matplotlib plots if matplotlib is available)
"""

import argparse, json
import pandas as pd
import numpy as np

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default="./backtest_results")
    args = ap.parse_args()

    df = pd.read_csv(f"{args.results}/grid_search_summary.csv")
    with open(f"{args.results}/best_params.json") as f:
        best = json.load(f)

    # sensitivity: for each pos, a pivot table prior × reg → r2
    print("=== SENSITIVITY ANALYSIS ===\n")
    for pos in ["QB", "RB", "WR", "TE"]:
        pos_df = df[df["position"] == pos]
        if pos_df.empty:
            print(f"{pos}: no data\n")
            continue
        pivot = pos_df.pivot_table(
            index="priorWeight",
            columns="regressionStrength",
            values="r2_mean",
            aggfunc="first"
        )
        print(f"{pos} — R² by (priorWeight, regressionStrength):")
        print(pivot.round(3).to_string())
        print()
        pivot.to_csv(f"{args.results}/sensitivity_{pos}.csv")

    # diagnostics: best params, how much they vary by position
    print("\n=== RECOMMENDED PARAMETERS ===\n")
    for pos, metrics in sorted(best.items()):
        br2 = metrics["best_r2"]
        print(f"{pos}:")
        print(f"  (R² is {br2['r2_mean']:.3f})")
        print(f"  priorWeight: {br2['priorWeight']:.2f}  regressionStrength: {br2['regressionStrength']:.2f}")
        print()

    # variance across positions: are the optimal params universal?
    print("=== PARAMETER VARIANCE ===\n")
    prior_vals = [best[pos]["best_r2"]["priorWeight"] for pos in best]
    reg_vals = [best[pos]["best_r2"]["regressionStrength"] for pos in best]
    print(f"priorWeight range: {min(prior_vals):.2f} – {max(prior_vals):.2f}")
    print(f"regressionStrength range: {min(reg_vals):.2f} – {max(reg_vals):.2f}")
    print(f"Variance: {np.std(prior_vals):.3f} / {np.std(reg_vals):.3f}")
    if np.std(prior_vals) < 0.1 and np.std(reg_vals) < 0.1:
        print("  → params are stable across positions; use same settings for all.")
    else:
        print("  → params vary; consider per-position tuning.")
    print()

    # overall accuracy: what R² are we getting?
    print("=== OVERALL ACCURACY ===")
    overall_r2 = df.groupby("position")["r2_mean"].mean()
    for pos, r2 in overall_r2.items():
        print(f"{pos}: R² = {r2:.3f}")
    print(f"\nMean R² (all pos): {overall_r2.mean():.3f}")
    print("  (0.50–0.60 is solid; >0.70 means very strong predictiveness)")

if __name__ == "__main__":
    main()

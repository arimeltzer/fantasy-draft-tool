#!/usr/bin/env python3
"""
sos_backtest.py
===============
Empirically tune the Strength-of-Schedule parameters in
`frontend/src/engine/strength-of-schedule.js` against real NFL outcomes.

Unlike the projection backtest (which needs archived projections we don't
have for past years), the SOS engine can be validated from game logs alone:
its whole claim is "last year's opponent-adjusted defensive softness predicts
this year's, and folding it into player value improves accuracy." That is a
pure out-of-sample test.

METHOD (all out-of-sample, leak-free)
  Build half-PPR position-vs-defense game logs for 2015-2024.
  For each consecutive pair (Y-1 -> Y):
    predictor = adjustedDefenseRatings(Y-1)        # what the engine knows
    truth     = adjustedDefenseRatings(Y)          # what actually happened
  Pool every (team, position, year) observation, then estimate:

  1. yoyRetention  — the optimal shrinkage of last year's rating toward the
     mean. It is exactly the through-origin regression slope of truth_Y on
     rating_{Y-1}: beta* = sum(x*y)/sum(x*x). Per position + overall.
     (A scalar can't change rank/Pearson skill, so retention is a calibration
     of MAGNITUDE; the slope is the MSE-optimal magnitude.)

  2. Predictive skill — Pearson r, Spearman rho, R2 at beta*. Tells us how much
     signal SOS has at all (and whether the +/-6% philosophy is right).

  3. Prior-year blend (priorWeight) — does adding rating_{Y-2} help? Two-feature
     OLS truth ~ b1*r1 + b2*r2; report R2 gain and the implied blend weight.

  4. sosWeight — game-level fractional calibration: how big a production swing a
     unit of predicted softness actually produces. slope of
     (groupPts/leagueAvg - 1) on (predictedSoftness/leagueAvg). That slope IS
     the value sosWeight should take.

  5. cap — from the realized distribution of full-season schedule multipliers at
     the tuned params: set the cap so it trims only the tails, not the body.

  6. playoffWeight — check that Y-1 ratings predict Y *playoff-week* (15-17)
     softness at least as well as the full season, which is the premise for
     weighting those weeks.

RUN
  pip install nflreadpy pandas pyarrow scipy numpy
  python sos_backtest.py --start 2015 --end 2024 --out ./data/sos_backtest
"""
from __future__ import annotations
import argparse, json, os, warnings
import numpy as np
import pandas as pd
from scipy import stats

from sos_engine import adjusted_defense_ratings, regress_yoy, validate_port

warnings.filterwarnings("ignore")
FANTASY_POS = ["QB", "RB", "WR", "TE"]
PLAYOFF_WEEKS = [15, 16, 17]


def _pd(df):
    return df.to_pandas() if hasattr(df, "to_pandas") else df


def load_weekly(years, cache_dir):
    """Half-PPR position-vs-defense game logs per season.

    Returns {season: [ {week, off, def, pos, fp}, ... ]} where fp is the points
    the OFF's position group scored vs DEF that week (= points DEF allowed).
    """
    os.makedirs(cache_dir, exist_ok=True)
    cache = os.path.join(cache_dir, f"weekly_{min(years)}_{max(years)}.parquet")
    if os.path.exists(cache):
        wk = pd.read_parquet(cache)
        print(f"  loaded weekly cache: {cache} ({len(wk)} rows)")
    else:
        import nflreadpy as nfl
        frames = []
        for y in years:
            print(f"  fetching weekly {y}…", flush=True)
            df = _pd(nfl.load_player_stats([y], summary_level="week"))
            df = df[df["season_type"] == "REG"]
            df = df[df["position"].isin(FANTASY_POS)]
            df = df[df["opponent_team"].notna() & df["team"].notna()]
            # half-PPR = standard + 0.5*rec = mean(standard, full-ppr)
            df["fp_half"] = (df["fantasy_points"].fillna(0) + df["fantasy_points_ppr"].fillna(0)) / 2.0
            frames.append(df[["season", "week", "team", "opponent_team", "position", "fp_half"]])
        wk = pd.concat(frames, ignore_index=True)
        wk.to_parquet(cache)
        print(f"  cached weekly -> {cache} ({len(wk)} rows)")

    # aggregate to position-group points per (season, week, off, def, pos)
    grp = (wk.groupby(["season", "week", "team", "opponent_team", "position"], as_index=False)["fp_half"]
             .sum())
    logs_by_season = {}
    for season, g in grp.groupby("season"):
        logs_by_season[int(season)] = [
            {"week": int(r.week), "off": r.team, "def": r.opponent_team, "pos": r.position, "fp": float(r.fp_half)}
            for r in g.itertuples()
        ]
    return logs_by_season, grp


def through_origin_slope(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    sxx = float(np.sum(x * x))
    return float(np.sum(x * y) / sxx) if sxx > 0 else 0.0


def r2_through_origin(x, y, beta):
    x, y = np.asarray(x, float), np.asarray(y, float)
    ss_tot = float(np.sum(y * y))
    ss_res = float(np.sum((y - beta * x) ** 2))
    return 1 - ss_res / ss_tot if ss_tot > 0 else 0.0


def paired_ratings(logs_by_season, years):
    """For each (team,pos,year) build predictor (Y-1) and truth (Y) softness."""
    ratings = {y: adjusted_defense_ratings(logs_by_season[y]) for y in years if y in logs_by_season}
    rows = []  # {year, pos, team, pred (Y-1 raw), truth (Y), pred2 (Y-2 raw)}
    for y in years:
        if y not in ratings or (y - 1) not in ratings:
            continue
        truth, pred = ratings[y], ratings[y - 1]
        pred2 = ratings.get(y - 2)
        for pos in FANTASY_POS:
            tdef = truth["def"].get(pos, {})
            pdef = pred["def"].get(pos, {})
            p2def = pred2["def"].get(pos, {}) if pred2 else {}
            for team, tv in tdef.items():
                if team in pdef:
                    rows.append({
                        "year": y, "pos": pos, "team": team,
                        "pred": pdef[team], "truth": tv,
                        "pred2": p2def.get(team, np.nan),
                    })
    return ratings, pd.DataFrame(rows)


def tune_retention(df):
    """yoyRetention = MSE-optimal shrink (through-origin slope), per pos + all."""
    out = {}
    for pos in FANTASY_POS + ["ALL"]:
        d = df if pos == "ALL" else df[df["pos"] == pos]
        d = d.dropna(subset=["pred", "truth"])
        if len(d) < 10:
            continue
        x, y = d["pred"].values, d["truth"].values
        beta = through_origin_slope(x, y)
        pear = float(np.corrcoef(x, y)[0, 1])
        spear = float(stats.spearmanr(x, y).correlation)
        out[pos] = {
            "yoyRetention": round(beta, 3),
            "pearson_r": round(pear, 3),
            "spearman_rho": round(spear, 3),
            "r2_at_beta": round(r2_through_origin(x, y, beta), 3),
            "n": int(len(d)),
        }
    return out


def tune_prior_blend(df):
    """Does Y-2 add signal beyond Y-1? Two-feature OLS, report R2 gain + weight."""
    d = df.dropna(subset=["pred", "pred2", "truth"])
    if len(d) < 30:
        return {"note": "insufficient Y-2 overlap"}
    x1, x2, y = d["pred"].values, d["pred2"].values, d["truth"].values
    # single feature (Y-1 only), through origin
    b1 = through_origin_slope(x1, y)
    r2_single = r2_through_origin(x1, y, b1)
    # two features, through origin (least squares, no intercept)
    X = np.column_stack([x1, x2])
    coef, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
    pred = X @ coef
    ss_tot = float(np.sum(y * y))
    r2_two = 1 - float(np.sum((y - pred) ** 2)) / ss_tot if ss_tot > 0 else 0.0
    b1c, b2c = float(coef[0]), float(coef[1])
    blend = b2c / (b1c + b2c) if (b1c + b2c) != 0 else 0.0
    return {
        "r2_y1_only": round(r2_single, 3),
        "r2_with_y2": round(r2_two, 3),
        "r2_gain": round(r2_two - r2_single, 3),
        "implied_priorWeight": round(max(0.0, min(0.6, blend)), 3),
        "coef_y1": round(b1c, 3), "coef_y2": round(b2c, 3),
        "n": int(len(d)),
    }


def tune_sosweight(ratings, grp, years, retention):
    """Game-level fractional calibration of sosWeight (out of sample).

    For each year-Y game: x = predictedSoftness_{Y-1}/leagueAvg, y = realized
    groupPts/leagueAvg - 1. Through-origin slope = sosWeight.
    """
    rows_x, rows_y = [], []
    by = {(int(r.season), int(r.week), r.team, r.opponent_team, r.position): float(r.fp_half)
          for r in grp.itertuples()}
    # group points the DEF (opponent_team) allowed = OFF group pts; we want, per
    # (year, def, pos, week) the points that defense allowed -> that's the OFF's pts.
    for y in years:
        if y not in ratings or (y - 1) not in ratings:
            continue
        est = regress_yoy(ratings[y - 1], yoy_retention=retention)
        for pos in FANTASY_POS:
            lg = ratings[y - 1]["leagueAvg"].get(pos, 0) or ratings[y]["leagueAvg"].get(pos, 1)
            if not lg:
                continue
            est_pos = est["def"].get(pos, {})
            # iterate over realized games in year Y: off scored fp vs def
            gy = grp[(grp["season"] == y) & (grp["position"] == pos)]
            for r in gy.itertuples():
                opp = r.opponent_team  # the defense faced
                if opp not in est_pos:
                    continue
                x = est_pos[opp] / lg
                yv = float(r.fp_half) / lg - 1.0
                rows_x.append(x); rows_y.append(yv)
    if len(rows_x) < 50:
        return {"note": "insufficient data"}
    x, yv = np.array(rows_x), np.array(rows_y)
    beta = through_origin_slope(x, yv)
    return {
        "sosWeight": round(beta, 3),
        "pearson_r": round(float(np.corrcoef(x, yv)[0, 1]), 3),
        "n_games": int(len(x)),
    }


def recommend_cap(ratings, grp, years, retention, sosweight, playoff_weight=1.5):
    """Distribution of full-season schedule multipliers at tuned params."""
    # reconstruct each team's yearly schedule from the game logs
    deviations = []
    for y in years:
        if (y - 1) not in ratings or y not in ratings:
            continue
        est = regress_yoy(ratings[y - 1], yoy_retention=retention)
        gy = grp[grp["season"] == y]
        # schedule: team -> list of (week, opp)
        sched = {}
        for r in gy[["team", "week", "opponent_team"]].drop_duplicates().itertuples():
            sched.setdefault(r.team, []).append((int(r.week), r.opponent_team))
        for pos in FANTASY_POS:
            lg = ratings[y - 1]["leagueAvg"].get(pos, 0)
            if not lg:
                continue
            est_pos = est["def"].get(pos, {})
            for team, games in sched.items():
                acc = w = 0.0
                for wk, opp in games:
                    wt = playoff_weight if wk in PLAYOFF_WEEKS else 1.0
                    acc += wt * est_pos.get(opp, 0.0)
                    w += wt
                if w == 0:
                    continue
                rel = (acc / w) / lg
                m = 1 + rel * sosweight
                deviations.append(abs(m - 1))
    if not deviations:
        return {"note": "no data"}
    arr = np.array(deviations)
    return {
        "p50_abs_dev": round(float(np.percentile(arr, 50)), 4),
        "p90_abs_dev": round(float(np.percentile(arr, 90)), 4),
        "p95_abs_dev": round(float(np.percentile(arr, 95)), 4),
        "p99_abs_dev": round(float(np.percentile(arr, 99)), 4),
        "max_abs_dev": round(float(arr.max()), 4),
        "recommended_cap": round(float(np.percentile(arr, 95)), 3),
        "n": int(len(arr)),
    }


def playoff_skill(ratings, logs_by_season, years, retention):
    """Does Y-1 rating predict Y *playoff-week* softness as well as full season?"""
    full_x, full_y, po_x, po_y = [], [], [], []
    for y in years:
        if (y - 1) not in ratings or y not in logs_by_season:
            continue
        est = regress_yoy(ratings[y - 1], yoy_retention=retention)
        po_logs = [l for l in logs_by_season[y] if l["week"] in PLAYOFF_WEEKS]
        if not po_logs:
            continue
        truth_po = adjusted_defense_ratings(po_logs)
        truth_full = ratings[y]
        for pos in FANTASY_POS:
            ep = est["def"].get(pos, {})
            for team, tv in truth_full["def"].get(pos, {}).items():
                if team in ep:
                    full_x.append(ep[team]); full_y.append(tv)
            for team, tv in truth_po["def"].get(pos, {}).items():
                if team in ep:
                    po_x.append(ep[team]); po_y.append(tv)

    def corr(a, b):
        return round(float(np.corrcoef(a, b)[0, 1]), 3) if len(a) > 5 else None
    return {
        "full_season_pearson": corr(full_x, full_y),
        "playoff_weeks_pearson": corr(po_x, po_y),
        "n_full": len(full_x), "n_playoff": len(po_x),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=2015)
    ap.add_argument("--end", type=int, default=2024)
    ap.add_argument("--out", default="./data/sos_backtest")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    assert validate_port(), "Python SOS port does not match JS engine!"
    print("✓ Python SOS port matches shipping JS engine\n")

    years = list(range(args.start, args.end + 1))
    print(f"Loading weekly data {args.start}-{args.end}…")
    logs_by_season, grp = load_weekly(years, os.path.join(args.out, "..", "weekly_cache"))

    print("Computing opponent-adjusted ratings + pairing years…")
    ratings, df = paired_ratings(logs_by_season, years)
    print(f"  paired observations: {len(df)} (team×pos×year)\n")

    retention = tune_retention(df)
    overall_ret = retention.get("ALL", {}).get("yoyRetention", 0.35)
    blend = tune_prior_blend(df)
    sosw = tune_sosweight(ratings, grp, years, overall_ret)
    cap = recommend_cap(ratings, grp, years, overall_ret, sosw.get("sosWeight", 0.5))
    po = playoff_skill(ratings, logs_by_season, years, overall_ret)

    results = {
        "seasons": [args.start, args.end],
        "n_paired": int(len(df)),
        "yoyRetention_by_pos": retention,
        "prior_blend": blend,
        "sosWeight": sosw,
        "cap": cap,
        "playoff": po,
    }
    with open(os.path.join(args.out, "sos_results.json"), "w") as f:
        json.dump(results, f, indent=2)

    # ---- report ----
    print("=" * 64)
    print("SOS PARAMETER TUNING — empirical results")
    print("=" * 64)
    print(f"\n1) yoyRetention (MSE-optimal shrink) + predictive skill:")
    print(f"   {'pos':>4} {'retention':>10} {'pearson':>8} {'spearman':>9} {'R2':>7} {'n':>6}")
    for pos in FANTASY_POS + ["ALL"]:
        if pos in retention:
            r = retention[pos]
            print(f"   {pos:>4} {r['yoyRetention']:>10.3f} {r['pearson_r']:>8.3f} "
                  f"{r['spearman_rho']:>9.3f} {r['r2_at_beta']:>7.3f} {r['n']:>6}")
    print(f"\n2) Prior-year (Y-2) blend:")
    for k, v in blend.items():
        print(f"   {k}: {v}")
    print(f"\n3) sosWeight (game-level fractional calibration):")
    for k, v in sosw.items():
        print(f"   {k}: {v}")
    print(f"\n4) cap (abs season multiplier deviation distribution):")
    for k, v in cap.items():
        print(f"   {k}: {v}")
    print(f"\n5) playoff-week predictive skill vs full season:")
    for k, v in po.items():
        print(f"   {k}: {v}")
    print(f"\n✓ wrote {args.out}/sos_results.json")


if __name__ == "__main__":
    main()

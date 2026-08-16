#!/usr/bin/env python3
"""
projection_backtest.py — does the SHIPPED projection beat a naive baseline?
==========================================================================
Replaces `backtest_parameters.py`, which scored a degenerate formula the app
never runs (see docs/PROJECTION_BACKTEST.md).

WHAT IT MEASURES
  For each test season Y, build every player the way the app does at draft time
  — `last` = season Y-1, `last2` = season Y-2, age as of Y — run the real
  `projectPoints()` (via `projection_model.py`, parity-checked against the JS),
  then compare the projected ORDER to what actually happened in Y.

WHY RANK CORRELATION
  A draft board is a ranking. Being uniformly 15% low costs nothing if the order
  holds; MAE/RMSE punish that heavily and reward a well-calibrated model that
  orders players badly. Spearman is the metric that matches the use.
  Top-N hit rate is reported alongside because that is what the first few rounds
  actually turn on.

TWO TARGETS, deliberately both
  total — actual season points. What you really got, so missed games count
          against the player. This is the honest draft-day target.
  pace  — actual per-game x 17. Measures talent projection with availability
          removed. The gap between the two is the cost of injuries.

BASELINES
  pace1  — last season's per-game pace. The "just use last year" strawman.
  ecr_ish— not available historically, so omitted rather than faked.

CAVEAT, stated because it bounds every number below: players are scored only if
they appear in season Y. Someone who was projected well and then never played is
excluded rather than counted as a miss, so all correlations here flatter every
model equally, the shipped one included.

RUN
  pip install nflreadpy pandas scipy numpy pyarrow
  python projection_backtest.py --out ./backtest_results
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import date
from itertools import product

import nflreadpy as nfl
import pandas as pd
from scipy import stats

from projection_model import DEFAULT_PARAMS, default_scoring, project_points, with_overrides

try:
    from adp_probe import fetch_adp          # needs FANTASYPROS_API_KEY
    from fantasypros import norm as fp_norm
except Exception:                             # probe/key absent -> ADP skipped
    fetch_adp = None
    fp_norm = None

FANTASY_POS = {"QB", "RB", "WR", "TE"}
PPR = 0.5

# nflverse season-total column -> engine `last`/`last2` field.
COMP = {
    "passing_yards": "passYd", "passing_tds": "passTD", "interceptions": "int",
    "rushing_yards": "rushYd", "rushing_tds": "rushTD",
    "receptions": "rec", "receiving_yards": "recYd", "receiving_tds": "recTD",
}


def _pd(df):
    return df.to_pandas() if hasattr(df, "to_pandas") else df


def _col(df, *names):
    for n in names:
        if n in df.columns:
            return n
    return None


def load_seasons(years) -> pd.DataFrame:
    """One row per (season, player): the engine's season line + games played."""
    frames = []
    for y in years:
        print(f"  loading {y}…", end=" ", flush=True)
        df = _pd(nfl.load_player_stats(y, summary_level="reg"))
        pos_c = _col(df, "position", "pos")
        df = df[df[pos_c].isin(FANTASY_POS)].copy()
        gp_c = _col(df, "games", "games_played")
        id_c = _col(df, "player_id", "gsis_id")
        name_c = _col(df, "player_display_name", "player_name")

        keep = pd.DataFrame({
            "season": y,
            "player_id": df[id_c],
            "name": df[name_c],
            "pos": df[pos_c],
            "gp": df[gp_c].fillna(0).astype(int),
        })
        for src, dst in COMP.items():
            keep[dst] = df[src].fillna(0) if src in df.columns else 0
        fum = 0
        for c in ("rushing_fumbles_lost", "receiving_fumbles_lost", "sack_fumbles_lost"):
            if c in df.columns:
                fum = fum + df[c].fillna(0)
        keep["fumbles"] = fum
        frames.append(keep)
        print(f"{len(keep)} rows")
    return pd.concat(frames, ignore_index=True)


def load_ages(years) -> dict:
    """(season, player_id) -> age on Sept 1 of that season."""
    ages = {}
    for y in years:
        try:
            r = _pd(nfl.load_rosters(y))
        except Exception as e:
            print(f"  ! rosters {y} unavailable ({e}); ages blank for that year")
            continue
        id_c = _col(r, "gsis_id", "player_id")
        b_c = _col(r, "birth_date")
        if not id_c or not b_c:
            continue
        ref = date(y, 9, 1)
        for pid, bd in zip(r[id_c], pd.to_datetime(r[b_c], errors="coerce")):
            if pid and pd.notna(bd):
                ages[(y, pid)] = round(
                    (ref - bd.date()).days / 365.25, 1)
    return ages


def season_line(row) -> dict:
    return {"gp": int(row.gp), **{v: float(getattr(row, v)) for v in COMP.values()},
            "fumbles": float(row.fumbles)}


def build_players(data: pd.DataFrame, ages: dict, year: int) -> list[dict]:
    """Every player as the app would see them drafting for `year`."""
    prev = {r.player_id: r for r in data[data.season == year - 1].itertuples()}
    prev2 = {r.player_id: r for r in data[data.season == year - 2].itertuples()}
    actual = {r.player_id: r for r in data[data.season == year].itertuples()}

    out = []
    for pid, act in actual.items():
        p1, p2 = prev.get(pid), prev2.get(pid)
        if p1 is None and p2 is None:
            continue          # true rookie: no history AND no market rank here
        out.append({
            "player_id": pid,
            "name": act.name,
            "pos": act.pos,
            "team": "",
            "age": ages.get((year, pid)),
            "last": season_line(p1) if p1 is not None else None,
            "last2": season_line(p2) if p2 is not None else None,
            "_actual": act,
        })
    return out


def score(players: list[dict], projections: list[float], sc: dict) -> dict:
    """Rank correlation + top-N hit rate, against both targets."""
    rows = []
    for p, proj in zip(players, projections):
        act = p["_actual"]
        line = season_line(act)
        total = _points(line, sc)
        pace = (total / act.gp) * DEFAULT_PARAMS["projectedGames"] if act.gp > 0 else 0.0
        rows.append({"pos": p["pos"], "proj": proj, "total": total, "pace": pace})
    df = pd.DataFrame(rows)

    out = {}
    for pos, sub in df.groupby("pos"):
        if len(sub) < 10:
            continue
        res = {"n": len(sub)}
        for target in ("total", "pace"):
            rho = stats.spearmanr(sub["proj"], sub[target]).statistic
            res[f"spearman_{target}"] = round(float(rho), 4)
            for n in (12, 24, 36):
                if len(sub) >= n:
                    top_proj = set(sub.nlargest(n, "proj").index)
                    top_act = set(sub.nlargest(n, target).index)
                    res[f"hit{n}_{target}"] = round(len(top_proj & top_act) / n, 3)
        out[pos] = res
    return out


def _points(line, sc):
    from projection_model import points
    return points(line, sc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="./backtest_results")
    ap.add_argument("--first", type=int, default=2017, help="first TEST season")
    ap.add_argument("--last", type=int, default=2025, help="last TEST season")
    ap.add_argument("--no-adp", action="store_true",
                    help="skip the ADP baseline even when a FantasyPros key is present")
    args = ap.parse_args()

    test_years = list(range(args.first, args.last + 1))
    need = sorted({y for t in test_years for y in (t - 2, t - 1, t)})
    print(f"Loading NFL data {need[0]}–{need[-1]}…")
    data = load_seasons(need)
    print(f"Loaded {len(data)} player-seasons")
    if data.empty:
        raise SystemExit("No data loaded — fix the loader before reading anything below.")
    print("Loading ages from rosters…")
    ages = load_ages(test_years)
    print(f"  {len(ages)} player-ages")

    sc = default_scoring(PPR)

    # The parameters the SHIPPED model actually uses.
    GRID = {
        "primaryWeight": [0.5, 0.6, 0.7, 0.8, 1.0],
        "trendThreshold": [25, 50, 100, 10_000],   # 10k = trend logic disabled
    }
    combos = [dict(zip(GRID, v)) for v in product(*GRID.values())]

    use_adp = bool(fetch_adp) and not args.no_adp and os.getenv("FANTASYPROS_API_KEY")
    if not use_adp:
        print("\n! ADP baseline SKIPPED (no FANTASYPROS_API_KEY or --no-adp). "
              "The model-vs-market comparison is the point; run this where the key lives.")

    per_year = []
    for year in test_years:
        players = build_players(data, ages, year)
        if not players:
            continue

        # ── the matched population ────────────────────────────────────
        # Comparing the model to the market is only meaningful over players
        # BOTH can rank. ADP covers different (fewer) players than nflverse
        # history does, so scoring each on its own population would compare
        # two different exams and call it a result.
        adp_by_player = {}
        if use_adp:
            adp = fetch_adp(year, rank_type="ADP") or fetch_adp(year, rank_type="DRAFT")
            for p in players:
                v = adp.get((fp_norm(p["name"]), p["pos"]))
                if v:
                    adp_by_player[p["player_id"]] = v

        populations = [("all", players)]
        if adp_by_player:
            matched = [p for p in players if p["player_id"] in adp_by_player]
            populations.append(("matched_adp", matched))
            print(f"  {year}: {len(players)} players, {len(matched)} also have ADP")
        else:
            print(f"  {year}: {len(players)} players")

        for pop_name, pop in populations:
            if len(pop) < 40:
                continue

            base = []
            for p in pop:
                last = p["last"] or p["last2"]
                base.append((_points(last, sc) / last["gp"]) * 17 if last and last["gp"] else 0.0)
            for pos, m in score(pop, base, sc).items():
                per_year.append({"year": year, "population": pop_name,
                                 "model": "baseline_pace", "pos": pos, **m})

            if pop_name == "matched_adp":
                # ADP ascends (1 = best); negate so a good ranking scores positive.
                adp_scores = [-adp_by_player[p["player_id"]] for p in pop]
                for pos, m in score(pop, adp_scores, sc).items():
                    per_year.append({"year": year, "population": pop_name,
                                     "model": "adp_market", "pos": pos, **m})

            for combo in combos:
                P = with_overrides(**combo)
                projs = [project_points(p, sc, P)["proj"] for p in pop]
                label = f"pw{combo['primaryWeight']}_tt{combo['trendThreshold']}"
                for pos, m in score(pop, projs, sc).items():
                    per_year.append({"year": year, "population": pop_name,
                                     "model": "shipped", "variant": label,
                                     **combo, "pos": pos, **m})

    df = pd.DataFrame(per_year)
    os.makedirs(args.out, exist_ok=True)
    df.to_csv(f"{args.out}/projection_backtest_by_year.csv", index=False)

    agg = (df.groupby(["population", "model", "variant", "pos"], dropna=False)
             .agg(spearman_total=("spearman_total", "mean"),
                  spearman_pace=("spearman_pace", "mean"),
                  hit24_total=("hit24_total", "mean"),
                  n_years=("year", "nunique"))
             .reset_index()
             .sort_values(["pos", "spearman_total"], ascending=[True, False]))
    agg.to_csv(f"{args.out}/projection_backtest_summary.csv", index=False)

    for pop in [p for p in ("all", "matched_adp") if p in set(agg["population"])]:
        title = ("ALL players with prior-season history"
                 if pop == "all" else
                 "MATCHED population — only players the market also ranks")
        print(f"\n=== {title} ===")
        print("mean Spearman vs actual season TOTAL, over test years")
        pa = agg[agg["population"] == pop]
        for posn in sorted(pa["pos"].unique()):
            sub = pa[pa["pos"] == posn]
            basel = sub[sub["model"] == "baseline_pace"]
            ship = sub[(sub["model"] == "shipped") & (sub["variant"] == "pw0.7_tt50")]
            mkt = sub[sub["model"] == "adp_market"]
            print(f"\n  {posn}  (n_years={int(sub.n_years.max())})")
            if len(basel):
                print(f"    last-season pace : {basel.iloc[0].spearman_total:.4f}")
            if len(mkt):
                print(f"    ADP (the market) : {mkt.iloc[0].spearman_total:.4f}   "
                      f"top24 hit {mkt.iloc[0].hit24_total:.3f}")
            if len(ship):
                s0 = ship.iloc[0]
                edge = (s0.spearman_total - mkt.iloc[0].spearman_total) if len(mkt) else None
                print(f"    SHIPPED model    : {s0.spearman_total:.4f}   "
                      f"top24 hit {s0.hit24_total:.3f}"
                      + (f"   vs market {edge:+.4f}" if edge is not None else ""))

    print(f"\n✓ wrote {args.out}/projection_backtest_summary.csv and _by_year.csv")


if __name__ == "__main__":
    main()

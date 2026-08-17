#!/usr/bin/env python3
"""
projection_probe.py — are FantasyPros' historical PROJECTIONS real and preseason?
================================================================================
Roadmap step 0.1 wants to blend the expert projection into the model, because
`projectPoints` currently reads `player.proj` only for rookies while every
veteran is projected from their own box scores. Before any of that can be
BACKTESTED, one question has to be answered honestly:

    does `/nfl/{season}/projections` serve what the experts believed BEFORE
    that season, or something else?

`fetch_projections(season, ...)` accepts a past season, so the request is
possible. That is not evidence the data is right. This project already shipped
a function that "worked" and returned the wrong thing: `fetch_aav` requested
`type=auction`, got an ordinary ranking back, and parsed silently to zeros for
months. A 200 response is not a validation.

Three failure modes this distinguishes, none of which raise an error:

  1. NOTHING THERE — the season is ignored and few/no rows come back.
  2. CONTAMINATED — end-of-season or rest-of-season numbers served for a past
     year. These look spectacular and are worthless: the model would be
     "predicting" a season using knowledge of it.
  3. STALE/ECHOED — the same payload for every season, i.e. the current year's
     projections regardless of what was asked.

The test for (2) is the one from `adp_probe.py`: score the returned projection
against what actually happened that season.

  Spearman ~0.45-0.70  → consistent with genuine preseason opinion.
  Spearman > 0.85      → CONTAMINATED. Nothing that far ahead of the shipped
                         model (~0.50-0.59) or of ADP (~0.65) can be preseason.

The test for (3) is a cross-season fingerprint: if two different seasons return
identical player sets and identical values, only one season's data exists.

Run where FANTASYPROS_API_KEY lives (GitHub Actions):
    python projection_probe.py --seasons 2021 2022 2023 2024 2025
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os

import pandas as pd
from scipy import stats

from fantasypros import fetch_projections, norm
from projection_model import default_scoring, points

FANTASY_POS = {"QB", "RB", "WR", "TE"}
PPR = 0.5

COMP = {
    "passing_yards": "passYd", "passing_tds": "passTD", "interceptions": "int",
    "rushing_yards": "rushYd", "rushing_tds": "rushTD",
    "receptions": "rec", "receiving_yards": "recYd", "receiving_tds": "recTD",
}

# Anything at or above this cannot be a preseason opinion — see the header.
CONTAMINATION = 0.85


def actual_points(season: int, sc: dict) -> dict:
    """(normalized name, pos) -> what the player actually scored that season."""
    import nflreadpy as nfl
    df = nfl.load_player_stats(season, summary_level="reg")
    df = df.to_pandas() if hasattr(df, "to_pandas") else df
    pos_c = "position" if "position" in df.columns else "pos"
    name_c = "player_display_name" if "player_display_name" in df.columns else "player_name"
    df = df[df[pos_c].isin(FANTASY_POS)]

    out = {}
    for r in df.itertuples():
        line = {dst: float(getattr(r, src, 0) or 0) for src, dst in COMP.items()}
        fum = 0.0
        for c in ("rushing_fumbles_lost", "receiving_fumbles_lost", "sack_fumbles_lost"):
            fum += float(getattr(r, c, 0) or 0)
        line["fumbles"] = fum
        out[(norm(getattr(r, name_c)), getattr(r, pos_c))] = points(line, sc)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="+", type=int,
                    default=[2021, 2022, 2023, 2024, 2025])
    ap.add_argument("--out", default="./results")
    args = ap.parse_args()

    if not os.getenv("FANTASYPROS_API_KEY"):
        raise SystemExit("FANTASYPROS_API_KEY not set — run this where the key lives.")

    sc = default_scoring(PPR)
    rows = []
    fingerprints = {}

    for season in args.seasons:
        print(f"\n=== {season} ===")
        try:
            proj = fetch_projections(season, scoring="HALF")
        except Exception as e:  # noqa: BLE001 — a dead season is a result, not a crash
            print(f"  fetch failed: {type(e).__name__}: {e}")
            rows.append({"season": season, "verdict": "FETCH FAILED", "rows": 0})
            continue

        print(f"  rows returned: {len(proj)}")
        if not proj:
            rows.append({"season": season, "verdict": "EMPTY", "rows": 0})
            continue

        # (3) Same payload for every season? Fingerprint the returned values.
        items = sorted(((str(k), json.dumps(v, sort_keys=True, default=str))
                        for k, v in proj.items()))[:400]
        fingerprints[season] = hashlib.sha256(
            json.dumps(items, sort_keys=True).encode()).hexdigest()[:16]

        # (2) Contamination: score the projection against that season's actuals.
        actual = actual_points(season, sc)
        pairs = []
        for key, line in proj.items():
            a = actual.get(key)
            if a is None:
                continue
            pairs.append((points(line, sc), a))
        matched = len(pairs)
        print(f"  matched to actuals: {matched}")

        rho = float("nan")
        if matched >= 30:
            df = pd.DataFrame(pairs, columns=["proj", "actual"])
            rho = float(stats.spearmanr(df["proj"], df["actual"]).statistic)
            print(f"  Spearman(projection, actual) = {rho:.4f}")

        if matched < 30:
            verdict = "TOO FEW MATCHES"
        elif rho >= CONTAMINATION:
            verdict = "CONTAMINATED — DO NOT USE"
        elif rho < 0.2:
            verdict = "SUSPECT (barely predictive)"
        else:
            verdict = "looks like genuine preseason"
        print(f"  verdict: {verdict}")
        rows.append({"season": season, "verdict": verdict, "rows": len(proj),
                     "matched": matched, "spearman_vs_actual": round(rho, 4)})

    # Report the cross-season fingerprint check.
    print("\n=== distinct payloads per season ===")
    seen = {}
    for season, fp in fingerprints.items():
        seen.setdefault(fp, []).append(season)
    for fp, seasons in seen.items():
        flag = "  <-- IDENTICAL, so only one season's data really exists" if len(seasons) > 1 else ""
        print(f"  {fp}: {seasons}{flag}")
    if any(len(s) > 1 for s in seen.values()):
        print("  !! At least two seasons returned the same payload. Historical "
              "projections are NOT available and step 0.1 cannot be backtested.")

    os.makedirs(args.out, exist_ok=True)
    pd.DataFrame(rows).to_csv(f"{args.out}/projection_probe.csv", index=False)
    print(f"\n✓ wrote {args.out}/projection_probe.csv")

    usable = [r for r in rows if r["verdict"] == "looks like genuine preseason"]
    print(f"\nUSABLE SEASONS: {len(usable)} of {len(rows)}")
    if len(usable) < 3:
        print("Fewer than three usable seasons. Step 0.1's kill gate cannot be "
              "evaluated honestly on this data — say so rather than shipping a "
              "blend validated on nothing.")


if __name__ == "__main__":
    main()

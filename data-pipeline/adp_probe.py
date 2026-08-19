#!/usr/bin/env python3
"""
adp_probe.py — is FantasyPros' historical ADP real, and is it PRESEASON?
=======================================================================
Two questions, and the second is the one that matters.

`/nfl/{season}/consensus-rankings?type=ADP&week=0` accepts a past season, so the
data is presumably reachable. But a backtest needs what the market believed
BEFORE that season. If the endpoint quietly serves end-of-season or rest-of-
season rankings for a past year, the numbers would look spectacular and be
worthless — the model would be "predicting" a season using knowledge of it.

So this doesn't just check that rows come back. It scores the returned ADP
against what actually happened that year:

  Spearman ~0.5-0.65  → consistent with genuine preseason opinion.
  Spearman > 0.85     → CONTAMINATED. Nothing that far ahead of the shipped
                        model (~0.70) can be a preseason ranking; it is
                        hindsight and must not enter the backtest.

Run where FANTASYPROS_API_KEY lives (GitHub Actions):
    python adp_probe.py --seasons 2022 2023 2024
"""
from __future__ import annotations

import argparse
import os
from urllib.parse import urlencode

import nflreadpy as nfl
import pandas as pd
from scipy import stats

from fantasypros import _get_json, norm
from projection_model import default_scoring, points

BASE = "https://api.fantasypros.com/public/v2/json/nfl/{season}/consensus-rankings"
FANTASY_POS = {"QB", "RB", "WR", "TE"}
COMP = {
    "passing_yards": "passYd", "passing_tds": "passTD", "interceptions": "int",
    "rushing_yards": "rushYd", "rushing_tds": "rushTD",
    "receptions": "rec", "receiving_yards": "recYd", "receiving_tds": "recTD",
}


def fetch_adp(season: int, scoring="HALF", rank_type="ADP", week=0) -> dict:
    """Historical ADP/DRAFT-cost rankings, one season at a time.

    Routed through fantasypros._get_json (429 backoff: 2s/4s/8s/16s) rather
    than a bare urlopen. This bug was live and corrupting real results: a
    9-season export made 18 sequential calls to this endpoint with no pacing
    or retry, and a 429 partway through silently returned {} for the
    remaining seasons -- which then entered a downstream simulation as
    "these players have no ADP", not as "the fetch failed". Two runs of the
    roadmap 3.1 survival gate 15 minutes apart got opposite pass/fail verdicts
    for exactly this reason: whichever run got rate-limited on 2024/2025 had
    those seasons' entire player pool fall back to pSurvive()=1 (its
    documented behavior for missing ADP), which is a reasonable default for
    one missing player and a source of large, uniform, signal-free "costs"
    when an ENTIRE season is missing it. fetch_injuries() was already routed
    through this same retry path for the identical reason (see its own
    docstring); this endpoint should have been from the start.
    """
    key = os.getenv("FANTASYPROS_API_KEY")
    if not key:
        raise SystemExit("FANTASYPROS_API_KEY not set")
    url = BASE.format(season=season) + "?" + urlencode(
        {"position": "ALL", "scoring": scoring, "type": rank_type, "week": week})
    data = _get_json(url, key, label=f"{season} type={rank_type}")
    if data is None:
        return {}
    rows = data.get("players") or []
    out = {}
    for p in rows:
        name = p.get("player_name") or p.get("name")
        pos = "".join(ch for ch in (p.get("player_position_id") or p.get("position_id") or "").upper() if ch.isalpha())
        if not name or pos not in FANTASY_POS:
            continue
        val = p.get("rank_adp") or p.get("player_adp") or p.get("rank_ecr")
        try:
            val = float(val)
        except (TypeError, ValueError):
            continue
        if val > 0:
            out[(norm(name), pos)] = val
    print(f"  {season} type={rank_type} week={week}: {len(rows)} rows, {len(out)} usable "
          f"| meta season={data.get('season')} week={data.get('week')} type={data.get('type')}")
    return out


def actuals(season: int) -> dict:
    df = nfl.load_player_stats(season, summary_level="reg").to_pandas()
    df = df[df["position"].isin(FANTASY_POS)]
    sc = default_scoring(0.5)
    out = {}
    for r in df.itertuples():
        line = {dst: float(getattr(r, src, 0) or 0) for src, dst in COMP.items()}
        line["fumbles"] = float(getattr(r, "rushing_fumbles_lost", 0) or 0)
        out[(norm(r.player_display_name), r.position)] = points(line, sc)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", type=int, nargs="+", default=[2022, 2023, 2024])
    args = ap.parse_args()

    print("Fetching historical ADP…")
    verdicts = []
    for season in args.seasons:
        adp = fetch_adp(season, rank_type="ADP")
        if not adp:
            adp = fetch_adp(season, rank_type="DRAFT")   # fall back, still preseason-ish
        if not adp:
            verdicts.append((season, None, "no data"))
            continue
        act = actuals(season)
        pairs = [(v, act[k]) for k, v in adp.items() if k in act]
        if len(pairs) < 50:
            verdicts.append((season, None, f"only {len(pairs)} matched players"))
            continue
        # ADP ascends (1 = best), points descend — negate so a good ranking is +.
        rho = stats.spearmanr([-a for a, _ in pairs], [b for _, b in pairs]).statistic
        verdict = ("CONTAMINATED (hindsight)" if rho > 0.85
                   else "plausible preseason" if rho < 0.75
                   else "SUSPICIOUS — inspect before using")
        verdicts.append((season, rho, f"{verdict} · {len(pairs)} matched"))

    print("\n=== ADP vs that season's ACTUAL finish ===")
    print("(the shipped projection scores ~0.70; a preseason ADP should be near that,")
    print(" NOT far above it — anything >0.85 is hindsight leaking in)")
    for season, rho, note in verdicts:
        print(f"  {season}: spearman={rho if rho is None else round(rho,4)}  {note}")


if __name__ == "__main__":
    main()

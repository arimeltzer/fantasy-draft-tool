#!/usr/bin/env python3
"""
injury_probe.py — is FantasyPros' historical injury report real and preseason?
================================================================================
Roadmap step 0.3 wants to convert injury status into expected games missed and
apply it to the projection. Before that can be BACKTESTED, one question has to
be answered honestly, and the URL shape itself is a reason to suspect the
answer is no: `fetch_injuries()` hits a FLAT endpoint —
`/nfl/injuries?year=&week=` — unlike `/nfl/{season}/projections` and
`/nfl/{season}/consensus-rankings`, which embed the season in the PATH and were
independently verified (`adp_probe.py`, `projection_probe.py`) to serve real,
distinct, per-season preseason data. A query param that LOOKS like it selects a
season is not evidence it does; `fetch_aav` already shipped once parsing a
200 response into silent zeros. The one place this project calls
`fetch_injuries()` (`projections.py`) only ever passes the CURRENT season — so
whether `year=<past season>` returns anything real for that past season has
never been exercised at all.

Three failure modes, none of which raise an error:

  1. EMPTY — the season is ignored and nothing comes back.
  2. STALE/ECHOED — the same payload for every `year` requested, i.e. today's
     live injury report regardless of what was asked (the likeliest failure,
     given "current status" is literally what the docstring says this is for).
  3. NONSENSE — rows come back and differ by season, but don't correlate with
     anything: players flagged Out/Doubtful/Questionable pre-season should, on
     average, miss MORE games that season than an unflagged player. If a real,
     dated report exists, that gap should be visible; if the endpoint is
     silently serving some other week's or some other player's status, the gap
     should be noise.

There is no "contamination" check here the way adp_probe/projection_probe have
one — injury status isn't a continuous predictor of points, so there's no
Spearman-vs-actual ceiling that proves hindsight. The games-missed gap is the
closest available signal, and it is a floor, not hindsight-proof: even a
genuine week-0 report is included.

Run where FANTASYPROS_API_KEY lives (GitHub Actions):
    python injury_probe.py --seasons 2021 2022 2023 2024 2025
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os

import time

import pandas as pd

from fantasypros import RATE_LIMIT_PAUSE, fetch_injuries, norm

FANTASY_POS = {"QB", "RB", "WR", "TE", "K", "DST"}


def actual_gp(season: int) -> dict:
    """(normalized name, pos) -> games played that season, from nflverse."""
    import nflreadpy as nfl
    df = nfl.load_player_stats(season, summary_level="reg")
    df = df.to_pandas() if hasattr(df, "to_pandas") else df
    pos_c = "position" if "position" in df.columns else "pos"
    name_c = "player_display_name" if "player_display_name" in df.columns else "player_name"
    gp_c = "games" if "games" in df.columns else "games_played"
    df = df[df[pos_c].isin(FANTASY_POS)]
    out = {}
    for r in df.itertuples():
        pos = getattr(r, pos_c)
        out[(norm(getattr(r, name_c)), pos)] = int(getattr(r, gp_c, 0) or 0)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="+", type=int,
                    default=[2021, 2022, 2023, 2024, 2025])
    ap.add_argument("--out", default="./results")
    args = ap.parse_args()

    if not os.getenv("FANTASYPROS_API_KEY"):
        raise SystemExit("FANTASYPROS_API_KEY not set — run this where the key lives.")

    rows = []
    fingerprints = {}

    for season in args.seasons:
        print(f"\n=== {season} ===")
        try:
            # fetch_injuries() already parses (it's the shipped call, and
            # calling parse_injuries() again on its output would silently be
            # a no-op — parse_injuries is idempotent on a dict keyed by tuple
            # strings, not a second real check).
            inj = fetch_injuries(season, week=0)
        except Exception as e:  # noqa: BLE001 — a dead season is a result, not a crash
            print(f"  fetch failed: {type(e).__name__}: {e}")
            rows.append({"season": season, "verdict": "FETCH FAILED", "rows": 0})
            continue
        time.sleep(RATE_LIMIT_PAUSE)  # pace across seasons, not just within one

        print(f"  rows returned: {len(inj)}")
        if not inj:
            rows.append({"season": season, "verdict": "EMPTY", "rows": 0})
            continue

        # (2) Same payload every season? Fingerprint the (key, status) pairs —
        # NOT `chance`, which can drift hour to hour on an otherwise identical
        # report and would mask a real staleness match.
        items = sorted((f"{k[0]}|{k[1]}", v["status"]) for k, v in inj.items())
        fingerprints[season] = hashlib.sha256(
            json.dumps(items, sort_keys=True).encode()).hexdigest()[:16]

        # Roster sanity: what fraction of the returned names were even active
        # in that season? A report about the wrong year fails this cheaply.
        gp = actual_gp(season)
        matched = {k: v for k, v in inj.items() if k in gp}
        match_rate = len(matched) / len(inj)
        print(f"  matched to that season's roster: {len(matched)}/{len(inj)} "
              f"({match_rate:.0%})")

        # (3) Games-missed gap: flagged players should miss more games than
        # the unflagged population, on average, if the report is real and
        # dated to this season.
        flagged_gp = [gp[k] for k in matched if matched[k]["severity"] != "note"]
        unflagged_gp = [v for k, v in gp.items() if k not in inj]
        by_sev = {}
        for sev in ("out", "doubtful", "questionable"):
            vals = [gp[k] for k in matched if matched[k]["severity"] == sev]
            if vals:
                by_sev[sev] = round(sum(vals) / len(vals), 2)

        gap = None
        if flagged_gp and unflagged_gp:
            gap = round(sum(unflagged_gp) / len(unflagged_gp)
                        - sum(flagged_gp) / len(flagged_gp), 2)
            print(f"  mean gp: unflagged {sum(unflagged_gp)/len(unflagged_gp):.2f}  "
                  f"flagged {sum(flagged_gp)/len(flagged_gp):.2f}  gap {gap:+.2f}")
        if by_sev:
            print(f"  mean gp by severity: {by_sev}")

        if match_rate < 0.5:
            verdict = "ROSTER MISMATCH — likely the wrong season's players"
        elif len(matched) < 20:
            verdict = "TOO FEW MATCHES"
        elif gap is not None and gap <= 0.5:
            verdict = "NO GAMES-MISSED SIGNAL — flagged players didn't miss more games"
        else:
            verdict = "looks like a genuine dated report"
        print(f"  verdict: {verdict}")
        rows.append({"season": season, "verdict": verdict, "rows": len(inj),
                     "matched": len(matched), "match_rate": round(match_rate, 3),
                     "gp_gap": gap})

    print("\n=== distinct payloads per season ===")
    seen = {}
    for season, fp in fingerprints.items():
        seen.setdefault(fp, []).append(season)
    for fp, seasons in seen.items():
        flag = "  <-- IDENTICAL, so only one season's report really exists" if len(seasons) > 1 else ""
        print(f"  {fp}: {seasons}{flag}")
    if any(len(s) > 1 for s in seen.values()):
        print("  !! At least two seasons returned the same payload. Historical "
              "injury reports are NOT available and step 0.3 cannot be "
              "backtested against real per-season data.")

    os.makedirs(args.out, exist_ok=True)
    pd.DataFrame(rows).to_csv(f"{args.out}/injury_probe.csv", index=False)
    print(f"\n✓ wrote {args.out}/injury_probe.csv")

    usable = [r for r in rows if r["verdict"] == "looks like a genuine dated report"]
    print(f"\nUSABLE SEASONS: {len(usable)} of {len(rows)}")
    if len(usable) < 3:
        print("Fewer than three usable seasons. Step 0.3's kill gate cannot be "
              "evaluated honestly against per-season historical data — say so "
              "rather than shipping a discount validated on nothing.")


if __name__ == "__main__":
    main()

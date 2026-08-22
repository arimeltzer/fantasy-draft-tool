#!/usr/bin/env python3
"""
export_draft_seasons.py — historical draft-day boards for the Node simulator
============================================================================
`draft-sim.mjs` runs against the SHIPPED `pickScore`, which means it runs in
Node. The data it needs lives behind Python (nflverse, FantasyPros), so this
writes the bridge: one JSON per run holding, for each season,

  players    — every player as the app would have seen them on draft day:
               prior-season lines, age, ADP. The Node side runs the real
               `valueBoard` over these, so the simulated board IS the app's
               board rather than a reimplementation of it.
  actual     — what each player really scored that season. The target.
  adp        — the market's ordering, which drives the opponent bots.

NO LOOKAHEAD. `last`/`last2` come from seasons before the one being drafted,
ADP is that season's preseason consensus (validated by `adp_probe.py`), and the
only field drawn from the season itself is `actual`, which is never visible to
any drafting agent — the Node side receives it separately for scoring.

WHY 2017-2020 MATTERS. `DEFAULT_SNAKE_PARAMS.SLOTS` was tuned on 2021-2025, so
those seasons are in-sample for it. The seasons before are the only genuinely
held-out test of whether ten per-slot configs beat one shared config.

Run where FANTASYPROS_API_KEY lives:
    python export_draft_seasons.py --first 2017 --last 2025 --out ./results
"""
from __future__ import annotations

import argparse
import json
import os
import time

from projection_backtest import (
    COMP, VOLUME, build_players, load_ages, load_seasons, load_team_weeks,
    load_weeks, season_line,
)
from projection_model import default_scoring, points

PPR = 0.5

try:
    from adp_probe import fetch_adp
    from fantasypros import RATE_LIMIT_PAUSE, norm as fp_norm
except Exception:                     # no key -> no ADP, and the sim needs it
    fetch_adp = None
    fp_norm = None
    RATE_LIMIT_PAUSE = 1.5


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--first", type=int, default=2017)
    ap.add_argument("--last", type=int, default=2025)
    ap.add_argument("--out", default="./results")
    args = ap.parse_args()

    if not fetch_adp or not os.getenv("FANTASYPROS_API_KEY"):
        raise SystemExit(
            "FANTASYPROS_API_KEY not set. The simulator's opponents draft by ADP; "
            "without it they would draft by our own model and the whole comparison "
            "would be against a strawman that shares our biases.")

    test_years = list(range(args.first, args.last + 1))
    need = sorted({y for t in test_years for y in (t - 2, t - 1, t)})
    print(f"Loading NFL data {need[0]}–{need[-1]}…")
    data = load_seasons(need)
    ages = load_ages(test_years)
    sc = default_scoring(PPR)

    # Roadmap 2.4 needs the season's outcome resolved BY WEEK, not just as a
    # total, plus the real bye schedule — a bye-aware model that scored against
    # season totals would be marking its own homework, since the whole claim is
    # about which weeks a player could actually be started.
    print("Loading weekly outcomes + bye schedules…")
    weeks_df = load_weeks(test_years)
    team_weeks = load_team_weeks(test_years)
    weekly_by_year: dict[int, dict] = {}
    for r in weeks_df.itertuples():
        weekly_by_year.setdefault(int(r.season), {}).setdefault(r.player_id, {})[
            int(r.week)] = round(points(season_line(r), sc), 2)

    # A bye is a week missing from a team's own schedule — the same derivation
    # `bye-weeks.js byeByTeam` and `ingest_nflverse.build_schedule` use, so the
    # backtest and the shipped app cannot disagree about what a bye is. A team
    # with anything other than exactly one gap is left null rather than guessed
    # at; the Node side treats null as "no bye information" and skips it.
    byes_by_year: dict[int, dict] = {}
    for (season, team), sched in team_weeks.items():
        if season not in test_years:
            continue
        horizon = max(sched) if sched else 0
        missing = [w for w in range(1, horizon + 1) if w not in sched]
        byes_by_year.setdefault(season, {})[team] = missing[0] if len(missing) == 1 else None

    out = {}
    for year in test_years:
        players = build_players(data, ages, year)
        if not players:
            print(f"  {year}: no players")
            continue

        # Paced like every other loop in this pipeline that hits FantasyPros
        # sequentially (see fantasypros.py's own comment on this) -- pacing is
        # the cheap first line of defense, _get_json's retry (now wired into
        # fetch_adp) is the second, and this loop used to have neither.
        adp = fetch_adp(year, rank_type="ADP") or fetch_adp(year, rank_type="DRAFT") or {}
        time.sleep(RATE_LIMIT_PAUSE)
        wk_src = weekly_by_year.get(year, {})
        rows, actual, adp_by_id, weekly = [], {}, {}, {}
        for i, p in enumerate(players):
            pid = i + 1                       # dense ids; the sim only needs identity
            rank = adp.get((fp_norm(p["name"]), p["pos"]))
            # Re-key the realized weekly line onto the same dense id the board
            # uses. Absent = the player recorded no stats that week, which the
            # Node side scores as a real 0 rather than as missing data.
            wk = wk_src.get(p["player_id"])
            if wk:
                weekly[pid] = wk
            rows.append({
                "id": pid,
                "name": p["name"],
                "pos": p["pos"],
                "team": p.get("team") or "",
                "age": p.get("age"),
                "last": p.get("last"),
                "last2": p.get("last2"),
                "adp": rank,
            })
            actual[pid] = round(points(season_line(p["_actual"]), sc), 1)
            if rank:
                adp_by_id[pid] = rank

        out[year] = {
            "players": rows, "actual": actual,
            "weekly": weekly, "byes": byes_by_year.get(year, {}),
        }
        nbye = sum(1 for v in byes_by_year.get(year, {}).values() if v)
        print(f"  {year}: {len(rows)} players, {len(adp_by_id)} with ADP, "
              f"{len(weekly)} with weekly lines, {nbye} teams with a resolved bye")

    os.makedirs(args.out, exist_ok=True)
    path = f"{args.out}/draft_seasons.json"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh)
    size = os.path.getsize(path) / 1e6
    print(f"\n✓ wrote {path} ({size:.1f} MB, {len(out)} seasons)")

    thin = [y for y, v in out.items()
            if sum(1 for p in v["players"] if p["adp"]) < 120]
    if thin:
        print(f"! thin ADP coverage in {thin} — the opponent bots there are "
              f"drafting from a short list and those seasons should carry less weight")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
ingest_nflverse.py
==================
Pulls LIVE nflverse data and writes JSON that feeds the fantasy modules.

  sos_logs.json          -> strength-of-schedule.js : adjustedDefenseRatings(logs)
  schedule_2026.json     -> strength-of-schedule.js : buildSosMultipliers(schedule, ...)
  player_logs_2025.json  -> strength-of-schedule.js : commonOpponents(playerLogs, ...)
  players_base.json      -> valuation-engine.js     : valueBoard(players, ...)
                            (real `last` totals + age + 2026 team; `proj` optional)

DATA SOURCE
  nflverse via `nflreadpy` — the successor to nfl_data_py, which nflverse
  deprecated. nflreadpy returns Polars frames; we convert to pandas here.

INSTALL
  pip install nflreadpy pandas pyarrow

RUN
  python ingest_nflverse.py --last 2025 --upcoming 2026 --out ./data --baseline-proj

Notes
  * Fantasy points are computed from raw components using SCORING below, so the
    SOS logs are in YOUR league's currency. Edit SCORING to match the engine.
  * nflverse does NOT publish consensus projections. `--baseline-proj` seeds
    `proj` with last season's 17-game pace so the whole pipeline runs today;
    replace it with real projections (e.g. nfl.load_ff_rankings()) when ready.
"""

from __future__ import annotations
import argparse, json, os
import nflreadpy as nfl

FANTASY_POS = {"QB", "RB", "WR", "TE"}
PROJECTED_GAMES = 17

# Mirror valuation-engine.js defaultScoring(0.5). Change in one place.
SCORING = dict(passYd=0.04, passTD=4, intc=-2, rushYd=0.1, rushTD=6,
               rec=0.5, recYd=0.1, recTD=6, fum=-2, twoPt=2)

# nflverse component column -> engine `last`/`proj` field
COMP = {
    "passing_yards": "passYd", "passing_tds": "passTD", "interceptions": "int",
    "rushing_yards": "rushYd", "rushing_tds": "rushTD",
    "receptions": "rec", "receiving_yards": "recYd", "receiving_tds": "recTD",
}

# ---------- helpers ----------
def _pd(df):
    """nflreadpy returns Polars; give back a pandas frame."""
    return df.to_pandas() if hasattr(df, "to_pandas") else df

def _col(df, *names):
    for n in names:
        if n in df.columns:
            return n
    return None

def _num(r, k):
    v = r.get(k, 0)
    try:
        return float(v) if v == v else 0.0   # NaN guard
    except (TypeError, ValueError):
        return 0.0

def fantasy_points(r):
    fum = _num(r, "rushing_fumbles_lost") + _num(r, "receiving_fumbles_lost") + _num(r, "sack_fumbles_lost")
    two = _num(r, "passing_2pt_conversions") + _num(r, "rushing_2pt_conversions") + _num(r, "receiving_2pt_conversions")
    return round(
        _num(r, "passing_yards")*SCORING["passYd"] + _num(r, "passing_tds")*SCORING["passTD"]
        + _num(r, "interceptions")*SCORING["intc"]
        + _num(r, "rushing_yards")*SCORING["rushYd"] + _num(r, "rushing_tds")*SCORING["rushTD"]
        + _num(r, "receptions")*SCORING["rec"] + _num(r, "receiving_yards")*SCORING["recYd"]
        + _num(r, "receiving_tds")*SCORING["recTD"]
        + fum*SCORING["fum"] + two*SCORING["twoPt"], 2)

# ---------- loaders ----------
def load_weekly(season):
    df = _pd(nfl.load_player_stats(season, summary_level="week"))
    team = _col(df, "team", "recent_team")
    df = df[(df.get("season_type") == "REG") & (df["position"].isin(FANTASY_POS))].copy()
    df = df[df[team].notna() & df["opponent_team"].notna()]
    df["off_team"] = df[team]
    df["fp"] = df.apply(fantasy_points, axis=1)
    return df

# ---------- builders ----------
def build_sos_logs(df):
    """[{week, off, def, pos, fp}] — points each offense's position group scored vs each defense."""
    grp = df.groupby(["week", "off_team", "opponent_team", "position"])["fp"].sum().reset_index()
    return [{"week": int(g.week), "off": g.off_team, "def": g.opponent_team,
             "pos": g.position, "fp": round(float(g.fp), 2)} for g in grp.itertuples()]

def build_player_logs(df):
    """[{player_id, name, pos, team, games:[{week, opp, fp}]}]"""
    cols = ["player_id", "player_display_name", "position", "off_team", "week", "opponent_team", "fp"]
    sub = df[cols].copy()
    out = {}
    for g in sub.itertuples():
        rec = out.setdefault(g.player_id, {
            "player_id": g.player_id, "name": g.player_display_name,
            "pos": g.position, "team": g.off_team, "games": []})
        rec["games"].append({"week": int(g.week), "opp": g.opponent_team, "fp": round(float(g.fp), 2)})
    return list(out.values())

def build_schedule(upcoming):
    """{TEAM: [{week, opp}]} for the upcoming regular season."""
    sch = _pd(nfl.load_schedules(upcoming))
    typ = _col(sch, "game_type", "season_type")
    sch = sch[(sch[typ] == "REG")] if typ else sch
    out = {}
    for g in sch.itertuples():
        wk, home, away = int(g.week), g.home_team, g.away_team
        if home != home or away != away:   # NaN bye/placeholder
            continue
        out.setdefault(home, []).append({"week": wk, "opp": away})
        out.setdefault(away, []).append({"week": wk, "opp": home})
    return out

def _agg_season(df):
    """{player_id: {components + fumbles + gp}} — season totals for one completed season."""
    if df is None:
        return {}
    have = [c for c in COMP if c in df.columns]
    agg = (df.groupby(["player_id", "player_display_name", "position"])
           .agg(gp=("week", "nunique"),
                fum=("rushing_fumbles_lost", "sum"),
                **{c: (c, "sum") for c in have})
           .reset_index())
    out = {}
    for g in agg.itertuples():
        gp = int(g.gp) or 1
        d = {COMP[c]: round(float(getattr(g, c)), 1) for c in have}
        d["fumbles"] = round(float(getattr(g, "fum", 0) or 0), 1)
        d["gp"] = gp
        out[g.player_id] = d
    return out

def build_players_base(df_last, df_last2, upcoming, baseline_proj):
    """Engine rows: name, pos, team(upcoming), age, last{components+gp}, last2{...}, proj{} or baseline."""
    have = [c for c in COMP if c in df_last.columns]
    agg = (df_last.groupby(["player_id", "player_display_name", "position"])
           .agg(gp=("week", "nunique"),
                fum=("rushing_fumbles_lost", "sum"),
                **{c: (c, "sum") for c in have})
           .reset_index())
    last2_by_id = _agg_season(df_last2)   # 2-years-ago season, keyed by player_id

    # 2026 team + age from rosters (offseason rosters exist by summer)
    team_by_id, age_by_id = {}, {}
    try:
        ros = _pd(nfl.load_rosters(upcoming))
        rid = _col(ros, "gsis_id", "player_id")
        rteam, rage = _col(ros, "team"), _col(ros, "age")
        for r in ros.itertuples():
            pid = getattr(r, rid, None)
            if pid is None:
                continue
            if rteam: team_by_id[pid] = getattr(r, rteam)
            if rage:
                a = getattr(r, rage)
                if a == a: age_by_id[pid] = round(float(a), 1)
    except Exception as e:
        print(f"  ! rosters({upcoming}) unavailable ({e}); team/age may be blank")

    rows = []
    for g in agg.itertuples():
        gp = int(g.gp) or 1
        last = {COMP[c]: round(float(getattr(g, c)), 1) for c in have}
        last["fumbles"] = round(float(getattr(g, "fum", 0) or 0), 1)
        last["gp"] = gp
        proj = None
        if baseline_proj:
            scale = PROJECTED_GAMES / gp
            proj = {COMP[c]: round(float(getattr(g, c)) * scale, 1) for c in have}
        rows.append({
            "id": g.player_id, "name": g.player_display_name, "pos": g.position,
            "team": team_by_id.get(g.player_id, ""), "age": age_by_id.get(g.player_id),
            "last": last, "last2": last2_by_id.get(g.player_id), "proj": proj,
        })
    return rows

# ---------- main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--last", type=int, default=2025, help="completed season to learn from")
    ap.add_argument("--last2", type=int, default=None,
                    help="second-prior completed season for the 2-year projection blend (default: --last minus 1)")
    ap.add_argument("--upcoming", type=int, default=2026, help="season being drafted")
    ap.add_argument("--out", default="./data")
    ap.add_argument("--baseline-proj", action="store_true",
                    help="seed proj with last season's 17-game pace so the pipeline runs now")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    print(f"Loading {args.last} weekly player stats from nflverse…")
    df_last = load_weekly(args.last)

    last2_season = args.last2 if args.last2 is not None else args.last - 1
    print(f"Loading {last2_season} weekly player stats (2-year blend)…")
    try:
        df_last2 = load_weekly(last2_season)
    except Exception as e:
        print(f"  ! {last2_season} weekly stats unavailable ({e}); last2 will be blank")
        df_last2 = None

    artifacts = {
        "sos_logs.json": build_sos_logs(df_last),
        "player_logs_2025.json": build_player_logs(df_last),
        "schedule_2026.json": build_schedule(args.upcoming),
        "players_base.json": build_players_base(df_last, df_last2, args.upcoming, args.baseline_proj),
    }
    for fname, data in artifacts.items():
        path = os.path.join(args.out, fname)
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
        n = len(data) if isinstance(data, list) else len(data.keys())
        print(f"  ✓ {fname}  ({n} records)")

    sched = artifacts["schedule_2026.json"]
    if not sched:
        print(f"  ! schedule_2026.json is empty — the {args.upcoming} schedule may not be posted yet.")
    print("Done. Feed these into strength-of-schedule.js and valuation-engine.js.")

if __name__ == "__main__":
    main()

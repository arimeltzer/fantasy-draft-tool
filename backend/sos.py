"""
sos.py
======
Server-side Strength-of-Schedule recompute for the /api/admin/reload-sos
endpoint. Lets an admin re-apply the (empirically tuned) SOS parameters to the
live database over HTTPS, without a local pipeline run.

It is a faithful port of frontend/src/engine/strength-of-schedule.js
(adjustedDefenseRatings / regressYoY / buildSosMultipliers) — the SAME math that
data-pipeline/load_to_db.py uses — plus a dependency-light loader that fetches a
season of weekly player stats straight from the public nflverse data release
(stdlib gzip+csv; only httpx is needed, which the backend already ships).

KEEP DEFAULT_SOS_PARAMS BELOW IN SYNC with the JS engine and load_to_db.py.
See data-pipeline/SOS_TUNING_RESULTS.md for how these values were derived.
"""
from __future__ import annotations

import csv
import gzip
import io
from statistics import mean
from typing import Any

import httpx

FANTASY_POS = ("QB", "RB", "WR", "TE")

# Empirically tuned (2015-2024 out-of-sample backtest). Mirror of
# DEFAULT_SOS_PARAMS in strength-of-schedule.js.
DEFAULT_SOS_PARAMS: dict[str, Any] = {
    "iterations": 12,
    "yoyRetention": {"QB": 0.30, "RB": 0.30, "WR": 0.26, "TE": 0.11},
    "sosWeight": 0.8,
    "cap": 0.04,
    "playoffWeeks": {15, 16, 17},
    "playoffWeight": 1.2,
}

# nflverse weekly player stats, CSV (gzipped) — same source nflreadpy uses.
NFLVERSE_WEEKLY_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/"
    "player_stats/stats_player_week_{season}.csv.gz"
)


# ── SOS math (port of strength-of-schedule.js) ──────────────────────────────

def adjusted_defense_ratings(logs, iterations: int = 12):
    """logs: [{week, off, def, pos, fp}] -> opponent-adjusted def softness."""
    logs = list(logs)
    teams = sorted({t for l in logs for t in (l["off"], l["def"])})
    out = {"def": {}, "leagueAvg": {}}
    for pos in sorted({l["pos"] for l in logs}):
        rows = [l for l in logs if l["pos"] == pos]
        lg = mean([r["fp"] for r in rows]) if rows else 0.0
        off_games = {t: [r for r in rows if r["off"] == t] for t in teams}
        def_games = {t: [r for r in rows if r["def"] == t] for t in teams}
        off = {t: 0.0 for t in teams}
        defr = {t: 0.0 for t in teams}
        for _ in range(iterations):
            n_off, n_def = {}, {}
            for t in teams:
                og = off_games[t]
                n_off[t] = mean([r["fp"] - lg - defr[r["def"]] for r in og]) if og else 0.0
                dg = def_games[t]
                n_def[t] = mean([r["fp"] - lg - off[r["off"]] for r in dg]) if dg else 0.0
            m_o = mean(list(n_off.values())) if n_off else 0.0
            m_d = mean(list(n_def.values())) if n_def else 0.0
            for t in teams:
                off[t] = n_off[t] - m_o
                defr[t] = n_def[t] - m_d
        out["def"][pos] = defr
        out["leagueAvg"][pos] = round(lg, 2)
    return out


def regress_yoy(ratings, params=DEFAULT_SOS_PARAMS):
    ret = params["yoyRetention"]
    get = (lambda pos: ret.get(pos, 0.30)) if isinstance(ret, dict) else (lambda pos: ret)
    return {
        "def": {pos: {t: round(v * get(pos), 3) for t, v in defn.items()}
                for pos, defn in ratings["def"].items()},
        "leagueAvg": ratings["leagueAvg"],
    }


def build_sos_multipliers(schedule, est, params=DEFAULT_SOS_PARAMS):
    """schedule: {team: [{week, opp}]} -> {team: {pos: multiplier}}."""
    cap, sosw = params["cap"], params["sosWeight"]
    po_weeks, po_wt = params["playoffWeeks"], params["playoffWeight"]
    out = {}
    for team, games in schedule.items():
        out[team] = {}
        for pos, defn in est["def"].items():
            acc = w = 0.0
            for g in games:
                wt = po_wt if g["week"] in po_weeks else 1.0
                acc += wt * defn.get(g["opp"], 0.0)
                w += wt
            score = acc / w if w else 0.0
            lg = est["leagueAvg"].get(pos) or 1.0
            m = 1.0 + (score / lg) * sosw
            m = min(1 + cap, max(1 - cap, m))
            out[team][pos] = round(m, 3)
    return out


# ── nflverse loader (stdlib parse, half-PPR) ────────────────────────────────

def _num(v) -> float:
    try:
        return float(v) if v not in ("", None) and v == v else 0.0
    except (TypeError, ValueError):
        return 0.0


def build_sos_logs_from_csv(text: str):
    """Aggregate weekly CSV rows -> [{week, off, def, pos, fp}] (half-PPR).

    half-PPR = mean(standard fantasy_points, full-PPR fantasy_points_ppr).
    Schedule strength is a relative signal, so the PPR choice (which scales all
    positions together) is immaterial; half-PPR matches the app default.
    """
    agg: dict[tuple, float] = {}
    reader = csv.DictReader(io.StringIO(text))
    for r in reader:
        if r.get("season_type") != "REG":
            continue
        pos = r.get("position")
        if pos not in FANTASY_POS:
            continue
        off_t, def_t = r.get("team"), r.get("opponent_team")
        if not off_t or not def_t:
            continue
        fp = (_num(r.get("fantasy_points")) + _num(r.get("fantasy_points_ppr"))) / 2.0
        try:
            week = int(r["week"])
        except (KeyError, ValueError):
            continue
        agg[(week, off_t, def_t, pos)] = agg.get((week, off_t, def_t, pos), 0.0) + fp
    return [{"week": w, "off": o, "def": d, "pos": p, "fp": round(v, 2)}
            for (w, o, d, p), v in agg.items()]


async def fetch_sos_logs(log_season: int, ca_bundle: str | None = None):
    """Fetch a season of weekly stats from nflverse and build SOS logs."""
    url = NFLVERSE_WEEKLY_URL.format(season=log_season)
    verify = ca_bundle if ca_bundle else True
    async with httpx.AsyncClient(timeout=90, follow_redirects=True,
                                 trust_env=True, verify=verify) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        text = gzip.decompress(resp.content).decode("utf-8", "replace")
    return build_sos_logs_from_csv(text)


def recompute(schedule: dict, sos_logs: list, params=DEFAULT_SOS_PARAMS) -> dict:
    """schedule {team:[{week,opp}]} + sos_logs -> {team:{pos:mult}}."""
    ratings = adjusted_defense_ratings(sos_logs, params["iterations"])
    est = regress_yoy(ratings, params)
    return build_sos_multipliers(schedule, est, params)

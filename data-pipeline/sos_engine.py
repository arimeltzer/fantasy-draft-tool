#!/usr/bin/env python3
"""
sos_engine.py
=============
Faithful Python port of the two pure functions in
`frontend/src/engine/strength-of-schedule.js` that the SOS backtest needs:

  - adjustedDefenseRatings(logs, iterations)  the opponent-adjusted (SRS-style)
    solve for how many fantasy points each defense allows to each position,
    above league average, after removing the strength of offenses faced.
  - regress_yoy(ratings, yoy_retention, prior, prior_weight)  pull last year's
    rating toward the mean (defenses are noisy), optionally blending a prior
    season for stability.

The port is validated against the JS `demo()` output in `validate_port()` so
the backtest is measuring the SAME math that ships in the app.
"""
from __future__ import annotations
from statistics import mean


def adjusted_defense_ratings(logs, iterations: int = 12):
    """logs: iterable of dicts {week, off, def, pos, fp}.

    Returns {"def": {pos: {team: rating}}, "off": {...}, "leagueAvg": {pos: lg}}
    where def[pos][team] = points `team` allows to `pos` above league average,
    opponent-adjusted. >0 = soft matchup.
    """
    logs = list(logs)
    positions = sorted({l["pos"] for l in logs})
    teams = sorted({t for l in logs for t in (l["off"], l["def"])})
    out = {"def": {}, "off": {}, "leagueAvg": {}}

    for pos in positions:
        rows = [l for l in logs if l["pos"] == pos]
        lg = mean([r["fp"] for r in rows]) if rows else 0.0
        # precompute per-team game lists (matches JS rows.filter, but once)
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
        out["off"][pos] = off
        out["leagueAvg"][pos] = round(lg, 2)
    return out


def regress_yoy(ratings, yoy_retention=0.35, prior=None, prior_weight=0.25):
    """Pull each rating toward 0 by yoy_retention; optionally blend a prior solve.

    yoy_retention may be a scalar or a {pos: value} dict (mirrors the JS).
    Returns {"def": {pos: {team: rating}}, "leagueAvg": ...}.
    """
    def ret_for(pos):
        return yoy_retention.get(pos, 0.35) if isinstance(yoy_retention, dict) else yoy_retention

    out = {"def": {}, "leagueAvg": ratings["leagueAvg"]}
    for pos, byteam in ratings["def"].items():
        out["def"][pos] = {}
        for team, r in byteam.items():
            if prior and prior.get("def", {}).get(pos, {}).get(team) is not None:
                r = (1 - prior_weight) * r + prior_weight * prior["def"][pos][team]
            out["def"][pos][team] = round(r * ret_for(pos), 3)
    return out


# --- demo logs copied verbatim from strength-of-schedule.js demo() ---
_DEMO_LOGS = [
    {"week": 1, "off": "ATL", "def": "CAR", "pos": "RB", "fp": 28},
    {"week": 2, "off": "ATL", "def": "NO",  "pos": "RB", "fp": 22},
    {"week": 3, "off": "ATL", "def": "TB",  "pos": "RB", "fp": 12},
    {"week": 1, "off": "SF",  "def": "TB",  "pos": "RB", "fp": 9},
    {"week": 2, "off": "SF",  "def": "CAR", "pos": "RB", "fp": 31},
    {"week": 3, "off": "SF",  "def": "NO",  "pos": "RB", "fp": 18},
    {"week": 1, "off": "TB",  "def": "ATL", "pos": "RB", "fp": 14},
    {"week": 2, "off": "TB",  "def": "SF",  "pos": "RB", "fp": 7},
    {"week": 3, "off": "TB",  "def": "ATL", "pos": "RB", "fp": 16},
    {"week": 1, "off": "CAR", "def": "SF",  "pos": "RB", "fp": 6},
    {"week": 2, "off": "CAR", "def": "ATL", "pos": "RB", "fp": 19},
    {"week": 3, "off": "NO",  "def": "ATL", "pos": "RB", "fp": 24},
    {"week": 1, "off": "NO",  "def": "SF",  "pos": "RB", "fp": 11},
]

# Reference values produced by the shipping JS engine (node demo()).
_JS_RAW_RB = {"ATL": 5.028571426261334, "CAR": 9.814285714141334, "NO": 0.31428571414133305,
              "TB": -9.185714285858666, "SF": -5.971428568685336}
_JS_REG_RB = {"ATL": 1.76, "CAR": 3.435, "NO": 0.11, "TB": -3.215, "SF": -2.09}
_JS_LG_RB = 16.69


def validate_port(tol=1e-6):
    """Assert the Python port reproduces the JS demo() output."""
    ratings = adjusted_defense_ratings(_DEMO_LOGS)
    est = regress_yoy(ratings)
    raw, reg, lg = ratings["def"]["RB"], est["def"]["RB"], ratings["leagueAvg"]["RB"]
    assert abs(lg - _JS_LG_RB) < 1e-2, f"leagueAvg mismatch {lg} vs {_JS_LG_RB}"
    for t in _JS_RAW_RB:
        assert abs(raw[t] - _JS_RAW_RB[t]) < tol, f"raw {t}: {raw[t]} vs {_JS_RAW_RB[t]}"
        assert abs(reg[t] - _JS_REG_RB[t]) < 1e-3, f"reg {t}: {reg[t]} vs {_JS_REG_RB[t]}"
    return True


if __name__ == "__main__":
    ok = validate_port()
    print("Python SOS port matches JS demo():", ok)

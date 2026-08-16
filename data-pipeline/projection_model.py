"""
projection_model.py — the SHIPPED projection, in Python
=======================================================
A line-for-line port of `frontend/src/engine/engine-core.js`:
`points()`, `ageMultiplier()`, `durabilityMult()`, `rookieProjection()` and
`projectPoints()`.

Why a port rather than a fresh model: the previous backtest scored a *different*
(and degenerate) formula, so ten years of "validation" said nothing about what
the app actually does. A backtest is only worth reading if it runs the same
arithmetic as production.

The obvious risk is drift — a port that quietly disagrees with the JS measures a
fiction just as convincingly. `projection_parity.py` guards against that by
running both implementations over the same players and asserting identical
output; run it after ANY change to either side.

Structure is deliberately kept parallel to the JS (same branch order, same
rounding points) so a diff between the two files is readable.
"""
from __future__ import annotations

import copy
import math
from decimal import Decimal, ROUND_HALF_UP

# Mirrors DEFAULT_PARAMS in engine-core.js. `priorWeight`/`regressionStrength`
# are omitted on purpose: they are declared there but read by nothing.
DEFAULT_PARAMS = {
    "projectedGames": 17,
    "age": {
        "QB":  {"declineStart": 35, "declinePerYear": 0.03, "youthPeak": 0,  "youthBonus": 0.00},
        "RB":  {"declineStart": 27, "declinePerYear": 0.05, "youthPeak": 23, "youthBonus": 0.03},
        "WR":  {"declineStart": 30, "declinePerYear": 0.03, "youthPeak": 24, "youthBonus": 0.02},
        "TE":  {"declineStart": 31, "declinePerYear": 0.03, "youthPeak": 25, "youthBonus": 0.02},
        "K":   {"declineStart": 99, "declinePerYear": 0.00, "youthPeak": 0,  "youthBonus": 0.00},
        "DST": {"declineStart": 99, "declinePerYear": 0.00, "youthPeak": 0,  "youthBonus": 0.00},
    },
    "ageClamp": [0.85, 1.06],
    "projection": {
        "primaryWeight": 0.70,
        "primaryWeightUp": 0.80,
        "primaryWeightDown": 0.65,
        "trendThreshold": 50,
        "durability": [[6, 0.60], [10, 0.74], [14, 0.88]],
        "rookieCeil": {"QB": 330, "RB": 285, "WR": 275, "TE": 205, "K": 130, "DST": 130},
        "rookieEraBonus": 1.12,
        "rookieAdpFloor": 0.15,
        "rookieAdpSpan": 200,
        "fragileQbTeams": [],
        "fragileQbWrMult": 0.85,
    },
}

DEFAULT_SCORING = {
    "ptsPerPassYd": 0.04, "ptsPerPassTD": 4, "ptsPerInt": -2,
    "ptsPerRushYd": 0.1,  "ptsPerRushTD": 6,
    "ptsPerRecYd": 0.1,   "ptsPerRecTD": 6,
    "ptsPerFumble": -2,
}


def default_scoring(ppr: float = 0.5) -> dict:
    return {**DEFAULT_SCORING, "ptsPerRec": ppr}


def _round1(x: float) -> float:
    """JS `+(x).toFixed(1)`.

    Not `f"{x:.1f}"`: Python formats with banker's rounding, so an exact .x5
    goes to even (220.25 -> 220.2) while JS rounds half away from zero
    (220.25 -> 220.3). Decimal(x) takes the EXACT binary value, matching what
    toFixed inspects, so values that only look like halves (0.145 is really
    0.14499...) still round down in both. The parity test caught this.
    """
    if math.isnan(x) or math.isinf(x):
        return x
    return float(Decimal(x).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def points(line: dict | None, sc: dict) -> float:
    line = line or {}
    def g(k):
        return line.get(k) or 0
    has_stats = (g("passYd") or g("passTD") or g("rushYd") or g("rushTD")
                 or g("rec") or g("recYd") or g("recTD"))
    if not has_stats and line.get("pts") is not None:
        return line["pts"]
    return (
        g("passYd") * sc["ptsPerPassYd"] + g("passTD") * sc["ptsPerPassTD"] + g("int") * sc["ptsPerInt"]
        + g("rushYd") * sc["ptsPerRushYd"] + g("rushTD") * sc["ptsPerRushTD"]
        + g("rec") * sc["ptsPerRec"] + g("recYd") * sc["ptsPerRecYd"] + g("recTD") * sc["ptsPerRecTD"]
        + g("fumbles") * sc["ptsPerFumble"]
    )


def age_multiplier(pos: str, age, P: dict = DEFAULT_PARAMS) -> float:
    c = P["age"].get(pos)
    if not c or not age:
        return 1.0
    m = 1.0
    if age > c["declineStart"]:
        m -= (age - c["declineStart"]) * c["declinePerYear"]
    if c["youthPeak"] and age <= c["youthPeak"]:
        m += c["youthBonus"]
    return min(P["ageClamp"][1], max(P["ageClamp"][0], m))


def durability_mult(gp, table) -> float:
    for thresh, mult in table:
        if gp < thresh:
            return mult
    return 1.0


def rookie_projection(player: dict, sc: dict, PP: dict) -> float:
    market_pts = points(player.get("proj") or {}, sc)
    if market_pts > 0:
        return market_pts
    ceil = PP["rookieCeil"].get(player.get("pos"), 150)
    adp, ecr = player.get("adp"), player.get("ecr")
    rank = adp if (adp is not None and adp > 0) else (ecr if (ecr is not None and ecr > 0) else None)
    if rank is None:
        return ceil * PP["rookieAdpFloor"] * PP["rookieEraBonus"]
    frac = max(PP["rookieAdpFloor"], 1 - math.log(rank) / math.log(PP["rookieAdpSpan"]))
    return ceil * frac * PP["rookieEraBonus"]


def project_points(player: dict, sc: dict, P: dict = DEFAULT_PARAMS) -> dict:
    PP = P.get("projection") or DEFAULT_PARAMS["projection"]
    G = P["projectedGames"]

    def pace(season):
        if season and (season.get("gp") or 0) > 0:
            return (points(season, sc) / season["gp"]) * G
        return None

    pace1 = pace(player.get("last"))
    pace2 = pace(player.get("last2"))
    age_mult = age_multiplier(player.get("pos"), player.get("age"), P)

    if pace1 is None and pace2 is None:
        proj = _round1(rookie_projection(player, sc, PP) * age_mult)
        return {"proj": proj, "pace1": None, "pace2": None, "trend": None,
                "durMult": 1, "ageMult": age_mult, "rookie": True}

    trend = None
    if pace1 is not None and pace2 is not None:
        trend = pace1 - pace2
        w1 = PP["primaryWeight"]
        if trend > PP["trendThreshold"]:
            w1 = PP["primaryWeightUp"]
        elif trend < -PP["trendThreshold"]:
            w1 = PP["primaryWeightDown"]
        blended = w1 * pace1 + (1 - w1) * pace2
    else:
        blended = pace1 if pace1 is not None else pace2

    # JS `(a && a.gp) || (b && b.gp) || G` — falsy (0/None) falls through.
    gp = ((player.get("last") or {}).get("gp")
          or (player.get("last2") or {}).get("gp")
          or G)
    dur_mult = durability_mult(gp, PP["durability"])

    situ = (PP["fragileQbWrMult"]
            if player.get("pos") == "WR" and player.get("team") in (PP.get("fragileQbTeams") or [])
            else 1)

    proj = _round1(blended * dur_mult * age_mult * situ)
    return {"proj": proj, "pace1": pace1, "pace2": pace2, "trend": trend,
            "durMult": dur_mult, "ageMult": age_mult, "rookie": False}


def with_overrides(**overrides) -> dict:
    """A params copy with `projection.*` / top-level keys replaced — for grids."""
    P = copy.deepcopy(DEFAULT_PARAMS)
    for k, v in overrides.items():
        if k in P["projection"]:
            P["projection"][k] = v
        elif k in P:
            P[k] = v
        else:
            raise KeyError(f"unknown parameter: {k}")
    return P

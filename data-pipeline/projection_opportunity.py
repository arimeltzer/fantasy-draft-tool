"""
projection_opportunity.py — two-stage projection: volume x shrunk efficiency
==============================================================================
Roadmap Phase 1, steps 1.1/1.2. SHIPPED FOR TE ONLY — see the kill gate
result at the bottom of this docstring. QB/RB/WR were also swept and did not
clear the gate once measured against the ACTUAL live board (injury discount +
expert blend already shipped there); they stay on the points-pace model.

THE PROBLEM IT TARGETS
The shipped model reads last season's fantasy POINTS and blends them forward.
Points are volume x efficiency, and only one of those two repeats:
`projection_v2.py` already established that touchdown RATE is close to random
year over year while touchdown VOLUME (carries, targets) is not. This
generalizes that finding one level further: instead of patching shrunk
touchdowns onto the points-pace blend, it splits the projection into two
independent stages and shrinks the whole per-opportunity SCORING RATE (yards
and touchdowns together), not just the touchdown component.

Why the whole rate, not just touchdowns (v2's choice): v2's docstring reasons
that yards-per-opportunity is stable "over hundreds of events" — true for a
150-carry bellcow, not for a 40-target committee receiver. A single pooled
rate, shrunk by the SAME opportunity count that makes the touchdown estimate
noisy, treats the whole rate as one estimate of uncertain precision rather
than declaring the yardage half exempt by assumption.

WHAT IT DOES, two independent stages:

  1. VOLUME (`project_volume`) — next season's expected opportunities
     (carries+targets for RB, targets for WR/TE, attempts+carries for QB),
     blended from last/last2 season the same way project_points() already
     blends POINTS pace: trend-weighted two-season average, durability-
     discounted by games played. This is the SAME shipped blend shape,
     reused rather than re-derived, just aimed at a different total.

  2. EFFICIENCY (`league_efficiency` + the shrinkage in
     `project_points_opportunity`) — points per opportunity, shrunk toward
     the league rate for that position via the identical empirical-Bayes
     construction `projection_v2.py` uses for touchdown rate: k is the prior
     strength in multiples of a typical season's workload.

Final projection = volume_next x shrunk_efficiency x age multiplier. Age is
applied once, at the end, exactly where the shipped model applies it — not
also inside the volume stage, so aging is compared on equal footing rather
than double-counted.

FALLBACK. K/DST have no clean "opportunity" concept, and a true rookie has no
prior-season volume to project from either. Both keep the shipped model's
points-pace projection untouched (see `project_points_opportunity`) rather
than being forced through a stage that has nothing to work with.

NO LOOKAHEAD: `league_efficiency()` pools seasons strictly before the test
year, same discipline `projection_v2.league_rates()` already follows.

RESULT (docs/ROADMAP.md Phase 1). Swept 2017-2025, measured two ways:
against the pre-Phase-0 pure model (every other gate in this file's own
sweeps) AND against what is actually live (injury discount + expert blend +
anchor, at their shipped weights) — the question that decides what ships.
QB and WR passed the first measure and failed the second: their apparent
gain was mostly signal the expert blend (weighted 0.3/0.4 there, the two
highest) was already extracting, not something new. RB failed both,
landing within 0.0003 of v2's already-rejected RB result both times. TE
passed both — lowest expert-blend trust (0.2), no injury discount at all,
genuine room left. Shipped as `OPPORTUNITY_K = {"TE": 2.0}`, everything else
0 (see `frontend/src/engine/projection-opportunity.js`).

`_round1` (not plain `round()`) on the final `proj`, matching `toFixed(1)`
exactly — this function is now parity-tested
(`data-pipeline/opportunity_parity.py`) the same way `blend_expert`/
`injury_multiplier` are, so the rounding convention has to match theirs.
"""
from __future__ import annotations

from projection_model import _round1, age_multiplier, durability_mult, points, project_points

# Which season-line fields sum to "opportunities" for a position. Positions
# absent here (K, DST) have no clean volume concept and fall back untouched.
OPPORTUNITY_FIELDS = {
    "QB": ("attempts", "carries"),
    "RB": ("carries", "targets"),
    "WR": ("targets",),
    "TE": ("targets",),
}

# Shipped efficiency-shrinkage strength, per position — must match
# OPPORTUNITY_K in frontend/src/engine/projection-opportunity.js exactly.
# Only TE cleared the Phase 1 kill gate against the live board; everyone
# else is 0 (inert -- always falls back to the shipped points-pace model).
OPPORTUNITY_K = {"QB": 0.0, "RB": 0.0, "WR": 0.0, "TE": 2.0, "K": 0.0, "DST": 0.0}


def opportunity(line: dict | None, pos: str) -> float:
    """Total opportunities on one season line, for this position's fields."""
    fields = OPPORTUNITY_FIELDS.get(pos)
    if not line or not fields:
        return 0.0
    return sum(float(line.get(f) or 0) for f in fields)


def _trend_weight(pace1: float, pace2: float, PP: dict) -> float:
    trend = pace1 - pace2
    if trend > PP["trendThreshold"]:
        return PP["primaryWeightUp"]
    if trend < -PP["trendThreshold"]:
        return PP["primaryWeightDown"]
    return PP["primaryWeight"]


def project_volume(player: dict, P: dict) -> float | None:
    """Stage 1: next season's expected opportunities.

    Same blend shape `project_points()` uses for points pace (weight shifts
    with the trend, durability discounts by games played) — reused, not
    re-derived, because there is no separate evidence a DIFFERENT blend rule
    would suit volume better. Returns None for a position with no
    opportunity concept, or a player with no prior-season volume at all
    (true rookies keep the shipped model's own rookie handling).
    """
    pos = player.get("pos")
    if pos not in OPPORTUNITY_FIELDS:
        return None
    PP = P["projection"]
    G = P["projectedGames"]

    last, last2 = player.get("last"), player.get("last2")
    gp1 = (last or {}).get("gp") or 0
    gp2 = (last2 or {}).get("gp") or 0
    pace1 = (opportunity(last, pos) / gp1) * G if gp1 else None
    pace2 = (opportunity(last2, pos) / gp2) * G if gp2 else None
    if pace1 is None and pace2 is None:
        return None

    if pace1 is not None and pace2 is not None:
        w1 = _trend_weight(pace1, pace2, PP)
        blended = w1 * pace1 + (1 - w1) * pace2
    else:
        blended = pace1 if pace1 is not None else pace2

    gp = gp1 or gp2 or G
    return blended * durability_mult(gp, PP["durability"])


def league_efficiency(rows) -> dict:
    """Per position: pooled points-per-opportunity rate and typical
    workload, from seasons STRICTLY BEFORE the test year — the same
    no-lookahead discipline `projection_v2.league_rates()` follows, and the
    same reason: reading the test season here would leak the answer into the
    "prediction".

    `rows` is an iterable of (pos, line, scoring).
    """
    acc: dict[str, list] = {}
    for pos, line, sc in rows:
        if pos not in OPPORTUNITY_FIELDS:
            continue
        opp = opportunity(line, pos)
        if opp <= 0:
            continue
        a = acc.setdefault(pos, [0.0, 0.0, 0])
        a[0] += points(line, sc)
        a[1] += opp
        a[2] += 1
    return {pos: {"rate": pts / opp, "mean_opp": opp / n}
            for pos, (pts, opp, n) in acc.items() if opp > 0 and n > 0}


def _player_own_rate(player: dict, sc: dict, pos: str) -> tuple[float, float]:
    """(points, opportunities) pooled across whichever prior seasons the
    player has — the player's own empirical evidence, before shrinkage."""
    tot_pts = tot_opp = 0.0
    for line in (player.get("last"), player.get("last2")):
        if not line:
            continue
        o = opportunity(line, pos)
        if o > 0:
            tot_pts += points(line, sc)
            tot_opp += o
    return tot_pts, tot_opp


def project_points_opportunity(player: dict, sc: dict, rates: dict, k: float, P: dict) -> dict:
    """The two-stage projection: volume x shrunk efficiency x age.

    k is the efficiency prior strength (multiples of a typical season's
    workload, same units as v2's k). There is no k that reproduces
    `project_points()` exactly — unlike v2, which rewrites the INPUT line and
    so has a true k=0 identity, this replaces the blend shape itself, so k=0
    means "the player's own unshrunk rate", not "the shipped model".

    Falls back to `project_points()` untouched when there's no usable volume
    signal (K/DST, or a player with zero prior-season opportunities) — those
    keep whatever the shipped model already gives them.
    """
    pos = player.get("pos")
    vol = project_volume(player, P)
    own_pts, own_opp = _player_own_rate(player, sc, pos)
    r = rates.get(pos)

    if vol is None or vol <= 0 or own_opp <= 0 or not r:
        base = project_points(player, sc, P)
        return {**base, "volume": vol, "efficiency": None, "opportunity_based": False}

    n0 = k * r["mean_opp"]
    shrunk_rate = (own_pts + n0 * r["rate"]) / (own_opp + n0)
    age_mult = age_multiplier(pos, player.get("age"), P)
    # _round1, not plain round() — matches JS toFixed(1) exactly (half away
    # from zero on the true binary value), the same fix documented on
    # projection_model._round1 itself. Only `proj` needs this: it is the
    # only field the parity test (and the app) actually consumes.
    proj = _round1(vol * shrunk_rate * age_mult)
    return {
        "proj": proj, "volume": round(vol, 1), "efficiency": round(shrunk_rate, 4),
        "own_efficiency": round(own_pts / own_opp, 4), "ageMult": age_mult,
        "opportunity_based": True, "rookie": False,
    }

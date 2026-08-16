"""
projection_v2.py — stabilized inputs for the shipped projection
===============================================================
NOT shipped. An experiment the backtest scores against the real thing.

THE PROBLEM IT TARGETS
The shipped model reads last season's fantasy POINTS and carries them forward.
Points are the wrong thing to extrapolate, because they are dominated by
touchdowns and touchdowns barely repeat: a running back's carries are close to
the same number two years running, but his touchdowns per carry swing wildly on
sample sizes of 5-15 scores. Extrapolating last year's points therefore projects
last year's luck along with last year's talent.

The market makes the same mistake, and more loudly — ADP chases production, so a
back who scored 14 times gets drafted as though he will again. That is the
whole reason this is worth testing: a correction the market ALSO fails to make
is incremental signal, and incremental signal is the only kind a blend can use.
A refinement the market already prices in would improve the model's solo score
and still add nothing on top of ADP.

WHAT IT DOES
Rewrite each prior season's line before the projection sees it, replacing raw
touchdowns with volume x a shrunk scoring rate:

    shrunk_rate = (player_TDs + n0 * league_rate) / (player_opportunities + n0)
    expected_TDs = shrunk_rate * player_opportunities

This is standard empirical-Bayes shrinkage. n0 is the prior strength in units of
opportunities — the number of carries/targets of league-average evidence every
player is credited with before their own record counts. n0 = 0 is the shipped
model exactly; large n0 erases individual scoring ability entirely. It is swept
rather than assumed, because "how much of a high TD rate is real" is precisely
the empirical question and picking a number by feel would beg it.

Yardage is deliberately left alone: yards per carry and per target are already
volume-weighted averages over hundreds of events, so they are far more stable
than scoring rate and shrinking them would throw away real information.

NO LOOKAHEAD: league rates come from the seasons the model would have had at
draft time (strictly before the test year), computed by `league_rates()` and
passed in. Nothing here may read the season being predicted.
"""
from __future__ import annotations

import copy

# Which volume column gates which touchdown, per position-agnostic stat.
# (opportunity field on the season line, touchdown field on the season line)
TD_RATES = {
    "rush": ("carries", "rushTD"),
    "rec": ("targets", "recTD"),
    "pass": ("attempts", "passTD"),
}


def league_rates(rows) -> dict:
    """Per (position, stat): the league touchdown rate and a typical workload.

    `rows` is an iterable of (pos, line) for the seasons available at draft
    time. Pooled across those seasons: the rates are stable enough that pooling
    buys precision at negligible cost in staleness.

    `mean_opp` is carried because the prior strength has to be expressed in
    each stat's own units. 100 carries is most of a starting back's season,
    while 100 pass attempts is a fifth of a starting quarterback's — one raw n0
    swept across all three would shrink rushing hard and passing barely, and the
    sweep would be reading three different treatments as one number.
    """
    acc = {}
    for pos, line in rows:
        for stat, (opp_f, td_f) in TD_RATES.items():
            opp = line.get(opp_f) or 0
            if opp <= 0:
                continue
            a = acc.setdefault((pos, stat), [0.0, 0.0, 0])
            a[0] += line.get(td_f) or 0
            a[1] += opp
            a[2] += 1
    return {k: {"rate": td / opp, "mean_opp": opp / n}
            for k, (td, opp, n) in acc.items() if opp > 0 and n > 0}


def stabilize_line(line: dict | None, pos: str, rates: dict, k: float) -> dict | None:
    """A season line with touchdowns replaced by their shrunk expectation.

    `k` is the prior strength as a MULTIPLE of a typical season's workload for
    that position and stat: k = 1 means "weight league-average scoring as
    heavily as one full season of this player's own evidence", k = 0 leaves the
    line untouched — which is what makes the sweep's endpoint check possible.

    Returns a copy; the caller's line is never mutated.
    """
    if not line or k <= 0:
        return line
    out = copy.deepcopy(line)
    for stat, (opp_f, td_f) in TD_RATES.items():
        opp = line.get(opp_f) or 0
        r = rates.get((pos, stat))
        if opp <= 0 or not r:
            continue          # no volume, or a stat this position never records
        n0 = k * r["mean_opp"]
        td = line.get(td_f) or 0
        out[td_f] = ((td + n0 * r["rate"]) / (opp + n0)) * opp
    return out


def stabilize_player(player: dict, rates: dict, k: float) -> dict:
    """`player` with both prior seasons stabilized. Copy, not in place."""
    p = dict(player)
    pos = player.get("pos")
    p["last"] = stabilize_line(player.get("last"), pos, rates, k)
    p["last2"] = stabilize_line(player.get("last2"), pos, rates, k)
    return p

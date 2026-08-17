"""
team_context.py — roadmap 1.3: team change, QB change, coach change, pace.
============================================================================
Four candidate context signals, each swept and judged INDEPENDENTLY in
`projection_backtest.py` — the roadmap's own instruction ("measure each
feature's incremental contribution before adding it") rules out folding all
four into one combined adjustment, the same reason 0.3 ships per-position
K's instead of one shared number and 1.1/1.2 reports per-position instead of
a phase-wide verdict: a single passing sweep could hide three failing ideas
behind one real one.

WHAT'S BUILT HERE is pure data plumbing + a discount-multiplier shape (same
family as `injury_multiplier`/`durabilityMult`): a continuity disruption
(team/QB/coach changed) or a workload-driving team property (pace) SCALES
the existing projection; none of the four REPLACE it the way the opportunity
model does for TE, because unlike volume x efficiency this isn't a rebuilt
projection, it's a correction to the one that already exists.

DATA SOURCES, each checked before use — this project's rule about not
guessing undocumented mappings applies to features, not just column names:

  - team: `recent_team` from nflreadpy's `load_player_stats` (already loaded
    by `projection_backtest.load_seasons`) — the team a player's season
    stats are credited to. For a mid-season trade this is the team they
    ENDED the season on, not necessarily the one they started it on; used
    here as the "team entering the following season" proxy. Right for the
    large majority of players (no in-season trade at all); for the minority
    who moved mid-season, it BLURS their split rather than clarifying it —
    a bias against finding a team-change signal, not toward manufacturing
    one.

  - starting QB: within that same `load_player_stats` data, the QB with the
    most pass attempts on a team in a season (minimum `MIN_QB_ATTEMPTS`, so
    a token mop-up series can't crown a third-stringer). Spot-checked
    against known rosters (2022 CLE -> Jacoby Brissett, 2023 CLE -> Joe
    Flacco, 2023 HOU -> C.J. Stroud, etc.) and matched real depth charts.
    `qb_changed` compares the player's OWN Y-1 passer (`team_prev`'s
    attempts leader in Y-1) against `team_now`'s attempts leader in season
    Y itself — the SAME "season Y's own outcome as a preseason-knowable
    proxy" reasoning as coach_changed below, and for the same underlying
    reason: an incumbent-vs-Y-1 comparison on BOTH sides would be trivially
    unchanged whenever team_prev == team_now (comparing a team's Y-1 QB to
    itself), which would make qb_changed silently degenerate into
    team_changed and be unable to see the one case the roadmap actually
    names — a player who did NOT switch teams but whose OWN team got a new
    starter. Starting jobs are settled before the season the large majority
    of the time (camp battles are covered, ADP already prices in the
    presumed Week 1 starter); the exception is a competition resolved
    during the season itself (an injury, a rookie winning the job in
    Week 3), which is a similar order of rarity to coach_changed's
    in-season-firing exception.

  - head coach: `home_coach`/`away_coach` from nflreadpy's `load_schedules`,
    the modal name per (season, team) across that team's games — verified
    0% null and matching real coaching history for 2015-2024 (Belichick/NE,
    Tomlin/PIT, etc.). Coaching hires happen in the offseason and are public
    long before the season, so using season Y's own modal coach as the
    "coach entering Y" proxy is accurate the large majority of the time;
    the exception is a genuine in-season firing, which is rare enough
    (a handful of team-seasons across a decade) to be noise rather than a
    systematic leak.

  - pace: (pass attempts + rush carries + sacks suffered) / games played,
    per (season, team), from `load_team_stats` — a standard "plays run"
    workload proxy, not literal seconds-per-snap tempo (nflverse's free
    tables don't expose that). Verified numeric and in a realistic
    55-71 plays/game band across 2015-2024. Unlike team/QB/coach, this is
    read ONLY from `team_now`'s prior season (Y-1) — a team's OWN pace next
    season is exactly the thing being predicted, so using it directly would
    be the same look-ahead `league_rates`/`league_efficiency` are built to
    avoid; last year's pace is the honest, draft-time-knowable proxy.

  - offensive quality (roadmap 1.3 follow-up — nuancing team_change with
    WHERE a player landed, not just THAT he moved): (passing_epa +
    rushing_epa) / plays, per (season, team), from the same `load_team_stats`
    pull pace already uses. Spot-checked against 2023's known offenses —
    SF/BUF/DAL/MIA top the list, NYJ (Rodgers' Achilles in Q1)/CAR (Bryce
    Young's rookie year)/NE bottom it, matching real 2023 reputations exactly
    — so this is a real signal, not sourcing noise. `receiving_epa` is NOT
    added in — it's the same passing plays' EPA re-attributed to the
    receiver, not a separate category, and summing it in would double-count
    the passing game. Same zero-lookahead discipline as pace: read ONLY from
    team_now's prior season, expressed as a z-score against that season's
    league distribution (not a plain ratio — EPA straddles zero, so
    value/average is ill-defined near a near-zero league mean the way it
    isn't for pace, which is always positive).
"""
from __future__ import annotations

from collections import Counter

MIN_QB_ATTEMPTS = 20


def team_qb_by_season(rows) -> dict:
    """rows: iterable of objects with .season, .pos, .team, .player_id,
    .attempts. Returns {(season, team): player_id} — whoever led that team
    in attempts that season, at least MIN_QB_ATTEMPTS."""
    best: dict = {}
    for r in rows:
        if r.pos != "QB" or not r.team:
            continue
        att = getattr(r, "attempts", 0) or 0
        if att < MIN_QB_ATTEMPTS:
            continue
        key = (r.season, r.team)
        cur = best.get(key)
        if cur is None or att > cur[1]:
            best[key] = (r.player_id, att)
    return {k: v[0] for k, v in best.items()}


def team_coach_by_season(rows) -> dict:
    """rows: iterable of (season, home_team, home_coach, away_team, away_coach).
    Returns {(season, team): modal coach name} across that team's games."""
    counts: dict = {}
    for season, home_team, home_coach, away_team, away_coach in rows:
        for team, coach in ((home_team, home_coach), (away_team, away_coach)):
            if not team or not coach:
                continue
            counts.setdefault((season, team), Counter())[coach] += 1
    return {k: c.most_common(1)[0][0] for k, c in counts.items()}


def team_pace_by_season(rows) -> dict:
    """rows: iterable of (season, team, attempts, carries, sacks_suffered, games).
    Returns {(season, team): plays per game}."""
    out = {}
    for season, team, attempts, carries, sacks, games in rows:
        if not team or not games:
            continue
        plays = (attempts or 0) + (carries or 0) + (sacks or 0)
        out[(season, team)] = plays / games
    return out


def league_avg_pace(pace_by_team: dict, season: int):
    vals = [v for (s, _t), v in pace_by_team.items() if s == season]
    return sum(vals) / len(vals) if vals else None


def team_quality_by_season(rows) -> dict:
    """rows: iterable of (season, team, passing_epa, rushing_epa, attempts,
    carries, sacks_suffered, games). Returns {(season, team): offensive EPA
    per play} — passing_epa + rushing_epa only (receiving_epa is the same
    passing plays re-attributed to the receiver, not additional offense)."""
    out = {}
    for season, team, passing_epa, rushing_epa, attempts, carries, sacks, games in rows:
        if not team or not games:
            continue
        plays = (attempts or 0) + (carries or 0) + (sacks or 0)
        if not plays:
            continue
        out[(season, team)] = ((passing_epa or 0.0) + (rushing_epa or 0.0)) / plays
    return out


def league_quality_stats(quality_by_team: dict, season: int):
    """(mean, stdev) of offensive EPA/play across the league that season,
    for z-scoring one team against its actual peers — None, None when there
    is nothing to compute a spread from."""
    vals = [v for (s, _t), v in quality_by_team.items() if s == season]
    if len(vals) < 2:
        return None, None
    mean = sum(vals) / len(vals)
    var = sum((v - mean) ** 2 for v in vals) / (len(vals) - 1)
    return mean, var ** 0.5


QUALITY_Z_CLAMP = 2.0  # a team more than 2 sd from the mean is rare enough
                       # that the raw z shouldn't extrapolate further un-clamped


def context_flags(pos: str, team_prev, team_now, season_now: int,
                   qb_by_team: dict, coach_by_team: dict, pace_by_team: dict,
                   quality_by_team: dict | None = None) -> dict:
    """One player-season's raw signals. Each is None when not computable (a
    true rookie's team_prev is unknown, a team/QB pair below
    MIN_QB_ATTEMPTS, etc.) — the caller treats None as "no adjustment",
    the same coverage rule the rest of this pipeline uses throughout.
    """
    team_changed = (team_prev != team_now) if (team_prev and team_now) else None

    qb_changed = None
    if pos in ("RB", "WR", "TE") and team_prev and team_now:
        qb_prev = qb_by_team.get((season_now - 1, team_prev))
        qb_now = qb_by_team.get((season_now, team_now))
        if qb_prev and qb_now:
            qb_changed = qb_prev != qb_now

    coach_changed = None
    if team_prev and team_now:
        coach_prev = coach_by_team.get((season_now - 1, team_prev))
        coach_now = coach_by_team.get((season_now, team_now))
        if coach_prev and coach_now:
            coach_changed = coach_prev != coach_now

    pace_ratio = None
    if team_now:
        p = pace_by_team.get((season_now - 1, team_now))
        avg = league_avg_pace(pace_by_team, season_now - 1)
        if p and avg:
            pace_ratio = p / avg

    quality_z = None
    if team_now and quality_by_team is not None:
        q = quality_by_team.get((season_now - 1, team_now))
        mean, sd = league_quality_stats(quality_by_team, season_now - 1)
        if q is not None and mean is not None and sd:
            z = (q - mean) / sd
            quality_z = max(-QUALITY_Z_CLAMP, min(QUALITY_Z_CLAMP, z))

    return {"team_changed": team_changed, "qb_changed": qb_changed,
            "coach_changed": coach_changed, "pace_ratio": pace_ratio,
            "quality_z": quality_z}


def apply_flag_discount(projs, players, flags_by_id: dict, key: str, k: float):
    """multiplier = (1 - k) wherever flags_by_id[player_id][key] is True;
    untouched when False OR None (unknown is not "no change")."""
    out = []
    for p, proj in zip(players, projs):
        flagged = flags_by_id.get(p["player_id"], {}).get(key)
        out.append(proj * (1 - k) if flagged else proj)
    return out


def apply_pace(projs, players, flags_by_id: dict, k: float):
    """multiplier = 1 + k*(pace_ratio - 1); untouched when pace_ratio is None."""
    out = []
    for p, proj in zip(players, projs):
        r = flags_by_id.get(p["player_id"], {}).get("pace_ratio")
        out.append(proj * (1 + k * (r - 1)) if r is not None else proj)
    return out


# Bounds on the quality-nuanced multiplier itself, separate from the z clamp
# above — a defensive floor/ceiling so a large k can't invert a projection to
# near-zero or inflate it past what any k this small should plausibly do.
QUALITY_MULT_FLOOR = 0.4
QUALITY_MULT_CEIL = 1.3


def apply_team_change_quality(projs, players, flags_by_id: dict, k: float):
    """Nuances the flat team_changed discount with WHERE a player landed,
    not just THAT he moved: multiplier = 1 - k*(1 - quality_z). At
    quality_z=0 (a league-average destination) this is IDENTICAL to
    apply_flag_discount's flat (1-k) — a strict generalization, not a
    different feature. A below-average destination (negative z) pushes the
    discount deeper than flat; an above-average one shrinks it, and a
    strongly above-average one can flip it into a bonus (multiplier > 1).

    Only applies to a player who actually changed teams (team_changed is
    True) — untouched otherwise, same as apply_flag_discount. A mover with
    no quality_z available (destination quality couldn't be computed) falls
    back to quality_z=0, i.e. the flat discount — the move itself is still
    real signal even without a quality read on it, so this must not un-flag
    a player who apply_flag_discount would have discounted.
    """
    out = []
    for p, proj in zip(players, projs):
        flags = flags_by_id.get(p["player_id"], {})
        if not flags.get("team_changed"):
            out.append(proj)
            continue
        z = flags.get("quality_z")
        if z is None:
            z = 0.0
        mult = 1 - k * (1 - z)
        mult = max(QUALITY_MULT_FLOOR, min(QUALITY_MULT_CEIL, mult))
        out.append(proj * mult)
    return out

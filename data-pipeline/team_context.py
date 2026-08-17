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
    `qb_changed` compares each team's OWN prior-season passer only —
    `team_now`'s attempts leader in Y-1 against `team_prev`'s attempts
    leader in Y-1 — never season Y's own outcome, so it carries zero
    look-ahead. The cost is that it can't see a genuinely NEW Y starter
    (a rookie or free-agent signing) who has no Y-1 attempts for that team;
    it under-counts real QB changes rather than inventing ones that
    wouldn't have been knowable at draft time.

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


def context_flags(pos: str, team_prev, team_now, season_now: int,
                   qb_by_team: dict, coach_by_team: dict, pace_by_team: dict) -> dict:
    """One player-season's four raw signals. Each is None when not
    computable (a true rookie's team_prev is unknown, a team/QB pair below
    MIN_QB_ATTEMPTS, etc.) — the caller treats None as "no adjustment",
    the same coverage rule the rest of this pipeline uses throughout.
    """
    team_changed = (team_prev != team_now) if (team_prev and team_now) else None

    qb_changed = None
    if pos in ("RB", "WR", "TE") and team_prev and team_now:
        qb_prev = qb_by_team.get((season_now - 1, team_prev))
        qb_now = qb_by_team.get((season_now - 1, team_now))
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

    return {"team_changed": team_changed, "qb_changed": qb_changed,
            "coach_changed": coach_changed, "pace_ratio": pace_ratio}


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

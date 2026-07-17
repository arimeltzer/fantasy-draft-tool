"""
integrations/espn.py
===================
ESPN adapter. ESPN has no official fantasy API; this uses the same read host the
web app and community libraries use:

  https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{year}
      /segments/0/leagues/{leagueId}?view=mSettings&view=mTeam&view=mRoster&view=mDraftDetail

Public leagues need no auth. Private leagues need two cookies copied from a
logged-in browser: `espn_s2` and `SWID`. Network fetch is isolated in
`fetch_league`; all parsing is in pure functions so it can be fixture-tested.
"""
from __future__ import annotations

import httpx

from .base import DEFAULT_ROSTER, NormLeague, NormPlayer, NormTeam, make_settings

READ_HOST = "https://lm-api-reads.fantasy.espn.com"
VIEWS = ("mSettings", "mTeam", "mRoster", "mDraftDetail")

# ESPN proTeamId -> NFL abbreviation.
PRO_TEAM = {
    0: "", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
    8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR",
    15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI",
    22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WAS",
    29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
}
# defaultPositionId -> position bucket.
POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST"}
# lineupSlotId -> our roster bucket (None = ignore, e.g. IR/bench-of-bench).
SLOT = {
    0: "QB", 2: "RB", 4: "WR", 6: "TE", 17: "K", 16: "DST",
    23: "FLEX", 3: "FLEX", 5: "FLEX", 7: "SF", 20: "BENCH", 21: None, 24: "BENCH",
}
RECEPTION_STAT_ID = 53


def league_url(league_id: str, season: int) -> str:
    q = "&".join(f"view={v}" for v in VIEWS)
    return f"{READ_HOST}/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league_id}?{q}"


def _team_name(t: dict) -> str:
    if t.get("name"):
        return t["name"]
    nm = f"{t.get('location', '')} {t.get('nickname', '')}".strip()
    return nm or f"Team {t.get('id')}"


def parse_settings(data: dict) -> tuple[dict, str]:
    """Returns (app LeagueSettings dict, fmt)."""
    s = data.get("settings", {}) or {}
    size = s.get("size") or len(data.get("teams", []) or []) or 12

    # PPR from scoring items (reception statId 53).
    ppr = 0.0
    for item in (s.get("scoringSettings", {}) or {}).get("scoringItems", []) or []:
        if item.get("statId") == RECEPTION_STAT_ID:
            ppr = float(item.get("points", item.get("pointsOverrides", {}).get("16", 0)) or 0)
            break

    draft = s.get("draftSettings", {}) or {}
    fmt = "auction" if str(draft.get("type", "")).upper() == "AUCTION" else "snake"
    budget = int(draft.get("auctionBudget", 200) or 200)

    counts = (s.get("rosterSettings", {}) or {}).get("lineupSlotCounts", {}) or {}
    superflex = False
    if counts:
        # Build the roster entirely from the league's real slot counts (so a
        # league with, say, no kicker comes through as K:0 rather than a default).
        roster = {"QB": 0, "RB": 0, "WR": 0, "TE": 0, "FLEX": 0, "K": 0, "DST": 0,
                  "BENCH": 0, "SF": 0}
        for slot_id, n in counts.items():
            bucket = SLOT.get(int(slot_id))
            n = int(n or 0)
            if bucket is None or n == 0:
                continue
            if bucket == "SF":
                superflex = True
            roster[bucket] = roster.get(bucket, 0) + n  # accumulate (multiple flex slots)
    else:
        roster = dict(DEFAULT_ROSTER)

    settings = make_settings(teams=size, ppr=ppr, roster=roster, fmt=fmt,
                             budget=budget, superflex=superflex)
    return settings, fmt


def _draft_map(data: dict) -> dict[int, dict]:
    """playerId -> {bid, round} from the draft, for keeper-cost basis."""
    out: dict[int, dict] = {}
    for p in (data.get("draftDetail", {}) or {}).get("picks", []) or []:
        pid = p.get("playerId")
        if pid is None:
            continue
        bid = int(p["bidAmount"]) if p.get("bidAmount") is not None else None
        rnd = int(p["roundId"]) if p.get("roundId") is not None else None
        out[pid] = {"bid": bid, "round": rnd}
    return out


def parse_teams(data: dict, my_team: str | None) -> list[NormTeam]:
    draft = _draft_map(data)
    mine_key = (my_team or "").strip().lower()
    out: list[NormTeam] = []
    for t in data.get("teams", []) or []:
        name = _team_name(t)
        is_mine = bool(mine_key) and mine_key in (str(t.get("id")).lower(), name.lower())
        players: list[NormPlayer] = []
        for entry in (t.get("roster", {}) or {}).get("entries", []) or []:
            pl = (entry.get("playerPoolEntry", {}) or {}).get("player", {}) or {}
            pid = pl.get("id")
            d = draft.get(pid, {})
            players.append(NormPlayer(
                name=pl.get("fullName", "") or "",
                pos=POS.get(pl.get("defaultPositionId"), ""),
                team=PRO_TEAM.get(pl.get("proTeamId"), ""),
                ext_id=str(pid) if pid is not None else None,
                bid=d.get("bid"),
                round=d.get("round"),
            ))
        out.append(NormTeam(name=name, is_mine=is_mine, players=players))
    return out


def parse_league(data: dict, season: int, my_team: str | None = None) -> NormLeague:
    settings, fmt = parse_settings(data)
    teams = parse_teams(data, my_team)
    name = (data.get("settings", {}) or {}).get("name") or f"ESPN League {data.get('id', '')}"
    return NormLeague(provider="espn", ext_id=str(data.get("id", "")), name=name,
                      season=season, fmt=fmt, settings=settings, teams=teams)


async def fetch_league(league_id: str, season: int, espn_s2: str | None = None,
                       swid: str | None = None, my_team: str | None = None,
                       ca_bundle: str | None = None) -> NormLeague:
    cookies = {}
    if espn_s2 and swid:
        cookies = {"espn_s2": espn_s2, "SWID": swid if swid.startswith("{") else "{" + swid + "}"}
    verify = ca_bundle if ca_bundle else True
    async with httpx.AsyncClient(timeout=30, follow_redirects=True, trust_env=True,
                                 verify=verify, cookies=cookies,
                                 headers={"User-Agent": "Mozilla/5.0"}) as client:
        resp = await client.get(league_url(league_id, season))
        if resp.status_code in (401, 403):
            raise PermissionError("ESPN league is private — espn_s2 and SWID cookies required.")
        resp.raise_for_status()
        data = resp.json()
    if isinstance(data, list):  # ESPN sometimes wraps a single league in a list
        data = data[0]
    return parse_league(data, season, my_team)

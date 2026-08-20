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

import json
import time

import httpx

from .base import DEFAULT_ROSTER, DraftPickRow, NormLeague, NormPlayer, NormTeam, make_settings
from .live import LiveDraftState, LivePick, order_picks

READ_HOST = "https://lm-api-reads.fantasy.espn.com"
VIEWS = ("mSettings", "mTeam", "mRoster", "mDraftDetail")

# Player universe, used ONLY to name the draft picks whose players are no
# longer on any roster. Returns the same `player` object the rosters carry,
# so POS and PRO_TEAM below decode it unchanged.
PLAYER_INFO_VIEW = "kona_player_info"

# Headers ESPN's own web app sends. Some payloads (transaction/activity data in
# particular) are gated on the client identifying itself as the fantasy web app,
# so send the same set rather than a bare User-Agent.
SITE_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"),
    "accept": "application/json",
    "x-fantasy-source": "kona",
    "x-fantasy-platform": "espn-fantasy-web",
    "origin": "https://fantasy.espn.com",
    "referer": "https://fantasy.espn.com/",
}

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


# The exact view set ESPN's own web app requests when it renders the league's
# free-agent offers / transactions report. mTransactions2 returns nothing when
# asked for on its own — it only populates alongside these.
SITE_VIEWS = ("mDraftDetail", "mStatus", "mSettings", "mTeam", "mTransactions2",
              "modular", "mNav")
PLATFORM_VERSION = "780b95110927d72210293cc5dfe9d151165efd33"


# ESPN's site filters waiver history on WAIVER + WAIVER_ERROR (failed claims);
# FREEAGENT adds carry no bid. Executed-only is enforced when parsing.
WAIVER_TXN_FILTER = json.dumps(
    {"transactions": {"filterType": {"value": ["WAIVER", "WAIVER_ERROR"]}}})

# Transactions are scoped to a scoring period (week) — omit it and ESPN returns
# nothing at all, which is why plain mTransactions2 always looked empty.
MAX_SCORING_PERIOD = 18


def site_transactions_url(league_id: str, season: int, scoring_period: int | None = None,
                          platform: bool = True) -> str:
    """Mirror the request ESPN's site makes for the transactions report."""
    q = "&".join(f"view={v}" for v in SITE_VIEWS)
    if scoring_period is not None:
        q = f"scoringPeriodId={scoring_period}&{q}"
    if platform:
        q += f"&platformVersion={PLATFORM_VERSION}"
    return f"{READ_HOST}/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league_id}?{q}"


def transactions_url(league_id: str, season: int) -> str:
    return (f"{READ_HOST}/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/"
            f"{league_id}?view=mTransactions2")


def history_transactions_url(league_id: str, season: int) -> str:
    """Completed prior seasons often only answer on the leagueHistory host."""
    return (f"{READ_HOST}/apis/v3/games/ffl/leagueHistory/{league_id}"
            f"?seasonId={season}&view=mTransactions2")


def activity_url(league_id: str, season: int, history: bool = False) -> str:
    """ESPN football serves transactions through the league ACTIVITY feed.

    The `kona_league_communication` view is only valid on the league's
    `/communication/` sub-resource — requesting it on the base league URL 400s
    no matter what filter you send.
    """
    if history:
        return (f"{READ_HOST}/apis/v3/games/ffl/leagueHistory/{league_id}/communication/"
                f"?seasonId={season}&view={ACTIVITY_VIEW}")
    return (f"{READ_HOST}/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/"
            f"{league_id}/communication/?view={ACTIVITY_VIEW}")


ACTIVITY_VIEW = "kona_league_communication"
MSG_WAIVER_ADDED = 180   # FAAB claim: targetId=player, to=team, from=winning bid
ACTIVITY_PAGE = 25       # ESPN 400s on a larger limit for this feed
ACTIVITY_MAX_PAGES = 40  # -> up to 1000 topics (a full season of claims)


def activity_filters(size: int, offset: int) -> list[tuple[str, str]]:
    """x-fantasy-filter shapes for the activity feed.

    ESPN rejects `limit` without a sort ("FILTER_LIMIT_MISSING_SORT"), so every
    variant here carries sortMessageDate. On the `/communication/` sub-resource
    the filter root is `topics`; on the base league endpoint it is `communication`
    (ESPN enumerates the valid league roots as players / transactions /
    communication / schedule).
    """
    body = {
        "filterType": {"value": ["ACTIVITY_TRANSACTIONS"]},
        "limit": size,
        "offset": offset,
        "sortMessageDate": {"sortPriority": 1, "sortAsc": False},
    }
    typed = {**body, "filterIncludeMessageTypeIds": {"value": [MSG_WAIVER_ADDED]}}
    return [
        ("full", json.dumps({"topics": {
            **typed,
            "limitPerMessageSet": {"value": size},
            "sortFor": {"sortPriority": 2, "sortAsc": False},
        }})),
        ("typed", json.dumps({"topics": typed})),
        ("all-msgs", json.dumps({"topics": body})),
    ]


def base_activity_filters(size: int, offset: int) -> list[tuple[str, str]]:
    """Same feed via the BASE league endpoint, where the filter nests under
    `communication` (ESPN: CommunicationGroupFilterParams knows topics /
    topicsByType). Worth trying when the per-season /communication/ group is
    missing, as it is for completed seasons."""
    return [(f"base-{name}", json.dumps({"communication": json.loads(f)}))
            for name, f in activity_filters(size, offset)]


# ESPN is picky about the transaction filter and 400s on keys it doesn't know,
# so try the known-good shape first, then no filter, then the history endpoint.
TXN_FILTER = '{"transactions":{"filterType":{"value":["WAIVER","FREEAGENT"]}}}'


def _team_name(t: dict) -> str:
    if t.get("name"):
        return t["name"]
    nm = f"{t.get('location', '')} {t.get('nickname', '')}".strip()
    return nm or f"Team {t.get('id')}"


def raw_scoring_items(data: dict) -> list[dict]:
    """The league's full scoringItems, as ESPN sent them (statId/points/
    isReverseItem) — everything beyond the one stat (receptions, statId 53)
    this adapter maps automatically. ESPN's statId scheme for scoring rules is
    undocumented and not something we're confident enough to guess a full
    mapping for (guessing wrong here would mean silently incorrect valuations —
    worse than not mapping at all). Surfaced so the import report can point the
    user at Settings -> Scoring instead of pretending scoring was fully
    auto-detected, and so a future mapping can be calibrated from real evidence
    (the same way the waiver-transactions endpoint was worked out) rather than
    guesswork."""
    items = (data.get("settings", {}) or {}).get("scoringSettings", {}).get("scoringItems", []) or []
    return [
        {"statId": it.get("statId"), "points": it.get("points"),
         "isReverseItem": it.get("isReverseItem")}
        for it in items if it.get("statId") is not None
    ]


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


def parse_draft_picks(data: dict, pos_by_id: dict[int, dict] | None = None) -> list[DraftPickRow]:
    """EVERY pick of the draft, including players since dropped.

    `parse_teams` walks end-of-season rosters and attaches each player's draft
    price, so a player who was drafted and later cut never appears. That is the
    right list for keeper eligibility and the wrong one for learning what the
    room PAYS: the survivors skew toward the picks that worked, because
    expensive players get held and cheap busts get dropped.

    `draftDetail.picks` is the draft itself. It identifies players by id only,
    so name/pos/team are filled from the rosters where the player survived and
    from `pos_by_id` (a player-info lookup) where they did not. Unresolved
    picks are returned with `resolved=False` rather than dropped — the caller
    should know the sample is partial instead of quietly getting a smaller one.
    """
    roster_meta: dict[int, dict] = {}
    for t in data.get("teams", []) or []:
        owner = _team_name(t)
        for entry in (t.get("roster", {}) or {}).get("entries", []) or []:
            pl = (entry.get("playerPoolEntry", {}) or {}).get("player", {}) or {}
            pid = pl.get("id")
            if pid is None:
                continue
            roster_meta[pid] = {
                "name": pl.get("fullName", "") or "",
                "pos": POS.get(pl.get("defaultPositionId"), ""),
                "team": PRO_TEAM.get(pl.get("proTeamId"), ""),
                "owner": owner,
            }

    team_names = {t.get("id"): _team_name(t) for t in (data.get("teams", []) or [])}
    out: list[DraftPickRow] = []
    for p in (data.get("draftDetail", {}) or {}).get("picks", []) or []:
        pid = p.get("playerId")
        if pid is None:
            continue
        meta = roster_meta.get(pid) or (pos_by_id or {}).get(pid) or {}
        out.append(DraftPickRow(
            ext_id=str(pid),
            name=meta.get("name", "") or "",
            pos=meta.get("pos", "") or "",
            team=meta.get("team", "") or "",
            bid=int(p["bidAmount"]) if p.get("bidAmount") is not None else None,
            round=int(p["roundId"]) if p.get("roundId") is not None else None,
            # Who drafted him, which is NOT who ended up rostering him.
            owner=team_names.get(p.get("teamId"), "") or "",
            resolved=bool(meta.get("pos")),
        ))
    return out


def history_league_url(league_id: str, season: int) -> str:
    """A completed season's league payload.

    ESPN retires old seasons off the per-season path onto `leagueHistory`, as
    the transactions code already discovered. Callers should try the ordinary
    URL first and fall back here, since which one answers depends on how long
    ago the season was and ESPN does not document the cutover.
    """
    q = "&".join(f"view={v}" for v in VIEWS)
    return (f"{READ_HOST}/apis/v3/games/ffl/leagueHistory/{league_id}"
            f"?seasonId={season}&{q}")


def unresolved_pick_ids(picks: list[DraftPickRow]) -> list[int]:
    """Player ids from the draft that no roster could name — the dropped ones."""
    return [int(p.ext_id) for p in picks if not p.resolved and p.ext_id.isdigit()]


def player_info_url(league_id: str, season: int) -> str:
    """League-scoped player universe. Same `player` object shape the rosters
    already use (fullName / defaultPositionId / proTeamId), so the existing POS
    and PRO_TEAM maps apply unchanged — which is the reason to prefer this view
    over any other player endpoint."""
    return (f"{READ_HOST}/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league_id}"
            f"?view={PLAYER_INFO_VIEW}")


def player_info_filter(ids: list[int]) -> str:
    """`x-fantasy-filter` header value selecting just the ids we're missing."""
    return json.dumps({"players": {"filterIds": {"value": [int(i) for i in ids]}}})


def parse_player_info(payload: dict | list) -> dict[int, dict]:
    """id -> {name, pos, team} from a kona_player_info response.

    Accepts both shapes ESPN returns: `{"players": [{"player": {...}}]}` and a
    bare list of the same entries.
    """
    entries = payload.get("players", []) if isinstance(payload, dict) else (payload or [])
    out: dict[int, dict] = {}
    for e in entries or []:
        pl = (e or {}).get("player", {}) or {}
        pid = pl.get("id", (e or {}).get("id"))
        if pid is None:
            continue
        out[int(pid)] = {
            "name": pl.get("fullName", "") or "",
            "pos": POS.get(pl.get("defaultPositionId"), ""),
            "team": PRO_TEAM.get(pl.get("proTeamId"), ""),
        }
    return out


def _topics(data: dict) -> list:
    """Activity topics, from either response shape: the /communication/ endpoint
    returns {"topics": [...]}; the base league endpoint nests them under
    {"communication": {"topics": [...]}}."""
    if isinstance(data.get("topics"), list):
        return data["topics"]
    comm = data.get("communication")
    if isinstance(comm, dict) and isinstance(comm.get("topics"), list):
        return comm["topics"]
    return []


def _waiver_map_from_topics(data: dict) -> dict[int, int]:
    """playerId -> highest FAAB bid, read from ESPN's league ACTIVITY feed.

    For football ESPN serves transactions as `topics` (view=kona_league_
    communication), not the `transactions` array. Each topic holds messages; a
    successful FAAB waiver claim is messageTypeId 180, where `targetId` is the
    player, `to` is the claiming team and `from` is the winning bid. Straight
    free-agent adds (178) have no bid, so they're skipped.
    """
    out: dict[int, int] = {}
    for topic in _topics(data):
        for msg in topic.get("messages", []) or []:
            if msg.get("messageTypeId") != MSG_WAIVER_ADDED:
                continue
            pid = msg.get("targetId")
            if pid is None:
                continue
            try:
                bid = int(msg.get("from") or 0)
            except (TypeError, ValueError):
                bid = 0
            if bid > 0 and bid > out.get(pid, 0):
                out[pid] = bid
    return out


def _waiver_map(data: dict) -> dict[int, int]:
    """playerId -> the highest FAAB/waiver bid spent to ACQUIRE that player,
    across executed waiver/free-agent transactions. Keeper leagues often set a
    keeper's cost to the higher of his draft value and his waiver claim, so this
    is the waiver-claim basis. Non-FAAB (priority-order) claims have no dollar
    value and are ignored (bid 0/None)."""
    out: dict[int, int] = {}
    for txn in data.get("transactions", []) or []:
        status = str(txn.get("status", "") or "").upper()
        if status and status != "EXECUTED":
            continue
        bid = txn.get("bidAmount")
        try:
            bid = int(bid) if bid is not None else 0
        except (TypeError, ValueError):
            bid = 0
        if bid <= 0:
            continue
        for item in txn.get("items", []) or []:
            if str(item.get("type", "") or "").upper() != "ADD":
                continue
            pid = item.get("playerId")
            if pid is None:
                continue
            if bid > out.get(pid, 0):
                out[pid] = bid
    return out


def all_waivers(data: dict) -> dict[int, int]:
    """Merge both waiver sources (activity topics + transactions), keeping the
    highest bid seen per player."""
    merged = dict(_waiver_map(data))
    for pid, bid in _waiver_map_from_topics(data).items():
        if bid > merged.get(pid, 0):
            merged[pid] = bid
    return merged


def parse_teams(data: dict, my_team: str | None) -> list[NormTeam]:
    draft = _draft_map(data)
    waivers = all_waivers(data)
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
                waiver=waivers.get(pid),
            ))
        out.append(NormTeam(name=name, is_mine=is_mine, players=players))
    return out


def parse_live_draft(data: dict, my_team: str | None = None,
                     pos_by_id: dict[int, dict] | None = None) -> LiveDraftState:
    """Join `draftDetail.picks` (order/owner/price) to the rosters (names).

    `mDraftDetail` fills in as the draft runs, but identifies players only by
    ESPN's numeric id, so names come from the roster entries — a drafted player
    is on a roster. Verified against a real in-progress draft (pick 57 on the
    board): the roster view can lag the WHOLE draft, not just "briefly" as the
    original comment assumed — every pick was unresolved. Same survivorship
    problem `parse_draft_picks` already solved for end-of-season rosters, same
    fix: `pos_by_id` (a `kona_player_info` lookup, player-universe-wide rather
    than roster-scoped) fills in where the roster hasn't caught up. A pick
    resolved by neither is still skipped — the next poll, or the next top-up,
    gets it — never guessed at.
    """
    teams_by_id = {t.get("id"): _team_name(t) for t in data.get("teams", []) or []}
    mine_key = (my_team or "").strip().lower()
    mine_ids = {
        t.get("id") for t in data.get("teams", []) or []
        if mine_key and mine_key in (str(t.get("id")).lower(), _team_name(t).lower())
    }

    players: dict[int, dict] = {}
    for t in data.get("teams", []) or []:
        for entry in (t.get("roster", {}) or {}).get("entries", []) or []:
            pl = (entry.get("playerPoolEntry", {}) or {}).get("player", {}) or {}
            if pl.get("id") is not None:
                players[pl["id"]] = {
                    "name": pl.get("fullName", "") or "",
                    "pos": POS.get(pl.get("defaultPositionId"), ""),
                    "team": PRO_TEAM.get(pl.get("proTeamId"), ""),
                }

    size = int((data.get("settings", {}) or {}).get("size") or 0)
    picks: list[LivePick] = []
    for p in (data.get("draftDetail", {}) or {}).get("picks", []) or []:
        pl = players.get(p.get("playerId")) or (pos_by_id or {}).get(p.get("playerId"))
        if not pl or not pl["name"]:
            continue
        overall = p.get("overallPickNumber")
        if not overall and size and p.get("roundId") and p.get("roundPickNumber"):
            overall = (int(p["roundId"]) - 1) * size + int(p["roundPickNumber"])
        if not overall:
            continue
        tid = p.get("teamId")
        picks.append(LivePick(
            overall=int(overall),
            name=pl["name"], pos=pl["pos"], team=pl["team"],
            round=int(p["roundId"]) if p.get("roundId") else None,
            owner=teams_by_id.get(tid),
            is_mine=tid in mine_ids,
            bid=int(p["bidAmount"]) if p.get("bidAmount") is not None else None,
        ))

    state = LiveDraftState(picks=order_picks(picks),
                           fmt="auction" if any(p.bid for p in picks) else "snake")
    raw_picks = (data.get("draftDetail", {}) or {}).get("picks", []) or []
    # `raw_picks` can include placeholder rows for slots that haven't been
    # picked yet (seen with playerId <= 0 on a live, in-progress draft) — a
    # completed draft never has these, which is why the older draft-history
    # code this was adapted from never needed to filter them out. Counting
    # them as "drafted" wildly overstates progress (a 10-team/16-round league
    # showed "160 drafted" from pick 1 on) and pollutes the kona_player_info
    # top-up's id list with junk ids.
    real_picks = [p for p in raw_picks if isinstance(p.get("playerId"), int) and p["playerId"] > 0]
    state.meta = {"drafted": len(real_picks),
                  "resolved": len(picks),
                  "in_progress": bool((data.get("draftDetail", {}) or {}).get("inProgress")),
                  "raw_pick_slots": len(raw_picks),
                  # Temporary diagnostic: `drafted == 0` with real picks on the
                  # board (verified against a real league at pick 57+) means
                  # the playerId>0 filter above is wrong for this payload shape
                  # in some way not yet seen — a handful of raw entries as-is
                  # is the fastest way to find out without guessing again.
                  "sample": raw_picks[:3]}
    return state


def parse_league(data: dict, season: int, my_team: str | None = None,
                 pos_by_id: dict[int, dict] | None = None) -> NormLeague:
    settings, fmt = parse_settings(data)
    teams = parse_teams(data, my_team)
    name = (data.get("settings", {}) or {}).get("name") or f"ESPN League {data.get('id', '')}"
    return NormLeague(provider="espn", ext_id=str(data.get("id", "")), name=name,
                      season=season, fmt=fmt, settings=settings, teams=teams,
                      draft_picks=parse_draft_picks(data, pos_by_id))


async def fetch_raw_league(league_id: str, season: int, espn_s2: str | None = None,
                          swid: str | None = None, ca_bundle: str | None = None) -> dict:
    """One request for the league payload — settings, teams, rosters, draft.

    Deliberately NOT `fetch_league`: that also sweeps 18 weeks of transactions
    for keeper waiver costs, which is right once and abusive on a poll loop.
    Live sync needs only the draft board, so it pays for exactly one call.

    `lm-api-reads` sits behind a CDN — verified against a real in-progress
    auction draft where every poll came back with round 1 pick 1 STILL
    showing `playerId: -1` well past pick 57, on every retry, across a span
    of minutes: a frozen edge-cached snapshot, not a slow-to-update roster
    view (that theory is what the earlier `kona_player_info` top-up assumed,
    and it doesn't apply here — there was nothing stale to top up, the
    picks array itself was stale). Cache-busted with a per-request
    timestamp query param plus explicit no-cache headers, live-sync only —
    `fetch_league`'s once-per-import calls don't need it and don't get it.
    """
    cookies = {}
    if espn_s2 and swid:
        cookies = {"espn_s2": espn_s2, "SWID": swid if swid.startswith("{") else "{" + swid + "}"}
    verify = ca_bundle if ca_bundle else True
    headers = {**SITE_HEADERS, "Cache-Control": "no-cache, no-store", "Pragma": "no-cache"}
    url = league_url(league_id, season) + f"&_={int(time.time() * 1000)}"
    async with httpx.AsyncClient(timeout=20, follow_redirects=True, trust_env=True,
                                 verify=verify, cookies=cookies, headers=headers) as client:
        resp = await client.get(url)
        if resp.status_code in (401, 403):
            raise PermissionError("ESPN league is private — espn_s2 and SWID cookies required.")
        resp.raise_for_status()
        data = resp.json()
    return data[0] if isinstance(data, list) and data else data


async def fetch_and_resolve_live_draft(league_id: str, season: int, espn_s2: str | None = None,
                                       swid: str | None = None, my_team: str | None = None,
                                       ca_bundle: str | None = None) -> LiveDraftState:
    """`fetch_raw_league` + `parse_live_draft`, with a best-effort
    `kona_player_info` top-up for whatever the roster view didn't resolve.

    `parse_live_draft`'s own header explains why this exists: verified against
    a real in-progress draft where the roster view had resolved NONE of the
    picks already made, not just the "briefly" lagging one or two the original
    code assumed. Same survivorship problem `fetch_league`'s draft-history path
    already solved for end-of-season rosters (`unresolved_pick_ids` +
    `player_info_url`), reused here rather than reinvented. Best-effort: a
    failed top-up returns the roster-only state rather than losing the poll.
    """
    data = await fetch_raw_league(league_id, season, espn_s2=espn_s2, swid=swid, ca_bundle=ca_bundle)
    state = parse_live_draft(data, my_team=my_team)
    if state.meta.get("drafted", 0) <= state.meta.get("resolved", 0):
        return state  # rosters already named everyone drafted so far

    roster_ids = {
        pl["id"] for t in data.get("teams", []) or []
        for entry in (t.get("roster", {}) or {}).get("entries", []) or []
        for pl in [(entry.get("playerPoolEntry", {}) or {}).get("player", {}) or {}]
        if pl.get("id") is not None
    }
    all_ids = {
        p.get("playerId") for p in (data.get("draftDetail", {}) or {}).get("picks", []) or []
        if isinstance(p.get("playerId"), int) and p["playerId"] > 0
    }
    missing = sorted(all_ids - roster_ids)
    diag = {"lookup_attempted": len(missing), "lookup_found": 0, "lookup_status": "skipped"}
    if not missing:
        state.meta["lookup"] = diag
        return state

    cookies = {}
    if espn_s2 and swid:
        cookies = {"espn_s2": espn_s2, "SWID": swid if swid.startswith("{") else "{" + swid + "}"}
    verify = ca_bundle if ca_bundle else True
    found: dict[int, dict] = {}
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, trust_env=True,
                                     verify=verify, cookies=cookies, headers=SITE_HEADERS) as client:
            for i in range(0, len(missing), 200):
                chunk = missing[i:i + 200]
                pr = await client.get(
                    player_info_url(league_id, season),
                    headers={"x-fantasy-filter": player_info_filter(chunk)})
                diag["lookup_status"] = pr.status_code
                if pr.status_code != 200:
                    break
                found.update(parse_player_info(pr.json()))
                diag["lookup_status"] = "ok"
    except Exception as exc:  # noqa: BLE001 — the top-up is optional, the poll is not
        diag["lookup_status"] = f"error:{type(exc).__name__}"
    diag["lookup_found"] = len(found)
    if not found:
        state.meta["lookup"] = diag
        return state
    resolved = parse_live_draft(data, my_team=my_team, pos_by_id=found)
    resolved.meta["lookup"] = diag
    return resolved


async def fetch_league(league_id: str, season: int, espn_s2: str | None = None,
                       swid: str | None = None, my_team: str | None = None,
                       ca_bundle: str | None = None) -> NormLeague:
    cookies = {}
    if espn_s2 and swid:
        cookies = {"espn_s2": espn_s2, "SWID": swid if swid.startswith("{") else "{" + swid + "}"}
    verify = ca_bundle if ca_bundle else True
    async with httpx.AsyncClient(timeout=30, follow_redirects=True, trust_env=True,
                                 verify=verify, cookies=cookies,
                                 headers=SITE_HEADERS) as client:
        resp = await client.get(league_url(league_id, season))
        if resp.status_code in (401, 403):
            raise PermissionError("ESPN league is private — espn_s2 and SWID cookies required.")
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, list):  # ESPN sometimes wraps a single league in a list
            data = data[0]

        # Best-effort: pull waiver/FAAB transactions so keeper costs can use the
        # higher of draft vs. waiver. Never let this break the core import.
        txn_diag: dict = {"source": None, "attempts": []}
        if "transactions" in data:
            txn_diag["source"] = "league"

        # PRIMARY: the transactions array, exactly as ESPN's own site fetches it.
        # Two details matter and both were missing before — transactions are
        # scoped to a scoringPeriodId (week), and the filter is WAIVER +
        # WAIVER_ERROR. Without the week param ESPN returns nothing at all.
        if not data.get("transactions"):
            hdrs = {"x-fantasy-filter": WAIVER_TXN_FILTER}
            collected: dict = {}          # id -> txn (dedupe across weeks)

            async def _week(sp: int | None) -> int:
                url = site_transactions_url(league_id, season, scoring_period=sp)
                try:
                    tr = await client.get(url, headers=hdrs)
                except Exception as e:  # noqa: BLE001 — waiver data is optional
                    txn_diag["attempts"].append(f"sp{sp}:{type(e).__name__}")
                    return 0
                if tr.status_code != 200:
                    txn_diag["attempts"].append(f"sp{sp}:HTTP {tr.status_code}")
                    return 0
                tj = tr.json()
                if isinstance(tj, list):
                    tj = tj[0] if tj else {}
                found = tj.get("transactions") or []
                for t in found:
                    collected[t.get("id") or id(t)] = t
                return len(found)

            # scoringPeriodId=0 sometimes returns the whole season in one call.
            if await _week(0):
                txn_diag["source"] = "transactions/sp0"
            else:
                for sp in range(1, MAX_SCORING_PERIOD + 1):
                    await _week(sp)
                if collected:
                    txn_diag["source"] = "transactions/weekly"
            if collected:
                data["transactions"] = list(collected.values())
                txn_diag["attempts"].append(f"transactions:{len(collected)} txns")

        # FALLBACK: the league ACTIVITY feed (works for a live season; ESPN
        # deletes the communication group once a season completes).
        if not _topics(data) and not data.get("transactions"):
            routes = [
                # The /communication/ sub-resource (works for the live season).
                ("activity", activity_url(league_id, season), activity_filters),
                # The base league endpoint, filter nested under `communication` —
                # a route that doesn't depend on the per-season communication
                # group, which ESPN deletes for completed seasons.
                ("base-comm", league_url(league_id, season).split("?")[0] + f"?view={ACTIVITY_VIEW}",
                 base_activity_filters),
                ("activity-history", activity_url(league_id, season, history=True), activity_filters),
            ]
            for label, url, filters in routes:
                # Negotiate a filter shape ESPN accepts, using page 0 as the probe.
                shape, topics = None, []
                for name, filt in filters(ACTIVITY_PAGE, 0):
                    try:
                        ar = await client.get(url, headers={"x-fantasy-filter": filt})
                    except Exception as e:  # noqa: BLE001 — waiver data is optional
                        txn_diag["attempts"].append(f"{label}/{name}:{type(e).__name__}")
                        continue
                    if ar.status_code != 200:
                        txn_diag["attempts"].append(f"{label}/{name}:HTTP {ar.status_code}")
                        continue
                    aj = ar.json()
                    if isinstance(aj, list):
                        aj = aj[0] if aj else {}
                    topics = _topics(aj)
                    shape = name
                    txn_diag["attempts"].append(f"{label}/{name}:{len(topics)} topics")
                    break
                if shape is None:
                    continue

                # Page through the rest with the shape that worked.
                try:
                    if len(topics) >= ACTIVITY_PAGE:
                        for page in range(1, ACTIVITY_MAX_PAGES):
                            filt = dict(filters(ACTIVITY_PAGE, page * ACTIVITY_PAGE))[shape]
                            ar = await client.get(url, headers={"x-fantasy-filter": filt})
                            if ar.status_code != 200:
                                break
                            aj = ar.json()
                            if isinstance(aj, list):
                                aj = aj[0] if aj else {}
                            batch = _topics(aj)
                            topics.extend(batch)
                            if len(batch) < ACTIVITY_PAGE:
                                break
                except Exception as e:  # noqa: BLE001 — partial pages are fine
                    txn_diag["attempts"].append(f"{label}/paging:{type(e).__name__}")

                if topics:
                    data["topics"] = topics
                    txn_diag["source"] = f"{label}/{shape}"
                    txn_diag["attempts"].append(f"{label}:{len(topics)} topics total")
                    break

        # Name the draft picks whose players are no longer on any roster.
        #
        # Without this the draft list is only as complete as the rosters, which
        # is the survivorship problem it exists to fix. Best-effort in exactly
        # the same sense as the waiver sweep above: a failure here costs
        # calibration accuracy and must never cost the import, so every error
        # is recorded and swallowed.
        draft_diag: dict = {"resolved_from_rosters": 0, "looked_up": 0, "attempts": []}
        pos_lookup: dict[int, dict] | None = None
        try:
            provisional = parse_draft_picks(data)
            draft_diag["picks"] = len(provisional)
            draft_diag["resolved_from_rosters"] = sum(1 for p in provisional if p.resolved)
            missing = unresolved_pick_ids(provisional)
            if missing:
                found: dict[int, dict] = {}
                # Chunked: the filter goes in a header, and a whole draft's
                # worth of ids in one header is asking to be rejected.
                for i in range(0, len(missing), 200):
                    chunk = missing[i:i + 200]
                    pr = await client.get(
                        player_info_url(league_id, season),
                        headers={"x-fantasy-filter": player_info_filter(chunk)})
                    if pr.status_code != 200:
                        draft_diag["attempts"].append(f"players:HTTP {pr.status_code}")
                        break
                    found.update(parse_player_info(pr.json()))
                draft_diag["looked_up"] = len(found)
                if found:
                    pos_lookup = found
        except Exception as e:  # noqa: BLE001 — draft completeness is optional
            draft_diag["attempts"].append(f"players:{type(e).__name__}")

    lg = parse_league(data, season, my_team, pos_lookup)
    draft_diag["unresolved"] = sum(1 for p in lg.draft_picks if not p.resolved)
    lg.meta["draft"] = draft_diag
    waivers = all_waivers(data)
    lg.meta["transactions"] = {
        **txn_diag,
        "count": len(_topics(data)) or len(data.get("transactions", []) or []),
        "waiver_players": len(waivers),
        "max_bid": max(waivers.values()) if waivers else 0,
    }
    raw_items = raw_scoring_items(data)
    lg.meta["scoring"] = {
        "auto_mapped": ["ptsPerRec"],       # only PPR — see raw_scoring_items()
        "raw_rule_count": len(raw_items),
        "raw": raw_items,
    }
    return lg


async def probe_activity(league_id: str, season: int, espn_s2: str | None = None,
                         swid: str | None = None, ca_bundle: str | None = None) -> list[dict]:
    """Diagnostic: try every plausible way to reach the transaction/activity feed
    and report what ESPN actually returns for each (status, top-level JSON keys,
    a short body snippet). Read-only; used to settle where FAAB history lives
    for a given league instead of guessing one deploy at a time."""
    cookies = {}
    if espn_s2 and swid:
        cookies = {"espn_s2": espn_s2, "SWID": swid if swid.startswith("{") else "{" + swid + "}"}
    base = f"{READ_HOST}/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league_id}"
    hist = f"{READ_HOST}/apis/v3/games/ffl/leagueHistory/{league_id}"
    cur = f"{READ_HOST}/apis/v3/games/ffl/seasons/{season + 1}/segments/0/leagues/{league_id}"
    # ESPN: "Limit request must be accompanied by a sort" — every limited filter
    # must carry one.
    activity_body = {
        "filterType": {"value": ["ACTIVITY_TRANSACTIONS"]},
        "limit": 25, "offset": 0,
        "sortMessageDate": {"sortPriority": 1, "sortAsc": False},
    }
    sorted_topics = json.dumps({"topics": activity_body})
    comm_root = json.dumps({"communication": activity_body})
    txn_filter = json.dumps({"transactions": {"filterType": {"value": ["WAIVER", "FREEAGENT"]}}})
    txn_root = json.dumps({"transactions": {
        "filterType": {"value": ["WAIVER", "FREEAGENT"]},
        "limit": 100, "offset": 0,
        "sortDate": {"sortPriority": 1, "sortAsc": False},
    }})
    comm_nested = json.dumps({"communication": {"topics": activity_body}})
    # topicsByType is a Map keyed by TopicType (ESPN enumerated the valid keys:
    # CHAT, ACTIVITY_TRANSACTIONS, MSG_BOARD, ...), not a filter object.
    comm_by_type = json.dumps({"communication": {
        "topicsByType": {"ACTIVITY_TRANSACTIONS": {
            "limit": 25, "offset": 0,
            "sortMessageDate": {"sortPriority": 1, "sortAsc": False},
        }}}})
    candidates = [
        # EXACT replica of the request ESPN's site makes for the transactions
        # report (mTransactions2 only populates alongside these views).
        ("SITE replica (exact)", site_transactions_url(league_id, season), None),
        ("SITE replica + txn filter", site_transactions_url(league_id, season), txn_filter),
        ("SITE replica no platformVersion", site_transactions_url(league_id, season, platform=False), None),
        ("league+mTeam (auth sanity)", f"{base}?view=mTeam", None),
        # Sub-resource + nested-filter alternatives.
        ("SUB /transactions/ + txn filter", f"{base}/transactions/?view=mTransactions2", txn_root),
        ("base + communication.topics", f"{base}?view={ACTIVITY_VIEW}", comm_nested),
        ("base + communication.topicsByType", f"{base}?view={ACTIVITY_VIEW}", comm_by_type),
        ("base mTransactions2 alone (known empty)", f"{base}?view=mTransactions2", txn_root),
        (f"comm/ CURRENT {season + 1} (control)", f"{cur}/communication/?view={ACTIVITY_VIEW}", sorted_topics),
    ]
    # Transaction/FAAB history is league-member data; without cookies ESPN serves
    # the public subset (settings/teams/draft) and silently omits transactions.
    out: list[dict] = [{"probe": "AUTH", "cookies_sent": bool(cookies),
                        "note": ("authenticated request" if cookies else
                                 "NO espn_s2/SWID cookies — transactions are likely "
                                 "omitted for that reason")}]
    verify = ca_bundle if ca_bundle else True
    async with httpx.AsyncClient(timeout=20, follow_redirects=True, trust_env=True,
                                 verify=verify, cookies=cookies,
                                 headers=SITE_HEADERS) as client:
        for label, url, filt in candidates:
            row: dict = {"probe": label, "url": url.replace(str(league_id), "<league>")}
            try:
                hdrs = {"x-fantasy-filter": filt} if filt else {}
                r = await client.get(url, headers=hdrs)
                row["status"] = r.status_code
                if r.status_code == 200:
                    try:
                        j = r.json()
                        if isinstance(j, list):
                            j = j[0] if j else {}
                        row["keys"] = sorted(j.keys())[:25] if isinstance(j, dict) else type(j).__name__
                        for k in ("topics", "transactions", "communication", "pendingTransactions"):
                            v = j.get(k) if isinstance(j, dict) else None
                            if isinstance(v, list):
                                row[f"{k}_len"] = len(v)
                                if v:
                                    # Full first record: we need the exact field
                                    # carrying the FAAB amount to map it.
                                    row[f"{k}_sample"] = str(v[0])[:900]
                                    bids = [t for t in v if isinstance(t, dict) and t.get("bidAmount")]
                                    row[f"{k}_with_bid"] = len(bids)
                                    if bids:
                                        row[f"{k}_bid_sample"] = str(bids[0])[:900]
                            elif isinstance(v, dict):
                                row[f"{k}_keys"] = sorted(v.keys())[:15]
                    except Exception:  # noqa: BLE001
                        row["body"] = r.text[:700]
                else:
                    row["body"] = r.text[:700]
            except Exception as e:  # noqa: BLE001
                row["error"] = f"{type(e).__name__}: {e}"[:300]
            out.append(row)
    return out


async def fetch_draft_history(league_id: str, seasons: list[int],
                              espn_s2: str | None = None, swid: str | None = None,
                              ca_bundle: str | None = None) -> dict:
    """Draft results for several past seasons of the same league.

    WHY MORE THAN ONE. Auction calibration learns how a room's money splits
    across positions. One draft cannot separate a league's habits from one
    year's accidents — a single injury-hit RB run looks identical to a genuine
    RB-heavy culture. Several drafts do, and they let the premise be TESTED
    rather than assumed (see `assessStability` on the JS side): if a league's
    own past does not predict its own future better than the generic
    allocation, the deviations are noise and the calibration should back off.
    Membership turns over, so this returns per-season picks and leaves the
    recency weighting to the caller rather than pooling them here.

    Each season is independent and best-effort: a missing or private one is
    recorded and skipped, never fatal. The current-season path is tried first
    and `leagueHistory` second, because which answers depends on how long ago
    the season was and ESPN documents neither.
    """
    cookies = {}
    if espn_s2 and swid:
        cookies = {"espn_s2": espn_s2, "SWID": swid if swid.startswith("{") else "{" + swid + "}"}
    verify = ca_bundle if ca_bundle else True

    out: dict[int, list[DraftPickRow]] = {}
    diag: dict[int, str] = {}
    async with httpx.AsyncClient(timeout=30, follow_redirects=True, trust_env=True,
                                 verify=verify, cookies=cookies,
                                 headers=SITE_HEADERS) as client:
        for season in seasons:
            data = None
            for label, url in (("season", league_url(league_id, season)),
                               ("history", history_league_url(league_id, season))):
                try:
                    r = await client.get(url)
                except Exception as e:  # noqa: BLE001 — one bad season is not fatal
                    diag[season] = f"{label}:{type(e).__name__}"
                    continue
                if r.status_code != 200:
                    diag[season] = f"{label}:HTTP {r.status_code}"
                    continue
                j = r.json()
                if isinstance(j, list):
                    j = j[0] if j else {}
                # leagueHistory sometimes answers 200 with no draft at all.
                if (j.get("draftDetail", {}) or {}).get("picks"):
                    data = j
                    diag[season] = f"{label}:ok"
                    break
                diag[season] = f"{label}:no draft"
            if data is None:
                continue

            picks = parse_draft_picks(data)
            missing = unresolved_pick_ids(picks)
            if missing:
                found: dict[int, dict] = {}
                try:
                    for i in range(0, len(missing), 200):
                        pr = await client.get(
                            player_info_url(league_id, season),
                            headers={"x-fantasy-filter": player_info_filter(missing[i:i + 200])})
                        if pr.status_code != 200:
                            diag[season] += f" players:HTTP {pr.status_code}"
                            break
                        found.update(parse_player_info(pr.json()))
                except Exception as e:  # noqa: BLE001 — naming is optional
                    diag[season] += f" players:{type(e).__name__}"
                if found:
                    picks = parse_draft_picks(data, found)
            out[season] = picks
            diag[season] += f" picks:{len(picks)} named:{sum(1 for p in picks if p.resolved)}"

    return {"by_season": out, "diag": diag}

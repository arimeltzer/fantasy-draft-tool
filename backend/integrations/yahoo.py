"""
integrations/yahoo.py
====================
Yahoo adapter. Yahoo has an OFFICIAL Fantasy Sports API behind OAuth2, so this
module has two halves:

  1. OAuth2 helpers (authorize URL / code exchange / refresh) — needs a Yahoo
     developer app: set YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_REDIRECT_URI.
  2. Fetch + parse league settings and rosters (requested as `?format=json`).

Yahoo's JSON wraps almost everything as a list of single-key dicts; `flatten()`
collapses that so the parsers stay readable. Network is isolated in
`fetch_league`; parsing is pure and fixture-tested.
"""
from __future__ import annotations

import base64
import os

import httpx

from .base import NormLeague, NormPlayer, NormTeam, make_settings
from .live import LiveDraftState, LivePick, order_picks

AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth"
TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token"
API = "https://fantasysports.yahooapis.com/fantasy/v2"

# Yahoo roster position label -> our bucket.
POS_LABEL = {
    "QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "K": "K", "DEF": "DST",
    "W/R/T": "FLEX", "W/R": "FLEX", "R/W/T": "FLEX", "Q/W/R/T": "SF", "BN": "BENCH",
}
RECEPTION_STAT_ID = "11"  # Yahoo NFL "Rec"

# Yahoo's fantasy-sports READ scope. Without it a token is issued happily and
# then rejected by every fantasy endpoint.
DEFAULT_SCOPE = "fspt-r"

# Yahoo's marker for "this token has no fantasy permission". It arrives as a
# 401 whose text blames credentials, which sends you hunting the wrong problem.
NEEDS_FANTASY_SCOPE = "additional_authorization_required"


class FantasyScopeError(RuntimeError):
    """Token is valid but carries no Fantasy Sports permission."""


def check_fantasy_scope(status_code: int, body: str) -> None:
    """Turn Yahoo's misleading 401 into something actionable.

    Yahoo reports a missing fantasy grant as "Please provide valid credentials",
    which reads as a bad token or a wrong client secret. The real cause is
    always one of three things, so say so instead of echoing the JSON.
    """
    if NEEDS_FANTASY_SCOPE not in (body or ""):
        return
    raise FantasyScopeError(
        "Yahoo issued a token with no Fantasy Sports permission "
        f'(oauth_problem="{NEEDS_FANTASY_SCOPE}"). Three things to check, in order: '
        "(1) the Yahoo app at developer.yahoo.com/apps must list API Permissions -> "
        "Fantasy Sports (Read); (2) the backend must request the scope — it now sends "
        f"'{DEFAULT_SCOPE}' by default, but Railway only picks up env changes on a fresh "
        "DEPLOY, not a restart; (3) any token minted before either of those was true is "
        "still under-scoped and refreshing will not upgrade it — Disconnect and authorize again."
    )


# ── OAuth2 ──────────────────────────────────────────────────────────────────

def _cfg():
    return (os.getenv("YAHOO_CLIENT_ID", ""), os.getenv("YAHOO_CLIENT_SECRET", ""),
            os.getenv("YAHOO_REDIRECT_URI", ""))


def authorize_url(state: str = "") -> str:
    cid, _, redirect = _cfg()
    if not cid or not redirect:
        raise RuntimeError("Yahoo app not configured (YAHOO_CLIENT_ID / YAHOO_REDIRECT_URI).")
    from urllib.parse import urlencode
    q = {"client_id": cid, "redirect_uri": redirect, "response_type": "code", "language": "en-us"}
    # Fantasy read is the ONLY thing this app uses, so request it by default.
    # Leaving the scope off gets a token that authenticates fine and then fails
    # every fantasy call with oauth_problem="additional_authorization_required"
    # — a confusing failure that looks like the credential was never granted.
    # YAHOO_SCOPE can override (e.g. "fspt-w"); set it to "-" to send none.
    scope = os.getenv("YAHOO_SCOPE", DEFAULT_SCOPE) or DEFAULT_SCOPE
    if scope and scope != "-":
        q["scope"] = scope
    if state:
        q["state"] = state
    return f"{AUTH_URL}?{urlencode(q)}"


async def _token_request(payload: dict, ca_bundle: str | None = None) -> dict:
    cid, secret, _ = _cfg()
    basic = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    verify = ca_bundle if ca_bundle else True
    async with httpx.AsyncClient(timeout=30, trust_env=True, verify=verify) as client:
        resp = await client.post(
            TOKEN_URL, data=payload,
            headers={"Authorization": f"Basic {basic}",
                     "Content-Type": "application/x-www-form-urlencoded"},
        )
        if resp.status_code >= 400:
            # Surface Yahoo's OAuth error so failures are diagnosable
            # (invalid_grant = expired/used code or redirect mismatch, etc.).
            try:
                body = resp.json()
                detail = body.get("error_description") or body.get("error") or body
            except Exception:
                detail = resp.text[:300]
            raise RuntimeError(f"{resp.status_code} {detail}")
        return resp.json()


async def exchange_code(code: str, ca_bundle: str | None = None) -> dict:
    _, _, redirect = _cfg()
    return await _token_request(
        {"grant_type": "authorization_code", "redirect_uri": redirect, "code": code}, ca_bundle)


async def refresh_token(refresh: str, ca_bundle: str | None = None) -> dict:
    return await _token_request({"grant_type": "refresh_token", "refresh_token": refresh}, ca_bundle)


# ── JSON helpers ────────────────────────────────────────────────────────────

def flatten(node):
    """Yahoo wraps fields as a list of single-key dicts; merge into one dict."""
    if isinstance(node, dict):
        return node
    out: dict = {}
    if isinstance(node, list):
        for item in node:
            if isinstance(item, dict):
                out.update(item)
            elif isinstance(item, list):
                out.update(flatten(item))
    return out


# ── parsing ─────────────────────────────────────────────────────────────────

def raw_stat_modifiers(league_node) -> list[dict]:
    """The league's full stat_modifiers, as Yahoo sent them (stat_id/value) —
    everything beyond the one stat (receptions, stat_id 11) this adapter maps
    automatically. Yahoo's numbering isn't something we're confident enough to
    guess a full category mapping for without a real payload to check field-by-
    field (guessing wrong would mean silently incorrect valuations — worse than
    not mapping at all). Surfaced so the import report can point the user at
    Settings -> Scoring, and so a real mapping can be calibrated from evidence
    later if wanted."""
    settings_raw = {}
    if isinstance(league_node, list) and len(league_node) > 1:
        settings_raw = flatten(league_node[1]).get("settings") or flatten(league_node[1])
    settings_raw = flatten(settings_raw)
    out = []
    for sm in (flatten(settings_raw.get("stat_modifiers")) or {}).get("stats", []) or []:
        st = flatten(sm.get("stat", sm))
        if st.get("stat_id") is not None:
            out.append({"stat_id": st.get("stat_id"), "value": st.get("value")})
    return out


def parse_settings(league_node) -> tuple[dict, str, str]:
    """league_node = fantasy_content.league (a 2-elem list). Returns
    (settings dict, fmt, league_name)."""
    meta = flatten(league_node[0]) if isinstance(league_node, list) else flatten(league_node)
    settings_raw = {}
    if isinstance(league_node, list) and len(league_node) > 1:
        settings_raw = flatten(league_node[1]).get("settings") or flatten(league_node[1])
    settings_raw = flatten(settings_raw)

    name = meta.get("name", "Yahoo League")
    teams = int(meta.get("num_teams", 12) or 12)
    is_auction = str(settings_raw.get("is_auction_draft", "0")) in ("1", "true")
    fmt = "auction" if is_auction else "snake"

    # PPR from stat_modifiers
    ppr = 0.0
    for sm in (flatten(settings_raw.get("stat_modifiers")) or {}).get("stats", []) or []:
        st = flatten(sm.get("stat", sm))
        if str(st.get("stat_id")) == RECEPTION_STAT_ID:
            ppr = float(st.get("value", 0) or 0)
            break

    roster = {"QB": 0, "RB": 0, "WR": 0, "TE": 0, "FLEX": 0, "K": 0, "DST": 0, "BENCH": 0, "SF": 0}
    superflex = False
    for rp in settings_raw.get("roster_positions", []) or []:
        p = flatten(rp.get("roster_position", rp))
        bucket = POS_LABEL.get(p.get("position", ""))
        n = int(p.get("count", 0) or 0)
        if not bucket or n == 0 or p.get("position") == "IR":
            continue
        if bucket == "SF":
            superflex = True
        roster[bucket] = roster.get(bucket, 0) + n

    budget = int(settings_raw.get("auction_budget", 200) or 200) if is_auction else 200
    settings = make_settings(teams=teams, ppr=ppr, roster=roster, fmt=fmt,
                             budget=budget, superflex=superflex)
    return settings, fmt, name


def _player_from_node(player_node) -> NormPlayer:
    """player_node = the array Yahoo returns for one player."""
    d = flatten(player_node[0]) if isinstance(player_node, list) else flatten(player_node)
    name = flatten(d.get("name")).get("full", "") if d.get("name") else d.get("name_full", "")
    pos = d.get("display_position") or d.get("primary_position") or ""
    pos = "DST" if pos in ("DEF", "D/ST") else pos.split(",")[0].upper()
    return NormPlayer(
        name=name or "",
        pos=pos,
        team=(d.get("editorial_team_abbr") or "").upper(),
        ext_id=str(d.get("player_id")) if d.get("player_id") is not None else None,
    )


def parse_teams(teams_node, my_guid: str | None = None) -> list[NormTeam]:
    """teams_node = fantasy_content.league[1].teams (dict keyed by index)."""
    teams_map = flatten(teams_node)
    out: list[NormTeam] = []
    for k, v in teams_map.items():
        if k == "count" or not isinstance(v, dict):
            continue
        tnode = v.get("team")
        if not tnode:
            continue
        meta = flatten(tnode[0]) if isinstance(tnode, list) else flatten(tnode)
        name = meta.get("name", "Team")
        team_key = meta.get("team_key")
        # "mine" if this team's manager guid matches the token owner
        is_mine = False
        for mgr in (flatten(meta.get("managers")) or {}).values() if meta.get("managers") else []:
            if isinstance(mgr, dict) and my_guid and flatten(mgr.get("manager", mgr)).get("guid") == my_guid:
                is_mine = True
        players: list[NormPlayer] = []
        roster = None
        if isinstance(tnode, list):
            for seg in tnode:
                if isinstance(seg, dict) and "roster" in seg:
                    roster = seg["roster"]
        if roster:
            pmap = flatten(flatten(roster).get("0", {}).get("players", {})) or flatten(
                flatten(roster).get("players", {}))
            for pk, pv in pmap.items():
                if pk == "count" or not isinstance(pv, dict):
                    continue
                players.append(_player_from_node(pv.get("player")))
        out.append(NormTeam(name=name, is_mine=is_mine, players=players, ext_id=team_key))
    return out


# ── keeper inputs: draft results, waivers, keeper flags ─────────────────────
#
# Keeper costs need last season's draft (what each player cost) and, for
# price-basis leagues, the top waiver/FAAB claim — the same two inputs the ESPN
# adapter pulls. Yahoo identifies players by `player_key` ("449.p.31883") in
# draft results and transactions but by `player_id` ("31883") on rosters, so
# everything here is keyed on the numeric id via `player_num()`.

def player_num(key_or_id) -> str:
    """Last dotted segment of a Yahoo player key — "449.p.31883" -> "31883".
    Already-bare ids pass through, so callers can mix the two forms."""
    s = str(key_or_id or "")
    return s.rsplit(".", 1)[-1]


def parse_draft_results(data) -> dict[str, dict]:
    """`/league/{key}/draftresults` -> {player_id: {round, pick, cost, team_key}}.

    `cost` is present only for auction drafts; snake leagues carry the round.
    Both are handed to the client untouched — the league's keeper RULE decides
    which basis applies, exactly as with ESPN and the paste importer."""
    league = (data.get("fantasy_content") or {}).get("league")
    node = {}
    if isinstance(league, list) and len(league) > 1:
        node = flatten(league[1]).get("draft_results") or {}
    node = flatten(node)

    out: dict[str, dict] = {}
    for k, v in node.items():
        if k == "count" or not isinstance(v, dict):
            continue
        dr = flatten(v.get("draft_result", v))
        pkey = dr.get("player_key")
        if not pkey:
            continue
        cost = dr.get("cost")
        out[player_num(pkey)] = {
            "round": int(dr["round"]) if str(dr.get("round") or "").isdigit() else None,
            "pick": int(dr["pick"]) if str(dr.get("pick") or "").isdigit() else None,
            "cost": int(cost) if str(cost or "").isdigit() else None,
            "team_key": dr.get("team_key"),
        }
    return out


def parse_transactions(data) -> dict[str, int]:
    """`/league/{key}/transactions;types=add` -> {player_id: top FAAB bid}.

    Keeper price in many leagues is the HIGHER of the draft price and what the
    player was claimed for, so only the maximum winning bid per player matters.
    Yahoo puts the bid on the transaction, not the player, and a player can be
    added more than once in a season — hence the max."""
    league = (data.get("fantasy_content") or {}).get("league")
    node = {}
    if isinstance(league, list) and len(league) > 1:
        node = flatten(league[1]).get("transactions") or {}
    node = flatten(node)

    out: dict[str, int] = {}
    for k, v in node.items():
        if k == "count" or not isinstance(v, dict):
            continue
        txn = v.get("transaction")
        meta = flatten(txn[0]) if isinstance(txn, list) and txn else flatten(txn)
        if meta.get("status") not in (None, "successful"):
            continue
        bid = meta.get("faab_bid")
        if not str(bid or "").isdigit():
            continue
        bid = int(bid)

        players = {}
        if isinstance(txn, list):
            for seg in txn[1:]:
                if isinstance(seg, dict) and "players" in seg:
                    players = flatten(seg["players"])
        for pk, pv in players.items():
            if pk == "count" or not isinstance(pv, dict):
                continue
            pnode = pv.get("player")
            fields = flatten(pnode[0]) if isinstance(pnode, list) and pnode else flatten(pnode)
            # Only the ADDED player was bid on; the dropped side rides along.
            tdata = {}
            if isinstance(pnode, list):
                for seg in pnode[1:]:
                    if isinstance(seg, dict) and "transaction_data" in seg:
                        td = seg["transaction_data"]
                        tdata = flatten(td[0]) if isinstance(td, list) and td else flatten(td)
            if tdata.get("type") not in (None, "add"):
                continue
            pid = player_num(fields.get("player_key") or fields.get("player_id"))
            if pid:
                out[pid] = max(out.get(pid, 0), bid)
    return out


def parse_keeper_flags(teams_node) -> dict[str, dict]:
    """Yahoo's own `is_keeper` block per rostered player, if the league has one.

    `kept` means the player was kept THIS season, which in most keeper rules is
    what makes them ineligible next season. That is Yahoo's data rather than an
    inference — but it is surfaced for confirmation rather than trusted
    silently, the same treatment the pasted keeper badge gets, because the
    field is undocumented and a wrong read would quietly delete real options.
    """
    out: dict[str, dict] = {}
    for tk, tv in flatten(teams_node).items():
        if tk == "count" or not isinstance(tv, dict):
            continue
        tnode = tv.get("team")
        roster = None
        if isinstance(tnode, list):
            for seg in tnode:
                if isinstance(seg, dict) and "roster" in seg:
                    roster = seg["roster"]
        if not roster:
            continue
        pmap = flatten(flatten(roster).get("0", {}).get("players", {})) or flatten(
            flatten(roster).get("players", {}))
        for pk, pv in pmap.items():
            if pk == "count" or not isinstance(pv, dict):
                continue
            pnode = pv.get("player")
            fields = flatten(pnode[0]) if isinstance(pnode, list) and pnode else flatten(pnode)
            keep = fields.get("is_keeper")
            if not isinstance(keep, dict):
                continue
            pid = player_num(fields.get("player_key") or fields.get("player_id"))
            cost = keep.get("cost")
            out[pid] = {
                "kept": str(keep.get("kept") or "").lower() in ("1", "true"),
                "cost": int(cost) if str(cost or "").isdigit() else None,
            }
    return out


def team_names_by_key(teams_node) -> dict[str, str]:
    """team_key -> display name, so a draft pick can be attributed to a team."""
    out: dict[str, str] = {}
    for tk, tv in flatten(teams_node).items():
        if tk == "count" or not isinstance(tv, dict):
            continue
        tnode = tv.get("team")
        meta = flatten(tnode[0]) if isinstance(tnode, list) else flatten(tnode)
        if meta.get("team_key"):
            out[meta["team_key"]] = meta.get("name", "Team")
    return out


def attach_keeper_inputs(teams: list[NormTeam], teams_node, draft: dict, waivers: dict,
                         keeper_flags: dict | None = None) -> list[str]:
    """Fold draft cost / waiver claim / keeper flag onto each rostered player.

    Returns the names Yahoo reports as already kept, for the import report —
    the caller shows them for confirmation instead of silently dropping them.
    """
    kept_names: list[str] = []
    # Roster order is preserved by parse_teams, so walking the same structure
    # again lines player ids up with the NormPlayer objects already built.
    ids_by_team: list[list[str]] = []
    for tk, tv in flatten(teams_node).items():
        if tk == "count" or not isinstance(tv, dict):
            continue
        tnode = tv.get("team")
        roster = None
        if isinstance(tnode, list):
            for seg in tnode:
                if isinstance(seg, dict) and "roster" in seg:
                    roster = seg["roster"]
        ids: list[str] = []
        if roster:
            pmap = flatten(flatten(roster).get("0", {}).get("players", {})) or flatten(
                flatten(roster).get("players", {}))
            for pk, pv in pmap.items():
                if pk == "count" or not isinstance(pv, dict):
                    continue
                pnode = pv.get("player")
                fields = flatten(pnode[0]) if isinstance(pnode, list) and pnode else flatten(pnode)
                ids.append(player_num(fields.get("player_key") or fields.get("player_id")))
        ids_by_team.append(ids)

    for team, ids in zip(teams, ids_by_team):
        for player, pid in zip(team.players, ids):
            d = draft.get(pid) or {}
            player.bid = d.get("cost")
            player.round = d.get("round")
            player.waiver = waivers.get(pid)
            flag = (keeper_flags or {}).get(pid) or {}
            if flag.get("kept"):
                player.keeper_ineligible = True
                kept_names.append(player.name)
    return kept_names


# ── fetch ───────────────────────────────────────────────────────────────────

def parse_my_leagues(data) -> list[dict]:
    """Walk users -> games -> leagues from the `users;use_login=1/games/leagues`
    response into a flat [{key, name, season, num_teams}], newest season first."""
    out: list[dict] = []
    users = flatten((data.get("fantasy_content") or {}).get("users", {}))
    for uk, uv in users.items():
        if uk == "count" or not isinstance(uv, dict):
            continue
        user = flatten(uv.get("user"))
        games = flatten(user.get("games", {}))
        for gk, gv in games.items():
            if gk == "count" or not isinstance(gv, dict):
                continue
            game = flatten(gv.get("game"))
            season = game.get("season")
            leagues = flatten(game.get("leagues", {}))
            for lk, lv in leagues.items():
                if lk == "count" or not isinstance(lv, dict):
                    continue
                lg = flatten(lv.get("league"))
                if not lg.get("league_key"):
                    continue
                out.append({
                    "key": lg.get("league_key"),
                    "name": lg.get("name", "League"),
                    "season": int(lg.get("season") or season or 0),
                    "num_teams": int(lg.get("num_teams") or 0),
                })
    out.sort(key=lambda x: -(x["season"] or 0))
    return out


async def fetch_my_leagues(access_token: str, ca_bundle: str | None = None) -> list[dict]:
    """All NFL leagues the token owner has played, across seasons."""
    verify = ca_bundle if ca_bundle else True
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    url = f"{API}/users;use_login=1/games;game_codes=nfl/leagues?format=json"
    async with httpx.AsyncClient(timeout=30, trust_env=True, verify=verify, headers=headers) as client:
        r = await client.get(url)
        if r.status_code >= 400:
            check_fantasy_scope(r.status_code, r.text)
            raise RuntimeError(f"{r.status_code} {r.text[:200]}")
        return parse_my_leagues(r.json())


async def fetch_league(league_key: str, access_token: str, my_guid: str | None = None,
                       ca_bundle: str | None = None) -> NormLeague:
    verify = ca_bundle if ca_bundle else True
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=30, trust_env=True, verify=verify, headers=headers) as client:
        rs = await client.get(f"{API}/league/{league_key}/settings?format=json")
        if rs.status_code >= 400:
            check_fantasy_scope(rs.status_code, rs.text)
        rs.raise_for_status()
        s = rs.json()
        rt = await client.get(f"{API}/league/{league_key}/teams/roster?format=json")
        rt.raise_for_status()
        t = rt.json()

    league_node = s["fantasy_content"]["league"]
    settings, fmt, name = parse_settings(league_node)
    teams_node = None
    tn = t["fantasy_content"]["league"]
    if isinstance(tn, list) and len(tn) > 1:
        teams_node = flatten(tn[1]).get("teams")
    teams = parse_teams(teams_node, my_guid) if teams_node else []
    raw_stats = raw_stat_modifiers(league_node)
    lg = NormLeague(provider="yahoo", ext_id=league_key, name=name, season=0,
                    fmt=fmt, settings=settings, teams=teams)
    lg.meta["scoring"] = {
        "auto_mapped": ["ptsPerRec"],   # only PPR — see raw_stat_modifiers()
        "raw_rule_count": len(raw_stats),
        "raw": raw_stats,
    }
    return lg


def parse_live_draft(draft_json, teams_json, my_guid: str | None = None,
                     my_team_key: str | None = None) -> LiveDraftState:
    """Join Yahoo's draft results (order/owner/price) to the rosters (names).

    `draftresults` identifies players only by `player_key`, so on its own it
    can't say WHO was taken. Rosters carry the names, and a drafted player
    lands on a roster, so the two together give a complete pick list. A pick
    whose player isn't on any roster yet (the platform lagging between the two
    endpoints) is skipped rather than logged as an unknown player — the next
    poll picks it up.

    "Mine" identification here is a SINGLE POINT OF FAILURE with no visibility
    if it misses: unlike ESPN (whose raw payloads have been checked against
    real captures repeatedly in this codebase), Yahoo's `managers` node has
    never been verified that way, and `is_mine` matching the OAuth guid
    against it can silently come back false for every team — exactly the
    failure a real Yahoo keeper pull hit (see YahooKeeperAutofill.tsx).
    Two things fix that here, mirroring that same fix: `my_team_key`, when
    given, OVERRIDES the guid match outright (the caller already knows which
    team is real, e.g. from a user's manual pick); and `state.meta` always
    carries the raw team list + which key ended up "mine" (or None), so the
    frontend can show a mismatch and let the user correct it BEFORE picks
    get logged against the wrong roster, rather than discovering it pick by
    pick during a live draft.
    """
    draft = parse_draft_results(draft_json)

    teams_node = None
    tn = (teams_json.get("fantasy_content") or {}).get("league")
    if isinstance(tn, list) and len(tn) > 1:
        teams_node = flatten(tn[1]).get("teams")
    teams = parse_teams(teams_node, my_guid) if teams_node else []
    names_by_key = team_names_by_key(teams_node) if teams_node else {}

    # player_id -> the NormPlayer already parsed off the roster.
    by_id: dict[str, tuple] = {}
    for tk, tv in flatten(teams_node or {}).items():
        if tk == "count" or not isinstance(tv, dict):
            continue
        tnode = tv.get("team")
        meta = flatten(tnode[0]) if isinstance(tnode, list) else flatten(tnode)
        tkey = meta.get("team_key")
        roster = None
        if isinstance(tnode, list):
            for seg in tnode:
                if isinstance(seg, dict) and "roster" in seg:
                    roster = seg["roster"]
        if not roster:
            continue
        pmap = flatten(flatten(roster).get("0", {}).get("players", {})) or flatten(
            flatten(roster).get("players", {}))
        for pk, pv in pmap.items():
            if pk == "count" or not isinstance(pv, dict):
                continue
            pnode = pv.get("player")
            fields = flatten(pnode[0]) if isinstance(pnode, list) and pnode else flatten(pnode)
            pid = player_num(fields.get("player_key") or fields.get("player_id"))
            by_id[pid] = (_player_from_node(pnode), tkey)

    if my_team_key:
        # A manual pick always wins — it came from the user looking at the
        # real team names this same function already returns, not a guess.
        mine_keys = {my_team_key} if my_team_key in names_by_key else set()
    else:
        mine_keys = {
            meta_key for meta_key, team in zip(names_by_key.keys(), teams) if team.is_mine
        } if len(teams) == len(names_by_key) else set()

    picks: list[LivePick] = []
    for pid, d in draft.items():
        entry = by_id.get(pid)
        if not entry:
            continue
        np, roster_team_key = entry
        owner_key = d.get("team_key") or roster_team_key
        picks.append(LivePick(
            overall=d.get("pick") or 0,
            name=np.name, pos=np.pos, team=np.team,
            round=d.get("round"),
            owner=names_by_key.get(owner_key),
            owner_ext_id=owner_key,
            is_mine=owner_key in mine_keys,
            bid=d.get("cost"),
        ))
    picks = [p for p in picks if p.overall > 0]
    state = LiveDraftState(picks=order_picks(picks),
                           fmt="auction" if any(p.bid is not None for p in picks) else "snake")
    state.meta = {
        "drafted": len(draft), "resolved": len(picks),
        # Diagnostics for the "which team is mine" match — always present
        # (not just on failure) so the frontend can offer a correction
        # up front rather than only after something's already gone wrong.
        "yahoo_teams": [{"key": k, "name": n} for k, n in names_by_key.items()],
        "yahoo_my_team_key": next(iter(mine_keys), None),
    }
    return state


async def fetch_live_draft(league_key: str, access_token: str, my_guid: str | None = None,
                           my_team_key: str | None = None,
                           ca_bundle: str | None = None) -> LiveDraftState:
    """Poll a Yahoo draft in progress. Two calls: results (order) + rosters (names)."""
    verify = ca_bundle if ca_bundle else True
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=20, trust_env=True, verify=verify, headers=headers) as client:
        rd = await client.get(f"{API}/league/{league_key}/draftresults?format=json")
        if rd.status_code >= 400:
            check_fantasy_scope(rd.status_code, rd.text)
        rd.raise_for_status()
        rt = await client.get(f"{API}/league/{league_key}/teams/roster?format=json")
        rt.raise_for_status()
    return parse_live_draft(rd.json(), rt.json(), my_guid, my_team_key)


async def fetch_keeper_league(league_key: str, access_token: str, my_guid: str | None = None,
                              ca_bundle: str | None = None) -> NormLeague:
    """A prior season's league with everything keeper costs need attached.

    `fetch_league` covers settings + rosters, which is all an import needs. The
    keeper planner additionally needs what each rostered player COST — the draft
    result, and the top waiver/FAAB claim for price-basis leagues. Those are
    separate Yahoo endpoints, and the transactions one is optional: leagues with
    no FAAB, or with transaction history unavailable, must still produce
    draft-basis candidates rather than failing outright.
    """
    verify = ca_bundle if ca_bundle else True
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=30, trust_env=True, verify=verify, headers=headers) as client:
        rs = await client.get(f"{API}/league/{league_key}/settings?format=json")
        if rs.status_code >= 400:
            check_fantasy_scope(rs.status_code, rs.text)
        rs.raise_for_status()
        settings_json = rs.json()

        rt = await client.get(f"{API}/league/{league_key}/teams/roster?format=json")
        rt.raise_for_status()
        teams_json = rt.json()

        rd = await client.get(f"{API}/league/{league_key}/draftresults?format=json")
        rd.raise_for_status()
        draft_json = rd.json()

        txn_json, txn_error = None, None
        try:
            rx = await client.get(f"{API}/league/{league_key}/transactions;types=add?format=json")
            if rx.status_code < 400:
                txn_json = rx.json()
            else:
                txn_error = f"{rx.status_code} {rx.text[:120]}"
        except Exception as e:  # noqa: BLE001 — waivers are a bonus, not a blocker
            txn_error = str(e)

    league_node = settings_json["fantasy_content"]["league"]
    settings, fmt, name = parse_settings(league_node)

    teams_node = None
    tn = teams_json["fantasy_content"]["league"]
    if isinstance(tn, list) and len(tn) > 1:
        teams_node = flatten(tn[1]).get("teams")
    teams = parse_teams(teams_node, my_guid) if teams_node else []

    draft = parse_draft_results(draft_json)
    waivers = parse_transactions(txn_json) if txn_json else {}
    flags = parse_keeper_flags(teams_node) if teams_node else {}
    kept_names = attach_keeper_inputs(teams, teams_node, draft, waivers, flags)

    lg = NormLeague(provider="yahoo", ext_id=league_key, name=name, season=0,
                    fmt=fmt, settings=settings, teams=teams)
    lg.meta["draft"] = {"picks": len(draft),
                        "auction": any(d.get("cost") is not None for d in draft.values())}
    lg.meta["transactions"] = {
        "waiver_players": len(waivers),
        **({"error": txn_error} if txn_error else {}),
    }
    # Surfaced for confirmation, never silently trusted — see parse_keeper_flags.
    lg.meta["kept_detected"] = kept_names
    return lg

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

AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth"
TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token"
API = "https://fantasysports.yahooapis.com/fantasy/v2"

# Yahoo roster position label -> our bucket.
POS_LABEL = {
    "QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "K": "K", "DEF": "DST",
    "W/R/T": "FLEX", "W/R": "FLEX", "R/W/T": "FLEX", "Q/W/R/T": "SF", "BN": "BENCH",
}
RECEPTION_STAT_ID = "11"  # Yahoo NFL "Rec"


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
        out.append(NormTeam(name=name, is_mine=is_mine, players=players))
    return out


# ── fetch ───────────────────────────────────────────────────────────────────

async def fetch_league(league_key: str, access_token: str, my_guid: str | None = None,
                       ca_bundle: str | None = None) -> NormLeague:
    verify = ca_bundle if ca_bundle else True
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=30, trust_env=True, verify=verify, headers=headers) as client:
        rs = await client.get(f"{API}/league/{league_key}/settings?format=json")
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
    return NormLeague(provider="yahoo", ext_id=league_key, name=name, season=0,
                      fmt=fmt, settings=settings, teams=teams)

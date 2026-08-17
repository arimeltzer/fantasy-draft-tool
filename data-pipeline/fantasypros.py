#!/usr/bin/env python3
"""
fantasypros.py — fresh ECR / ADP from the FantasyPros public API
================================================================
The free nflverse `load_ff_rankings()` is a limited, sometimes-stale snapshot.
With a FantasyPros API key this pulls CURRENT, scoring-aware consensus rankings
(ECR), tiers, and positional ranks straight from FantasyPros, keyed by
(normalized name, position) so projections.py can fold them onto the board.

  key:   set FANTASYPROS_API_KEY (env) — never commit it.
  auth:  sent as the `x-api-key` header.
  data:  GET /public/v2/json/nfl/{season}/consensus-rankings

Network is isolated in `fetch_rankings`; `parse_rankings` is pure and
fixture-tested. The endpoint can't be reached from the build sandbox (egress
policy), so validate a real pull where the key lives (local pipeline run).
"""
from __future__ import annotations

import json
import os
import time
import re
import urllib.error
import urllib.request
from urllib.parse import urlencode

BASE = "https://api.fantasypros.com/public/v2/json/nfl/{season}/consensus-rankings"
PROJ_BASE = "https://api.fantasypros.com/public/v2/json/nfl/{season}/projections"

# FantasyPros projection stat key -> engine `proj` field (lowercased synonyms).
# Engine scoring reads: passYd passTD int rushYd rushTD rec recYd recTD fumbles.
PROJ_FIELDS = {
    "passYd": ["pass_yds", "passing_yards", "pass_yards", "py"],
    "passTD": ["pass_tds", "passing_tds", "pass_td", "ptd"],
    "int":    ["int", "ints", "interceptions", "pass_ints"],
    "rushYd": ["rush_yds", "rushing_yards", "ry"],
    "rushTD": ["rush_tds", "rushing_tds", "rtd"],
    "rec":    ["rec_rec", "rec", "receptions"],
    "recYd":  ["rec_yds", "receiving_yards", "rey"],
    "recTD":  ["rec_tds", "receiving_tds", "retd"],
    "fumbles":["fumbles", "fl", "fum_lost", "fumbles_lost"],
}

# scoring tokens the API accepts
SCORING = {"STD": "STD", "STANDARD": "STD", "HALF": "HALF", "HALF-PPR": "HALF",
           "PPR": "PPR"}

_SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b\.?", re.I)



# FantasyPros rate-limits, and it answers 429 rather than failing loudly. A
# probe that fired four requests per season across seven seasons got two
# seasons of data and five seasons of "Too Many Requests" — which reads exactly
# like "historical data does not exist" unless you look at the status code.
# Anything that loops over seasons or positions has to pace itself and retry.
RATE_LIMIT_PAUSE = 1.5      # seconds between consecutive calls
RATE_LIMIT_RETRIES = 4      # on 429, back off 2s, 4s, 8s, 16s


def _get_json(url: str, api_key: str, *, label: str = "") -> dict | None:
    """GET with 429 backoff. Returns None when the call ultimately fails, so a
    caller looping over positions can report a partial pull instead of dying."""
    req = urllib.request.Request(url, headers={
        "x-api-key": api_key, "Accept": "application/json",
        "User-Agent": "fantasy-draft-tool/1.0",
    })
    for attempt in range(RATE_LIMIT_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < RATE_LIMIT_RETRIES:
                wait = 2 ** (attempt + 1)
                print(f"  · {label or url}: 429, waiting {wait}s")
                time.sleep(wait)
                continue
            body = e.read()[:200].decode("utf-8", "replace")
            print(f"  ! {label or url}: HTTP {e.code} {body}")
            return None
        except Exception as e:  # noqa: BLE001 — one dead call is not fatal
            print(f"  ! {label or url}: {type(e).__name__}: {e}")
            return None
    return None

def norm(n: str) -> str:
    """Match projections.py / matching.py normalization."""
    n = (n or "").lower()
    n = re.sub(r"[.'`’]", "", n)
    n = _SUFFIX.sub("", n)
    n = re.sub(r"[^a-z ]", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def describe_payload(data, label: str, limit: int = 24) -> str:
    """Report the SHAPE of an API response — never guess field names from memory.

    A pull that returns HTTP 200 and parses to zero rows means our key
    expectations are wrong, and the only way to fix that honestly is to look at
    what actually arrived. Prints top-level keys, the row count, and the keys of
    the first row (plus any nested `stats`), with a couple of sample values —
    enough to write a correct parser, small enough to read in a CI log.
    """
    out = [f"  [diag] {label}:"]
    if not isinstance(data, dict):
        return f"  [diag] {label}: payload is {type(data).__name__}, not an object"
    out.append(f"    top-level keys: {sorted(data.keys())[:limit]}")
    rows = None
    for k in ("players", "projections", "rankings", "data", "results"):
        v = data.get(k)
        if isinstance(v, list):
            rows = v
            out.append(f"    '{k}' is a list of {len(v)}")
            break
    if rows is None:
        for k, v in data.items():
            out.append(f"    {k}: {type(v).__name__}"
                       + (f" (len {len(v)})" if isinstance(v, (list, dict)) else f" = {v!r}"[:60]))
        return "\n".join(out)
    if not rows:
        out.append("    (row list is EMPTY — the request returned no players)")
        return "\n".join(out)
    first = rows[0]
    if isinstance(first, dict):
        out.append(f"    first row keys: {sorted(first.keys())[:limit]}")
        for k in ("stats", "projection", "projections"):
            if isinstance(first.get(k), dict):
                out.append(f"    first row ['{k}'] keys: {sorted(first[k].keys())[:limit]}")
        sample = {k: v for k, v in list(first.items())[:6] if not isinstance(v, (dict, list))}
        out.append(f"    first row sample: {sample}")
    else:
        out.append(f"    first row is {type(first).__name__}: {str(first)[:120]}")
    return "\n".join(out)


def _num(d: dict, *keys):
    for k in keys:
        v = d.get(k)
        if v in (None, "", "null"):
            continue
        try:
            return float(v)
        except (TypeError, ValueError):
            continue
    return None


def parse_rankings(data: dict) -> dict:
    """API JSON -> {(norm_name, pos): {ecr, adp, tier, pos_rank}}.

    Defensive about field names (the public API has shifted them over time).
    """
    players = data.get("players") or data.get("rankings") or []
    out: dict[tuple, dict] = {}
    for p in players:
        name = p.get("player_name") or p.get("name") or p.get("player")
        pos = (p.get("player_position_id") or p.get("position_id")
               or p.get("position") or p.get("pos") or "").upper()
        pos = re.sub(r"[^A-Z]", "", pos)
        if pos == "DEF":
            pos = "DST"
        if not name or pos not in ("QB", "RB", "WR", "TE", "K", "DST"):
            continue
        ecr = _num(p, "rank_ecr", "ecr", "rank")
        adp = _num(p, "rank_adp", "player_adp", "adp")
        tier = _num(p, "tier", "player_tier")
        out[(norm(name), pos)] = {
            "ecr": ecr, "adp": adp,
            "tier": int(tier) if tier else None,
            "pos_rank": p.get("pos_rank"),
            # Display name + team are kept so a ranked player who ISN'T in the
            # nflverse base (every incoming rookie, since the base is built from
            # last season's stats) can be added to the pool rather than dropped.
            "name": name,
            "team": (p.get("player_team_id") or p.get("player_team")
                     or p.get("team") or "").upper(),
        }
    return out


def fetch_rankings(season: int, scoring: str = "HALF", api_key: str | None = None,
                   position: str = "ALL", week: int = 0) -> dict:
    """Fetch consensus rankings for a season. Returns parse_rankings() output."""
    api_key = api_key or os.getenv("FANTASYPROS_API_KEY")
    if not api_key:
        raise RuntimeError("FANTASYPROS_API_KEY not set")
    sc = SCORING.get(scoring.upper(), "HALF")
    url = BASE.format(season=season) + "?" + urlencode(
        {"position": position, "scoring": sc, "type": "draft", "week": week})
    req = urllib.request.Request(url, headers={
        "x-api-key": api_key,
        "Accept": "application/json",
        "User-Agent": "fantasy-draft-tool/1.0",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    return parse_rankings(data)


def parse_aav(data: dict, cap: float = 250.0) -> dict:
    """API JSON (type=auction pull) -> {(norm_name, pos): aav}.

    Only reads fields that are unambiguously DOLLAR values. Never fall back to
    rank-style fields (rank_ave etc.) — those are average expert RANKS, and
    treating them as prices poisons the market model ($500 "values" on deep
    players). `cap` drops implausible prices outright: no single player can
    cost more than a full team budget, so anything above it means we grabbed
    the wrong field and it's safer to store nothing (engine falls back to the
    modeled curve).
    """
    players = data.get("players") or data.get("rankings") or []
    out: dict[tuple, float] = {}
    for p in players:
        name = p.get("player_name") or p.get("name") or p.get("player")
        pos = (p.get("player_position_id") or p.get("position_id")
               or p.get("position") or p.get("pos") or "").upper()
        pos = re.sub(r"[^A-Z]", "", pos)
        if pos == "DEF":
            pos = "DST"
        if not name or pos not in ("QB", "RB", "WR", "TE", "K", "DST"):
            continue
        aav = _num(p, "auction_value", "player_auction_value", "avg_auction_value", "aav")
        if aav is not None and 0 < aav <= cap:
            out[(norm(name), pos)] = round(aav, 1)
    return out


def fetch_aav(season: int, scoring: str = "HALF", api_key: str | None = None,
             position: str = "ALL", week: int = 0) -> dict:
    """Auction values are NOT available on this API.

    The public v2 spec contains no auction endpoint and no auction field: the
    NFL ranking types are WW/WAIVER/ROS/DRAFT/PRESEASON/SLEEPERS/ADP/BEST/
    PROSPECT/PRO/DEVY/ROOKIES/DYNADP, with nothing auction-shaped among them.
    The old `type=auction` request was answered as an ordinary ranking pull,
    which is why it always parsed to zero rather than failing loudly.

    Kept as an explicit no-op so callers don't need branching and so this stays
    documented; `marketPrice()` falls back to its modeled price curve, which is
    what it already does whenever `aav` is null.
    """
    return {}


def _fetch_aav_unavailable(season: int, scoring: str = "HALF", api_key: str | None = None,
                           position: str = "ALL", week: int = 0) -> dict:
    """Previous implementation, retained for reference only."""
    api_key = api_key or os.getenv("FANTASYPROS_API_KEY")
    if not api_key:
        raise RuntimeError("FANTASYPROS_API_KEY not set")
    sc = SCORING.get(scoring.upper(), "HALF")
    url = BASE.format(season=season) + "?" + urlencode(
        {"position": position, "scoring": sc, "type": "auction", "week": week})
    req = urllib.request.Request(url, headers={
        "x-api-key": api_key,
        "Accept": "application/json",
        "User-Agent": "fantasy-draft-tool/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read()[:200].decode("utf-8", "replace")
        print(f"  ! AAV: HTTP {e.code} {body}")
        return {}
    got = parse_aav(data)
    if not got:
        print(describe_payload(data, "AAV parsed 0 rows"))
    return got


def _extract_stats(player: dict) -> dict:
    """Pull engine `proj` component stats from a FantasyPros projection row.

    Stats may be nested under "stats" or flat on the player object.
    """
    raw = player.get("stats")
    if isinstance(raw, dict):
        merged = raw
    elif isinstance(raw, list):
        # Spec models `stats` as an array whose items are the per-position stat
        # objects; flatten so a QB's and an RB's shapes both read the same.
        merged = {}
        for entry in raw:
            if isinstance(entry, dict):
                merged.update(entry)
    else:
        merged = player
    low = {str(k).lower(): v for k, v in merged.items()}
    out: dict[str, float] = {}
    for eng, syns in PROJ_FIELDS.items():
        val = 0.0
        for k in syns:
            if k in low and low[k] not in (None, "", "null"):
                try:
                    val = float(str(low[k]).replace(",", ""))
                except (TypeError, ValueError):
                    val = 0.0
                break
        out[eng] = val
    return out


def parse_projections(data: dict) -> dict:
    """API JSON -> {(norm_name, pos): {engine proj components}} for skill positions."""
    players = data.get("players") or data.get("projections") or []
    out: dict[tuple, dict] = {}
    for p in players:
        name = p.get("player_name") or p.get("name") or p.get("player")
        pos = re.sub(r"[^A-Z]", "",
                     (p.get("player_position_id") or p.get("position_id")
                      or p.get("position") or "").upper())
        if not name or pos not in ("QB", "RB", "WR", "TE"):
            continue
        out[(norm(name), pos)] = _extract_stats(p)
    return out


def fetch_projections(season: int, scoring: str = "HALF", api_key: str | None = None,
                      positions=("QB", "RB", "WR", "TE"), week: int = 0) -> dict:
    """Full-season component projections, merged across skill positions.

    Requested per position because the stat columns differ by position.
    """
    api_key = api_key or os.getenv("FANTASYPROS_API_KEY")
    if not api_key:
        raise RuntimeError("FANTASYPROS_API_KEY not set")
    sc = SCORING.get(scoring.upper(), "HALF")
    merged: dict[tuple, dict] = {}
    for pos in positions:
        url = PROJ_BASE.format(season=season) + "?" + urlencode(
            {"position": pos, "scoring": sc, "week": week})
        # Per-position, so one bad position can't silently zero the whole pull,
        # and paced because FantasyPros 429s a tight loop (see _get_json).
        data = _get_json(url, api_key, label=f"projections {season} {pos}")
        if data is None:
            continue
        time.sleep(RATE_LIMIT_PAUSE)
        got = parse_projections(data)
        if not got:
            print(describe_payload(data, f"projections {pos} parsed 0 rows"))
        merged.update(got)
    return merged


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Smoke-test a FantasyPros pull (needs FANTASYPROS_API_KEY).")
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--scoring", default="HALF")
    ap.add_argument("--what", choices=["rankings", "projections", "aav"], default="rankings")
    args = ap.parse_args()
    data = (fetch_projections(args.season, args.scoring) if args.what == "projections"
            else fetch_aav(args.season, args.scoring) if args.what == "aav"
            else fetch_rankings(args.season, args.scoring))
    print(f"pulled {len(data)} players ({args.what}); sample:")
    for k, v in list(data.items())[:5]:
        print(" ", k, v)


# ── injuries ────────────────────────────────────────────────────────────────
#
# GET /public/v2/json/nfl/injuries?year=&week=
# Response: {"injuries": [ {player_id, name, team_id, position_id, injury_type,
#            status, status_short, probability_of_playing, ...} ]}
#
# `status` is a closed enum in the spec, which is what makes this safe to act
# on rather than merely display: COV-IR, Doubtful, IR, Not Starting, OUT, PUP,
# Questionable, Suspended.

INJURY_BASE = "https://api.fantasypros.com/public/v2/json/nfl/injuries"

# How much each status should worry you on draft day. Season-ending or
# multi-week absences are a different thing from a Questionable tag.
INJURY_SEVERITY = {
    "IR": "out", "COV-IR": "out", "PUP": "out", "OUT": "out",
    "Suspended": "out", "Doubtful": "doubtful", "Questionable": "questionable",
    "Not Starting": "note",
}


def parse_injuries(data: dict) -> dict:
    """API JSON -> {(norm_name, pos): {status, short, type, severity, chance}}.

    Only the documented enum values map to a severity; anything unrecognised is
    still surfaced with severity "note" rather than dropped, because an unknown
    status is a reason to look, not a reason to hide the player's situation.
    """
    rows = data.get("injuries") or data.get("players") or []
    out: dict[tuple, dict] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        name = r.get("name") or r.get("player_name")
        pos = re.sub(r"[^A-Z]", "",
                     (r.get("position_id") or r.get("player_position_id") or "").upper())
        if pos == "DEF":
            pos = "DST"
        if not name or pos not in ("QB", "RB", "WR", "TE", "K", "DST"):
            continue
        status = (r.get("status") or "").strip()
        if not status:
            continue
        out[(norm(name), pos)] = {
            "status": status,
            "short": (r.get("status_short") or "").strip() or None,
            "type": (r.get("injury_type") or "").strip() or None,
            "severity": INJURY_SEVERITY.get(status, "note"),
            "chance": r.get("probability_of_playing"),
        }
    return out


def fetch_injuries(season: int, week: int = 0, api_key: str | None = None) -> dict:
    """Current injury statuses. Week 0 is the preseason/current report."""
    api_key = api_key or os.getenv("FANTASYPROS_API_KEY")
    if not api_key:
        raise RuntimeError("FANTASYPROS_API_KEY not set")
    url = INJURY_BASE + "?" + urlencode(
        {"year": season, "week": week, "include_probabilities": "true"})
    req = urllib.request.Request(url, headers={
        "x-api-key": api_key, "Accept": "application/json",
        "User-Agent": "fantasy-draft-tool/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read()[:200].decode("utf-8", "replace")
        print(f"  ! injuries: HTTP {e.code} {body}")
        return {}
    got = parse_injuries(data)
    if not got:
        print(describe_payload(data, "injuries parsed 0 rows"))
    return got

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
import re
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
    "rec":    ["rec", "receptions"],
    "recYd":  ["rec_yds", "receiving_yards", "rey"],
    "recTD":  ["rec_tds", "receiving_tds", "retd"],
    "fumbles":["fumbles", "fl", "fum_lost", "fumbles_lost"],
}

# scoring tokens the API accepts
SCORING = {"STD": "STD", "STANDARD": "STD", "HALF": "HALF", "HALF-PPR": "HALF",
           "PPR": "PPR"}

_SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b\.?", re.I)


def norm(n: str) -> str:
    """Match projections.py / matching.py normalization."""
    n = (n or "").lower()
    n = re.sub(r"[.'`’]", "", n)
    n = _SUFFIX.sub("", n)
    n = re.sub(r"[^a-z ]", " ", n)
    return re.sub(r"\s+", " ", n).strip()


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
        pos = (p.get("player_position_id") or p.get("position") or p.get("pos") or "").upper()
        pos = re.sub(r"[^A-Z]", "", pos)
        if pos == "DEF":
            pos = "DST"
        if not name or pos not in ("QB", "RB", "WR", "TE", "K", "DST"):
            continue
        ecr = _num(p, "rank_ecr", "ecr", "rank")
        adp = _num(p, "player_adp", "adp")  # only if the payload carries it
        tier = _num(p, "tier", "player_tier")
        out[(norm(name), pos)] = {
            "ecr": ecr, "adp": adp,
            "tier": int(tier) if tier else None,
            "pos_rank": p.get("pos_rank"),
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


def _extract_stats(player: dict) -> dict:
    """Pull engine `proj` component stats from a FantasyPros projection row.

    Stats may be nested under "stats" or flat on the player object.
    """
    s = player.get("stats") if isinstance(player.get("stats"), dict) else player
    low = {str(k).lower(): v for k, v in s.items()}
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
        pos = re.sub(r"[^A-Z]", "", (p.get("player_position_id") or p.get("position") or "").upper())
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
        req = urllib.request.Request(url, headers={
            "x-api-key": api_key, "Accept": "application/json",
            "User-Agent": "fantasy-draft-tool/1.0",
        })
        with urllib.request.urlopen(req, timeout=30) as r:
            merged.update(parse_projections(json.load(r)))
    return merged


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Smoke-test a FantasyPros pull (needs FANTASYPROS_API_KEY).")
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--scoring", default="HALF")
    ap.add_argument("--what", choices=["rankings", "projections"], default="rankings")
    args = ap.parse_args()
    data = fetch_projections(args.season, args.scoring) if args.what == "projections" \
        else fetch_rankings(args.season, args.scoring)
    print(f"pulled {len(data)} players ({args.what}); sample:")
    for k, v in list(data.items())[:5]:
        print(" ", k, v)

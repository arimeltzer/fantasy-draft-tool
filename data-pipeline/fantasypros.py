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


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Smoke-test a FantasyPros pull (needs FANTASYPROS_API_KEY).")
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--scoring", default="HALF")
    args = ap.parse_args()
    r = fetch_rankings(args.season, args.scoring)
    print(f"pulled {len(r)} ranked players; sample:")
    for k, v in list(r.items())[:5]:
        print(" ", k, v)

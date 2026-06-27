"""
integrations/matching.py
========================
Match a platform's roster entries to rows in `fantasy_players`. Platforms use
their own player ids; we key players by (name, pos, team), so importing anything
hinges on a forgiving name/team matcher.

Pure functions (no DB) so they can be fixture-tested: build an index from plain
player rows, then match NormPlayers against it.
"""
from __future__ import annotations

import re
import unicodedata

from .base import NormPlayer

# Suffixes and noise stripped before comparing names.
_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}

# Canonicalize NFL team abbreviations across platforms/eras.
_TEAM_ALIASES = {
    "JAC": "JAX", "WSH": "WAS", "LA": "LAR", "STL": "LAR", "SD": "LAC",
    "OAK": "LV", "ARZ": "ARI", "BLT": "BAL", "CLV": "CLE", "HST": "HOU",
    "GNB": "GB", "KAN": "KC", "NWE": "NE", "NOR": "NO", "SFO": "SF",
    "TAM": "TB", "LVR": "LV",
}


def normalize_team(team: str | None) -> str:
    t = (team or "").strip().upper()
    return _TEAM_ALIASES.get(t, t)


def normalize_name(name: str | None) -> str:
    if not name:
        return ""
    # strip accents, lowercase
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = s.lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[.'`]", "", s)        # d'andre -> dandre, t.j. -> tj
    s = re.sub(r"[^a-z0-9]+", " ", s)  # everything else -> space
    parts = [p for p in s.split() if p and p not in _SUFFIXES]
    return " ".join(parts)


def build_index(rows):
    """rows: iterable of objects/dicts with id, name, pos, team.

    Returns an index dict used by match_player().
    """
    def get(r, k):
        return r[k] if isinstance(r, dict) else getattr(r, k)

    by_name_pos: dict[tuple, list] = {}   # (norm_name, pos) -> [(id, team)]
    by_name: dict[str, list] = {}          # norm_name -> [(id, pos, team)]
    dst_by_team: dict[str, int] = {}       # team -> id (defenses)
    for r in rows:
        pid, name, pos, team = get(r, "id"), get(r, "name"), get(r, "pos"), get(r, "team")
        nn = normalize_name(name)
        nt = normalize_team(team)
        by_name_pos.setdefault((nn, pos), []).append((pid, nt))
        by_name.setdefault(nn, []).append((pid, pos, nt))
        if pos == "DST":
            # Team abbreviation is the reliable key for defenses (names vary too
            # much across platforms to risk fuzzy matching).
            dst_by_team[nt] = pid
    return {"by_name_pos": by_name_pos, "by_name": by_name, "dst_by_team": dst_by_team}


def match_player(index, np: NormPlayer) -> int | None:
    """Best-effort id for a NormPlayer; None if no confident match."""
    pos = (np.pos or "").upper()
    team = normalize_team(np.team)

    # Defenses: match on team abbreviation (names vary wildly across platforms).
    if pos == "DST":
        return index["dst_by_team"].get(team) if team else None

    nn = normalize_name(np.name)
    if not nn:
        return None

    cands = index["by_name_pos"].get((nn, pos), [])
    if len(cands) == 1:
        return cands[0][0]
    if len(cands) > 1:
        # disambiguate by team, else give up to avoid a wrong pick
        for pid, t in cands:
            if t and t == team:
                return pid
        return None

    # name matched but position differs (platform pos quirk) — accept if unique
    loose = index["by_name"].get(nn, [])
    if len(loose) == 1:
        return loose[0][0]
    for pid, p, t in loose:
        if t and t == team:
            return pid
    return None


def map_roster(index, players: list[NormPlayer]):
    """Returns (matched: [(NormPlayer, id)], unmatched: [NormPlayer])."""
    matched, unmatched = [], []
    for p in players:
        pid = match_player(index, p)
        (matched if pid is not None else unmatched).append((p, pid) if pid is not None else p)
    return matched, unmatched

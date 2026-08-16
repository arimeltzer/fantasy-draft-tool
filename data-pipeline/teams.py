"""
data-pipeline/teams.py
=====================
Canonical NFL team abbreviations for the pipeline.

`fantasy_players` is unique on `(season, name, pos, team)`, so the team code is
part of a player's IDENTITY in the database. Any source that spells a team
differently therefore creates a SECOND row for the same player — and a
duplicate on the draft board is worse than cosmetic: drafting one copy leaves
the other looking available, so the pool and every scarcity calculation drawn
from it are wrong for the rest of the draft.

Sources disagree in practice — nflverse has used ARI and ARZ across seasons,
FantasyPros and several feeds use AZ, JAC/JAX and WAS/WSH split the same way.
Everything is folded to the nflverse/ESPN spelling here, before insert.

Mirrors `backend/integrations/matching.py:_TEAM_ALIASES`; keep the two in step.
"""
from __future__ import annotations

TEAM_ALIASES = {
    # Arizona — the split that produced a duplicate on the live board.
    "AZ": "ARI", "ARZ": "ARI", "CRD": "ARI",
    # Jacksonville
    "JAC": "JAX",
    # Washington
    "WSH": "WAS", "WFT": "WAS", "OTI": "TEN",
    # Los Angeles / relocations
    "LA": "LAR", "STL": "LAR", "RAM": "LAR", "SD": "LAC", "SDG": "LAC",
    "OAK": "LV", "LVR": "LV", "RAI": "LV",
    # Pro-Football-Reference / older feed spellings
    "BLT": "BAL", "RAV": "BAL", "CLV": "CLE", "HST": "HOU", "HTX": "HOU",
    "GNB": "GB", "KAN": "KC", "NWE": "NE", "NOR": "NO", "SFO": "SF",
    "TAM": "TB", "NYG": "NYG", "NYJ": "NYJ",
}

# Every abbreviation we consider valid after normalization.
CANONICAL = {
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN",
    "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA",
    "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB",
    "TEN", "WAS",
}


def normalize_team(team: str | None) -> str:
    """Fold a team code to its canonical spelling. Unknown codes pass through
    upper-cased rather than being dropped — a free agent's empty team and a
    genuinely new abbreviation should both survive, just consistently."""
    t = (team or "").strip().upper()
    return TEAM_ALIASES.get(t, t)


def merge_player_rows(players: list[dict]) -> tuple[list[dict], list[str]]:
    """Collapse rows that are the same player once team codes are canonical.

    Returns (merged, notes). Later rows fill gaps in earlier ones rather than
    overwriting: the point is to end up with ONE row holding the union of what
    the sources knew, not to pick a winner and discard data.
    """
    by_key: dict[tuple[str, str, str], dict] = {}
    order: list[tuple[str, str, str]] = []
    notes: list[str] = []

    for p in players:
        team = normalize_team(p.get("team"))
        p = {**p, "team": team}
        key = ((p.get("name") or "").strip().lower(), p.get("pos", ""), team)
        if key not in by_key:
            by_key[key] = p
            order.append(key)
            continue
        kept = by_key[key]
        for field, value in p.items():
            if value in (None, "", {}, []):
                continue
            if kept.get(field) in (None, "", {}, []):
                kept[field] = value
        notes.append(f"{p.get('name')} ({p.get('pos')}) — merged duplicate rows into {team}")

    return [by_key[k] for k in order], notes

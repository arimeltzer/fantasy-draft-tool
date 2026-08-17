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


_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


# The nickname table lives with the backend matcher so there is one copy to
# edit; `name_parity.py` checks it against the TypeScript copy too.
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
from integrations.name_aliases import alias_name, same_team_or_unknown  # noqa: E402


def normalize_name(name: str | None) -> str:
    """Match `backend/integrations/matching.py:normalize_name` — accents, case,
    punctuation and Jr/III suffixes all folded away, whitespace collapsed."""
    import re
    import unicodedata
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[.\'`]", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(p for p in s.split() if p and p not in _SUFFIXES)


def merge_player_rows(players: list[dict]) -> tuple[list[dict], list[str]]:
    """Collapse rows that are the same player.

    Keyed on (normalized name, position) — deliberately NOT on team. Team was
    the first thing to disagree between sources (ARI vs AZ), but it is not the
    only one: a load where the roster fetch failed leaves `team` blank, and a
    blank-vs-ARI pair splits into two rows just as an alias pair does. Within a
    single season a name+position identifies one player, so that is the key,
    and the team is then reconciled to whichever spelling is real.

    Returns (merged, notes). Later rows fill gaps rather than overwriting: the
    goal is ONE row holding the union of what the sources knew.
    """
    by_key: dict[tuple[str, str], dict] = {}
    order: list[tuple[str, str]] = []
    notes: list[str] = []

    for p in players:
        p = {**p, "team": normalize_team(p.get("team"))}
        key = (normalize_name(p.get("name")), p.get("pos", ""))
        if not key[0]:
            continue
        if key not in by_key:
            by_key[key] = p
            order.append(key)
            continue
        kept = by_key[key]
        before_team = kept.get("team")
        for field, value in p.items():
            if value in (None, "", {}, []):
                continue
            if kept.get(field) in (None, "", {}, []):
                kept[field] = value
        after = kept.get("team")
        notes.append(
            f"{kept.get('name')} ({kept.get('pos')}) — merged duplicate rows"
            + (f" [{before_team or 'blank'} + {p.get('team') or 'blank'} -> {after}]"
               if before_team != p.get("team") else ""))

    rows = [by_key[k] for k in order]

    # SECOND PASS — the same player under a nickname in one feed and the legal
    # name in the other ("Josh Palmer" / "Joshua Palmer"). The pass above cannot
    # see these: the normalized names genuinely differ.
    #
    # This is an inference, not a normalization, so it demands more evidence.
    # Folding given names alone would also merge Michael Thomas (NO) into Mike
    # Thomas (LAR), who overlapped at the same position, so a row pair that
    # names two DIFFERENT teams is left alone. A split feed agrees on team or
    # leaves it blank; two different players usually do not. Getting this wrong
    # is worse than the duplicate it fixes — a duplicate is visible on the
    # board, a bad merge silently deletes a player — hence the extra gate.
    by_alias: dict[tuple[str, str], dict] = {}
    merged: list[dict] = []
    for p in rows:
        key = (alias_name(normalize_name(p.get("name"))), p.get("pos", ""))
        kept = by_alias.get(key)
        if kept is not None and same_team_or_unknown(kept.get("team"), p.get("team")):
            for field, value in p.items():
                if value in (None, "", {}, []):
                    continue
                if kept.get(field) in (None, "", {}, []):
                    kept[field] = value
            notes.append(
                f"{kept.get('name')} ({kept.get('pos')}) — merged nickname row "
                f"'{p.get('name')}'")
            continue
        if kept is None:
            by_alias[key] = p
        else:
            notes.append(
                f"{p.get('name')} ({p.get('pos')}) — NOT merged with "
                f"'{kept.get('name')}': different teams "
                f"({kept.get('team') or 'blank'} vs {p.get('team') or 'blank'})")
        merged.append(p)

    return merged, notes

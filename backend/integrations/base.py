"""
integrations/base.py
====================
Provider-agnostic, normalized representation of an imported fantasy league, plus
the shared constants both adapters (ESPN, Yahoo) translate into.

Every adapter's job is the same: turn a platform's idiosyncratic payload into a
`NormLeague` whose `.settings` already matches the app's LeagueSettings shape and
whose `.teams[].players` are plain (name, pos, team) — leaving player-id matching
and persistence to the import endpoint. Keeping adapters this thin is what lets
ESPN and Yahoo share one code path.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# Position buckets the rest of the app understands.
POSITIONS = ("QB", "RB", "WR", "TE", "K", "DST")

# Default roster shape (mirrors the app's LeagueSettings.roster); adapters
# overwrite the counts they can read and leave the rest at these defaults.
DEFAULT_ROSTER = {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 1,
                  "K": 1, "DST": 1, "BENCH": 6, "SF": 0}


@dataclass
class NormPlayer:
    name: str
    pos: str                      # one of POSITIONS
    team: str                     # NFL abbrev, best-effort ("" if unknown)
    ext_id: str | None = None     # platform player id (for reference/debug)
    bid: int | None = None        # auction price paid, if known
    round: int | None = None      # draft round, if known (snake keeper cost)


@dataclass
class NormTeam:
    name: str
    is_mine: bool = False
    players: list[NormPlayer] = field(default_factory=list)


@dataclass
class NormLeague:
    provider: str                 # "espn" | "yahoo"
    ext_id: str                   # platform league id/key
    name: str
    season: int
    fmt: str                      # "auction" | "snake"
    settings: dict                # app LeagueSettings shape
    teams: list[NormTeam] = field(default_factory=list)


def make_settings(*, teams: int, ppr: float, roster: dict, fmt: str,
                  budget: int = 200, superflex: bool = False,
                  draft_slot: int | None = None) -> dict:
    """Assemble an app-shaped LeagueSettings dict from adapter-extracted parts."""
    r = {**DEFAULT_ROSTER, **{k: int(v) for k, v in roster.items() if v is not None}}
    if superflex and r.get("SF", 0) < 1:
        r["SF"] = 1
    return {
        "teams": int(teams),
        "budget": int(budget) if fmt == "auction" else 200,
        "ppr": float(ppr),
        "roster": r,
        "superflex": bool(superflex),
        "draftSlot": int(draft_slot) if draft_slot else 1,
    }

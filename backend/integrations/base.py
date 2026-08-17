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
    waiver: int | None = None     # top FAAB/waiver claim spent to acquire, if any
    # Platform says this player CANNOT be kept again (e.g. Yahoo badges players
    # already kept, under a no-consecutive-years rule). Ground truth from the
    # source — stronger than inferring it from our own keeper rule — so the
    # recommender must exclude these rather than recommend an illegal keep.
    keeper_ineligible: bool = False


@dataclass
class NormTeam:
    name: str
    is_mine: bool = False
    players: list[NormPlayer] = field(default_factory=list)


@dataclass
class DraftPickRow:
    """One pick of a completed draft, whether or not the player is still rostered.

    `pos` is the field auction calibration needs and the one the draft endpoint
    does not supply — picks reference a platform player id only. It is resolved
    from the rosters where the player survived, and from a player-info lookup
    where they did not; `resolved` records which picks got an answer so a
    partial resolution is visible rather than silently shrinking the sample.
    """
    ext_id: str
    name: str = ""
    pos: str = ""
    team: str = ""
    bid: int | None = None
    round: int | None = None
    owner: str = ""
    resolved: bool = False


@dataclass
class NormLeague:
    provider: str                 # "espn" | "yahoo"
    ext_id: str                   # platform league id/key
    name: str
    season: int
    fmt: str                      # "auction" | "snake"
    settings: dict                # app LeagueSettings shape
    teams: list[NormTeam] = field(default_factory=list)
    meta: dict = field(default_factory=dict)   # adapter diagnostics (non-essential)
    # EVERY pick of the prior draft, including players later dropped.
    #
    # `teams` holds end-of-season ROSTERS, so a player who was drafted and then
    # cut vanishes from it entirely. That is fine for keeper eligibility — you
    # cannot keep someone you no longer roster — but it makes the roster list a
    # survivorship-biased sample of what the room PAID, which is what auction
    # price calibration learns from. This carries the draft itself, separately,
    # so the two questions are answered from the data that actually fits them.
    draft_picks: list[DraftPickRow] = field(default_factory=list)


def opponent_team_ids(teams: list[NormTeam]) -> tuple[list[str], dict[str, int]]:
    """Real opponent names (in stable NormLeague.teams order, "my" team
    excluded) plus a name -> index lookup — the index IS the DraftPick.team_id
    each opponent's picks should carry, and the list IS settings.opponents, so
    a picked team_id always resolves back to the label the user sees. A name
    clash keeps the first team's index (rare; opponents are typically unique
    league display names)."""
    names = [t.name for t in teams if not t.is_mine and t.name]
    by_name: dict[str, int] = {}
    for i, name in enumerate(names):
        by_name.setdefault(name, i)
    return names, by_name


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

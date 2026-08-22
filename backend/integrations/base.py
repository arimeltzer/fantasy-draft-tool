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
    # Platform's own team id, when the adapter has one. Only consumer today is
    # `resolve_my_team`'s exact tier, so a user who types their numeric ESPN
    # team id instead of its display name still resolves. Optional by design:
    # Yahoo identifies "mine" by manager guid, not by anything typed.
    ext_id: str | None = None


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
    # Overall pick number (nomination order for an auction), when the platform
    # supplies one — ESPN's `overallPickNumber`, with the same `roundId`/
    # `roundPickNumber` fallback `parse_live_draft` already uses when it's
    # absent. Confirmed real nomination order against a live multi-season pull
    # (data-pipeline/espn_draft_order_probe.py, see docs/ROADMAP.md 3.7) before
    # any caller relies on array/overall order meaning "who was bid on when".
    overall: int | None = None
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


def _fold_team_key(s: str) -> str:
    """Casefold and drop everything that isn't alphanumeric.

    Team display names are typed by humans on one platform and re-typed by a
    human into this app's import form, so they differ in exactly the ways
    punctuation and spacing differ: "Ari's Astounding Team" vs "Aris Astounding
    Team" vs "ari's  astounding team". Folding those away is safe here in a way
    it is NOT safe for PLAYER names (see playerName.ts / name_aliases.py —
    folding there can merge two real people). Two DIFFERENT teams in one league
    almost never collide under this fold, and the tiered matcher below refuses
    to guess when they do.
    """
    return "".join(c for c in (s or "").casefold() if c.isalnum())


def resolve_my_team_index(pairs: list[tuple[str | None, str]],
                          my_team: str | None) -> int | None:
    """Index of the user's own team among `(platform_id, display_name)` pairs.

    Tiered, weakest-tier-last, and refuses on ambiguity — the same discipline
    `matching.py` uses for players. Tiers: exact id/name, then punctuation- and
    case-folded name, then a UNIQUE substring either direction (so "Ari's
    Astounding" finds "Ari's Astounding Team", and vice versa).

    Why this matters more than it looks: when nothing matches, `is_mine` is
    False for EVERY team, so `opponent_team_ids` excludes nobody and an N-team
    league imports N opponents instead of N-1. The draft rooms then render
    "You" plus all N — the user's own team shown as a rival that never drafts
    anyone. That was a real, hit-in-practice bug from an exact-only match.

    Takes raw pairs rather than `NormTeam` so the LIVE draft path can share it:
    `parse_live_draft` works on raw payload dicts and had its own copy of the
    exact-only match, which is the same bug in a second place (a mock draft
    reported picks landing on the wrong team). `resolve_my_team` below is the
    `NormTeam` wrapper.
    """
    key = (my_team or "").strip()
    if not key:
        return None
    ids = [str(pid or "").strip().casefold() for pid, _ in pairs]
    names = [(name or "").strip() for _, name in pairs]

    # Tier 1 — exact, on the platform id or the display name.
    low = key.casefold()
    for i, (tid, name) in enumerate(zip(ids, names)):
        if low and (low == tid or low == name.casefold()):
            return i

    # Tier 2 — punctuation/spacing folded away. Unique match only.
    folded = _fold_team_key(key)
    if folded:
        hits = [i for i, name in enumerate(names) if _fold_team_key(name) == folded]
        if len(hits) == 1:
            return hits[0]

    # Tier 3 — unique substring, either direction. Ambiguity gives up rather
    # than picking one: attributing MY picks to a rival is worse than the
    # count being visibly wrong, which the rooms already warn about.
    if folded:
        hits = [i for i, name in enumerate(names)
                if (f := _fold_team_key(name)) and (folded in f or f in folded)]
        if len(hits) == 1:
            return hits[0]

    return None


def resolve_my_team(teams: list[NormTeam], my_team: str | None) -> int | None:
    """`resolve_my_team_index` over a list of NormTeam. See it for the tiers."""
    return resolve_my_team_index([(t.ext_id, t.name) for t in teams], my_team)


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

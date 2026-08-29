"""
integrations/live.py
===================
Live draft sync — pulling picks out of a draft that is happening right now.

**Polling, for both platforms — that's a deliberate scope limit, not "there
is no push channel."** Yahoo's `draftresults` genuinely has no push
alternative found so far. ESPN DOES have one — a WebSocket at
`wss://fantasydraft.espn.com/.../JOIN`, confirmed from a captured HAR of a
real draft (`espn_draft_ws.py`) — but its auth token isn't reproducible from
that capture alone, so it isn't wired into this module yet; see
`espn_draft_ws.py`'s docstring and CLAUDE.md. Until that's closed, ESPN
picks still come from `mDraftDetail`, which — also discovered via that same
HAR — is a static skeleton until the draft is FINALIZED, not a live feed;
polling it faster or smarter cannot produce live picks for a draft still in
progress. Yahoo's `draftresults` does fill in as a draft proceeds, so
polling it is the real mechanism there. The cadence, not the code, is Yahoo's
latency floor; ESPN's live-in-progress case is presently unsolved.

The join is the same on both platforms: the draft endpoint gives ORDER (overall
pick, round, owning team, auction price) but identifies players by the
platform's own id, while the roster endpoint gives NAMES for those ids. Neither
alone is enough, so each adapter fetches both and this module holds the shared
shape they produce.

Parsing is pure and fixture-tested; the network lives in the adapters.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class LivePick:
    """One pick as the platform reports it, before we map it to our own ids."""
    overall: int                      # overall pick number, 1-based
    name: str
    pos: str = ""
    team: str = ""                    # NFL team abbrev
    round: int | None = None
    owner: str | None = None          # fantasy team display name
    # The platform's own team id (ESPN numeric teamId, Yahoo team_key) behind
    # `owner`, when the source has one. This is the STABLE identifier a team
    # rename doesn't touch — `resolve_opponent_index` in base.py prefers it
    # over matching `owner` by name, which a "serious" rename can defeat even
    # with tiered fuzzy matching.
    owner_ext_id: str | None = None
    is_mine: bool = False
    bid: int | None = None            # auction price, when it's an auction


@dataclass
class LiveDraftState:
    picks: list[LivePick] = field(default_factory=list)
    fmt: str = "snake"
    meta: dict = field(default_factory=dict)

    @property
    def complete_through(self) -> int:
        """Highest contiguous overall pick seen — i.e. where the draft is now.
        Gaps mean the platform hasn't published something yet, so this is
        deliberately conservative rather than max(overall)."""
        seen = {p.overall for p in self.picks}
        n = 0
        while n + 1 in seen:
            n += 1
        return n


def order_picks(picks: list[LivePick]) -> list[LivePick]:
    """Ascending by overall pick. Platforms don't promise ordering, and a draft
    log that jumps around is worse than useless."""
    return sorted(picks, key=lambda p: p.overall)

"""
integrations/live.py
===================
Live draft sync — pulling picks out of a draft that is happening right now.

**There is no push channel here.** Neither platform exposes its draft room
socket publicly; both are polled. ESPN's `mDraftDetail` view and Yahoo's
`draftresults` endpoint both fill in as a draft proceeds, so a short poll gives
near-real-time picks. The cadence, not the code, is the latency floor.

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

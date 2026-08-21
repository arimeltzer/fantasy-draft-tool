"""
integrations/espn_draft_ws.py
==============================
ESPN's real live-draft channel. Confirmed from a captured HAR of a real
(mock) draft session — overturning this repo's earlier conclusion that ESPN
exposes no live feed at all for an in-progress draft. See CLAUDE.md's "Live
draft sync" section for the full history: four separate REST-side fixes
(roster top-up, placeholder-slot filtering, CDN cache-busting, fmt inference)
each addressed a real bug without resolving the actual symptom, because
`draftDetail.picks` (`integrations/live.py`'s whole approach) is a static
skeleton until the draft is FINALIZED — it was never going to carry live
picks no matter how the REST polling was tuned. This is what ESPN's own
draft-room page actually uses instead.

`wss://fantasydraft.espn.com/game-1/league-{leagueId}/JOIN?...` is a plain
line-based TEXT protocol (not JSON, not binary) — draft events arrive live,
one per line, the instant they happen in the draft room:

    NOMINATION <teamId> <clockMs>
    BID <teamId> <playerId> <amount> <clockMs> [<clockMs2>]
    SOLD <winningTeamId> <playerId> <?> <price> <flag>
    PASSED <teamId> <playerId> <auto:true|false>
    CLOCK <phase> <clockMs> [<teamId> <playerId> <amount>]   -- ticks ~1/sec
    JOINED <teamId> <swid>
    AUTODRAFT <teamId> <enabled:true|false>
    TOKEN <gameId:leagueId:teamId:swid:hash>
    PING <opaque>   -- client-initiated keepalive, ~every 15s in the capture
    PONG <opaque>   -- server echoes the same payload back
    INIT <opaque blob>   -- see "NOT solved" below

`SOLD` is the one that matters for sync: player id, winning team, price, live,
the moment ESPN's own draft room shows it.

**`SOLD`'s two team-id positions were WRONG in the first version of this
file and got corrected live, not from a second HAR.** The original guess —
`SOLD <nominatingTeamId> <playerId> <winningTeamId> <price> <flag>` — was
never independently verified against a known-correct answer; it just
looked plausible from the one captured example. A real user hit visibly
wrong team assignment mid-draft, and cross-checking three consecutive
`SOLD` lines against what ESPN's own room actually showed proved the FIRST
team-id position (originally labeled "nominating") was the true winning
bidder — constant across three different picks the same team won — while
the position originally labeled "winning" held values outside the
league's real 1-10 team-id range entirely. Player id and price positions
were independently confirmed correct in the same exchange and are
unchanged. The third position's true meaning is unconfirmed (kept as
`nominating_team_id` for the field name only — nothing downstream treats
it as authoritative for anything).

**The JOIN url's 5th query param is SOLVED — it isn't a guess or a derived
hash, it's a real ESPN endpoint.** It's a colon-joined
`gameId:leagueId:teamId:swid:<signed-32-bit-int>` token; the first attempt at
this (see CLAUDE.md) tried to reverse-engineer the trailing int as some
Java-`String.hashCode()`-style function of the SWID and got nowhere — because
it isn't derived client-side at all. A SECOND captured HAR (this one WITH
response bodies) showed the real mechanism: ESPN's own client calls
`GET .../seasons/{season}/segments/0/leagues/{leagueId}/teams/{teamId}/
draftSecurity` (`espn.fetch_draft_security()`, same espn_s2/SWID cookies
every other authenticated call here already uses) and gets back a bare
integer body — exactly the value that appears in the JOIN url. Two
independent real examples (different league, team, and resulting value) both
matched this mechanism exactly, which is what actually confirmed it, not
just the endpoint existing.

**What's still NOT solved, on purpose:** `INIT`'s blob. Sent once on connect,
presumably the full draft-so-far backfill in an undocumented binary encoding
(protobuf-shaped from a raw look at it). This module does not attempt to
decode it — a client that joins mid-draft only sees `SOLD` events from the
moment it connects forward, not the picks already made before that.
Acceptable for the forward-only use case this was built for; revisit only if
backfill turns out to matter in practice.

Wired into `sync_draft` via `backend/live_ws_registry.py`, which owns the
persistent per-league background task and its lifecycle — this module stays
the pure/testable layer (protocol parsing, event accumulation), same split
as `parse_live_draft` vs. `fetch_and_resolve_live_draft`. See CLAUDE.md for
status and `live_ws_registry.py`'s docstring for the wiring itself.
"""
from __future__ import annotations

import asyncio
import inspect
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from urllib.parse import unquote
from typing import Any

from .live import LiveDraftState, LivePick, order_picks

WS_HOST = "wss://fantasydraft.espn.com"
KEEPALIVE_SECONDS = 15  # matched to the capture: sends land ~15.0s apart


def parse_ws_line(line: str) -> dict[str, Any] | None:
    """One line of the draft-room protocol -> a typed dict, or None for a
    line this doesn't recognize. Never raises — an unrecognized or future
    message type should be skipped by the caller, not crash the listener."""
    line = line.strip()
    if not line:
        return None
    cmd, *rest = line.split(" ")
    try:
        if cmd == "SOLD" and len(rest) >= 5:
            # rest[0]/rest[2] were swapped from the original HAR-based guess
            # — confirmed WRONG live: a real user cross-checked against
            # ESPN's own draft room and rest[0] (originally labeled
            # "nominating") was the actual winning bidder for three
            # consecutive picks, while rest[2] (originally "winning") held
            # values outside the league's real team-id range entirely. The
            # field at rest[2]'s TRUE meaning is unconfirmed — kept as
            # `nominating_team_id` for backward field-name compatibility,
            # but nothing downstream treats it as authoritative for
            # anything (only `winning_team_id` drives owner/is_mine).
            return {"type": "sold", "nominating_team_id": int(rest[2]), "player_id": int(rest[1]),
                    "winning_team_id": int(rest[0]), "price": int(rest[3]), "flag": int(rest[4])}
        if cmd == "BID" and len(rest) >= 4:
            out: dict[str, Any] = {"type": "bid", "team_id": int(rest[0]), "player_id": int(rest[1]),
                                    "amount": int(rest[2]), "clock_ms": int(rest[3])}
            if len(rest) >= 5:
                out["clock_ms2"] = int(rest[4])
            return out
        if cmd == "NOMINATION" and len(rest) >= 2:
            return {"type": "nomination", "team_id": int(rest[0]), "clock_ms": int(rest[1])}
        if cmd == "PASSED" and len(rest) >= 3:
            return {"type": "passed", "team_id": int(rest[0]), "player_id": int(rest[1]),
                    "auto": rest[2] == "true"}
        if cmd == "CLOCK" and len(rest) >= 2:
            out = {"type": "clock", "phase": int(rest[0]), "clock_ms": int(rest[1])}
            if len(rest) >= 5:
                out.update(team_id=int(rest[2]), player_id=int(rest[3]), amount=int(rest[4]))
            return out
        if cmd == "JOINED" and len(rest) >= 2:
            return {"type": "joined", "team_id": int(rest[0]), "swid": rest[1]}
        if cmd == "AUTODRAFT" and len(rest) >= 2:
            return {"type": "autodraft", "team_id": int(rest[0]), "enabled": rest[1] == "true"}
        if cmd == "TOKEN" and rest:
            return {"type": "token", "raw": rest[0]}
        if cmd == "PING":
            return {"type": "ping", "payload": unquote(rest[0]) if rest else ""}
        if cmd == "PONG":
            return {"type": "pong", "payload": unquote(rest[0]) if rest else ""}
        if cmd == "INIT":
            return {"type": "init"}  # deliberately not decoded — see module docstring
    except (ValueError, IndexError):
        return None
    return None


def join_url(league_id: str, team_id: int, swid: str, join_hash: int,
             game: str = "game-1", nocache: int | None = None) -> str:
    """Builds the draft-room JOIN url. `join_hash` is the unverified trailing
    component of query param 5 — see module docstring; this function does not
    fabricate one."""
    swid_b = swid if swid.startswith("{") else "{" + swid + "}"
    token = f"1:{league_id}:{team_id}:{swid_b}:{join_hash}"
    nc = nocache if nocache is not None else int(time.time() * 1000) % 100000
    return (f"{WS_HOST}/{game}/league-{league_id}/JOIN"
            f"?1=1&2={league_id}&3={team_id}&4={swid_b}&5={token}&6=false&7=false&8=KONA&nocache={nc}")


async def watch_draft(league_id: str, season: int, team_id: int, swid: str, join_hash: int,
                      on_event: Callable[[dict[str, Any]], Awaitable[None] | None],
                      espn_s2: str | None = None, game: str = "game-1",
                      on_connect: Callable[[], None] | None = None,
                      connect_timeout: float = 5.0) -> None:
    """Connects to the live draft-room WebSocket and calls `on_event` for
    every parsed line until the connection closes or the caller cancels this
    coroutine. Called from `live_ws_registry.py`, not directly by any route.

    `on_connect`, if given, fires once the handshake actually succeeds — the
    caller uses this to distinguish "still trying to connect" from "attempt
    finished" in a way a bare boolean set before the attempt can't.
    `connect_timeout` bounds the handshake itself so a network black hole
    (egress blocked, DNS hanging, or ESPN's multi-location security kicking
    in) surfaces as a real, timely error instead of hanging the watcher task
    forever with no feedback. Default is 5.0s — short enough that a failed
    connection attempt doesn't trigger ESPN's session invalidation, but long
    enough for a real handshake to complete.

    Requires the `websockets` package (added to requirements.txt but not
    otherwise used in this repo yet, since nothing calls this function).
    """
    import websockets  # local import: keep this optional dependency out of
                        # every other module's import path until this ships

    url = join_url(league_id, team_id, swid, join_hash, game=game)
    swid_b = swid if swid.startswith("{") else "{" + swid + "}"
    headers = {"Cookie": f"SWID={swid_b}" + (f"; espn_s2={espn_s2}" if espn_s2 else ""),
               "Origin": "https://fantasy.espn.com"}

    # `extra_headers` — NOT `additional_headers` (that's a different, newer
    # websockets major-version API this pinned 13.1 doesn't have; passing it
    # here would TypeError on every single connection attempt, silently
    # indistinguishable from "never tried" without the `started` flag below).
    try:
        ws = await websockets.connect(url, extra_headers=headers, open_timeout=connect_timeout)
    except OSError as e:
        # TCP connection failed — likely ESPN's multi-location security blocking
        # at the socket level (connection refused, host unreachable, etc.)
        raise OSError(
            f"ESPN WebSocket connection blocked at TCP level. ESPN's multi-location security "
            f"may be preventing the backend server from connecting. Close the draft page or "
            f"try again in a few minutes. Original error: {type(e).__name__}"
        ) from e
    if on_connect is not None:
        on_connect()
    async with ws:
        async def _keepalive() -> None:
            while True:
                await asyncio.sleep(KEEPALIVE_SECONDS)
                await ws.send(f"PING PING%20{int(time.time() * 1000)}")

        pinger = asyncio.ensure_future(_keepalive())
        try:
            async for raw in ws:
                text = raw.decode() if isinstance(raw, bytes) else raw
                for line in text.splitlines():
                    msg = parse_ws_line(line)
                    if msg is None:
                        continue
                    result = on_event(msg)
                    if inspect.isawaitable(result):
                        await result
        finally:
            pinger.cancel()


@dataclass
class SoldEvent:
    """One `SOLD` line, already parsed. Arrival order IS draft order — the
    WebSocket delivers these live, one at a time, in the order they happen."""
    winning_team_id: int
    player_id: int
    price: int
    # Kept for diagnosing a wrong-team-assignment report live (was
    # discarded before) — the SOLD line's OTHER team-id field, in case
    # winning/nominating turn out to be mixed up somewhere for a
    # not-yet-explained reason. Not otherwise used in the picks pipeline.
    nominating_team_id: int = 0


def sold_events_to_picks(events: list[SoldEvent], pos_by_id: dict[int, dict],
                         teams_by_id: dict[int, str] | None = None,
                         my_team_id: int | None = None, start_overall: int = 1) -> list[LivePick]:
    """Turns accumulated SOLD events into `LivePick`s, resolving names from
    `pos_by_id` (the same `{id: {name, pos, team}}` shape `fetch_player_info`
    /`parse_player_info` already produce — SOLD carries no name, only ids).

    A player id `pos_by_id` doesn't know about yet is skipped, not guessed —
    the same "leave it for the next lookup" discipline `parse_live_draft`
    uses for an unresolved roster join. Overall pick numbers are assigned by
    ARRIVAL POSITION (`start_overall` + index), including for skipped events,
    so a pick that resolves on a later call still gets the number matching
    when it actually happened rather than being renumbered to fill a gap.
    """
    picks = []
    for i, ev in enumerate(events):
        info = pos_by_id.get(ev.player_id)
        if not info or not info.get("name"):
            continue
        picks.append(LivePick(
            overall=start_overall + i, name=info["name"], pos=info.get("pos", ""),
            team=info.get("team", ""), owner=(teams_by_id or {}).get(ev.winning_team_id),
            is_mine=(my_team_id is not None and ev.winning_team_id == my_team_id),
            bid=ev.price,
        ))
    return picks


class LiveDraftWatcher:
    """Pure accumulator for one draft's WebSocket session — no networking.
    `main.py`'s eventual live-sync route owns the actual connection (via
    `watch_draft`) and the player-name lookups (via `espn.fetch_player_info`);
    this class only tracks state and turns it into a `LiveDraftState` on
    request, which keeps the accumulation logic itself fully unit-testable
    without a live connection, same as `parse_live_draft` and `parse_ws_line`.
    """

    def __init__(self, my_team_id: int | None = None, teams_by_id: dict[int, str] | None = None,
                start_overall: int = 1) -> None:
        self.my_team_id = my_team_id
        self.teams_by_id = dict(teams_by_id or {})
        self.start_overall = start_overall
        self.events: list[SoldEvent] = []
        self.pos_by_id: dict[int, dict] = {}
        self._pending: set[int] = set()   # ids already flagged for lookup, not yet resolved
        self.started = False    # the background task has begun executing at all
        self.connected = False
        self.last_error: str | None = None
        # Set by the ingest path (live_ws_registry.py) when it couldn't
        # resolve team names/your team at all — this used to fail silently,
        # which hid the actual cause of "picks assigned to the wrong team /
        # not flagged as mine" for a real user until this field existed.
        self.team_resolution_error: str | None = None

    def on_event(self, msg: dict[str, Any]) -> int | None:
        """Feed one parsed message (from `parse_ws_line`) in. Returns the
        player id that now needs a name lookup, if this event introduced a
        new unresolved one — the caller batches these rather than looking
        one up per event. A pid already resolved OR already flagged (and not
        yet resolved by `add_player_info`) doesn't get re-flagged, so a burst
        of events for the same still-unresolved player doesn't fan out into
        redundant lookup requests.

        Deliberately does NOT dedupe by player id here — a repeat SOLD for
        an id already seen is appended as another `events` entry as-is
        (pinned by a selftest). Line-level dedup for a caller that might
        legitimately re-deliver the SAME event (browser-side batch resend,
        see `live_ws_registry.ingest_sold_event`) belongs at THAT caller,
        not baked into this shared accumulator that the live WebSocket path
        also uses."""
        if msg.get("type") != "sold":
            return None
        self.events.append(SoldEvent(winning_team_id=msg["winning_team_id"],
                                     player_id=msg["player_id"], price=msg["price"],
                                     nominating_team_id=msg.get("nominating_team_id", 0)))
        pid = msg["player_id"]
        if pid in self.pos_by_id or pid in self._pending:
            return None
        self._pending.add(pid)
        return pid

    def add_player_info(self, info: dict[int, dict]) -> None:
        """Merge a `fetch_player_info()` result in, once the caller has
        resolved whatever `on_event` flagged as unresolved."""
        self.pos_by_id.update(info)
        self._pending -= set(info.keys())

    def state(self) -> LiveDraftState:
        picks = order_picks(sold_events_to_picks(
            self.events, self.pos_by_id, self.teams_by_id, self.my_team_id, self.start_overall))
        fmt = "auction" if any(e.price for e in self.events) else "snake"
        return LiveDraftState(picks=picks, fmt=fmt, meta={
            "drafted": len(self.events), "resolved": len(picks),
            "started": self.started, "connected": self.connected, "last_error": self.last_error,
            "team_resolution_error": self.team_resolution_error,
            # Diagnostic for a wrong-team-assignment report — lets a human
            # (or us, reading the raw response) cross-check "ESPN's room
            # said Team X won this player" against exactly what numeric id
            # this app captured and what name it resolved that id to,
            # rather than guessing where a mismatch is coming from.
            "my_team_id": self.my_team_id,
            "teams_by_id": self.teams_by_id,
            "recent_events": [
                {"player_id": e.player_id, "nominating_team_id": e.nominating_team_id,
                 "winning_team_id": e.winning_team_id, "price": e.price,
                 "name": self.pos_by_id.get(e.player_id, {}).get("name")}
                for e in self.events[-10:]
            ],
        })

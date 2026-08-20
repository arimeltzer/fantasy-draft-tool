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
    SOLD <nominatingTeamId> <playerId> <winningTeamId> <price> <flag>
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

**What's NOT solved yet — deliberately left unguessed rather than shipped
wrong:**

1. **The JOIN url's 5th query param.** It's a colon-joined
   `gameId:leagueId:teamId:swid:<signed-32-bit-int>` token, and that trailing
   int isn't reproducible from anything visible in a HAR that has no response
   bodies (this repo's capture doesn't — no JS source, no earlier XHR that
   returns it). A best-effort Java-`String.hashCode()`-style guess over
   several candidate input strings (bare SWID, braced SWID, various
   `gameId:leagueId:teamId:swid` orderings, upper/lowercase) was tried against
   the ONE known example and none matched — and even a match wouldn't have
   been trustworthy from a single data point (32-bit hash space, real
   collision risk). `join_url()` below takes it as a REQUIRED external
   parameter; there is deliberately no `_guess_join_token()` here. Closing
   this needs either the actual JS source (capture "Save all as HAR with
   content", or set a breakpoint on `new WebSocket(...)` and read the call
   site) or a SECOND real `(leagueId, teamId, swid) -> token` example from a
   different draft to test hypotheses against two independent points instead
   of one.
2. **`INIT`'s blob.** Sent once on connect, presumably the full draft-so-far
   backfill in an undocumented binary encoding (protobuf-shaped from a raw
   look at it). This module does not attempt to decode it — a client that
   joins mid-draft only sees `SOLD` events from the moment it connects
   forward, not the picks already made before that. Acceptable for the
   forward-only use case this was built for; revisit only if backfill turns
   out to matter in practice.

Until (1) is resolved, nothing in this module is wired into `sync_draft` —
it's real, tested infrastructure sitting unused, same treatment this repo
gives other validated-but-not-integrated work (see CLAUDE.md's "Outcome
distributions" and "2.2b lineup optimizer" for the same pattern).
"""
from __future__ import annotations

import asyncio
import inspect
import time
from collections.abc import Awaitable, Callable
from urllib.parse import unquote
from typing import Any

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
            return {"type": "sold", "nominating_team_id": int(rest[0]), "player_id": int(rest[1]),
                    "winning_team_id": int(rest[2]), "price": int(rest[3]), "flag": int(rest[4])}
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
                      espn_s2: str | None = None, game: str = "game-1") -> None:
    """Connects to the live draft-room WebSocket and calls `on_event` for
    every parsed line until the connection closes or the caller cancels this
    coroutine. NOT wired into any route yet — see module docstring for why.

    Requires the `websockets` package (added to requirements.txt but not
    otherwise used in this repo yet, since nothing calls this function).
    """
    import websockets  # local import: keep this optional dependency out of
                        # every other module's import path until this ships

    url = join_url(league_id, team_id, swid, join_hash, game=game)
    swid_b = swid if swid.startswith("{") else "{" + swid + "}"
    headers = {"Cookie": f"SWID={swid_b}" + (f"; espn_s2={espn_s2}" if espn_s2 else ""),
               "Origin": "https://fantasy.espn.com"}

    async with websockets.connect(url, additional_headers=headers) as ws:
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

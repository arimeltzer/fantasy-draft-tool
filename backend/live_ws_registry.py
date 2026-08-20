"""
live_ws_registry.py
====================
Process-global registry of active ESPN live-draft WebSocket watchers, one per
league being synced. Lives outside `integrations/` because it's request-
lifecycle state (background asyncio tasks tied to this running process), not
a pure/testable parsing concern — those live in `integrations/espn_draft_ws.py`
and are fixture-tested there; this module is a thin, best-effort orchestration
layer over them.

**Single-process assumption.** Railway runs this app as one `uvicorn`
process (see `Procfile`/`nixpacks.toml` — no `--workers`), so an in-memory
dict keyed by our own league id is visible to every request. If that ever
changes (multiple workers/instances), this registry would need to move to
something shared (Redis, DB) — noted here so a future deploy-config change
doesn't silently break this instead of just not syncing.

A watcher that dies (bad auth, network drop, ESPN closing the connection) is
NOT retried automatically — the next `sync-draft` poll sees the dead task and
starts a fresh one, same "poll picks it back up" resilience this app already
leans on everywhere else. `last_error` rides along so a poll can see WHY the
previous attempt died instead of just silently getting zero picks again.
"""
from __future__ import annotations

import asyncio
import logging

from integrations import espn, espn_draft_ws

log = logging.getLogger(__name__)


class WatcherHandle:
    def __init__(self) -> None:
        self.watcher: espn_draft_ws.LiveDraftWatcher | None = None
        self.task: asyncio.Task | None = None
        self.start_error: str | None = None


_watchers: dict[int, WatcherHandle] = {}
_locks: dict[int, asyncio.Lock] = {}


async def _run(handle: WatcherHandle, ext_id: str, season: int, team_id: int, swid: str,
               join_hash: int, espn_s2: str | None) -> None:
    assert handle.watcher is not None
    watcher = handle.watcher
    watcher.started = True   # the task is executing, whether or not it connects
    watcher.last_error = None
    log.info(f"ESPN WebSocket watcher started for league {ext_id}, team {team_id}")

    async def on_event(msg: dict) -> None:
        pid = watcher.on_event(msg)
        if pid is None:
            return
        try:
            info, _diag = await espn.fetch_player_info(ext_id, season, [pid],
                                                        espn_s2=espn_s2, swid=swid)
            watcher.add_player_info(info)
        except Exception:  # noqa: BLE001 — a failed lookup retries on the next SOLD, not fatal
            pass

    def on_connect() -> None:
        watcher.connected = True
        log.info(f"ESPN WebSocket connected for league {ext_id}")

    try:
        await espn_draft_ws.watch_draft(ext_id, season, team_id, swid, join_hash, on_event,
                                        espn_s2=espn_s2, on_connect=on_connect)
        # watch_draft returned WITHOUT raising -> ESPN closed the socket on
        # its own. During an active draft that shouldn't happen, so this is
        # worth flagging rather than leaving last_error looking like nothing
        # went wrong at all.
        watcher.last_error = "WebSocket closed by ESPN (no exception raised)."
        log.warning(f"WebSocket closed unexpectedly for league {ext_id}")
    except asyncio.TimeoutError as exc:
        # Connection attempt timed out — likely ESPN's multi-location security
        # kicking in (backend server IP differs from browser IP). Fallback to
        # REST polling will happen automatically; document this for the user.
        watcher.last_error = (
            "Live WebSocket connection timed out (ESPN may have multi-location "
            "login protection active). Using REST polling instead — close your "
            "draft page or minimize interaction with it while syncing."
        )
        log.warning(f"WebSocket timeout for league {ext_id}: {exc}")
    except Exception as exc:  # noqa: BLE001 — surfaced via last_error, never crashes the app
        watcher.last_error = f"{type(exc).__name__}: {exc}"
        log.error(f"WebSocket error for league {ext_id}: {type(exc).__name__}: {exc}")
    finally:
        watcher.connected = False


async def ensure_watcher(league_id: int, ext_id: str, season: int, my_team: str | None,
                         espn_s2: str | None, swid: str | None,
                         start_overall: int = 1) -> WatcherHandle:
    """Returns the running watcher for this league, starting one if none is
    alive. Safe to call on every poll — a lock scoped per league id makes
    concurrent polls converge on one watcher instead of racing to start two.
    `start_overall` only matters the moment a NEW watcher is created; it's
    ignored (along with every other param but `league_id`) once one is
    already running, since re-numbering picks already accumulated would
    shift overall numbers the caller may already have persisted."""
    lock = _locks.setdefault(league_id, asyncio.Lock())
    async with lock:
        existing = _watchers.get(league_id)
        if existing and existing.task is not None and not existing.task.done():
            log.debug(f"Reusing existing watcher for league {league_id}")
            return existing

        if existing and existing.task and existing.task.done():
            log.info(f"Previous watcher task finished for league {league_id}; starting new one")

        handle = WatcherHandle()
        _watchers[league_id] = handle

        if not (swid and espn_s2):
            handle.start_error = "espn_s2 and SWID are required for live WebSocket sync."
            log.warning(f"League {league_id}: missing espn_s2 or SWID")
            return handle

        # Two separate calls, two separate try/excepts — `fetch_raw_league`
        # and `fetch_draft_security` both raise the SAME PermissionError
        # message on any 401/403, which made an earlier version of this
        # error message useless for telling "cookies are bad" (both calls
        # would fail) apart from "resolved the wrong team id, and ESPN
        # rejects draftSecurity for a team the SWID doesn't own" (only the
        # second call fails) — a real, materially different diagnosis.
        try:
            data = await espn.fetch_raw_league(ext_id, season, espn_s2=espn_s2, swid=swid)
            log.info(f"League {league_id}: fetched raw league data")
        except Exception as exc:  # noqa: BLE001 — reported via start_error, caller falls back
            handle.start_error = f"league fetch failed: {type(exc).__name__}: {exc}"
            log.error(f"League {league_id}: {handle.start_error}")
            return handle

        teams_by_id, my_team_id = espn.resolve_team_ids(data, my_team)
        if my_team_id is None:
            handle.start_error = (f"Couldn't match my_team {my_team!r} to a team in this league. "
                                  f"Known teams: {sorted(teams_by_id.values())}")
            log.warning(f"League {league_id}: {handle.start_error}")
            return handle
        try:
            join_hash = await espn.fetch_draft_security(ext_id, season, my_team_id,
                                                        espn_s2=espn_s2, swid=swid)
            log.info(f"League {league_id}: fetched draft security token for team {my_team_id}")
        except Exception as exc:  # noqa: BLE001 — reported via start_error, caller falls back
            handle.start_error = (f"draftSecurity failed for team_id={my_team_id} "
                                  f"({teams_by_id.get(my_team_id)!r}): {type(exc).__name__}: {exc}")
            log.error(f"League {league_id}: {handle.start_error}")
            return handle

        handle.watcher = espn_draft_ws.LiveDraftWatcher(my_team_id=my_team_id, teams_by_id=teams_by_id,
                                                        start_overall=start_overall)
        handle.task = asyncio.ensure_future(
            _run(handle, ext_id, season, my_team_id, swid, join_hash, espn_s2))
        log.info(f"League {league_id}: watcher created and task scheduled")
        return handle


def stop_watcher(league_id: int) -> bool:
    """Cancels and drops the watcher for this league, if any. Returns whether
    one was actually running."""
    handle = _watchers.pop(league_id, None)
    if handle and handle.task and not handle.task.done():
        handle.task.cancel()
        return True
    return False

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

from integrations import espn, espn_draft_ws


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
    watcher.connected = True
    watcher.last_error = None

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

    try:
        await espn_draft_ws.watch_draft(ext_id, season, team_id, swid, join_hash,
                                        on_event, espn_s2=espn_s2)
    except Exception as exc:  # noqa: BLE001 — surfaced via last_error, never crashes the app
        watcher.last_error = f"{type(exc).__name__}: {exc}"
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
            return existing

        handle = WatcherHandle()
        _watchers[league_id] = handle

        if not (swid and espn_s2):
            handle.start_error = "espn_s2 and SWID are required for live WebSocket sync."
            return handle
        try:
            data = await espn.fetch_raw_league(ext_id, season, espn_s2=espn_s2, swid=swid)
            teams_by_id, my_team_id = espn.resolve_team_ids(data, my_team)
            if my_team_id is None:
                handle.start_error = f"Couldn't match my_team {my_team!r} to a team in this league."
                return handle
            join_hash = await espn.fetch_draft_security(ext_id, season, my_team_id,
                                                        espn_s2=espn_s2, swid=swid)
        except Exception as exc:  # noqa: BLE001 — reported via start_error, caller falls back
            handle.start_error = f"{type(exc).__name__}: {exc}"
            return handle

        handle.watcher = espn_draft_ws.LiveDraftWatcher(my_team_id=my_team_id, teams_by_id=teams_by_id,
                                                        start_overall=start_overall)
        handle.task = asyncio.ensure_future(
            _run(handle, ext_id, season, my_team_id, swid, join_hash, espn_s2))
        return handle


def stop_watcher(league_id: int) -> bool:
    """Cancels and drops the watcher for this league, if any. Returns whether
    one was actually running."""
    handle = _watchers.pop(league_id, None)
    if handle and handle.task and not handle.task.done():
        handle.task.cancel()
        return True
    return False

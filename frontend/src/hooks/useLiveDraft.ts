import { useCallback, useEffect, useRef, useState } from "react";
import { api, LiveSyncResult } from "@/lib/api";
import { yahooAccessToken, loadYahooSession } from "@/lib/yahooAuth";

export interface LiveDraftConfig {
  provider: "espn" | "yahoo";
  extId: string;
  season?: number;
  matchSeason?: number;
  espnS2?: string;
  swid?: string;
  myTeam?: string;
}

export interface LiveDraftStatus {
  running: boolean;
  lastSyncAt: string | null;
  lastResult: LiveSyncResult | null;
  error: string | null;
  totalAdded: number;
  busy: boolean;
}

/**
 * Poll a live draft and log new picks.
 *
 * Neither ESPN nor Yahoo exposes its draft-room push channel, so this is a
 * poll loop — the interval, not the code, is the latency floor. The sync
 * endpoint is idempotent by player, so a slow or duplicated round is harmless.
 *
 * A tick is skipped while the previous one is still in flight: a draft server
 * having a slow moment shouldn't queue up a pile of overlapping requests.
 */
export function useLiveDraft(
  leagueId: number,
  config: LiveDraftConfig | null,
  intervalMs = 10_000,
  onPicks?: () => void,
) {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<Omit<LiveDraftStatus, "running">>({
    lastSyncAt: null, lastResult: null, error: null, totalAdded: 0, busy: false,
  });
  const inFlight = useRef(false);
  const onPicksRef = useRef(onPicks);
  onPicksRef.current = onPicks;

  // `overrideConfig` lets a caller (the "Sync now" button, e.g.) fire an
  // immediate sync with a config that hasn't been committed to this hook's
  // own `config` param yet — that commit happens through the PARENT's state
  // setter, which is async/batched, so a synchronous `syncOnce()` call right
  // after setting it would otherwise still see last render's stale value.
  const syncOnce = useCallback(async (apply = true, overrideConfig?: LiveDraftConfig) => {
    const cfg = overrideConfig ?? config;
    if (!cfg || inFlight.current) return;
    inFlight.current = true;
    setStatus((s) => ({ ...s, busy: true }));
    try {
      let accessToken: string | undefined;
      let myGuid: string | undefined;
      if (cfg.provider === "yahoo") {
        const t = await yahooAccessToken();
        if (!t) throw new Error("Yahoo session expired — reconnect in the Keepers panel.");
        accessToken = t;
        myGuid = loadYahooSession()?.guid;
      }
      const res = await api.syncDraft(leagueId, {
        provider: cfg.provider,
        ext_id: cfg.extId,
        season: cfg.season ?? 2026,
        match_season: cfg.matchSeason ?? 2026,
        access_token: accessToken,
        my_guid: myGuid,
        espn_s2: cfg.espnS2 || undefined,
        swid: cfg.swid || undefined,
        my_team: cfg.myTeam || undefined,
        apply,
      });
      setStatus((s) => ({
        ...s,
        lastSyncAt: new Date().toISOString(),
        lastResult: res,
        error: null,
        totalAdded: s.totalAdded + (res.applied ? res.added_count : 0),
        busy: false,
      }));
      if (res.applied && res.added_count > 0) onPicksRef.current?.();
    } catch (e) {
      setStatus((s) => ({
        ...s, busy: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      inFlight.current = false;
    }
  }, [leagueId, config]);

  useEffect(() => {
    if (!running || !config) return;
    void syncOnce(true);                       // don't wait a full interval to start
    const id = setInterval(() => void syncOnce(true), intervalMs);
    return () => clearInterval(id);
  }, [running, config, intervalMs, syncOnce]);

  return {
    ...status,
    running,
    start: () => setRunning(true),
    stop: () => setRunning(false),
    toggle: () => setRunning((v) => !v),
    syncOnce,
  };
}

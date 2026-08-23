import { useEffect, useMemo, useState } from "react";
import { Radio, Loader2, AlertTriangle, Pause, Play, RefreshCw, X, Link2, Download } from "lucide-react";
import { LeagueSettings, api, BASE } from "@/lib/api";
import { useLiveDraft, LiveDraftConfig } from "@/hooks/useLiveDraft";
import { yahooConnected } from "@/lib/yahooAuth";
import { loadEspnCreds, saveEspnCreds } from "@/lib/espnAuth";
import EspnCredsNote from "@/components/shared/EspnCredsNote";
import { buildBookmarklet, downloadUserscript } from "@/lib/liveBookmarklet";

interface Props {
  leagueId: number;
  settings: LeagueSettings;
  onClose: () => void;
  // Lifted up to the room component (AuctionRoom/SnakeRoom) rather than
  // owned here — the hook instance used to live INSIDE this panel, so
  // closing it (unmounting) killed the poll along with it. A user who closes
  // this to get back to drafting is exactly the person who wants syncing to
  // keep running, not the person telling it to stop. See ROADMAP-adjacent
  // note in AuctionRoom.tsx/SnakeRoom.tsx where the hook is now instantiated.
  live: ReturnType<typeof useLiveDraft>;
  config: LiveDraftConfig | null;
  onConfigChange: (c: LiveDraftConfig | null) => void;
  intervalMs: number;
  onIntervalChange: (ms: number) => void;
}

const INTERVALS = [
  { label: "5s", ms: 5_000 },
  { label: "10s", ms: 10_000 },
  { label: "30s", ms: 30_000 },
];

/**
 * Follow a draft that's happening on ESPN/Yahoo and log picks automatically.
 *
 * This is polling, not a push feed — neither platform publishes its draft-room
 * socket — so the interval is the latency, and the panel says so rather than
 * implying picks arrive the instant they're made.
 *
 * This component is a CONTROLLER for the lifted `live` hook, not its owner —
 * closing this panel (via the × button) only hides the UI. Syncing keeps
 * running in the background, visible via the "live" indicator on the room's
 * header "Live" button.
 */
export default function LiveDraftPanel({ leagueId, settings, onClose, live, config, onConfigChange, intervalMs, onIntervalChange }: Props) {
  const source = settings.source;
  const [provider, setProvider] = useState<"espn" | "yahoo">(
    config?.provider ?? (source?.provider === "yahoo" ? "yahoo" : "espn"));
  const [extId, setExtId] = useState(config?.extId ?? source?.extId ?? "");
  const [myTeam, setMyTeam] = useState(config?.myTeam ?? "");
  // `config` wins when the parent already has a live config in memory;
  // otherwise fall back to the browser-stored pair. `liveConfig` is plain
  // component state that starts null on every page load, so without this
  // fallback the cookies had to be re-pasted for every draft session.
  const [s2, setS2] = useState(() => config?.espnS2 ?? loadEspnCreds()?.espnS2 ?? "");
  const [swid, setSwid] = useState(() => config?.swid ?? loadEspnCreds()?.swid ?? "");

  // What the FORM currently describes — not yet committed to the parent
  // (and therefore not yet what `live` is actually polling with) until
  // "Start watching" or "Sync now" is pressed.
  const formConfig: LiveDraftConfig | null = useMemo(
    () => (extId.trim()
      ? { provider, extId: extId.trim(), espnS2: s2, swid, myTeam }
      : null),
    [provider, extId, s2, swid, myTeam],
  );

  const res = live.lastResult;
  const yahooReady = provider !== "yahoo" || yahooConnected();

  // Remember cookies that demonstrably WORKED. A sync that came back with a
  // result (rather than setting `live.error`) is ESPN having accepted them,
  // which is a stronger signal than the user having typed something. Covers
  // both "Sync now" and "Start watching" without either button needing to
  // know about credential storage. `saveEspnCreds` no-ops unless both halves
  // are present, so a public league syncing with empty fields stores nothing.
  useEffect(() => {
    if (provider === "espn" && res && !live.error) saveEspnCreds(s2, swid);
  }, [res, live.error, provider, s2, swid]);

  // Bookmarklet / userscript — see live_ws_registry.py "Browser-side ingest"
  // and liveBookmarklet.ts for the full why. Built on demand (not on mount)
  // since it needs a real ext_id typed into the form first.
  //
  // The bookmarklet has a real, hit-in-practice limitation: patching
  // window.WebSocket only affects connections opened AFTER the click, and
  // reloading the page to catch an already-open socket wipes the patch
  // right back out (in-memory page state, not persistent) — so it can only
  // win an unreliable race against ESPN's own script on that reload. The
  // userscript (Tampermonkey, @run-at document-start) doesn't have this
  // problem at all — it's the one to reach for once that's been hit.
  const [bookmarkletHref, setBookmarkletHref] = useState<string | null>(null);
  const [bookmarkletBusy, setBookmarkletBusy] = useState(false);
  const [bookmarkletError, setBookmarkletError] = useState<string | null>(null);
  const [userscriptBusy, setUserscriptBusy] = useState(false);
  const [userscriptError, setUserscriptError] = useState<string | null>(null);
  const [userscriptDone, setUserscriptDone] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopMsg, setStopMsg] = useState<string | null>(null);

  function ingestConfig(token: string) {
    return {
      apiUrl: BASE, leagueId, token, extId: extId.trim(), season: 2026,
      espnS2: s2 || undefined, swid: swid || undefined, myTeam: myTeam || undefined,
      startOverall: 1,
    };
  }

  async function makeBookmarklet() {
    if (!extId.trim()) return;
    setBookmarkletBusy(true);
    setBookmarkletError(null);
    try {
      const { token } = await api.getLiveIngestToken(leagueId);
      setBookmarkletHref(buildBookmarklet(ingestConfig(token)));
    } catch (e) {
      setBookmarkletError(e instanceof Error ? e.message : String(e));
    } finally {
      setBookmarkletBusy(false);
    }
  }

  async function makeUserscript() {
    if (!extId.trim()) return;
    setUserscriptBusy(true);
    setUserscriptError(null);
    setUserscriptDone(false);
    try {
      const { token } = await api.getLiveIngestToken(leagueId);
      downloadUserscript(ingestConfig(token));
      setUserscriptDone(true);
    } catch (e) {
      setUserscriptError(e instanceof Error ? e.message : String(e));
    } finally {
      setUserscriptBusy(false);
    }
  }

  async function stopBackendWatcher() {
    setStopBusy(true);
    setStopMsg(null);
    try {
      const { stopped } = await api.stopLiveWatcher(leagueId);
      setStopMsg(stopped ? "Stopped." : "Nothing was running.");
    } catch (e) {
      setStopMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setStopBusy(false);
    }
  }

  // Backfill — for picks made BEFORE the live channel connected (e.g.
  // joining an already-in-progress draft late). One-shot REST catch-up, not
  // continuous — see LiveDraftRequest.backfill's docstring on the backend
  // for why this can resolve OLDER picks even though the same REST path is
  // a confirmed dead end for LIVE ones.
  const [backfillBusy, setBackfillBusy] = useState(false);

  async function runBackfill() {
    setBackfillBusy(true);
    try {
      await live.syncOnce(true, formConfig ?? undefined, true);
    } finally {
      setBackfillBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4">
      <div className="mt-10 w-full max-w-lg rounded-xl border border-line bg-surface shadow-xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Radio className={`h-4 w-4 ${live.running ? "text-emerald-600" : "text-faint"}`} />
          <h2 className="text-sm font-semibold tracking-tight">Live draft sync</h2>
          {live.running && (
            <span className="flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-2xs text-emerald-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> watching
            </span>
          )}
          <button onClick={onClose} className="ml-auto rounded-lg p-1 text-muted hover:bg-hover">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-3">
          <p className="text-2xs leading-snug text-muted">
            Picks are <span className="text-ink">polled</span>, not pushed — neither platform
            offers a live feed to outside apps, so new picks show up within one interval of being
            made. Everything you log by hand still works; syncing only adds picks that aren't
            already on the board. {live.running && "Closing this window does NOT stop it — "}
            {live.running && <span className="text-emerald-700 font-medium">it keeps polling in the background</span>}
            {live.running && "; the \"Live\" button up top shows it's still active."}
          </p>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs">
              <span className="mb-1 block text-muted">Platform</span>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as "espn" | "yahoo")}
                className="w-full rounded-lg border border-line bg-surface px-2 py-1 text-ink focus:border-faint focus:outline-none"
              >
                <option value="espn">ESPN</option>
                <option value="yahoo">Yahoo</option>
              </select>
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-muted">
                {provider === "yahoo" ? "League key" : "League ID"}
              </span>
              <input
                value={extId}
                onChange={(e) => setExtId(e.target.value)}
                placeholder={provider === "yahoo" ? "461.l.82486" : "123456"}
                className="w-full rounded-lg border border-line bg-surface px-2 py-1 font-mono text-ink focus:border-faint focus:outline-none"
              />
            </label>
          </div>

          <label className="block text-xs">
            <span className="mb-1 block text-muted">
              Your team <span className="text-faint">
                {provider === "yahoo" ? "(detected from your Yahoo login)" : "(name or team id — marks your picks)"}
              </span>
            </span>
            {provider === "espn" && (
              <input
                value={myTeam}
                onChange={(e) => setMyTeam(e.target.value)}
                placeholder="Team Ari"
                className="w-full rounded-lg border border-line bg-surface px-2 py-1 text-ink focus:border-faint focus:outline-none"
              />
            )}
            {provider === "yahoo" && !yahooConnected() && (
              <span className="block rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-2xs text-amber-800">
                Not connected to Yahoo — open Keepers → "Yahoo — pull last season from the API"
                and connect once. The same session is used here.
              </span>
            )}
          </label>

          {provider === "espn" && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted hover:text-ink">
                Private ESPN league? Add cookies
              </summary>
              <div className="mt-2 grid gap-2">
                <input value={s2} onChange={(e) => setS2(e.target.value)} placeholder="espn_s2"
                  className="w-full rounded-lg border border-line bg-surface px-2 py-1 font-mono text-2xs text-ink focus:border-faint focus:outline-none" />
                <input value={swid} onChange={(e) => setSwid(e.target.value)} placeholder="{SWID}"
                  className="w-full rounded-lg border border-line bg-surface px-2 py-1 font-mono text-2xs text-ink focus:border-faint focus:outline-none" />
                <EspnCredsNote />
              </div>
            </details>
          )}

          {provider === "espn" && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs">
              <div className="flex items-center gap-1.5 font-medium text-emerald-800">
                <Download className="h-3.5 w-3.5" /> Tampermonkey script (recommended)
              </div>
              <p className="mt-1 text-2xs leading-snug text-emerald-800/80">
                Reads picks straight off ESPN's own draft-room connection, from inside your
                browser tab — doesn't touch ESPN's login/session at all, so it can't trigger the
                multi-location kick a server-side connection can. Runs automatically on every
                page load (needs the free{" "}
                <a href="https://www.tampermonkey.net/" target="_blank" rel="noreferrer"
                  className="underline">Tampermonkey</a> extension — one-time install if you
                don't have it). Requires the League ID above.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => void makeUserscript()}
                  disabled={!extId.trim() || userscriptBusy}
                  className="flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-2.5 py-1.5 text-2xs font-medium text-emerald-800 hover:border-emerald-400 disabled:opacity-50"
                >
                  {userscriptBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  Download script
                </button>
                {userscriptDone && <span className="text-2xs text-emerald-700">Downloaded ✓</span>}
              </div>
              {userscriptDone && (
                <p className="mt-1.5 text-2xs leading-snug text-emerald-800/70">
                  Don't double-click the downloaded file — Windows may try to run it itself and
                  fail with a syntax error. Instead: Tampermonkey icon → Dashboard → Utilities →
                  "Import from file" → pick <code>fantasy-live-sync.user.js</code>. Then, on
                  recent Chrome, go to <code>chrome://extensions</code> and turn on both{" "}
                  <span className="font-medium">"Allow User Scripts"</span> (a separate
                  Chrome-level toggle Tampermonkey needs, independent of site permissions) and,
                  under Tampermonkey's own Details, <span className="font-medium">Site
                  access: "On all sites"</span>. Reload your ESPN draft tab once — it runs
                  automatically after that, no re-clicking anything.
                </p>
              )}
              {userscriptError && (
                <p className="mt-1.5 text-2xs text-rose-700">{userscriptError}</p>
              )}
            </div>
          )}

          {provider === "espn" && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => void runBackfill()}
                disabled={!formConfig || backfillBusy}
                className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-2xs text-muted hover:border-faint disabled:opacity-50"
              >
                {backfillBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Backfill prior picks
              </button>
              <span className="text-2xs text-faint">
                For picks made before you connected — e.g. joining a draft already in progress.
                One-shot, not automatic.
              </span>
            </div>
          )}
          {res?.meta.backfill_resolved !== undefined && (
            <p className="text-2xs text-muted">
              ESPN's roster view has {res.meta.backfill_resolved} pick{res.meta.backfill_resolved === 1 ? "" : "s"} resolved
              (new ones just added show below). Picks made very recently may not have caught up
              there yet — try again in a minute if any are still missing.
            </p>
          )}
          {res?.meta.backfill_error && (
            <p className="text-2xs text-rose-600">Backfill failed: {res.meta.backfill_error}</p>
          )}

          {provider === "espn" && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted hover:text-ink">
                Prefer a bookmarklet instead (no extension)?
              </summary>
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
                <p className="text-2xs leading-snug text-amber-900">
                  <span className="font-medium">Known limitation:</span> this only catches
                  connections opened AFTER you click it. If the draft room's socket is already
                  open, reloading to catch a fresh one also wipes the click's effect — you'd be
                  racing ESPN's own script on that reload, which is unreliable by hand. Use the
                  Tampermonkey script above if you hit this.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => void makeBookmarklet()}
                    disabled={!extId.trim() || bookmarkletBusy}
                    className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 text-2xs font-medium text-amber-800 hover:border-amber-400 disabled:opacity-50"
                  >
                    {bookmarkletBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />}
                    {bookmarkletHref ? "Regenerate" : "Get bookmarklet"}
                  </button>
                  {bookmarkletHref && (
                    <a
                      href={bookmarkletHref}
                      onClick={(e) => {
                        // A javascript: href only does anything when dragged to
                        // a bookmarks bar and clicked FROM there (on ESPN's
                        // page) — clicking it here, still on our own site,
                        // would run the hook against the wrong page. Block
                        // that and say so, rather than let it silently no-op.
                        e.preventDefault();
                        alert("Drag this link to your bookmarks bar first, then click it from "
                          + "the ESPN draft room tab — clicking it here won't do anything.");
                      }}
                      draggable
                      className="cursor-grab rounded-lg border border-amber-300 bg-amber-100 px-2.5 py-1.5 text-2xs font-medium text-amber-900 active:cursor-grabbing"
                      title="Drag me to your bookmarks bar"
                    >
                      🖐 Drag to bookmarks bar: Fantasy Live Sync
                    </a>
                  )}
                </div>
                {bookmarkletError && (
                  <p className="mt-1.5 text-2xs text-rose-700">{bookmarkletError}</p>
                )}
              </div>
            </details>
          )}

          {provider === "espn" && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted hover:text-ink">
                A server-side live connection kicked me out of ESPN
              </summary>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => void stopBackendWatcher()}
                  disabled={stopBusy}
                  className="flex items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1.5 text-2xs font-medium text-rose-700 hover:border-rose-400 disabled:opacity-50"
                >
                  {stopBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Stop it now
                </button>
                {stopMsg && <span className="text-2xs text-muted">{stopMsg}</span>}
              </div>
              <p className="mt-1.5 text-2xs leading-snug text-muted">
                Kills any backend-owned live connection for this league right now. The
                bookmarklet above doesn't have this problem — use it instead going forward.
              </p>
            </details>
          )}

          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-line">
              {INTERVALS.map((i) => (
                <button
                  key={i.ms}
                  onClick={() => onIntervalChange(i.ms)}
                  className={`px-2 py-1 text-2xs ${intervalMs === i.ms ? "bg-raised font-semibold text-ink" : "text-muted hover:text-ink"}`}
                >
                  {i.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => void live.syncOnce(true, formConfig ?? undefined)}
              disabled={!formConfig || live.busy}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-muted hover:border-faint disabled:opacity-50"
            >
              {live.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Sync now
            </button>
            <button
              onClick={() => {
                if (live.running) {
                  live.stop();
                } else {
                  onConfigChange(formConfig);
                  live.start();
                }
              }}
              disabled={!formConfig || !yahooReady}
              className={`ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                live.running
                  ? "border border-line bg-surface text-ink hover:border-faint"
                  : "border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"}`}
            >
              {live.running ? <><Pause className="h-3.5 w-3.5" /> Stop</> : <><Play className="h-3.5 w-3.5" /> Start watching</>}
            </button>
          </div>

          {live.error && (
            <p className="flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-2xs text-rose-700">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {live.error}
            </p>
          )}

          {res?.meta.last_error?.includes("timed out") && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-2xs text-amber-900">
              <div className="font-medium text-amber-800 mb-1">Live sync is using REST fallback</div>
              <p>ESPN's multi-location login protection is preventing the live WebSocket connection. For best results, close your draft page or avoid clicking while syncing.</p>
            </div>
          )}

          {res && (
            <div className="space-y-2 rounded-lg border border-line bg-raised px-2.5 py-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-2xs text-muted">
                <span className="font-medium text-ink">Pick {res.on_the_clock} on the clock</span>
                <span>{res.meta.resolved ?? 0} of {res.meta.drafted ?? 0} picks read</span>
                <span>{live.totalAdded} logged this session</span>
                {live.lastSyncAt && (
                  <span className="ml-auto font-mono text-faint">
                    {new Date(live.lastSyncAt).toLocaleTimeString()}
                  </span>
                )}
              </div>

              {res.meta.started !== undefined && (
                <p className={`text-2xs ${res.meta.connected ? "text-emerald-600" : "text-amber-600"}`}>
                  live channel: {res.meta.connected ? "connected" : res.meta.started ? "reconnecting…" : "starting…"}
                  {res.meta.last_error && !res.meta.last_error.includes("timed out") ? ` — ${res.meta.last_error}` : ""}
                </p>
              )}
              {res.meta.ws_start_error && (
                <p className="text-2xs text-rose-600">
                  live channel didn't start, using REST fallback: {res.meta.ws_start_error}
                </p>
              )}
              {res.meta.team_resolution_error && (
                <p className="text-2xs text-rose-600">
                  Couldn't resolve teams from ESPN — picks will show with no owner and won't be
                  flagged as yours until this is fixed: {res.meta.team_resolution_error}
                </p>
              )}

              {res.meta.lookup && res.meta.lookup.lookup_attempted ? (
                <p className="text-2xs text-faint">
                  roster view behind: looked up {res.meta.lookup.lookup_attempted}, found{" "}
                  {res.meta.lookup.lookup_found} (status {String(res.meta.lookup.lookup_status)})
                </p>
              ) : null}

              {res.meta.teams_by_id && (
                <details className="text-2xs text-muted">
                  <summary className="cursor-pointer hover:text-ink">
                    Debug: team ID mapping (for a wrong-team-assignment report)
                  </summary>
                  <div className="mt-1 space-y-1 rounded-lg border border-line bg-white p-1.5">
                    <div>
                      <span className="font-medium">my_team_id:</span> {String(res.meta.my_team_id)}
                    </div>
                    <div>
                      <span className="font-medium">teams_by_id:</span>{" "}
                      {Object.entries(res.meta.teams_by_id).map(([id, name]) => `${id}=${name}`).join(", ")}
                    </div>
                    {res.meta.recent_events && res.meta.recent_events.length > 0 && (
                      <div>
                        <span className="font-medium">recent raw events:</span>
                        {res.meta.recent_events.map((e, i) => (
                          <div key={i} className="font-mono">
                            {e.name ?? `player ${e.player_id}`} — nominating={e.nominating_team_id},
                            winning={e.winning_team_id}, price={e.price}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              )}

              {res.added.length > 0 && (
                <div className="space-y-0.5">
                  {res.added.slice(-6).map((a) => (
                    <div key={a.overall} className="flex items-center gap-1.5 text-2xs">
                      <span className="w-7 font-mono text-faint">#{a.overall}</span>
                      <span className="truncate text-ink">{a.name}</span>
                      <span className="font-mono text-faint">{a.pos}</span>
                      <span className="ml-auto truncate text-muted">{a.owner ?? "—"}</span>
                      {a.price != null && <span className="font-mono text-amber-700">${a.price}</span>}
                    </div>
                  ))}
                </div>
              )}

              {res.unmatched.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-2xs text-amber-900">
                  <span className="font-medium">Not in the player pool ({res.unmatched.length})</span>
                  {" — "}{res.unmatched.slice(0, 6).join(", ")}
                  {res.unmatched.length > 6 ? "…" : ""}
                  <div className="mt-0.5 text-amber-700">
                    These stay unlogged, so they'll still look available on your board. Log them by
                    hand if they matter.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useMemo, useState } from "react";
import { Radio, Loader2, AlertTriangle, Pause, Play, RefreshCw, X, Link2 } from "lucide-react";
import { LeagueSettings, api, BASE } from "@/lib/api";
import { useLiveDraft, LiveDraftConfig } from "@/hooks/useLiveDraft";
import { yahooConnected } from "@/lib/yahooAuth";
import { buildBookmarklet } from "@/lib/liveBookmarklet";

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
  const [s2, setS2] = useState(config?.espnS2 ?? "");
  const [swid, setSwid] = useState(config?.swid ?? "");

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

  // Bookmarklet — see live_ws_registry.py "Browser-side ingest" and
  // liveBookmarklet.ts for the full why. Built on demand (not on mount)
  // since it needs a real ext_id typed into the form first.
  const [bookmarkletHref, setBookmarkletHref] = useState<string | null>(null);
  const [bookmarkletBusy, setBookmarkletBusy] = useState(false);
  const [bookmarkletError, setBookmarkletError] = useState<string | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopMsg, setStopMsg] = useState<string | null>(null);

  async function makeBookmarklet() {
    if (!extId.trim()) return;
    setBookmarkletBusy(true);
    setBookmarkletError(null);
    try {
      const { token } = await api.getLiveIngestToken(leagueId);
      const href = buildBookmarklet({
        apiUrl: BASE, leagueId, token, extId: extId.trim(), season: 2026,
        espnS2: s2 || undefined, swid: swid || undefined, myTeam: myTeam || undefined,
        startOverall: 1,
      });
      setBookmarkletHref(href);
    } catch (e) {
      setBookmarkletError(e instanceof Error ? e.message : String(e));
    } finally {
      setBookmarkletBusy(false);
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

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-gray-900/40 p-4">
      <div className="mt-10 w-full max-w-lg rounded-xl border border-gray-200 bg-gray-50 shadow-xl">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
          <Radio className={`h-4 w-4 ${live.running ? "text-emerald-600" : "text-gray-400"}`} />
          <h2 className="text-sm font-semibold tracking-tight">Live draft sync</h2>
          {live.running && (
            <span className="flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-2xs text-emerald-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> watching
            </span>
          )}
          <button onClick={onClose} className="ml-auto rounded p-1 text-gray-500 hover:bg-gray-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-3">
          <p className="text-2xs leading-snug text-gray-500">
            Picks are <span className="text-gray-700">polled</span>, not pushed — neither platform
            offers a live feed to outside apps, so new picks show up within one interval of being
            made. Everything you log by hand still works; syncing only adds picks that aren't
            already on the board. {live.running && "Closing this window does NOT stop it — "}
            {live.running && <span className="text-emerald-700 font-medium">it keeps polling in the background</span>}
            {live.running && "; the \"Live\" button up top shows it's still active."}
          </p>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs">
              <span className="mb-1 block text-gray-500">Platform</span>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as "espn" | "yahoo")}
                className="w-full rounded border border-gray-300 bg-gray-50 px-2 py-1 text-gray-700 focus:border-gray-400 focus:outline-none"
              >
                <option value="espn">ESPN</option>
                <option value="yahoo">Yahoo</option>
              </select>
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-gray-500">
                {provider === "yahoo" ? "League key" : "League ID"}
              </span>
              <input
                value={extId}
                onChange={(e) => setExtId(e.target.value)}
                placeholder={provider === "yahoo" ? "461.l.82486" : "123456"}
                className="w-full rounded border border-gray-300 bg-gray-50 px-2 py-1 font-mono text-gray-700 focus:border-gray-400 focus:outline-none"
              />
            </label>
          </div>

          <label className="block text-xs">
            <span className="mb-1 block text-gray-500">
              Your team <span className="text-gray-400">
                {provider === "yahoo" ? "(detected from your Yahoo login)" : "(name or team id — marks your picks)"}
              </span>
            </span>
            {provider === "espn" && (
              <input
                value={myTeam}
                onChange={(e) => setMyTeam(e.target.value)}
                placeholder="Team Ari"
                className="w-full rounded border border-gray-300 bg-gray-50 px-2 py-1 text-gray-700 focus:border-gray-400 focus:outline-none"
              />
            )}
            {provider === "yahoo" && !yahooConnected() && (
              <span className="block rounded border border-amber-200 bg-amber-50 px-2 py-1 text-2xs text-amber-800">
                Not connected to Yahoo — open Keepers → "Yahoo — pull last season from the API"
                and connect once. The same session is used here.
              </span>
            )}
          </label>

          {provider === "espn" && (
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
                Private ESPN league? Add cookies
              </summary>
              <div className="mt-2 grid gap-2">
                <input value={s2} onChange={(e) => setS2(e.target.value)} placeholder="espn_s2"
                  className="w-full rounded border border-gray-300 bg-gray-50 px-2 py-1 font-mono text-2xs text-gray-700 focus:border-gray-400 focus:outline-none" />
                <input value={swid} onChange={(e) => setSwid(e.target.value)} placeholder="{SWID}"
                  className="w-full rounded border border-gray-300 bg-gray-50 px-2 py-1 font-mono text-2xs text-gray-700 focus:border-gray-400 focus:outline-none" />
              </div>
            </details>
          )}

          {provider === "espn" && (
            <div className="rounded border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs">
              <div className="flex items-center gap-1.5 font-medium text-emerald-800">
                <Link2 className="h-3.5 w-3.5" /> Live channel bookmarklet (recommended)
              </div>
              <p className="mt-1 text-2xs leading-snug text-emerald-800/80">
                Reads picks straight off ESPN's own draft-room connection, from inside your
                browser tab — doesn't touch ESPN's login/session at all, so it can't trigger the
                multi-location kick a server-side connection can. Requires the League ID above.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => void makeBookmarklet()}
                  disabled={!extId.trim() || bookmarkletBusy}
                  className="flex items-center gap-1.5 rounded border border-emerald-300 bg-white px-2.5 py-1.5 text-2xs font-medium text-emerald-800 hover:border-emerald-400 disabled:opacity-50"
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
                    className="cursor-grab rounded border border-emerald-300 bg-emerald-100 px-2.5 py-1.5 text-2xs font-medium text-emerald-900 active:cursor-grabbing"
                    title="Drag me to your bookmarks bar"
                  >
                    🖐 Drag to bookmarks bar: Fantasy Live Sync
                  </a>
                )}
              </div>
              {bookmarkletHref && (
                <p className="mt-1.5 text-2xs leading-snug text-emerald-800/70">
                  On the ESPN draft page: click the bookmark, then reload the page if the
                  draft-room connection was already open before you clicked it.
                </p>
              )}
              {bookmarkletError && (
                <p className="mt-1.5 text-2xs text-rose-700">{bookmarkletError}</p>
              )}
            </div>
          )}

          {provider === "espn" && (
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
                A server-side live connection kicked me out of ESPN
              </summary>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => void stopBackendWatcher()}
                  disabled={stopBusy}
                  className="flex items-center gap-1.5 rounded border border-rose-300 bg-rose-50 px-2.5 py-1.5 text-2xs font-medium text-rose-700 hover:border-rose-400 disabled:opacity-50"
                >
                  {stopBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Stop it now
                </button>
                {stopMsg && <span className="text-2xs text-gray-500">{stopMsg}</span>}
              </div>
              <p className="mt-1.5 text-2xs leading-snug text-gray-500">
                Kills any backend-owned live connection for this league right now. The
                bookmarklet above doesn't have this problem — use it instead going forward.
              </p>
            </details>
          )}

          <div className="flex items-center gap-2">
            <div className="flex rounded border border-gray-300">
              {INTERVALS.map((i) => (
                <button
                  key={i.ms}
                  onClick={() => onIntervalChange(i.ms)}
                  className={`px-2 py-1 text-2xs ${intervalMs === i.ms ? "bg-gray-200 font-semibold text-gray-800" : "text-gray-500 hover:text-gray-700"}`}
                >
                  {i.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => void live.syncOnce(true, formConfig ?? undefined)}
              disabled={!formConfig || live.busy}
              className="flex items-center gap-1.5 rounded border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-600 hover:border-gray-400 disabled:opacity-50"
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
              className={`ml-auto flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                live.running
                  ? "border border-gray-300 bg-gray-50 text-gray-700 hover:border-gray-400"
                  : "border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"}`}
            >
              {live.running ? <><Pause className="h-3.5 w-3.5" /> Stop</> : <><Play className="h-3.5 w-3.5" /> Start watching</>}
            </button>
          </div>

          {live.error && (
            <p className="flex items-start gap-1.5 rounded border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-2xs text-rose-700">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {live.error}
            </p>
          )}

          {res?.meta.last_error?.includes("timed out") && (
            <div className="rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-2xs text-amber-900">
              <div className="font-medium text-amber-800 mb-1">Live sync is using REST fallback</div>
              <p>ESPN's multi-location login protection is preventing the live WebSocket connection. For best results, close your draft page or avoid clicking while syncing.</p>
            </div>
          )}

          {res && (
            <div className="space-y-2 rounded border border-gray-200 bg-gray-100 px-2.5 py-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-2xs text-gray-600">
                <span className="font-medium text-gray-800">Pick {res.on_the_clock} on the clock</span>
                <span>{res.meta.resolved ?? 0} of {res.meta.drafted ?? 0} picks read</span>
                <span>{live.totalAdded} logged this session</span>
                {live.lastSyncAt && (
                  <span className="ml-auto font-mono text-gray-400">
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

              {res.meta.lookup && res.meta.lookup.lookup_attempted ? (
                <p className="text-2xs text-gray-400">
                  roster view behind: looked up {res.meta.lookup.lookup_attempted}, found{" "}
                  {res.meta.lookup.lookup_found} (status {String(res.meta.lookup.lookup_status)})
                </p>
              ) : null}

              {res.added.length > 0 && (
                <div className="space-y-0.5">
                  {res.added.slice(-6).map((a) => (
                    <div key={a.overall} className="flex items-center gap-1.5 text-2xs">
                      <span className="w-7 font-mono text-gray-400">#{a.overall}</span>
                      <span className="truncate text-gray-700">{a.name}</span>
                      <span className="font-mono text-gray-400">{a.pos}</span>
                      <span className="ml-auto truncate text-gray-500">{a.owner ?? "—"}</span>
                      {a.price != null && <span className="font-mono text-amber-700">${a.price}</span>}
                    </div>
                  ))}
                </div>
              )}

              {res.unmatched.length > 0 && (
                <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-2xs text-amber-900">
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

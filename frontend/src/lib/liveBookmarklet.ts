/**
 * lib/liveBookmarklet.ts
 * =======================
 * Builds the "browser-side ingest" bookmarklet — see backend/live_ws_registry.py
 * "Browser-side ingest" for the full why. Short version: a backend-owned
 * WebSocket connection to ESPN's live draft channel, from Railway's server IP,
 * can trip ESPN's multi-location login protection and kick the user's own
 * browser session — confirmed live, not theoretical, and worse under polling
 * (a failed attempt just gets retried next poll, hitting the check repeatedly).
 * Browser JS can't open that same connection itself either: the standard
 * `WebSocket` constructor has no headers parameter, and `Cookie` is a
 * forbidden header even where headers ARE settable — so neither a pasted
 * espn_s2/SWID nor the browser's own cookie jar (blocked anyway by SameSite
 * on a cross-site request from OUR origin) can authenticate a NEW connection
 * opened from JS.
 *
 * What DOES work: this bookmarklet runs on the ESPN draft page ITSELF (same
 * origin, already logged in) and monkey-patches `window.WebSocket` so it can
 * read the connection ESPN's OWN client already opens — no new connection,
 * nothing for their fraud detection to flag. It parses `SOLD` lines
 * client-side (same tiny grammar as `parse_ws_line` in espn_draft_ws.py,
 * ported here since the whole point is this runs OUTSIDE our backend) and
 * POSTs them to `/api/leagues/{id}/live-ingest`.
 *
 * Patching `WebSocket` only affects connections opened AFTER the patch runs
 * — if ESPN's page already opened its socket before you click the
 * bookmarklet, you won't see anything until the page reloads (and the
 * bookmarklet's own alert() says so, so this isn't a silent gap).
 *
 * **Sends its FULL locally-captured history on every send, not just the
 * newest line — found live, not designed in from the start.** The first
 * version POSTed one event per SOLD line, fire-and-forget, no retry. A
 * single dropped request (a backgrounded browser tab throttling its
 * timers, one momentary network blip) silently and PERMANENTLY lost that
 * pick — over a full draft this compounded into a real, growing gap
 * between ESPN's own pick count and what this app had. Resending the whole
 * captured array — on every new pick AND on a periodic timer, so even a
 * quiet stretch with no new picks eventually retries anything still
 * missing — makes a single dropped request just a one-cycle delay instead
 * of permanent data loss. Safe to do blindly, with no per-event ack
 * tracking on this side, because the backend dedupes by player id before
 * anything reaches the accumulator (`live_ws_registry.ingest_sold_events`).
 */

export interface BookmarkletConfig {
  apiUrl: string;   // backend base URL, e.g. https://fantasy-draft-production-43ab.up.railway.app
  leagueId: number;
  token: string;
  extId: string;
  season: number;
  espnS2?: string;
  swid?: string;
  myTeam?: string;
  startOverall: number;
  // Bookmarklet: user-triggered, one shot — an alert() is the ONLY feedback
  // they get that the click did anything, so it's worth the interruption.
  // Userscript: runs automatically on every page load via @run-at
  // document-start (see buildUserscript below) — an alert() on every load
  // would be disruptive, so that path logs to console instead and stays
  // silent unless something's actually wrong.
  silent?: boolean;
}

/** The function body that runs on the ESPN page. Kept as a plain function
 * (not a template string) so it round-trips through `Function.prototype.toString`
 * cleanly — no manual escaping of quotes/newlines to get wrong. */
function bookmarkletBody(cfg: BookmarkletConfig): void {
  // `any` deliberately, not a real DOM type — this whole function is
  // serialized (via .toString()) and run in a completely different page's
  // context (ESPN's draft room), not compiled/executed here, so it can't
  // see our app's types or bundler globals at all.
  const w = window as any;
  if (w.__fantasyLiveHookInstalled) {
    if (!cfg.silent) alert("Fantasy live sync hook is already installed on this page.");
    return;
  }
  w.__fantasyLiveHookInstalled = true;

  const OrigWS = w.WebSocket;
  const cfgJson = JSON.stringify(cfg);
  // Every parsed SOLD event this page instance has ever seen — resent in
  // FULL on every send (see module docstring on why). Never trimmed: a
  // full draft is at most a few hundred entries, trivial to resend
  // repeatedly, and trimming would reintroduce the exact data-loss risk
  // this exists to close.
  const captured: Array<{ nominating_team_id: number; player_id: number;
                          winning_team_id: number; price: number }> = [];
  // The player currently up for auction — see LiveDraftWatcher
  // .current_nomination_id's docstring (backend) for why this is tracked
  // off BID rather than NOMINATION.
  let currentNominationId: number | null = null;

  function postBatch() {
    if (captured.length === 0 && currentNominationId === null) return;
    const c = JSON.parse(cfgJson);
    fetch(c.apiUrl + "/api/leagues/" + c.leagueId + "/live-ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: c.token, ext_id: c.extId, season: c.season,
        espn_s2: c.espnS2 || null, swid: c.swid || null, my_team: c.myTeam || null,
        start_overall: c.startOverall,
        events: captured, current_nomination_id: currentNominationId,
      }),
    }).catch(function () { /* best-effort — the NEXT send (next pick, or the
                               periodic timer below) resends this exact same
                               list again, so a dropped request delays
                               delivery by one cycle instead of losing it */ });
  }

  function handleLine(line: string) {
    line = line.trim();
    if (!line) return;
    const parts = line.split(" ");
    // SOLD <winningTeamId> <playerId> <?> <price> <flag> — positions 1 and 3
    // were swapped from the original guess (labeled nominating/winning
    // respectively). Confirmed wrong live: a user cross-checked against
    // ESPN's own draft room and position 1 was the real winning bidder for
    // three consecutive picks, while position 3 held values outside the
    // league's real team-id range entirely. Position 3's true meaning is
    // unconfirmed; kept only for the backend's diagnostic display.
    if (parts[0] === "SOLD" && parts.length >= 5) {
      const winningTeamId = parseInt(parts[1], 10);
      const playerId = parseInt(parts[2], 10);
      const nominatingTeamId = parseInt(parts[3], 10);
      const price = parseInt(parts[4], 10);
      if (!isNaN(playerId) && !isNaN(winningTeamId)) {
        captured.push({ nominating_team_id: nominatingTeamId, player_id: playerId,
                        winning_team_id: winningTeamId, price: price });
        postBatch();
      }
      return;
    }
    // BID <teamId> <playerId> <amount> <clockMs> [<clockMs2>] — the
    // nominating team's own opening bid lands within a moment of the
    // nomination in ESPN's own auction UI, so this is used as "who's up
    // right now" (see currentNominationId's own comment for why NOMINATION
    // itself isn't trusted for this).
    if (parts[0] === "BID" && parts.length >= 4) {
      const bidPlayerId = parseInt(parts[2], 10);
      if (!isNaN(bidPlayerId) && bidPlayerId !== currentNominationId) {
        currentNominationId = bidPlayerId;
        postBatch();
      }
    }
  }

  w.WebSocket = function (url: string, protocols?: string | string[]) {
    const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    if (typeof url === "string" && url.indexOf("fantasydraft.espn.com") !== -1) {
      ws.addEventListener("message", function (ev: any) {
        if (typeof ev.data !== "string") return;   // protocol is plain text; a
                                                     // Blob/ArrayBuffer frame
                                                     // isn't one we understand
        const lines = ev.data.split("\n");
        for (let i = 0; i < lines.length; i++) handleLine(lines[i]);
      });
    }
    return ws;
  };
  w.WebSocket.prototype = OrigWS.prototype;

  // Periodic full resync — catches anything a dropped POST missed even
  // during a quiet stretch with no new picks (e.g. right after a
  // backgrounded tab gets throttled and stops delivering for a while).
  setInterval(postBatch, 5000);

  if (cfg.silent) {
    // eslint-disable-next-line no-console
    console.log("[fantasy-live-sync] hook installed at document-start.");
  } else {
    alert(
      "Fantasy live sync hook installed.\n\n" +
      "If the draft room's socket already connected before you clicked this, " +
      "reload the page NOW so it reconnects under the hook. Picks will start " +
      "showing up in the app within a poll or two after that."
    );
  }
}

/** Builds the `javascript:` URI for the bookmarklet — drag the returned
 * string's href onto a bookmarks bar. Config is baked into the source at
 * build time (not fetched at click time), so the bookmarklet keeps working
 * even if our API is briefly down when it's first installed.
 *
 * **Known limitation, not silently swept under the rug**: patching
 * `window.WebSocket` only affects connections opened AFTER the patch runs.
 * If ESPN's page already opened its socket before you click this, nothing
 * shows up until the page reloads — but reloading wipes the patch right
 * back out (it's in-memory page JS state, not persistent), so a manual
 * click can only ever win a race against ESPN's own script re-opening the
 * connection on that same reload. `buildUserscript` below exists BECAUSE
 * this race isn't reliably winnable by hand — prefer it once you've hit
 * this in practice. */
export function buildBookmarklet(cfg: BookmarkletConfig): string {
  const src = `(function(){(${bookmarkletBody.toString()})(${JSON.stringify(cfg)});})();`;
  return "javascript:" + encodeURIComponent(src);
}

/** Builds a Tampermonkey/Violentmonkey userscript with the same hook,
 * declared `@run-at document-start` — guaranteed to execute before ANY of
 * ESPN's own page JS, on every load, with no manual re-click and no race
 * against when the draft-room socket opens. Solves the exact failure mode
 * `buildBookmarklet` cannot: a page that reloads (or was already open)
 * still gets patched before its own WebSocket call runs, every time. */
export function buildUserscript(cfg: BookmarkletConfig): string {
  const cfgSilent: BookmarkletConfig = { ...cfg, silent: true };
  const header = [
    "// ==UserScript==",
    "// @name         Fantasy Draft Tool - Live Sync",
    "// @namespace    fantasy-draft-tool",
    "// @version      1.0",
    "// @description  Streams live ESPN draft picks to your Fantasy Draft Tool board",
    // Wildcarded across the whole espn.com family, not just fantasy.espn.com
    // — the WebSocket connects to wss://fantasydraft.espn.com, which strongly
    // suggests the draft-room UI that actually OPENS it may render inside an
    // iframe on that (or another) espn.com subdomain, not the top-level page
    // you're looking at. Tampermonkey injects into every matching frame, not
    // just the top one, by default — this only helps if it's broad enough to
    // match whichever frame the real WebSocket call happens in.
    "// @match        https://*.espn.com/*",
    "// @run-at       document-start",
    "// @grant        none",
    "// ==/UserScript==",
  ].join("\n");
  return `${header}\n\n(function(){\n(${bookmarkletBody.toString()})(${JSON.stringify(cfgSilent)});\n})();\n`;
}

/** Triggers a browser download of the userscript file — Tampermonkey
 * auto-detects a `.user.js` file opened/downloaded in the browser and
 * offers to install it, no manual copy-paste into the extension's editor
 * needed. Standard `<a download>` — this runs inside OUR OWN app's page,
 * not a sandboxed artifact, so the download API is available normally. */
export function downloadUserscript(cfg: BookmarkletConfig): void {
  const blob = new Blob([buildUserscript(cfg)], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "fantasy-live-sync.user.js";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

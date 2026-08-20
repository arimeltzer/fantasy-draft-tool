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
 * POSTs each one to `/api/leagues/{id}/live-ingest`.
 *
 * Patching `WebSocket` only affects connections opened AFTER the patch runs
 * — if ESPN's page already opened its socket before you click the
 * bookmarklet, you won't see anything until the page reloads (and the
 * bookmarklet's own alert() says so, so this isn't a silent gap).
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
    alert("Fantasy live sync hook is already installed on this page.");
    return;
  }
  w.__fantasyLiveHookInstalled = true;

  const OrigWS = w.WebSocket;
  const cfgJson = JSON.stringify(cfg);

  function post(nominatingTeamId: number, playerId: number, winningTeamId: number, price: number) {
    const c = JSON.parse(cfgJson);
    fetch(c.apiUrl + "/api/leagues/" + c.leagueId + "/live-ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: c.token, ext_id: c.extId, season: c.season,
        espn_s2: c.espnS2 || null, swid: c.swid || null, my_team: c.myTeam || null,
        start_overall: c.startOverall,
        nominating_team_id: nominatingTeamId, player_id: playerId,
        winning_team_id: winningTeamId, price: price,
      }),
    }).catch(function () { /* best-effort — a missed POST is retried never;
                               the next SOLD line for a DIFFERENT player still
                               goes through, so one dropped event doesn't wedge
                               anything else */ });
  }

  function handleLine(line: string) {
    line = line.trim();
    if (!line) return;
    const parts = line.split(" ");
    // SOLD <nominatingTeamId> <playerId> <winningTeamId> <price> <flag>
    if (parts[0] === "SOLD" && parts.length >= 5) {
      const nominatingTeamId = parseInt(parts[1], 10);
      const playerId = parseInt(parts[2], 10);
      const winningTeamId = parseInt(parts[3], 10);
      const price = parseInt(parts[4], 10);
      if (!isNaN(playerId) && !isNaN(winningTeamId)) {
        post(nominatingTeamId, playerId, winningTeamId, price);
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

  alert(
    "Fantasy live sync hook installed.\n\n" +
    "If the draft room's socket already connected before you clicked this, " +
    "reload the page NOW so it reconnects under the hook. Picks will start " +
    "showing up in the app within a poll or two after that."
  );
}

/** Builds the `javascript:` URI for the bookmarklet — drag the returned
 * string's href onto a bookmarks bar. Config is baked into the source at
 * build time (not fetched at click time), so the bookmarklet keeps working
 * even if our API is briefly down when it's first installed. */
export function buildBookmarklet(cfg: BookmarkletConfig): string {
  const src = `(function(){(${bookmarkletBody.toString()})(${JSON.stringify(cfg)});})();`;
  return "javascript:" + encodeURIComponent(src);
}

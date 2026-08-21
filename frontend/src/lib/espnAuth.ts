/* ESPN private-league cookie storage.
 *
 * `espn_s2` and `SWID` are what ESPN's unofficial read API accepts in place of
 * a real OAuth grant, and they are needed by THREE separate screens — league
 * import, keeper auto-fill, and live draft sync. Each one held its own
 * `useState("")`, so the same pair had to be pasted again for every screen and
 * again after every page reload. A user asked for exactly this: enter it once
 * at league creation and stop re-entering it.
 *
 * WHY localStorage AND NOT THE DATABASE. `League.settings` would survive a
 * browser change, but it is returned by the leagues API on every fetch, so the
 * cookies would ride along to the client constantly and into anything that logs
 * a response — and a database compromise would then leak a live ESPN ACCOUNT
 * session for every user of this app, not merely fantasy data. Keeping the
 * secret on the machine that typed it is the smaller blast radius, and it is
 * the same call `yahooAuth.ts` already made for Yahoo's refresh token, which is
 * longer-lived than these. The cost is honest and stated in the UI: it is
 * per-browser, and "Forget" is offered wherever the fields appear.
 *
 * Unlike the Yahoo session there is no expiry handling here. These cookies are
 * long-lived (months) and ESPN exposes no refresh endpoint for them — when they
 * do go stale the API simply starts refusing, which surfaces as the same
 * "check your cookies" error the manual path already produced.
 */

const KEY = "fantasy_espn";
/** Same-tab counterpart to the `storage` event, which only fires elsewhere. */
const CREDS_EVENT = "fantasy-espn-creds";

export interface EspnCreds {
  espnS2: string;
  swid: string;
  /** Epoch ms, for "saved on this device" copy. */
  savedAt: number;
}

export function loadEspnCreds(): EspnCreds | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as EspnCreds;
    // Both halves are required — ESPN rejects one without the other, and a
    // half-saved pair would silently produce "private league" failures that
    // look like bad cookies rather than missing ones.
    return c?.espnS2 && c?.swid ? c : null;
  } catch {
    return null;
  }
}

/** Persist a pair. No-ops unless BOTH are present, so a half-filled form
 *  can't overwrite a good saved pair with an unusable one. */
export function saveEspnCreds(espnS2: string, swid: string): EspnCreds | null {
  const s2 = (espnS2 || "").trim();
  const sw = (swid || "").trim();
  if (!s2 || !sw) return null;
  const creds: EspnCreds = { espnS2: s2, swid: sw, savedAt: Date.now() };
  try {
    localStorage.setItem(KEY, JSON.stringify(creds));
  } catch {
    return null;   // private mode / storage disabled — not worth failing over
  }
  window.dispatchEvent(new Event(CREDS_EVENT));
  return creds;
}

export function clearEspnCreds() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
  window.dispatchEvent(new Event(CREDS_EVENT));
}

export function hasEspnCreds(): boolean {
  return loadEspnCreds() !== null;
}

/**
 * Watch for the pair being saved or forgotten, including from ANOTHER tab.
 * `storage` only fires in other tabs, so same-tab writes dispatch a matching
 * custom event — identical treatment to `onYahooSession`.
 */
export function onEspnCreds(cb: (c: EspnCreds | null) => void): () => void {
  const fire = () => cb(loadEspnCreds());
  const onStorage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) fire(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CREDS_EVENT, fire);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CREDS_EVENT, fire);
  };
}

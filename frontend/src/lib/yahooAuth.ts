/* Yahoo OAuth session handling.
 *
 * Yahoo access tokens last about an hour, which is shorter than a draft and far
 * shorter than the gap between importing a league and opening the keeper
 * planner. Holding the token in React state (as the import modal originally
 * did) meant it died on the first page reload and was invisible to every other
 * screen. So the session is persisted and refreshed on demand.
 *
 * Storage is localStorage, alongside the app's own JWT. That does mean a
 * refresh token sits in the browser: it is scoped to Yahoo Fantasy READ, and
 * "Disconnect" clears it, but on a shared machine prefer disconnecting when
 * you're done.
 */
import { api } from "@/lib/api";

const KEY = "fantasy_yahoo";
/** Same-tab counterpart to the `storage` event, which only fires elsewhere. */
const SESSION_EVENT = "fantasy-yahoo-session";
/** Refresh this long before expiry so a call in flight can't age out. */
const SKEW_MS = 120_000;

export interface YahooSession {
  accessToken: string;
  refreshToken?: string;
  guid?: string;
  /** Epoch ms. */
  expiresAt: number;
}

export function loadYahooSession(): YahooSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as YahooSession;
    return s?.accessToken ? s : null;
  } catch {
    return null;
  }
}

export function saveYahooSession(t: {
  access_token: string; refresh_token?: string | null; guid?: string | null; expires_in?: number | null;
}): YahooSession {
  const session: YahooSession = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? undefined,
    guid: t.guid ?? undefined,
    expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
  };
  localStorage.setItem(KEY, JSON.stringify(session));
  window.dispatchEvent(new Event(SESSION_EVENT));
  return session;
}

export function clearYahooSession() {
  localStorage.removeItem(KEY);
  window.dispatchEvent(new Event(SESSION_EVENT));
}

/**
 * Watch for the session appearing or being cleared, including from ANOTHER
 * tab — the OAuth redirect completes in the tab Yahoo opened, while the import
 * dialog is still sitting in the original one. `storage` only fires in other
 * tabs, so same-tab writes dispatch a matching custom event.
 */
export function onYahooSession(cb: (s: YahooSession | null) => void): () => void {
  const fire = () => cb(loadYahooSession());
  const onStorage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) fire(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener(SESSION_EVENT, fire);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(SESSION_EVENT, fire);
  };
}

export function yahooConnected(): boolean {
  const s = loadYahooSession();
  // A dead access token is still "connected" when it can be refreshed.
  return !!s && (!!s.refreshToken || s.expiresAt > Date.now());
}

/**
 * A usable access token, refreshing first if it is expired or about to be.
 * Returns null when there is no session, or when the refresh itself fails —
 * which means the grant was revoked and the user has to reconnect.
 */
export async function yahooAccessToken(): Promise<string | null> {
  const s = loadYahooSession();
  if (!s) return null;
  if (s.expiresAt - SKEW_MS > Date.now()) return s.accessToken;
  if (!s.refreshToken) return null;
  try {
    const tok = await api.yahooRefresh(s.refreshToken);
    return saveYahooSession({ ...tok, guid: tok.guid ?? s.guid }).accessToken;
  } catch {
    clearYahooSession();
    return null;
  }
}

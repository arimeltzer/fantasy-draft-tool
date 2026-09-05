import { useEffect, useMemo, useRef, useState } from "react";
import { Link2, Loader2, AlertTriangle, Check, ChevronDown, LogOut } from "lucide-react";
import { api, KeeperCandidate, KeeperImportCache } from "@/lib/api";
import {
  loadYahooSession, saveYahooSession, clearYahooSession, yahooAccessToken, onYahooSession,
} from "@/lib/yahooAuth";

interface Props {
  onCandidates: (c: KeeperCandidate[]) => void;
  matchSeason?: number;
  cached?: KeeperImportCache;
  onCache?: (c: KeeperImportCache) => void;
}

const CURRENT_SEASON = 2026;

/**
 * Keeper auto-fill over Yahoo's official API.
 *
 * The paste importer exists because Yahoo's developer program would not grant
 * the Fantasy Sports scope; with a real credential this is the better path —
 * it reads the prior season's draft results and FAAB claims directly, so
 * keeper costs come from the platform instead of a copied page.
 */
export default function YahooKeeperAutofill({
  onCandidates, matchSeason = CURRENT_SEASON, cached, onCache,
}: Props) {
  const restored = cached?.source === "yahoo" ? cached : undefined;
  const [open, setOpen] = useState(!!restored);
  const [session, setSession] = useState(() => loadYahooSession());
  const [code, setCode] = useState("");
  const [leagues, setLeagues] = useState<{ key: string; name: string; season: number }[]>([]);
  const [leagueKey, setLeagueKey] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ matched: number; total: number; waivers: number; kept: string[] } | null>(
    restored ? { matched: restored.candidates.length, total: restored.candidates.length,
                 waivers: restored.waivers?.players ?? 0, kept: [] } : null);
  const [restoredAt] = useState<string | undefined>(restored?.fetchedAt);

  // "mine" here is decided by matching your Yahoo manager guid against each
  // team's manager list server-side — the reason this screen never asks for
  // a team name at all (unlike ESPN's, which needs one to break name ties).
  // But that guid match is a single point of failure with no visibility if
  // it misses: reported live — a real 172-player pull, ineligibility flagged
  // correctly, and NO recommendations at all, because every candidate came
  // back is_mine=false and KeeperRecommendations only ever scores candidates
  // where is_mine is true. Rather than trust the guid match silently (the
  // same "never guess who you are" discipline resolve_my_team_index/
  // teamMatch.ts already apply elsewhere), keep the raw pull and let the
  // user correct it from the real team names Yahoo already returned.
  const [rawCandidates, setRawCandidates] = useState<KeeperCandidate[] | null>(restored?.candidates ?? null);
  const [pulledWaivers, setPulledWaivers] = useState(restored?.waivers);
  const [myTeamOverride, setMyTeamOverride] = useState<string>("");
  const overrideInitialized = useRef(false);

  // Default the picker to "Me" once a pull comes back ALREADY correctly
  // matched (the common, working case) — only when nothing's been chosen
  // yet, so a manual correction is never silently reverted.
  useEffect(() => {
    if (overrideInitialized.current || !rawCandidates) return;
    if (rawCandidates.some((c) => c.is_mine)) {
      overrideInitialized.current = true;
      setMyTeamOverride("Me");
    }
  }, [rawCandidates]);

  const distinctOwners = useMemo(() => {
    if (!rawCandidates) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of rawCandidates) {
      const o = c.is_mine ? "Me" : c.owner;
      if (!seen.has(o)) { seen.add(o); out.push(o); }
    }
    return out;
  }, [rawCandidates]);

  const autoMatched = useMemo(() => rawCandidates?.some((c) => c.is_mine) ?? false, [rawCandidates]);

  // Reclassify the selected team's rows as "Me". Only ever ADDS an is_mine —
  // it can't retroactively un-flag a guid match that landed on the wrong
  // team (that team's real name is already gone, overwritten to "Me" server
  // side), but that's not the failure mode reported: a missed match reads
  // as EVERY candidate is_mine=false, which this fully recovers from.
  const correctedCandidates = useMemo(() => {
    if (!rawCandidates || !myTeamOverride) return rawCandidates ?? [];
    return rawCandidates.map((c) => {
      const owner = c.is_mine ? "Me" : c.owner;
      return owner === myTeamOverride && !c.is_mine ? { ...c, is_mine: true, owner: "Me" } : c;
    });
  }, [rawCandidates, myTeamOverride]);

  // Push the corrected list up whenever the correction changes, so choosing
  // your team from the dropdown feeds the recommender immediately — no
  // separate "apply" step to miss.
  const pushedRef = useRef<KeeperCandidate[] | null>(null);
  useEffect(() => {
    if (correctedCandidates.length && pushedRef.current !== correctedCandidates) {
      pushedRef.current = correctedCandidates;
      onCandidates(correctedCandidates);
      if (rawCandidates) {
        onCache?.({
          season: matchSeason - 1,
          fetchedAt: restoredAt ?? new Date().toISOString(),
          candidates: correctedCandidates,
          waivers: pulledWaivers,
          source: "yahoo",
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correctedCandidates]);

  // The consent tab finishes the handshake itself, so reflect that here rather
  // than waiting for a code to be pasted into this panel.
  useEffect(() => onYahooSession(setSession), []);

  const connect = async () => {
    setError(null);
    try {
      const { url } = await api.yahooAuthUrl();
      window.open(url, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exchange = async () => {
    setLoading("exchange"); setError(null);
    try {
      const tok = await api.yahooExchange(code.trim());
      setSession(saveYahooSession(tok));
      setCode("");
      await loadLeagues(tok.access_token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  };

  const loadLeagues = async (token?: string) => {
    setLoading("leagues"); setError(null);
    try {
      const access = token ?? (await yahooAccessToken());
      if (!access) { setSession(null); throw new Error("Yahoo session expired — connect again."); }
      const { leagues: ls } = await api.yahooLeagues(access);
      setLeagues(ls);
      // Keeper costs come from LAST season, so default to it.
      const prior = ls.find((l) => l.season === matchSeason - 1) ?? ls[0];
      if (prior) setLeagueKey(prior.key);
      if (!ls.length) setError("Yahoo returned no NFL leagues for this account.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  };

  const pull = async () => {
    setLoading("pull"); setError(null);
    try {
      const access = await yahooAccessToken();
      if (!access) { setSession(null); throw new Error("Yahoo session expired — connect again."); }
      const res = await api.yahooKeeperCandidates({
        league_key: leagueKey,
        access_token: access,
        match_season: matchSeason,
        my_guid: loadYahooSession()?.guid,
      });
      overrideInitialized.current = false;
      setMyTeamOverride("");
      setPulledWaivers(res.waivers);
      setRawCandidates(res.candidates);
      setResult({
        matched: res.matched,
        total: res.candidates.length,
        waivers: res.waivers?.players ?? 0,
        kept: res.kept_detected ?? [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  };

  const disconnect = () => {
    clearYahooSession();
    setSession(null);
    setLeagues([]);
    setLeagueKey("");
  };

  return (
    <div className="mt-3 rounded-xl border border-line bg-raised/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-muted hover:text-ink"
      >
        <Link2 className="h-3.5 w-3.5" />
        Yahoo — pull last season from the API
        {session && <span className="rounded-full border border-emerald-300 bg-emerald-50 px-1.5 text-2xs text-emerald-700">connected</span>}
        <ChevronDown className={`ml-auto h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-hair px-3 py-3">
          {!session ? (
            <>
              <p className="text-2xs leading-snug text-faint">
                Connect your Yahoo account once. Keeper costs then come straight from last
                season's draft results and waiver claims — no copying pages.
              </p>
              <button onClick={connect} className="btn-brand w-full justify-center px-3 py-1.5 text-xs">
                Open Yahoo consent
              </button>
              <p className="text-2xs leading-snug text-faint">
                Approve in the new tab; it connects itself and this panel updates. The box below
                is only needed if that tab reports an error.
              </p>
              <label className="block text-xs">
                <span className="mb-1 block text-muted">
                  Paste the code manually <span className="text-faint">(fallback)</span>
                </span>
                <div className="flex gap-2">
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="auth code"
                    className="w-full rounded-md border border-line bg-sunken px-2 py-1 font-mono text-2xs text-ink focus:border-brand focus:outline-none"
                  />
                  <button
                    onClick={exchange}
                    disabled={!code.trim() || loading === "exchange"}
                    className="btn-brand shrink-0 px-2.5 py-1 text-xs disabled:opacity-50"
                  >
                    {loading === "exchange" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Connect"}
                  </button>
                </div>
              </label>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => loadLeagues()}
                  disabled={loading === "leagues"}
                  className="flex-1 rounded-md border border-line bg-sunken px-2.5 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-50"
                >
                  {loading === "leagues" ? "Loading…" : leagues.length ? "Refresh league list" : "Load my leagues"}
                </button>
                <button
                  onClick={disconnect}
                  title="Forget the stored Yahoo token on this browser"
                  className="flex items-center gap-1 rounded-md border border-line px-2 py-1.5 text-2xs text-faint hover:text-ink"
                >
                  <LogOut className="h-3 w-3" /> Disconnect
                </button>
              </div>

              {leagues.length > 0 && (
                <label className="block text-xs">
                  <span className="mb-1 block text-muted">
                    Last season's league <span className="text-faint">(where the keeper costs come from)</span>
                  </span>
                  <select
                    value={leagueKey}
                    onChange={(e) => setLeagueKey(e.target.value)}
                    className="w-full rounded-md border border-line bg-sunken px-2 py-1 text-xs text-ink focus:border-brand focus:outline-none"
                  >
                    {leagues.map((l) => (
                      <option key={l.key} value={l.key}>{l.season} · {l.name}</option>
                    ))}
                  </select>
                </label>
              )}

              <button
                onClick={pull}
                disabled={!leagueKey || loading === "pull"}
                className="btn-brand w-full justify-center px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {loading === "pull" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Pull keeper candidates
              </button>
            </>
          )}

          {restoredAt && !result?.kept.length && (
            <p className="rounded-md border border-line bg-sunken px-2.5 py-1.5 text-2xs text-muted">
              Showing a saved pull from {new Date(restoredAt).toLocaleDateString()} — pull again to refresh.
            </p>
          )}

          {error && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-2xs text-rose-700">
              {error}
            </p>
          )}

          {result && (
            <div className="space-y-2">
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-2xs text-emerald-800">
                <div className="flex items-center gap-1.5 font-medium">
                  <Check className="h-3.5 w-3.5" />
                  {result.matched}/{result.total} players matched
                  {result.waivers > 0 ? ` · ${result.waivers} with waiver claims` : ""}
                </div>
                {result.waivers === 0 && (
                  <div className="mt-1 text-emerald-700">
                    No FAAB claims found — costs use the draft price only. That's expected in a
                    league without FAAB bidding.
                  </div>
                )}
              </div>

              {!autoMatched && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-2xs text-amber-900">
                  <div className="mb-1 flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    Couldn't tell which team is yours
                  </div>
                  <div className="leading-relaxed">
                    Everyone imported correctly, but Yahoo didn't match your account to a team in
                    THIS league last season (can happen if you weren't a manager here, or joined
                    under a different Yahoo login) — with no team flagged as yours, there's nothing
                    to base a recommendation on. Pick your team below to fix it.
                  </div>
                </div>
              )}

              {distinctOwners.length > 0 && (
                <label className="block text-xs">
                  <span className="mb-1 block text-muted">
                    Which team was yours{" "}
                    <span className="text-faint">{autoMatched ? "(auto-detected — change if wrong)" : ""}</span>
                  </span>
                  <select
                    value={myTeamOverride}
                    onChange={(e) => setMyTeamOverride(e.target.value)}
                    className="w-full rounded-md border border-line bg-sunken px-2 py-1 text-xs text-ink focus:border-brand focus:outline-none"
                  >
                    <option value="" disabled>— pick your team —</option>
                    {distinctOwners.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </label>
              )}

              {result.kept.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-2xs text-amber-900">
                  <div className="mb-1 font-medium">
                    Yahoo flags as kept last year ({result.kept.length})
                  </div>
                  <div className="leading-relaxed">{result.kept.join(", ")}</div>
                  <div className="mt-1 flex items-start gap-1.5 text-amber-700">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    Excluded from recommendations if your rule bars repeats. Worth a glance —
                    it comes from an undocumented field.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

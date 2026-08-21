import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, ChevronDown, AlertTriangle } from "lucide-react";
import { keeperCost } from "@/engine/keeper.js";
import { api, KeeperCandidate, KeeperImportCache, KeeperRule, WaiverReport } from "@/lib/api";
import { encodeKeeper } from "@/lib/keeperPick";
import { posStyle } from "@/lib/posStyles";

interface Props {
  rule: KeeperRule;
  takenIds: Set<number>;
  addPick: (d: { playerId?: number; mine: boolean; price?: number; slot?: string }) => Promise<void>;
  // Surface the full fetched candidate list (all teams) so the recommender can
  // predict opponents' keepers.
  onCandidates?: (c: KeeperCandidate[]) => void;
  // If the league was imported from ESPN, its source id — used to pre-fill and
  // auto-fetch the prior season's draft.
  source?: { provider: string; extId: string };
  // Previously-saved pull (from league settings) + a way to persist a new one,
  // so the draft data survives reloads instead of refetching every time.
  cached?: KeeperImportCache;
  onCache?: (c: KeeperImportCache) => void;
}

const CURRENT_SEASON = 2026;

export default function KeeperAutofill({ rule, takenIds, addPick, onCandidates, source, cached, onCache }: Props) {
  const priceBasis = rule.basis === "price";
  const espnSource = source?.provider === "espn" ? source.extId : "";

  const [open, setOpen] = useState(!!espnSource || !!cached);
  const [leagueId, setLeagueId] = useState(espnSource);
  const [season, setSeason] = useState(cached?.season ?? CURRENT_SEASON - 1);
  // Extra completed drafts to pull for auction price calibration. Two prior
  // seasons on top of the keeper season is enough to test whether the league's
  // spending habits persist at all, which one draft cannot answer.
  const [historySeasons, setHistorySeasons] = useState(2);
  const [draftMeta, setDraftMeta] = useState<Record<string, unknown> | null>(null);
  const [priv, setPriv] = useState(false);
  const [s2, setS2] = useState("");
  const [swid, setSwid] = useState("");
  const [myTeam, setMyTeam] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cands, setCands] = useState<KeeperCandidate[] | null>(cached?.candidates ?? null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(0);
  const [waivers, setWaivers] = useState<WaiverReport | undefined>(cached?.waivers);
  const [fetchedAt, setFetchedAt] = useState<string | undefined>(cached?.fetchedAt);
  const [probe, setProbe] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  // Ask the backend what ESPN actually returns for each candidate waiver URL.
  const runProbe = async () => {
    if (!leagueId.trim()) return;
    setProbing(true); setProbe(null);
    try {
      const res = await api.espnProbeActivity({
        ext_id: leagueId.trim(),
        season,
        espn_s2: priv ? s2.trim() || undefined : undefined,
        swid: priv ? swid.trim() || undefined : undefined,
      });
      setProbe(JSON.stringify(res.probes, null, 1));
    } catch (e) {
      setProbe(`probe failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProbing(false);
    }
  };

  // base per current rule basis; null => free agent / undrafted
  const baseOf = (c: KeeperCandidate) => (priceBasis ? c.bid : c.round);

  const fetchCands = async () => {
    if (!leagueId.trim()) return;
    setLoading(true); setError(null); setCands(null); setAdded(0);
    try {
      const res = await api.espnKeeperCandidates({
        ext_id: leagueId.trim(),
        season,
        match_season: CURRENT_SEASON,
        espn_s2: priv ? s2.trim() || undefined : undefined,
        swid: priv ? swid.trim() || undefined : undefined,
        my_team: myTeam.trim() || undefined,
        // Extra completed seasons, for auction price calibration only. Keeper
        // costs still come from `season` alone.
        history_seasons: historySeasons,
      });
      setCands(res.candidates);
      setWaivers(res.waivers);
      const stamp = new Date().toISOString();
      setFetchedAt(stamp);
      onCandidates?.(res.candidates);
      // Persist so reopening the planner doesn't refetch from ESPN.
      // draftPicks is the FULL prior draft (dropped players included); the
      // candidate list above is end-of-season rosters. Auction calibration
      // needs the former, keeper eligibility the latter, so cache both.
      onCache?.({ season, fetchedAt: stamp, candidates: res.candidates,
                  draftPicks: res.draft_picks, waivers: res.waivers });
      setDraftMeta(res.draft_meta ?? null);
      // Don't pre-select: the recommender below analyzes your roster
      // automatically (nothing committed). This list is only for directly
      // committing specific keepers you already know.
      setSel(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Use the saved pull when there is one; otherwise auto-fetch once for an
  // imported ESPN league (public leagues just work; a private one 401s and the
  // user adds cookies + refetches).
  const autoTried = useRef(false);
  useEffect(() => {
    if (cached?.candidates?.length && !autoTried.current) {
      autoTried.current = true;
      onCandidates?.(cached.candidates);
      return;
    }
    if (espnSource && !autoTried.current) {
      autoTried.current = true;
      fetchCands();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [espnSource]);

  // Waiver/FAAB claim is a dollar amount → only a cost basis in price leagues.
  const waiverOf = (c: KeeperCandidate) => (priceBasis ? c.waiver : null);

  const rows = useMemo(() => (cands ?? []).map((c, i) => {
    const base = baseOf(c);
    const waiver = waiverOf(c);
    const fa = base == null;
    const alreadyKept = c.player_id != null && takenIds.has(c.player_id);
    const cost = keeperCost({ base: fa ? null : base, waiver, fa, kept: 0 }, rule);
    // ESPN reports keeper_ineligible when a player has already been kept the
    // max number of consecutive/total times the league's rule allows —
    // committing him again here would be an illegal keep, the same reason
    // KeeperRecommendations excludes these from its own suggestions.
    const selectable = c.matched && c.player_id != null && !alreadyKept && !c.keeper_ineligible;
    return { c, i, base, waiver, fa, alreadyKept, cost, selectable };
  }), [cands, rule, takenIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const addSelected = async () => {
    setAdding(true);
    let n = 0;
    try {
      for (const { c, i, base, waiver, fa, cost, selectable } of rows) {
        if (!selectable || !sel.has(i) || c.player_id == null) continue;
        await addPick({
          playerId: c.player_id,
          mine: c.is_mine,
          price: priceBasis ? (cost.price ?? undefined) : undefined,
          slot: encodeKeeper({
            k: 1, owner: c.owner, basis: rule.basis, kept: 0,
            base: fa ? null : base,
            waiver,
            round: cost.round ?? undefined,
          }),
        });
        n++;
      }
      setAdded(n);
      setCands(null); setSel(new Set());
    } finally {
      setAdding(false);
    }
  };

  const toggle = (i: number) =>
    setSel((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });

  const selCount = rows.filter((r) => r.selectable && sel.has(r.i)).length;

  return (
    <div className="mt-3 rounded-lg border border-line bg-raised/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-muted hover:text-ink"
      >
        <Download className="h-3.5 w-3.5" />
        Auto-fill from ESPN {priceBasis ? "(prices)" : "(rounds)"}
        <ChevronDown className={`ml-auto h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-hair px-3 py-3">
          <p className="text-2xs text-faint">
            Reads last year's ESPN draft ({season}) and fills in each keeper's{" "}
            {priceBasis ? "price" : "round"}. Enter the league's {season} season.
          </p>

          <div className="grid grid-cols-2 gap-2">
            <label className="text-2xs text-muted">
              ESPN league ID
              <input
                value={leagueId}
                onChange={(e) => setLeagueId(e.target.value)}
                placeholder="123456"
                className="mt-0.5 w-full rounded-md border border-line bg-sunken px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none"
              />
            </label>
            <label className="text-2xs text-muted">
              Draft season
              <input
                type="number"
                value={season}
                onChange={(e) => setSeason(Number(e.target.value) || CURRENT_SEASON - 1)}
                className="mt-0.5 w-full rounded-md border border-line bg-sunken px-2 py-1 text-right font-mono text-sm text-ink focus:border-brand focus:outline-none"
              />
            </label>
          </div>

          <label className="block text-2xs text-muted">
            Also read this many EARLIER drafts (auction prices only)
            <input
              type="number" min={0} max={15}
              value={historySeasons}
              onChange={(e) => setHistorySeasons(Math.min(15, Math.max(0, Number(e.target.value) || 0)))}
              className="mt-0.5 w-full rounded-md border border-line bg-sunken px-2 py-1 text-right font-mono text-sm text-ink focus:border-brand focus:outline-none"
            />
            <span className="mt-0.5 block text-faint">
              Keepers always come from the draft season above. Extra drafts only
              teach the price forecast what your room overpays for — and let it
              check whether that habit actually repeats, which one draft cannot.
              Older seasons count for less. 0 to skip.
            </span>
          </label>

          <label className="text-2xs text-muted">
            Your team name/ID <span className="text-faint">(optional — flags your keepers)</span>
            <input
              value={myTeam}
              onChange={(e) => setMyTeam(e.target.value)}
              placeholder="e.g. Team Ari or 3"
              className="mt-0.5 w-full rounded-md border border-line bg-sunken px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none"
            />
          </label>

          <label className="flex items-center gap-1.5 text-2xs text-muted">
            <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} className="h-3.5 w-3.5 accent-brand" />
            Private league (needs cookies)
          </label>
          {priv && (
            <div className="grid grid-cols-1 gap-2">
              <input value={s2} onChange={(e) => setS2(e.target.value)} placeholder="espn_s2 cookie"
                className="w-full rounded-md border border-line bg-sunken px-2 py-1 text-xs text-ink focus:border-brand focus:outline-none" />
              <input value={swid} onChange={(e) => setSwid(e.target.value)} placeholder="SWID cookie"
                className="w-full rounded-md border border-line bg-sunken px-2 py-1 text-xs text-ink focus:border-brand focus:outline-none" />
            </div>
          )}

          <button
            onClick={fetchCands}
            disabled={loading || !leagueId.trim()}
            className="btn border-line bg-surface px-3 py-1.5 text-xs text-ink hover:bg-hover disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Fetch draft
          </button>

          {error && (
            <p className="flex items-start gap-1.5 text-2xs text-rose-600">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {error}
            </p>
          )}
          {added > 0 && (
            <p className="text-2xs text-emerald-600">Added {added} keeper{added === 1 ? "" : "s"}.</p>
          )}

          {cands && historySeasons > 0 && (
            <div className="rounded-md border border-line bg-sunken px-2.5 py-1.5 text-2xs">
              <span className="text-muted">
                Earlier drafts (calibration only) —{" "}
              </span>
              {(() => {
                const hist = draftMeta?.history as Record<string, string> | undefined;
                if (draftMeta?.history_error) {
                  return <span className="text-rose-600">fetch failed: {String(draftMeta.history_error)}</span>;
                }
                if (!hist || Object.keys(hist).length === 0) {
                  return <span className="text-amber-600">no history returned</span>;
                }
                const entries = Object.entries(hist).sort((a, b) => Number(b[0]) - Number(a[0]));
                // NOT endsWith(":ok") — the backend always appends
                // " picks:N named:M" after a season resolves (see
                // fetch_draft_history), so a real success reads e.g.
                // "history:ok picks:150 named:140" and never actually ends
                // in ":ok". Checking for "picks:" instead — present once
                // real draft data was parsed, regardless of whether the
                // separate player-name lookup also fully succeeded — is
                // what "loaded" actually means here; a season that never
                // got that far (no draft found, an HTTP error, an
                // exception) has no "picks:" at all.
                const ok = entries.filter(([, v]) => v.includes(" picks:")).length;
                return (
                  <span title={entries.map(([y, v]) => `${y}: ${v}`).join("\n")}>
                    <span className={ok === entries.length ? "text-emerald-600" : "text-amber-600"}>
                      {ok} of {entries.length} seasons loaded
                    </span>
                    {" "}({entries.map(([y]) => y).join(", ")}) — hover for per-season detail
                  </span>
                );
              })()}
            </div>
          )}

          {cands && (
            <div className="space-y-2">
              {/* where this data came from + whether waiver/FAAB claims arrived */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-sunken px-2.5 py-1.5 text-2xs">
                {fetchedAt && (
                  <span className="text-muted">
                    Saved pull · {new Date(fetchedAt).toLocaleDateString()} ({season})
                  </span>
                )}
                {priceBasis && (
                  waivers?.players
                    ? <span className="text-emerald-600">
                        {waivers.players} waiver claim{waivers.players === 1 ? "" : "s"}
                        {waivers.max_bid ? ` · max $${waivers.max_bid}` : ""}
                      </span>
                    : waivers?.count
                      ? <span className="text-amber-600" title={(waivers.attempts || []).join(" · ")}>
                          No FAAB bids in {waivers.count} transactions — league likely uses waiver priority (no $ value)
                        </span>
                      : <span className="text-amber-600" title={(waivers?.attempts || []).join(" · ") || "no diagnostics"}>
                          No waiver data{waivers?.attempts?.length ? ` (${waivers.attempts.join("; ")})` : ""}
                        </span>
                )}
                {priceBasis && !waivers?.players && !priv && (
                  <button
                    onClick={() => { setPriv(true); setOpen(true); }}
                    className="text-brand hover:underline"
                    title="Waiver/FAAB history is league-member data — ESPN omits it from unauthenticated requests"
                  >
                    Add cookies (waivers need sign-in)
                  </button>
                )}
                <button onClick={fetchCands} disabled={loading} className="ml-auto text-brand hover:underline disabled:opacity-50">
                  {loading ? "Refreshing…" : "Refresh from ESPN"}
                </button>
                {priceBasis && !waivers?.players && (
                  <button onClick={runProbe} disabled={probing} className="text-muted hover:text-ink hover:underline disabled:opacity-50">
                    {probing ? "Probing…" : "Diagnose"}
                  </button>
                )}
              </div>
              {probe && (
                <div className="rounded-md border border-line bg-sunken p-2">
                  <div className="mb-1 flex items-center gap-2 text-2xs text-muted">
                    <span>Waiver-endpoint probe — copy this and send it over.</span>
                    <button
                      onClick={() => navigator.clipboard?.writeText(probe)}
                      className="ml-auto text-brand hover:underline"
                    >
                      Copy
                    </button>
                    <button onClick={() => setProbe(null)} className="text-faint hover:text-ink">Close</button>
                  </div>
                  <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-snug text-muted">{probe}</pre>
                </div>
              )}
              <div className="max-h-60 overflow-y-auto rounded-md border border-line bg-surface">
                {rows.length === 0 && <div className="px-3 py-4 text-center text-2xs italic text-faint">No rostered players found.</div>}
                {rows.map(({ c, i, waiver, fa, alreadyKept, cost, selectable }) => {
                  const st = posStyle(c.pos as string);
                  return (
                    <label
                      key={i}
                      title={c.keeper_ineligible ? "ESPN reports this player already used up their keeper eligibility — keeping him again would be an illegal keep" : undefined}
                      className={`flex items-center gap-2 border-b border-l-[3px] border-b-hair px-2.5 py-1.5 text-xs last:border-b-0 ${st.accent} ${selectable ? "cursor-pointer hover:bg-hover" : "opacity-50"}`}
                    >
                      <input
                        type="checkbox"
                        disabled={!selectable}
                        checked={selectable && sel.has(i)}
                        onChange={() => toggle(i)}
                        className="h-3.5 w-3.5 accent-brand"
                      />
                      <span className={`font-mono text-2xs font-semibold ${st.text}`}>{c.pos}</span>
                      <span className="min-w-0 flex-1 truncate text-ink">{c.name}</span>
                      <span className="w-16 truncate font-mono text-2xs text-faint" title={c.owner}>
                        {c.is_mine ? "Me" : c.owner}
                      </span>
                      <span
                        className="w-12 text-right font-mono text-2xs text-faint"
                        title={waiver != null ? `waiver/FAAB claim $${waiver}` : "no waiver claim"}
                      >
                        {waiver != null ? `w$${waiver}` : ""}
                      </span>
                      <span className="w-14 text-right font-mono text-2xs text-muted">
                        {!c.matched ? "no match" : c.keeper_ineligible ? "ineligible" : alreadyKept ? "added" :
                          cost.basis === "price" ? `$${cost.price}` :
                          fa ? "FA" : `R${cost.round}`}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="text-2xs text-faint">
                Your roster is already being analyzed below — no need to add anything. Only check players here
                to <em>commit</em> them straight to the draft (removes them from the pool now).
              </p>
              <button
                onClick={addSelected}
                disabled={adding || selCount === 0}
                className="btn border-line bg-surface w-full justify-center px-3 py-1.5 text-xs text-ink hover:bg-hover disabled:opacity-50"
              >
                {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Commit {selCount} selected keeper{selCount === 1 ? "" : "s"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

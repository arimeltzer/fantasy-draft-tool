import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, ChevronDown, AlertTriangle } from "lucide-react";
import { keeperCost } from "@/engine/keeper.js";
import { api, KeeperCandidate, KeeperRule } from "@/lib/api";
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
}

const CURRENT_SEASON = 2026;

export default function KeeperAutofill({ rule, takenIds, addPick, onCandidates, source }: Props) {
  const priceBasis = rule.basis === "price";
  const espnSource = source?.provider === "espn" ? source.extId : "";

  const [open, setOpen] = useState(!!espnSource);
  const [leagueId, setLeagueId] = useState(espnSource);
  const [season, setSeason] = useState(CURRENT_SEASON - 1);
  const [priv, setPriv] = useState(false);
  const [s2, setS2] = useState("");
  const [swid, setSwid] = useState("");
  const [myTeam, setMyTeam] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cands, setCands] = useState<KeeperCandidate[] | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(0);

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
      });
      setCands(res.candidates);
      onCandidates?.(res.candidates);
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

  // Auto-fetch once for an imported ESPN league (public leagues just work; a
  // private one 401s and the user adds cookies + refetches).
  const autoTried = useRef(false);
  useEffect(() => {
    if (espnSource && !autoTried.current) {
      autoTried.current = true;
      fetchCands();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [espnSource]);

  const rows = useMemo(() => (cands ?? []).map((c, i) => {
    const base = baseOf(c);
    const fa = base == null;
    const alreadyKept = c.player_id != null && takenIds.has(c.player_id);
    const cost = keeperCost({ base: fa ? null : base, fa, kept: 0 }, rule);
    const selectable = c.matched && c.player_id != null && !alreadyKept;
    return { c, i, base, fa, alreadyKept, cost, selectable };
  }), [cands, rule, takenIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const addSelected = async () => {
    setAdding(true);
    let n = 0;
    try {
      for (const { c, i, base, fa, cost, selectable } of rows) {
        if (!selectable || !sel.has(i) || c.player_id == null) continue;
        await addPick({
          playerId: c.player_id,
          mine: c.is_mine,
          price: priceBasis ? (cost.price ?? undefined) : undefined,
          slot: encodeKeeper({
            k: 1, owner: c.owner, basis: rule.basis, kept: 0,
            base: fa ? null : base,
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

          {cands && (
            <div className="space-y-2">
              <div className="max-h-60 overflow-y-auto rounded-md border border-line bg-surface">
                {rows.length === 0 && <div className="px-3 py-4 text-center text-2xs italic text-faint">No rostered players found.</div>}
                {rows.map(({ c, i, base, fa, alreadyKept, cost, selectable }) => {
                  const st = posStyle(c.pos as string);
                  return (
                    <label
                      key={i}
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
                      <span className="w-14 text-right font-mono text-2xs text-muted">
                        {!c.matched ? "no match" : alreadyKept ? "added" : fa ? "FA" :
                          cost.basis === "price" ? `$${cost.price}` : `R${cost.round}`}
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

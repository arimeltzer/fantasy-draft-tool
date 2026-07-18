import { useMemo, useState } from "react";
import { X, Lock, Plus, Trash2, AlertTriangle, Search } from "lucide-react";
import { keeperCost, normalizeKeeperRule, validateKeepers } from "@/engine/keeper.js";
import type { BoardPlayer } from "@/engine/valuation-engine.js";
import { LeagueSettings } from "@/lib/api";
import { DraftEntry } from "@/store/draftStore";
import { decodeKeeper, encodeKeeper } from "@/lib/keeperPick";
import { posStyle } from "@/lib/posStyles";
import KeeperAutofill from "./KeeperAutofill";
import KeeperRecommendations from "./KeeperRecommendations";

interface Props {
  format: "auction" | "snake";
  settings: LeagueSettings;
  board: BoardPlayer[];
  picks: DraftEntry[];
  addPick: (d: { playerId?: number; mine: boolean; price?: number; slot?: string }) => Promise<void>;
  removePick: (pickId: number) => Promise<void>;
  onClose: () => void;
}

interface KeeperRow {
  pick: DraftEntry;
  player: BoardPlayer | undefined;
  owner: string;
  base: number | null;
  fa: boolean;
  kept: number;
  cost: ReturnType<typeof keeperCost>;
}

export default function KeeperPlanner({
  format, settings, board, picks, addPick, removePick, onClose,
}: Props) {
  const rule = useMemo(() => normalizeKeeperRule(settings.keeper, format), [settings.keeper, format]);
  const priceBasis = rule.basis === "price";

  const owners = useMemo(
    () => ["Me", ...Array.from({ length: Math.max(0, settings.teams - 1) }, (_, i) => `Team ${i + 2}`)],
    [settings.teams],
  );

  const playerById = useMemo(() => new Map(board.map((p) => [p.id as number, p])), [board]);
  const takenIds = useMemo(() => new Set(picks.map((p) => p.playerId).filter(Boolean) as number[]), [picks]);

  const keeperRows: KeeperRow[] = useMemo(() => {
    return picks
      .map((pick) => ({ pick, meta: decodeKeeper(pick.slot) }))
      .filter((x): x is { pick: DraftEntry; meta: NonNullable<ReturnType<typeof decodeKeeper>> } => x.meta != null)
      .map(({ pick, meta }) => ({
        pick,
        player: pick.playerId != null ? playerById.get(pick.playerId) : undefined,
        owner: meta.owner,
        base: meta.base,
        fa: meta.base == null,
        kept: meta.kept ?? 0,
        cost: keeperCost({ base: meta.base, fa: meta.base == null, kept: meta.kept ?? 0 }, rule),
      }));
  }, [picks, playerById, rule]);

  const validation = useMemo(
    () => validateKeepers(keeperRows.map((r) => ({ owner: r.owner, base: r.base, fa: r.fa, kept: r.kept })), rule),
    [keeperRows, rule],
  );

  const mySpend = keeperRows
    .filter((r) => r.owner === "Me" && r.cost.price != null)
    .reduce((s, r) => s + (r.cost.price || 0), 0);
  const myRounds = keeperRows
    .filter((r) => r.owner === "Me" && r.cost.round != null)
    .map((r) => r.cost.round as number)
    .sort((a, b) => a - b);

  // ── add form ──────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState("Me");
  const [base, setBase] = useState<string>("");
  const [fa, setFa] = useState(false);
  const [kept, setKept] = useState(0);
  const [selected, setSelected] = useState<BoardPlayer | null>(null);
  const [saving, setSaving] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return board
      .filter((p) => !takenIds.has(p.id as number))
      .filter((p) => p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q))
      .slice(0, 6);
  }, [query, board, takenIds]);

  const baseNum = base === "" ? null : Number(base);
  const preview = selected
    ? keeperCost({ base: fa ? null : baseNum, fa: fa || baseNum == null, kept }, rule)
    : null;

  const reset = () => { setSelected(null); setQuery(""); setBase(""); setFa(false); setKept(0); };

  const add = async () => {
    if (!selected) return;
    setSaving(true);
    const cost = keeperCost({ base: fa ? null : baseNum, fa: fa || baseNum == null, kept }, rule);
    try {
      await addPick({
        playerId: selected.id as number,
        mine: owner === "Me",
        price: priceBasis ? (cost.price ?? undefined) : undefined,
        slot: encodeKeeper({
          k: 1, owner, basis: rule.basis, kept,
          base: fa ? null : baseNum,
          round: cost.round ?? undefined,
        }),
      });
      reset();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-b border-line bg-surface shadow-card">
      <div className="mx-auto max-w-6xl px-4 py-5">
        <div className="mb-4 flex items-center gap-2">
          <Lock className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-semibold tracking-tight">Keeper planner</h3>
          <span className="chip border-line bg-raised text-muted">
            {rule.label ?? rule.preset} · {priceBasis ? `+$${rule.priceSurcharge}` : `R${rule.undraftedRound} if FA`} · max {rule.maxKeepers}/team
          </span>
          <button onClick={onClose} className="ml-auto flex items-center gap-1 text-xs text-muted hover:text-ink">
            <X className="h-3.5 w-3.5" /> Close
          </button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          {/* ── Add keeper ─────────────────────────────────────────── */}
          <div>
            <h4 className="eyebrow mb-2">Add a keeper</h4>
            <div className="card p-3">
              {!selected ? (
                <div className="relative">
                  <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-1.5">
                    <Search className="h-3.5 w-3.5 text-faint" />
                    <input
                      autoFocus
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search player to keep…"
                      className="w-full bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
                    />
                  </div>
                  {matches.length > 0 && (
                    <div className="mt-1 overflow-hidden rounded-md border border-line bg-surface shadow-card">
                      {matches.map((p) => {
                        const st = posStyle(p.pos);
                        return (
                          <button
                            key={p.id}
                            onClick={() => setSelected(p)}
                            className={`flex w-full items-center gap-2 border-l-[3px] px-2.5 py-1.5 text-left text-sm hover:bg-hover ${st.accent}`}
                          >
                            <span className={`font-mono text-2xs font-semibold ${st.text}`}>{p.pos}</span>
                            <span className="flex-1 truncate text-ink">{p.name}</span>
                            <span className="font-mono text-2xs text-faint">{p.team}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-2xs font-semibold ${posStyle(selected.pos).text}`}>{selected.pos}</span>
                    <span className="font-medium text-ink">{selected.name}</span>
                    <span className="font-mono text-2xs text-faint">{selected.team}</span>
                    <button onClick={reset} className="ml-auto text-xs text-muted hover:text-ink">change</button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs">
                      <span className="mb-1 block text-muted">Owner</span>
                      <select
                        value={owner}
                        onChange={(e) => setOwner(e.target.value)}
                        className="w-full rounded-md border border-line bg-sunken px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none"
                      >
                        {owners.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </label>

                    <label className="text-xs">
                      <span className="mb-1 block text-muted">
                        {priceBasis ? "Last year's price ($)" : "Round drafted last year"}
                      </span>
                      <input
                        type="number"
                        disabled={fa}
                        value={base}
                        onChange={(e) => setBase(e.target.value)}
                        placeholder={priceBasis ? "e.g. 15" : "e.g. 5"}
                        className="w-full rounded-md border border-line bg-sunken px-2 py-1 text-right font-mono text-sm text-ink focus:border-brand focus:outline-none disabled:opacity-40"
                      />
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      <input type="checkbox" checked={fa} onChange={(e) => setFa(e.target.checked)} className="h-3.5 w-3.5 accent-brand" />
                      {priceBasis ? "Free agent last year" : "Undrafted / FA last year"}
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      Kept before
                      <input
                        type="number" min={0} value={kept}
                        onChange={(e) => setKept(Math.max(0, Number(e.target.value) || 0))}
                        className="w-14 rounded-md border border-line bg-sunken px-1.5 py-1 text-right font-mono text-ink focus:border-brand focus:outline-none"
                      />
                      yr
                    </label>
                  </div>

                  {preview && (
                    <div className="flex items-center justify-between rounded-md border border-line bg-raised px-3 py-2 text-sm">
                      <span className="text-muted">Keeper cost</span>
                      <span className="font-mono font-semibold text-ink">
                        {preview.basis === "price" ? `$${preview.price}` : `Round ${preview.round}`}
                      </span>
                    </div>
                  )}
                  {preview?.advisory.map((a, i) => (
                    <p key={i} className="flex items-start gap-1.5 text-2xs text-amber-600">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {a}
                    </p>
                  ))}

                  <button
                    onClick={add}
                    disabled={saving}
                    className="btn-brand w-full justify-center px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add keeper
                  </button>
                </div>
              )}
            </div>

            <p className="mt-2 text-2xs text-faint">
              Keepers are removed from the draft pool and seeded onto the board.
              {priceBasis
                ? " Their price counts against budget and drives auction inflation."
                : " Their round is the pick that team forfeits."}
            </p>

            <KeeperAutofill rule={rule} takenIds={takenIds} addPick={addPick} />
          </div>

          {/* ── Current keepers ───────────────────────────────────── */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="eyebrow">Keepers ({keeperRows.length})</h4>
              {priceBasis ? (
                <span className="font-mono text-2xs text-faint">
                  your spend ${mySpend} / ${settings.budget}
                </span>
              ) : myRounds.length > 0 ? (
                <span className="font-mono text-2xs text-faint">
                  you forfeit R{myRounds.join(", R")}
                </span>
              ) : null}
            </div>

            <div className="card divide-y divide-hair">
              {keeperRows.length === 0 && (
                <div className="px-3 py-6 text-center text-xs italic text-faint">No keepers yet.</div>
              )}
              {keeperRows.map((r) => {
                const st = r.player ? posStyle(r.player.pos) : null;
                return (
                  <div key={r.pick.pickId} className={`flex items-center gap-2 border-l-[3px] px-3 py-2 text-sm ${st?.accent ?? "border-l-transparent"}`}>
                    <span className={`w-10 font-mono text-2xs font-semibold ${r.owner === "Me" ? "text-brand" : "text-faint"}`}>
                      {r.owner === "Me" ? "Me" : r.owner.replace("Team ", "T")}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ink">
                      {r.player?.name ?? `#${r.pick.playerId}`}
                      {r.player && <span className="ml-1 font-mono text-2xs text-faint">{r.player.pos}·{r.player.team}</span>}
                    </span>
                    <span className="font-mono text-2xs text-muted">
                      {r.cost.basis === "price" ? `$${r.cost.price}` : `R${r.cost.round}`}
                    </span>
                    <button
                      onClick={() => removePick(r.pick.pickId)}
                      className="rounded p-1 text-faint hover:bg-raised hover:text-rose-600"
                      title="Remove keeper"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>

            {!validation.ok && validation.errors.map((e, i) => (
              <p key={i} className="mt-2 flex items-start gap-1.5 text-2xs text-rose-600">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {e}
              </p>
            ))}
          </div>
        </div>

        <KeeperRecommendations
          format={format}
          settings={settings}
          board={board}
          picks={picks}
          removePick={removePick}
        />
      </div>
    </div>
  );
}

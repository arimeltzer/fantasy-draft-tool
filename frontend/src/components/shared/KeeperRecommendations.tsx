import { useMemo, useState } from "react";
import { Sparkles, ChevronDown, Check, Minus, Info } from "lucide-react";
import { keeperCost, normalizeKeeperRule } from "@/engine/keeper.js";
import { marketOrder, recommendKeepers, draftImpact } from "@/engine/keeperReco.js";
import { auctionValues } from "@/engine/auction-engine.js";
import type { BoardPlayer } from "@/engine/valuation-engine.js";
import { LeagueSettings } from "@/lib/api";
import { DraftEntry } from "@/store/draftStore";
import { decodeKeeper } from "@/lib/keeperPick";
import { posStyle } from "@/lib/posStyles";

interface Props {
  format: "auction" | "snake";
  settings: LeagueSettings;
  board: BoardPlayer[];
  picks: DraftEntry[];
  removePick: (pickId: number) => Promise<void>;
}

export default function KeeperRecommendations({ format, settings, board, picks, removePick }: Props) {
  const rule = useMemo(() => normalizeKeeperRule(settings.keeper, format), [settings.keeper, format]);
  const priceBasis = rule.basis === "price";
  const [open, setOpen] = useState(true);
  const [flexFloor, setFlexFloor] = useState(3);

  // Auction market value lives on par values, which are computed off the raw
  // board — so price it here before scoring surplus. Snake scores off VBD.
  const pricedBoard = useMemo(() => {
    if (format !== "auction") return board;
    const r = settings.roster;
    const rosterSize = r.QB + r.RB + r.WR + r.TE + r.FLEX + r.K + r.DST + r.BENCH + (settings.superflex ? (r.SF ?? 0) : 0);
    return auctionValues(board, { teams: settings.teams, budget: settings.budget, rosterSize, benchSpots: r.BENCH });
  }, [format, board, settings]);

  const playerById = useMemo(() => new Map(pricedBoard.map((p) => [p.id as number, p])), [pricedBoard]);
  const marketBoard = useMemo(() => marketOrder(pricedBoard), [pricedBoard]);
  const allKeptIds = useMemo(
    () => new Set(picks.map((p) => p.playerId).filter(Boolean) as number[]),
    [picks],
  );

  // Candidate pool = your committed keepers (over-add, then let it prune).
  const myKeepers = useMemo(() => {
    return picks
      .map((pick) => ({ pick, meta: decodeKeeper(pick.slot) }))
      .filter((x) => x.meta && x.meta.owner === "Me" && x.pick.playerId != null)
      .map(({ pick, meta }) => {
        const player = playerById.get(pick.playerId as number);
        if (!player) return null;
        const cost = keeperCost({ base: meta!.base, fa: meta!.base == null, kept: meta!.kept ?? 0 }, rule);
        return { pickId: pick.pickId, id: pick.playerId as number, player, cost };
      })
      .filter(Boolean) as { pickId: number; id: number; player: BoardPlayer; cost: ReturnType<typeof keeperCost> }[];
  }, [picks, playerById, rule]);

  const reco = useMemo(() => {
    if (myKeepers.length === 0) return null;
    const candidates = myKeepers.map((k) => ({ id: k.id, player: k.player, cost: k.cost }));
    return recommendKeepers(candidates, {
      format, board: pricedBoard, marketBoard,
      settings: { teams: settings.teams, draftSlot: settings.draftSlot ?? 1, budget: settings.budget, roster: settings.roster as unknown as Record<string, number> },
      allKeptIds, maxKeepers: rule.maxKeepers, flexFloor,
    });
  }, [myKeepers, format, pricedBoard, marketBoard, settings, allKeptIds, rule.maxKeepers, flexFloor]);

  const impact = useMemo(
    () => (reco ? draftImpact(reco.best, { format, settings: { teams: settings.teams, draftSlot: settings.draftSlot ?? 1, budget: settings.budget, roster: settings.roster as unknown as Record<string, number> } }) : null),
    [reco, format, settings],
  );

  const keepIds = useMemo(() => new Set(reco?.best.ids ?? []), [reco]);
  const topExcluded = reco?.ranked.find((r) => !r.recommended);

  const applyReco = async () => {
    const drop = myKeepers.filter((k) => !keepIds.has(k.id));
    if (drop.length === 0) return;
    if (!confirm(`Drop ${drop.length} keeper${drop.length === 1 ? "" : "s"} the model doesn't recommend?`)) return;
    for (const k of drop) await removePick(k.pickId);
  };

  return (
    <div className="mt-4 border-t border-hair pt-4">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        <Sparkles className="h-4 w-4 text-brand" />
        <h4 className="text-sm font-semibold tracking-tight">Recommendation</h4>
        {format === "snake" && (
          <span className="chip border-line bg-raised text-muted">from slot {settings.draftSlot ?? 1}</span>
        )}
        <ChevronDown className={`ml-auto h-4 w-4 text-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="mt-3">
          {myKeepers.length === 0 ? (
            <p className="text-xs italic text-faint">
              Add your keeper candidates above (or auto-fill from ESPN) and this will recommend which to keep —
              it's fine to keep fewer than the max, or none.
            </p>
          ) : !reco ? null : (
            <div className="space-y-3">
              {/* headline */}
              <div className="rounded-lg border border-brand/30 bg-brand/5 px-3 py-2.5">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-semibold text-ink">
                    {reco.best.ids.length === 0
                      ? "Keep none"
                      : `Keep ${reco.best.ids.length} of ${myKeepers.length}`}
                  </span>
                  <span className="text-muted">
                    {reco.best.ids.length > 0 && `· ${reco.best.items.map((it) => it.cand.player.name).join(", ")}`}
                  </span>
                </div>
                {reco.best.ids.length < Math.min(myKeepers.length, rule.maxKeepers) && topExcluded && (
                  <p className="mt-1 flex items-start gap-1.5 text-2xs text-muted">
                    <Info className="mt-0.5 h-3 w-3 shrink-0 text-faint" />
                    Fewer than the max of {rule.maxKeepers}: {topExcluded.cand.player.name} adds only KV {topExcluded.kv} —
                    the open {priceBasis ? "money" : "pick"} and flexibility are worth more.
                  </p>
                )}
              </div>

              {/* ranked candidates */}
              <div className="overflow-hidden rounded-lg border border-line">
                <div className={`grid ${priceBasis ? "grid-cols-[1fr_46px_46px_46px_52px_56px]" : "grid-cols-[1fr_64px_46px_46px_52px_56px]"} gap-1 border-b border-line bg-raised px-2.5 py-1.5 font-mono text-2xs uppercase tracking-wider text-faint`}>
                  <span>Player</span>
                  <span className="text-right">{priceBasis ? "$cost" : "cost→pick"}</span>
                  <span className="text-right">{priceBasis ? "$mkt" : "you'd get"}</span>
                  <span className="text-right">surp</span>
                  <span className="text-right">scarce</span>
                  <span className="text-right">verdict</span>
                </div>
                {reco.ranked.map((it) => {
                  const st = posStyle(it.cand.player.pos);
                  return (
                    <div
                      key={it.cand.id}
                      className={`grid ${priceBasis ? "grid-cols-[1fr_46px_46px_46px_52px_56px]" : "grid-cols-[1fr_64px_46px_46px_52px_56px]"} items-center gap-1 border-b border-l-[3px] border-b-hair px-2.5 py-1.5 text-xs ${st.accent} ${it.recommended ? "bg-emerald-50/60" : "bg-surface"}`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={`font-mono text-2xs font-semibold ${st.text}`}>{it.cand.player.pos}</span>
                        <span className="truncate text-ink">{it.cand.player.name}</span>
                      </span>
                      <span className="text-right font-mono text-2xs text-muted">
                        {priceBasis ? `$${it.cost}` : `R${it.round ?? it.cost}→${it.forfeitPick}`}
                      </span>
                      <span className="text-right font-mono text-2xs text-faint" title={it.forfeit ? `you'd get ${it.forfeit.name}` : ""}>
                        {priceBasis ? `$${Math.round(it.market)}` : it.forfeit ? it.forfeit.name.split(" ").slice(-1)[0] : "—"}
                      </span>
                      <span className={`text-right font-mono text-2xs ${it.surplus >= 0 ? "text-emerald-600" : "text-rose-500"}`}>
                        {it.surplus > 0 ? "+" : ""}{it.surplus}
                      </span>
                      <span className="text-right font-mono text-2xs text-faint">{it.scarcity}</span>
                      <span className="flex items-center justify-end">
                        {it.recommended ? (
                          <span className="inline-flex items-center gap-0.5 font-mono text-2xs font-semibold text-emerald-600"><Check className="h-3 w-3" />keep</span>
                        ) : (
                          <span className="inline-flex items-center gap-0.5 font-mono text-2xs text-faint"><Minus className="h-3 w-3" />hold</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* draft impact + controls */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-2xs text-muted">
                {impact && priceBasis && (
                  <span>Keeper spend <span className="font-mono text-ink">${impact.spend}</span> · budget left <span className="font-mono text-ink">${impact.budgetLeft}</span></span>
                )}
                {impact && !priceBasis && impact.forfeitedPicks && (
                  <span>Forfeits {impact.forfeitedPicks.length === 0 ? "no picks" : impact.forfeitedPicks.map((f) => `R${f.round} (pick ${f.overall})`).join(", ")}</span>
                )}
                <label className="ml-auto flex items-center gap-1.5">
                  Flex floor
                  <input
                    type="number" value={flexFloor} min={0}
                    onChange={(e) => setFlexFloor(Math.max(0, Number(e.target.value) || 0))}
                    className="w-12 rounded border border-line bg-sunken px-1.5 py-0.5 text-right font-mono text-ink focus:border-brand focus:outline-none"
                    title="Minimum keeper value (KV) to bother keeping — higher = more selective"
                  />
                </label>
                {myKeepers.some((k) => !keepIds.has(k.id)) && (
                  <button onClick={applyReco} className="btn border-line bg-surface px-2.5 py-1 text-2xs text-ink hover:bg-hover">
                    Apply (drop {myKeepers.filter((k) => !keepIds.has(k.id)).length})
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

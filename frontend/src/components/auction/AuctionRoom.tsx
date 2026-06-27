import { useMemo, useState, useCallback } from "react";
import { ArrowLeft, Crown, AlertTriangle, Gavel, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { auctionValues, applyInflation, maxBid } from "@/engine/valuation-engine.js";
import type { BoardPlayer } from "@/engine/valuation-engine.js";
import { LeagueSettings, ApiLeague } from "@/lib/api";
import { useDraftStore } from "@/store/draftStore";
import { usePatchLeague } from "@/hooks/useLeague";
import { posStyle } from "@/lib/posStyles";
import BoardControls from "@/components/board/BoardControls";
import ValueBar from "@/components/board/ValueBar";
import BudgetTracker from "@/components/auction/BudgetTracker";
import NominationPanel from "@/components/auction/NominationPanel";
import InflationBadge from "@/components/auction/InflationBadge";
import RosterPanel from "@/components/shared/RosterPanel";
import CommonOpponentsPopover from "@/components/shared/CommonOpponentsPopover";
import SettingsDrawer from "./SettingsDrawer";

interface Props {
  league: ApiLeague;
  settings: LeagueSettings;
  board: BoardPlayer[];
  leagueId: number;
}

export default function AuctionRoom({ league, settings, board, leagueId }: Props) {
  const nav = useNavigate();
  const patchLeague = usePatchLeague(leagueId);
  const { picks, addPick, removePick } = useDraftStore();

  const [query, setQuery] = useState("");
  const [posFilter, setPosFilter] = useState("ALL");
  const [hideDrafted, setHideDrafted] = useState(true);
  const [prices, setPrices] = useState<Record<number, number>>({});
  const [showSettings, setShowSettings] = useState(false);

  const rosterSize = useMemo(() => {
    const r = settings.roster;
    return r.QB + r.RB + r.WR + r.TE + r.FLEX + r.K + r.DST + r.BENCH + (settings.superflex ? (r.SF ?? 0) : 0);
  }, [settings]);

  const al = useMemo(() => ({ teams: settings.teams, budget: settings.budget, rosterSize }), [settings, rosterSize]);

  const withPar = useMemo(() => auctionValues(board, al), [board, al]);

  const draftedPrices = useMemo(
    () => picks
      .filter((p): p is typeof p & { playerId: number; price: number } => p.mine && p.playerId != null && p.price != null)
      .map((p) => ({ id: p.playerId, price: p.price })),
    [picks]
  );

  const inflation = useMemo(
    () => applyInflation(withPar, draftedPrices, al),
    [withPar, draftedPrices, al]
  );

  const draftedIds = useMemo(() => new Set(picks.map((p) => p.playerId)), [picks]);

  const minePicks = picks.filter((p) => p.mine);
  const mySpent = minePicks.reduce((s, p) => s + (p.price ?? 0), 0);
  const myBudgetLeft = settings.budget - mySpent;
  const myOpenSpots = rosterSize - minePicks.length;
  const myMax = maxBid(myBudgetLeft, Math.max(1, myOpenSpots));

  const maxVbd = board.length ? Math.max(1, board[0].vbd) : 1;

  const buy = useCallback((p: BoardPlayer, mine: boolean) => {
    const price = Math.max(1, Math.round(prices[p.id as number] ?? p.adjValue ?? p.parValue ?? 1));
    addPick({ playerId: p.id as number, mine, price });
    setPrices((prev) => { const n = { ...prev }; delete n[p.id as number]; return n; });
  }, [prices, addPick]);

  const undo = useCallback((pickId: number) => removePick(pickId), [removePick]);

  const resetDraft = () => {
    if (confirm("Clear the auction log? Settings stay.")) {
      picks.forEach((p) => removePick(p.pickId));
    }
  };

  const filtered = useMemo(() => inflation.board.filter((p) => {
    if (hideDrafted && draftedIds.has(p.id as number)) return false;
    if (posFilter !== "ALL" && p.pos !== posFilter) return false;
    if (query && !p.name.toLowerCase().includes(query.toLowerCase()) && !p.team.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [inflation.board, hideDrafted, draftedIds, posFilter, query]);

  const targets = useMemo(() =>
    board.filter((p) => !draftedIds.has(p.id as number) && ["QB","RB","WR","TE"].includes(p.pos)).slice(0, 4),
    [board, draftedIds]
  );

  const pprLabel = settings.ppr === 1 ? "PPR" : settings.ppr === 0.5 ? "Half-PPR" : "Std";

  return (
    <div className="min-h-screen bg-paper text-ink font-sans">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <button onClick={() => nav("/")} className="rounded-md p-1 text-faint hover:bg-raised hover:text-ink">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-gold/10 ring-1 ring-gold/25">
              <Gavel className="h-4 w-4 text-gold" />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-none tracking-tight">{league.name}</h1>
              <p className="mt-1 font-mono text-2xs leading-none text-faint">
                {settings.teams}×${settings.budget} · {rosterSize}-man · {pprLabel}
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <InflationBadge factor={inflation.factor} />
            <button onClick={() => setShowSettings((v) => !v)} className="btn-ghost px-2.5 py-1.5 text-xs">
              <Settings className="h-3.5 w-3.5" /> League
            </button>
          </div>
        </div>
      </header>

      {showSettings && (
        <SettingsDrawer
          settings={settings}
          onSave={(s) => patchLeague.mutate({ settings: s })}
          onClose={() => setShowSettings(false)}
        />
      )}

      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-4 px-4 py-5 lg:grid-cols-[1fr_300px]">
        <section>
          <BoardControls
            query={query} onQuery={setQuery}
            posFilter={posFilter} onPos={setPosFilter}
            hideLabel="hide sold" hideChecked={hideDrafted} onHide={setHideDrafted}
            accentColor="accent-gold"
          />

          <div className="card overflow-hidden">
            <div className="grid grid-cols-[44px_1fr_64px_112px] items-center gap-2 border-b border-line bg-raised px-3 py-2 font-mono text-2xs uppercase tracking-wider text-faint sm:grid-cols-[48px_1fr_64px_60px_60px_150px]">
              <span>Pos</span><span>Player</span>
              <span className="hidden text-right sm:block">VBD</span>
              <span className="hidden text-right sm:block">$Par</span>
              <span className="text-right">$Live</span>
              <span className="text-right">Bid / buy</span>
            </div>

            <div className="scroll-tidy max-h-[62vh] overflow-y-auto">
              {filtered.map((p, i) => {
                const st = posStyle(p.pos);
                const pickEntry = picks.find((pk) => pk.playerId === (p.id as number));
                const sold = !!pickEntry;
                const live = p.adjValue ?? p.parValue ?? 1;
                const overMax = (live as number) > myMax;
                const mktDiff = p.ecr != null
                  ? Math.round(board.findIndex((b) => b.id === p.id) + 1 - p.ecr)
                  : null;

                const rowBg = sold
                  ? pickEntry?.mine
                    ? "bg-amber-50/70 opacity-80"
                    : "bg-sunken opacity-55"
                  : i % 2 === 1
                  ? "bg-stripe hover:bg-hover"
                  : "bg-surface hover:bg-hover";

                return (
                  <div
                    key={p.id}
                    className={`grid grid-cols-[44px_1fr_64px_112px] items-center gap-2 border-b border-l-[3px] border-b-hair px-3 py-2 text-sm transition-colors sm:grid-cols-[48px_1fr_64px_60px_60px_150px] ${st.accent} ${rowBg}`}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                      <span className={`font-mono text-2xs font-semibold ${st.text}`}>{p.pos}</span>
                    </span>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {pickEntry?.mine && <Crown className="h-3 w-3 shrink-0 text-gold" />}
                        <span className="truncate font-medium text-ink">{p.name}</span>
                        <span className="font-mono text-2xs text-faint">{p.team}</span>
                        {p.tier && <span className="chip border-line bg-raised text-muted">T{p.tier}</span>}
                        {p.risk >= 0.4 && <AlertTriangle className="h-3 w-3 text-amber-500" aria-label={`risk ${p.risk}`} />}
                        {typeof p.id === "number" && <CommonOpponentsPopover playerId={p.id} />}
                      </div>
                      <div className="font-mono text-2xs tnum text-faint">
                        {p.valuePoints}pt{p.priorEquiv != null ? ` · '25 pace ${p.priorEquiv}` : " · no '25"}
                        {mktDiff != null && (
                          <span className={`ml-1 ${mktDiff > 0 ? "text-emerald-600" : "text-rose-500"}`}>
                            mkt {mktDiff > 0 ? "+" : ""}{mktDiff}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="hidden sm:block">
                      <ValueBar pos={p.pos} vbd={p.vbd} maxVbd={maxVbd} />
                    </div>

                    <span className="hidden text-right font-mono text-2xs tnum text-faint sm:block">${p.parValue}</span>

                    <span className={`text-right font-mono text-sm tnum ${overMax && !sold ? "text-rose-600" : "text-gold"}`}>
                      ${live}
                    </span>

                    <div className="flex items-center justify-end gap-1">
                      {sold ? (
                        <button
                          onClick={() => pickEntry && undo(pickEntry.pickId)}
                          className={`btn px-2 py-1 font-mono text-2xs ${
                            pickEntry?.mine
                              ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
                              : "border-line bg-raised text-muted hover:text-ink"
                          }`}
                        >
                          ${pickEntry?.price} ✕
                        </button>
                      ) : (
                        <>
                          <input
                            type="number"
                            value={prices[p.id as number] ?? live}
                            onChange={(e) => setPrices((pr) => ({ ...pr, [p.id as number]: Number(e.target.value) }))}
                            className="w-12 rounded-md border border-line bg-sunken px-1.5 py-1 text-right font-mono text-xs text-ink focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/15"
                          />
                          <button
                            onClick={() => buy(p, true)}
                            className="btn border-gold bg-gold px-2 py-1 text-2xs text-white hover:bg-gold/90"
                          >
                            Mine
                          </button>
                          <button
                            onClick={() => buy(p, false)}
                            className="btn border-line bg-surface px-2 py-1 text-2xs text-muted hover:bg-raised hover:text-ink"
                          >
                            Out
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div className="px-3 py-10 text-center text-sm text-faint">No players match.</div>
              )}
            </div>
          </div>
        </section>

        <aside className="space-y-3">
          <BudgetTracker
            budget={settings.budget}
            spent={mySpent}
            openSpots={myOpenSpots}
            maxBid={myMax}
          />

          <RosterPanel
            picks={picks}
            board={board}
            settings={settings}
            onReset={resetDraft}
            mode="auction"
          />

          <NominationPanel
            factor={inflation.factor}
            targets={targets}
            myMax={myMax}
            remainingMoney={inflation.remainingMoney}
            remainingSpots={inflation.remainingSpots}
          />
        </aside>
      </main>
    </div>
  );
}

import { useMemo, useState, useCallback } from "react";
import { ArrowLeft, Crown, AlertTriangle, Gavel, Settings, RotateCcw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  auctionValues, applyInflation, maxBid,
  dollarValues, marketPrice, nominationScore, nominationPhase, suggestBid,
} from "@/engine/auction-engine.js";
import type { BoardPlayer } from "@/engine/auction-engine.js";
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

  const al = useMemo(
    () => ({ teams: settings.teams, budget: settings.budget, rosterSize, benchSpots: settings.roster.BENCH }),
    [settings, rosterSize],
  );

  // Opponent labels + live per-opponent remaining budget (for nomination strategy).
  const opponents = useMemo(
    () => (settings.opponents?.length
      ? settings.opponents
      : Array.from({ length: Math.max(0, settings.teams - 1) }, (_, i) => `Team ${i + 2}`)),
    [settings.opponents, settings.teams],
  );
  const oppBudgets = useMemo(() => {
    const spent = opponents.map(() => 0);
    for (const p of picks)
      if (!p.mine && p.teamId != null && p.teamId >= 0 && p.teamId < spent.length)
        spent[p.teamId] += p.price ?? 0;
    return spent.map((s) => settings.budget - s);
  }, [picks, opponents, settings.budget]);

  const withPar = useMemo(() => auctionValues(board, al), [board, al]);

  // Position-allocation dollar values + market prices (ported strategy).
  const withDollar = useMemo(() => dollarValues(board, al), [board, al]);
  const adpRankById = useMemo(() => {
    const ranked = board.filter((p) => p.adp != null && p.adp > 0).sort((a, b) => (a.adp! - b.adp!));
    const m: Record<number, number> = {};
    ranked.forEach((p, i) => { m[p.id as number] = i + 1; });
    return m;
  }, [board]);
  const marketById = useMemo(() => {
    const m: Record<number, number> = {};
    for (const p of board) m[p.id as number] = marketPrice(adpRankById[p.id as number], al, undefined, p.pos);
    return m;
  }, [board, adpRankById, al]);

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

  const buy = useCallback((p: BoardPlayer, mine: boolean, teamId?: number) => {
    const price = Math.max(1, Math.round(prices[p.id as number] ?? p.adjValue ?? p.parValue ?? 1));
    addPick({ playerId: p.id as number, mine, teamId, price });
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

  // Nomination strategy + value targets (ported model).
  const fractionDone = picks.length / Math.max(1, settings.teams * rosterSize);
  const richFrac = oppBudgets.length
    ? oppBudgets.filter((b) => b > 40).length / oppBudgets.length : 0;
  const phase = nominationPhase(richFrac);

  const availDollar = useMemo(
    () => withDollar.filter((p) => !draftedIds.has(p.id as number)),
    [withDollar, draftedIds],
  );
  const remainingDvSum = useMemo(
    () => availDollar.reduce((s, p) => s + (p.dollarValue ?? 1), 0),
    [availDollar],
  );

  const nominations = useMemo(() => {
    const ds = { oppBudgets, marketById, fractionDone };
    return availDollar
      .map((p) => ({ p, ...nominationScore(p, ds) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }, [availDollar, oppBudgets, marketById, fractionDone]);

  const valueTargets = useMemo(() => {
    return availDollar
      .filter((p) => ["QB", "RB", "WR", "TE"].includes(p.pos))
      .map((p) => {
        const market = marketById[p.id as number] ?? 1;
        const sug = suggestBid(p, { budget: myBudgetLeft, openSpots: Math.max(1, myOpenSpots), remainingDvSum, market });
        return { p, ...sug, surplus: (p.dollarValue ?? 1) - market };
      })
      .sort((a, b) => b.surplus - a.surplus)
      .slice(0, 4);
  }, [availDollar, marketById, myBudgetLeft, myOpenSpots, remainingDvSum]);

  const pprLabel = settings.ppr === 1 ? "PPR" : settings.ppr === 0.5 ? "Half-PPR" : "Std";

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-gray-50/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <button onClick={() => nav("/")} className="text-gray-500 hover:text-gray-600 mr-1">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded bg-amber-50 border border-amber-300 grid place-items-center">
              <Gavel className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight leading-none">{league.name}</h1>
              <p className="text-xs text-gray-500 leading-none mt-0.5 font-mono">
                {settings.teams}×${settings.budget} · {rosterSize}-man · {pprLabel}
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <InflationBadge factor={inflation.factor} />
            <button onClick={() => setShowSettings((v) => !v)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-gray-50 border border-gray-200 hover:border-gray-300">
              <Settings className="w-3.5 h-3.5" /> League
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

      <main className="max-w-6xl mx-auto px-4 py-4 grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
        <section>
          <BoardControls
            query={query} onQuery={setQuery}
            posFilter={posFilter} onPos={setPosFilter}
            hideLabel="hide sold" hideChecked={hideDrafted} onHide={setHideDrafted}
            accentColor="accent-amber-500"
          />

          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <div className="grid grid-cols-[40px_1fr_64px_110px] sm:grid-cols-[44px_1fr_60px_64px_64px_150px] gap-2 px-3 py-2 bg-white/80 text-xs uppercase tracking-wider text-gray-500 font-mono">
              <span>Pos</span><span>Player</span>
              <span className="text-right hidden sm:block">VBD</span>
              <span className="text-right hidden sm:block">$Par</span>
              <span className="text-right">$Live</span>
              <span className="text-right">Bid / buy</span>
            </div>

            <div className="divide-y divide-gray-200 max-h-[62vh] overflow-y-auto">
              {filtered.map((p) => {
                const st = posStyle(p.pos);
                const pickEntry = picks.find((pk) => pk.playerId === (p.id as number));
                const sold = !!pickEntry;
                const live = p.adjValue ?? p.parValue ?? 1;
                const overMax = (live as number) > myMax;
                const mktDiff = p.ecr != null
                  ? Math.round(board.findIndex((b) => b.id === p.id) + 1 - p.ecr)
                  : null;

                return (
                  <div
                    key={p.id}
                    className={`grid grid-cols-[40px_1fr_64px_110px] sm:grid-cols-[44px_1fr_60px_64px_64px_150px] gap-2 px-3 py-2 items-center text-sm ${sold ? "opacity-40" : "hover:bg-gray-100"}`}
                  >
                    <span className="flex items-center gap-1 text-xs font-mono">
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                      <span className={st.text}>{p.pos}</span>
                    </span>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {pickEntry?.mine && <Crown className="w-3 h-3 text-amber-400 shrink-0" />}
                        <span className="font-medium truncate">{p.name}</span>
                        <span className="font-mono text-xs text-gray-500">{p.team}</span>
                        {p.tier && <span className="text-xs font-mono bg-gray-100 px-1 rounded text-gray-500">T{p.tier}</span>}
                        {p.risk >= 0.4 && <AlertTriangle className="w-3 h-3 text-amber-600" aria-label={`risk ${p.risk}`} />}
                        {typeof p.id === "number" && <CommonOpponentsPopover playerId={p.id} />}
                      </div>
                      <div className="text-xs text-gray-500 font-mono tabular-nums">
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

                    <span className="text-right font-mono text-xs text-gray-500 hidden sm:block">${p.parValue}</span>

                    <span className={`text-right font-mono text-sm tabular-nums ${overMax && !sold ? "text-rose-600" : "text-amber-700"}`}>
                      ${live}
                    </span>

                    <div className="flex items-center justify-end gap-1">
                      {sold ? (
                        <button
                          onClick={() => pickEntry && undo(pickEntry.pickId)}
                          className="text-xs font-mono px-2 py-1 rounded bg-gray-100 border border-gray-300 text-gray-500 hover:text-gray-700"
                        >
                          ${pickEntry?.price} ✕
                        </button>
                      ) : (
                        <>
                          <input
                            type="number"
                            value={prices[p.id as number] ?? live}
                            onChange={(e) => setPrices((pr) => ({ ...pr, [p.id as number]: Number(e.target.value) }))}
                            className="w-12 px-1.5 py-1 rounded bg-gray-50 border border-gray-300 text-right font-mono text-xs text-gray-700 focus:outline-none focus:border-amber-600"
                          />
                          <button
                            onClick={() => buy(p, true)}
                            className="px-1.5 py-1 rounded text-xs bg-amber-50 border border-amber-300 text-amber-700 hover:bg-amber-100"
                          >
                            Mine
                          </button>
                          <select
                            value=""
                            onChange={(e) => { if (e.target.value !== "") buy(p, false, Number(e.target.value)); }}
                            title="Won by an opponent — pick which team"
                            className="px-1 py-1 rounded text-xs bg-gray-50 border border-gray-300 text-gray-500 hover:text-gray-700 focus:outline-none focus:border-gray-400 max-w-[72px]"
                          >
                            <option value="">Out ▾</option>
                            {opponents.map((name, i) => (
                              <option key={i} value={i}>{name}</option>
                            ))}
                          </select>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div className="px-3 py-8 text-center text-sm text-gray-500">No players match.</div>
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
            phase={phase}
            nominations={nominations}
            valueTargets={valueTargets}
            myMax={myMax}
            oppBudgets={oppBudgets}
            richThreshold={40}
          />
        </aside>
      </main>
    </div>
  );
}

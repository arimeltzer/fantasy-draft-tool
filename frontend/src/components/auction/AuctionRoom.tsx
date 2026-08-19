import { useMemo, useState, useCallback } from "react";
import { ArrowLeft, Crown, AlertTriangle, Gavel, Settings, Lock, RotateCcw, Radio, HelpCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  auctionValues, applyInflation, maxBid,
  dollarValues, marketPrice, nominationScore, nominationPhase, suggestBid, rankByAdp,
} from "@/engine/auction-engine.js";
import type { BoardPlayer } from "@/engine/auction-engine.js";
import { LeagueSettings, ApiLeague } from "@/lib/api";
import {
  calibrateAuction, picksFromKeeperImport, noCalibration, describeCalibration,
} from "@/engine/auction-calibration.js";
import { bidCeiling, remainingStartingSlots } from "@/engine/budget-path.js";
import {
  priceCeilingFor, bindingCeiling, opponentCountsFromPicks,
} from "@/engine/opponent-capacity.js";
import { useDraftStore } from "@/store/draftStore";
import { usePatchLeague } from "@/hooks/useLeague";
import { posStyle } from "@/lib/posStyles";
import { isKeeper, decodeKeeper, encodeKeeper } from "@/lib/keeperPick";
import BoardControls from "@/components/board/BoardControls";
import ValueBar from "@/components/board/ValueBar";
import BudgetTracker from "@/components/auction/BudgetTracker";
import NominationPanel from "@/components/auction/NominationPanel";
import InflationBadge from "@/components/auction/InflationBadge";
import CalibrationBadge from "@/components/auction/CalibrationBadge";
import RosterPanel from "@/components/shared/RosterPanel";
import NeedsPanel from "@/components/snake/NeedsPanel";
import CommonOpponentsPopover from "@/components/shared/CommonOpponentsPopover";
import KeeperPlanner from "@/components/shared/KeeperPlanner";
import DraftOverview from "@/components/shared/DraftOverview";
import DraftLogModal from "@/components/shared/DraftLogModal";
import LiveDraftPanel from "@/components/shared/LiveDraftPanel";
import InjuryBadge from "@/components/shared/InjuryBadge";
import Tip from "@/components/shared/Tip";
import ProjTip from "@/components/shared/ProjTip";
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
  const { picks, addPick, removePick, updatePick, hydrate } = useDraftStore();

  const [query, setQuery] = useState("");
  const [posFilter, setPosFilter] = useState("ALL");
  const [hideDrafted, setHideDrafted] = useState(true);
  const [prices, setPrices] = useState<Record<number, number>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [showKeepers, setShowKeepers] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showLive, setShowLive] = useState(false);

  const rosterSize = useMemo(() => {
    // Every term needs a fallback: a league that doesn't roster a kicker
    // simply has no K key, and one `undefined` in this sum makes rosterSize
    // NaN — which then silently poisons dollarValues (leagueAvail -> NaN),
    // every suggested bid, and maxBid, rendering "bid $NaN" in the panel.
    // Only SF was defensive before, so the bug fired on any roster missing
    // K or DST.
    const r = settings.roster;
    return (r.QB ?? 0) + (r.RB ?? 0) + (r.WR ?? 0) + (r.TE ?? 0) + (r.FLEX ?? 0)
      + (r.K ?? 0) + (r.DST ?? 0) + (r.BENCH ?? 0)
      + (settings.superflex ? (r.SF ?? 0) : 0);
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

  // Roster slots each opponent still has to fill (roadmap 3.4). Budget alone
  // overstates what a team can bid — every remaining slot needs a dollar held
  // back — so capacity needs the spot count too, not just the money.
  const oppOpenSpots = useMemo(() => {
    const taken = opponents.map(() => 0);
    for (const p of picks)
      if (!p.mine && p.teamId != null && p.teamId >= 0 && p.teamId < taken.length)
        taken[p.teamId] += 1;
    return taken.map((n) => Math.max(0, rosterSize - n));
  }, [picks, opponents, rosterSize]);

  // What each opponent already OWNS by position (roadmap 3.4a). Money alone
  // says a rich team can bid on anyone; this is what says whether they'd
  // want to. A team stacked at a position stops being a bidder there.
  const oppCounts = useMemo(
    () => opponentCountsFromPicks(
      picks,
      new Map(board.map((p) => [p.id as number, p.pos])),
      opponents.length,
    ),
    [picks, opponents.length, board],
  );

  const withPar = useMemo(() => auctionValues(board, al), [board, al]);

  // Position-allocation dollar values + market prices (ported strategy).
  const withDollar = useMemo(() => dollarValues(board, al), [board, al]);
  const adpRankById = useMemo(() => rankByAdp(board), [board]);

  // What THIS room pays, learned from last season's draft prices — which the
  // keeper importer already pulled and cached. FantasyPros publishes no
  // auction values, so without this every market price is a generic curve
  // identical for every league. Applied to the market forecast only; our own
  // dollarValue stays independent, or the bargain signal it exists to show
  // would be measuring itself.
  const calibration = useMemo(() => {
    if (settings.auctionCalibration === false) return noCalibration("turned off in settings");
    return calibrateAuction(picksFromKeeperImport(settings.keeperImport), al);
  }, [settings.keeperImport, settings.auctionCalibration, al]);

  const marketById = useMemo(() => {
    const m: Record<number, number> = {};
    for (const p of board) {
      m[p.id as number] = marketPrice(adpRankById[p.id as number], al, undefined, p.pos, p.aav, calibration);
    }
    return m;
  }, [board, adpRankById, al, calibration]);

  // Every priced pick in the room — my buys, opponents' buys, and keepers —
  // drives inflation (money spent is money out of the pool, whoever spent it).
  const draftedPrices = useMemo(
    () => picks
      .filter((p): p is typeof p & { playerId: number; price: number } => p.playerId != null && p.price != null)
      .map((p) => ({ id: p.playerId, price: p.price })),
    [picks]
  );

  const inflation = useMemo(
    () => applyInflation(withPar, draftedPrices, al),
    [withPar, draftedPrices, al]
  );

  const draftedIds = useMemo(() => new Set(picks.map((p) => p.playerId)), [picks]);

  const minePicks = picks.filter((p) => p.mine);
  const minePlayers = useMemo(() => {
    const byId = new Map(board.map((p) => [p.id as number, p]));
    return picks
      .filter((p) => p.mine && p.playerId)
      .map((p) => byId.get(p.playerId!))
      .filter(Boolean) as BoardPlayer[];
  }, [picks, board]);
  const mySpent = minePicks.reduce((s, p) => s + (p.price ?? 0), 0);
  const myBudgetLeft = settings.budget - mySpent;
  const myOpenSpots = rosterSize - minePicks.length;
  const myMax = maxBid(myBudgetLeft, Math.max(1, myOpenSpots));

  const maxVbd = board.length ? Math.max(1, board[0].vbd) : 1;

  const buy = useCallback((p: BoardPlayer, mine: boolean, teamId?: number) => {
    const price = Math.max(1, Math.round(prices[p.id as number] ?? p.adjValue ?? p.parValue ?? 1));
    // See SnakeRoom's `draft`: addPick rethrows on failure after rolling back
    // the optimistic row, and this call was never awaited, so that used to be
    // a silent unhandled rejection. Surface it instead.
    addPick({ playerId: p.id as number, mine, teamId, price }).catch(() => {
      alert(`Couldn't save the sale for ${p.name} — check your connection and try again.`);
    });
    setPrices((prev) => { const n = { ...prev }; delete n[p.id as number]; return n; });
  }, [prices, addPick]);

  const undo = useCallback((pickId: number) => removePick(pickId), [removePick]);

  /** Keepers tag their owner by name inside the pick's `slot` marker, which
   *  lives in the DB rather than league settings, so a rename rewrites them
   *  too — otherwise those keepers stop being attributed to their team. */
  const renameTeamOnPicks = useCallback(async (renames: { from: string; to: string }[]) => {
    if (!renames.length) return;
    const byOld = new Map(renames.map((r) => [r.from, r.to]));
    for (const pick of picks) {
      const meta = decodeKeeper(pick.slot);
      const next = meta && byOld.get(meta.owner);
      if (!next) continue;
      await updatePick(pick.pickId, { slot: encodeKeeper({ ...meta!, owner: next }) });
    }
  }, [picks, updatePick]);

  const resetDraft = () => {
    if (confirm("Clear the auction log? Keepers and settings stay.")) {
      picks.filter((p) => !isKeeper(p)).forEach((p) => removePick(p.pickId));
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

  // Budget path (roadmap 3.3): which starting slots are still open, and how
  // much of the budget is spoken for by bench/K/DST at minimum bid.
  const { slots: openStartSlots, reserveSpots } = useMemo(
    () => remainingStartingSlots(settings.roster as unknown as Record<string, number>, minePlayers),
    [settings.roster, minePlayers],
  );
  // Budget the DP may actually allocate: cash on hand minus $1 held back for
  // every slot the DP does not optimize (see budget-path.js's stated
  // approximations). Never negative.
  const dpBudget = Math.max(0, myBudgetLeft - reserveSpots);
  const priceOfPlayer = useCallback(
    (p: BoardPlayer) => marketById[p.id as number] ?? 1,
    [marketById],
  );
  const valueOfPlayer = useCallback((p: BoardPlayer) => p.vbd ?? 0, []);

  const valueTargets = useMemo(() => {
    const targets = availDollar
      .filter((p) => ["QB", "RB", "WR", "TE"].includes(p.pos))
      .map((p) => {
        const market = marketById[p.id as number] ?? 1;
        const sug = suggestBid(p, { budget: myBudgetLeft, openSpots: Math.max(1, myOpenSpots), remainingDvSum, market });
        return { p, ...sug, surplus: (p.dollarValue ?? 1) - market };
      })
      .sort((a, b) => b.surplus - a.surplus)
      .slice(0, 4);

    // The allocation-aware ceiling, computed ONLY for the handful shown —
    // bidCeiling runs a DP per evaluation and must not be mapped over the
    // whole board. Shown ALONGSIDE the existing suggestion rather than
    // replacing it: nothing has measured this against head-to-head title
    // share (no auction simulator exists), so it informs rather than
    // overrides. See ROADMAP 3.3.
    return targets.map((t) => {
      const allocationCeiling = openStartSlots.length
        ? bidCeiling({
            player: t.p,
            slots: openStartSlots,
            budget: dpBudget,
            pool: availDollar,
            valueOf: valueOfPlayer,
            priceOf: priceOfPlayer,
          })
        : null;
      // roadmap 3.4 — and the room's ability to pay. Position-aware (3.4a):
      // only opponents who still need THIS position count, so a rich team
      // stacked at running back stops holding up every back's ceiling.
      const room = priceCeilingFor(t.p.pos, {
        budgets: oppBudgets,
        openSpots: oppOpenSpots,
        counts: oppCounts,
        leagueRoster: settings.roster as unknown as Record<string, number>,
        superflex: !!settings.superflex,
        minBid: 1,
      });
      // Whichever constraint binds is the actionable number; naming WHICH is
      // the useful part.
      const { bid: ceiling, binding } = bindingCeiling({
        allocationCeiling: allocationCeiling ?? undefined,
        // priceCeilingFor already folded demand in, so hand bindingCeiling a
        // single synthetic capacity rather than the raw per-opponent list —
        // otherwise it would re-derive the ungated ceiling and the demand
        // gating would be silently discarded.
        capacities: [Math.max(0, room.ceiling - 1)],
        minBid: 1,
      });
      return { ...t, allocationCeiling, ceiling, binding, room };
    });
  }, [availDollar, marketById, myBudgetLeft, myOpenSpots, remainingDvSum,
      openStartSlots, dpBudget, valueOfPlayer, priceOfPlayer,
      oppBudgets, oppOpenSpots, oppCounts, settings.roster, settings.superflex]);

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
            <CalibrationBadge cal={calibration} />
            <button
              onClick={() => setShowLive(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-gray-50 border border-gray-200 hover:border-gray-300"
              title="Follow the draft on ESPN/Yahoo and log picks automatically"
            >
              <Radio className="w-3.5 h-3.5" /> Live
            </button>
            <button onClick={() => { setShowKeepers((v) => !v); setShowSettings(false); }} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-gray-50 border border-gray-200 hover:border-gray-300">
              <Lock className="w-3.5 h-3.5" /> Keepers
            </button>
            <button onClick={() => { setShowSettings((v) => !v); setShowKeepers(false); }} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-gray-50 border border-gray-200 hover:border-gray-300">
              <Settings className="w-3.5 h-3.5" /> League
            </button>
          </div>
        </div>
      </header>

      {showLive && (
        <LiveDraftPanel
          leagueId={leagueId}
          settings={settings}
          onPicks={() => void hydrate(leagueId)}
          onClose={() => setShowLive(false)}
        />
      )}

      {showSettings && (
        <SettingsDrawer
          settings={settings}
          onSave={(s) => patchLeague.mutate({ settings: s })}
          onClose={() => setShowSettings(false)}
          format="auction"
          onRenames={renameTeamOnPicks}
        />
      )}

      {showKeepers && (
        <KeeperPlanner
          format="auction"
          leagueId={leagueId}
          settings={settings}
          board={board}
          picks={picks}
          addPick={addPick}
          removePick={removePick}
          onClose={() => setShowKeepers(false)}
        />
      )}

      <main className="max-w-6xl xl:max-w-[1400px] mx-auto px-4 py-4 grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_300px]">
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

          <NeedsPanel
            mine={minePlayers}
            settings={settings}
            draftedCount={picks.length}
          />
        </aside>

        <section className="order-first lg:order-none">
          <BoardControls
            query={query} onQuery={setQuery}
            posFilter={posFilter} onPos={setPosFilter}
            hideLabel="hide sold" hideChecked={hideDrafted} onHide={setHideDrafted}
            accentColor="accent-amber-500"
          />

          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <div className="grid grid-cols-[40px_minmax(120px,1fr)_64px_128px] sm:grid-cols-[44px_minmax(160px,1fr)_60px_64px_64px_160px] gap-2 px-3 py-2 bg-white/80 text-xs uppercase tracking-wider text-gray-500 font-mono">
              <span>Pos</span>
              <span className="flex items-center gap-1">
                Player
                <a
                  href="/methodology"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="What do the projection and value labels mean?"
                  className="text-gray-400 hover:text-gray-600 normal-case"
                >
                  <HelpCircle className="w-3.5 h-3.5" />
                </a>
              </span>
              <span className="text-right hidden sm:block">
                <Tip tip="Value Based Drafting: projected points above a replacement-level player at the same position. The bigger the number, the more this player wins you over a waiver-wire fill-in.">VBD</Tip>
              </span>
              <span className="text-right hidden sm:block">
                <Tip tip="Par value: the player's fair auction price before the draft starts — the league's total budget split among draftable players in proportion to VBD.">$Par</Tip>
              </span>
              <span className="text-right">
                <Tip tip="Live value: par price repriced for how the room is actually spending. If teams have overpaid so far, remaining players are worth more (inflation), and vice versa. Red means it's above the max you can bid.">$Live</Tip>
              </span>
              <span className="text-right">
                <Tip tip="Type the final winning price, then hit Mine if you won the player or pick the opponent who did.">Bid / buy</Tip>
              </span>
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
                    className={`grid grid-cols-[40px_minmax(120px,1fr)_64px_128px] sm:grid-cols-[44px_minmax(160px,1fr)_60px_64px_64px_160px] gap-2 px-3 py-2 items-center text-sm ${sold ? "opacity-40" : "hover:bg-gray-100"}`}
                  >
                    <span className="flex items-center gap-1 text-xs font-mono">
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                      <span className={st.text}>{p.pos}</span>
                    </span>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {pickEntry?.mine && <Crown className="w-3 h-3 text-amber-400 shrink-0" />}
                        <span className="font-medium truncate">{p.name}</span>
                        <InjuryBadge injury={p.injury} />
                        <span className="font-mono text-xs text-gray-500">{p.team}</span>
                        {p.tier && <span className="text-xs font-mono bg-gray-100 px-1 rounded text-gray-500" title={`Tier ${p.tier} at ${p.pos} — players in the same tier are roughly interchangeable; a new tier means a drop-off in value`}>T{p.tier}</span>}
                        {p.risk >= 0.4 && (
                          <span title={`Elevated risk (${p.risk} of 1) from week-to-week volatility, injury history, or age — expect a wider range of outcomes`}>
                            <AlertTriangle className="w-3 h-3 text-amber-600" aria-label={`risk ${p.risk}`} />
                          </span>
                        )}
                        {typeof p.id === "number" && <CommonOpponentsPopover playerId={p.id} />}
                      </div>
                      <div className="text-xs text-gray-500 font-mono tabular-nums">
                        <ProjTip steps={p.projBreakdown} value={p.valuePoints} />
                        <span title={p.priorEquiv != null ? "Last season's scoring pace over a full 17 games — a reality check on the projection" : "No 2025 stats — rookie or missed season, so the projection leans on market rankings"}>
                          {p.priorEquiv != null ? ` · '25 pace ${p.priorEquiv}` : " · no '25"}
                        </span>
                        {mktDiff != null && (
                          <span
                            className={`ml-1 ${mktDiff > 0 ? "text-emerald-600" : "text-rose-500"}`}
                            title={`This tool ranks the player ${Math.abs(mktDiff)} spot${Math.abs(mktDiff) === 1 ? "" : "s"} ${mktDiff > 0 ? "lower than" : "higher than"} expert consensus — ${mktDiff > 0 ? "the market likes them more (they'll cost extra)" : "a potential bargain the market is sleeping on"}`}
                          >
                            mkt {mktDiff > 0 ? "+" : ""}{mktDiff}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="hidden sm:block">
                      <ValueBar pos={p.pos} vbd={p.vbd} maxVbd={maxVbd} />
                    </div>

                    <span className="text-right font-mono text-xs text-gray-500 hidden sm:block" title="Pre-draft fair price (par value)">${p.parValue}</span>

                    <span
                      className={`text-right font-mono text-sm tabular-nums ${overMax && !sold ? "text-rose-600" : "text-amber-700"}`}
                      title={overMax && !sold ? `Inflation-adjusted value — above your current max bid of $${myMax}` : "What the player is worth right now, adjusted for draft-room inflation"}
                    >
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
                            className="w-10 sm:w-12 px-1.5 py-1 rounded bg-gray-50 border border-gray-300 text-right font-mono text-xs text-gray-700 focus:outline-none focus:border-amber-600"
                          />
                          <select
                            value=""
                            onChange={(e) => {
                              if (e.target.value === "") return;
                              if (e.target.value === "mine") buy(p, true);
                              else buy(p, false, Number(e.target.value));
                            }}
                            title="Who won this player?"
                            className="min-w-0 flex-1 px-1 py-1 rounded text-xs bg-gray-50 border border-gray-300 text-gray-600 hover:text-gray-800 focus:outline-none focus:border-amber-500"
                          >
                            <option value="" disabled>Winner…</option>
                            <option value="mine">Mine</option>
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
          <NominationPanel
            factor={inflation.factor}
            phase={phase}
            nominations={nominations}
            valueTargets={valueTargets}
            myMax={myMax}
            oppBudgets={oppBudgets}
            richThreshold={40}
          />

          <DraftOverview
            picks={picks}
            board={board}
            settings={settings}
            mode="auction"
            onEditLog={() => setShowLog(true)}
          />
        </aside>
      </main>

      {showLog && (
        <DraftLogModal
          picks={picks}
          board={board}
          settings={settings}
          mode="auction"
          onClose={() => setShowLog(false)}
        />
      )}
    </div>
  );
}

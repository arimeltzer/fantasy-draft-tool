import { useMemo, useState, useCallback } from "react";
import { ArrowLeft, Crown, AlertTriangle, Gavel, Settings, Lock, RotateCcw, Radio, HelpCircle, DollarSign, CalendarX } from "lucide-react";
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
import { maxUseful } from "@/engine/snake-engine.js";
import { byeCollisions } from "@/engine/bye-weeks.js";
import { useByeWeeks } from "@/hooks/useByeWeeks";
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
import { useLiveDraft, LiveDraftConfig } from "@/hooks/useLiveDraft";
import InjuryBadge from "@/components/shared/InjuryBadge";
import Tip from "@/components/shared/Tip";
import ProjTip from "@/components/shared/ProjTip";
import SettingsDrawer from "./SettingsDrawer";
import AavPasteImport from "./AavPasteImport";

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
  const [showAav, setShowAav] = useState(false);

  // Lifted here (not owned inside LiveDraftPanel) so closing that panel
  // — the natural thing to do to get back to drafting — doesn't unmount the
  // hook and kill the poll along with it. The panel is a controller now,
  // not the owner; see its own header comment.
  const [liveConfig, setLiveConfig] = useState<LiveDraftConfig | null>(null);
  const [liveIntervalMs, setLiveIntervalMs] = useState(10_000);
  const live = useLiveDraft(leagueId, liveConfig, liveIntervalMs, () => void hydrate(leagueId));

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
      // A per-league pasted AAV (roadmap 3.5 follow-up) wins over the shared
      // `fantasy_players.aav` column — someone in THIS room copied THIS
      // sheet, which is more current than whatever the shared baseline holds.
      const aav = settings.aavOverrides?.[p.id as number] ?? p.aav;
      m[p.id as number] = marketPrice(adpRankById[p.id as number], al, undefined, p.pos, aav, calibration);
    }
    return m;
  }, [board, adpRankById, al, calibration, settings.aavOverrides]);

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

  // Roster-slot-priority policy for the bench phase (roadmap 3.6, "goal to
  // build around" per a user's own explicit statement — not the bye/injury
  // insurance framing 3.6 first scoped toward). FLEX + BENCH are
  // interchangeable for RB/WR/TE; once starters are filled you want ONE
  // backup at every position (QB included), essentially no value past that
  // at QB/TE/K/DST, and unbounded value stacking RB/WR. `maxUseful` already
  // encodes exactly this — shipped and validated for the SNAKE recommender
  // (same real-draft bug it was built to stop: a third QB outscoring
  // startable skill players) — reused here rather than re-derived.
  const haveByPos = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of minePlayers) m[p.pos] = (m[p.pos] || 0) + 1;
    return m;
  }, [minePlayers]);

  // Real-time bye-week flag on the board (a user's explicit ask: don't fold a
  // one-week event into price — surface every same-position/same-week
  // pairing against my OWN roster instead, so I decide in the moment). See
  // bye-weeks.js byeCollisions for why this is deliberately unpriced and
  // separate from the small, capped byeClash penalty the snake recommender
  // already applies. The auction room has no bye-aware valuation at all
  // today, so this is a display-only addition.
  const { data: byeByTeam } = useByeWeeks();
  const myRosterByes = useMemo(() => {
    if (!byeByTeam) return [];
    return minePlayers
      .map((p) => ({ pos: p.pos as string, bye: p.team ? byeByTeam[p.team] ?? null : null, name: p.name }))
      .filter((p) => p.bye != null) as { pos: string; bye: number; name: string }[];
  }, [minePlayers, byeByTeam]);
  const byeWarnByPlayer = useMemo(() => {
    const m = new Map<number, { week: number; names: string[] }>();
    if (!byeByTeam) return m;
    for (const p of board) {
      if (typeof p.id !== "number" || !p.team) continue;
      const bye = byeByTeam[p.team];
      if (bye == null) continue;
      const collisions = byeCollisions(p.pos, bye, myRosterByes)
        .filter((c) => c.name !== p.name);
      if (collisions.length) m.set(p.id, { week: bye, names: collisions.map((c) => c.name) });
    }
    return m;
  }, [board, byeByTeam, myRosterByes]);

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

  // The player currently up for auction in the live ESPN draft room, if
  // live sync is running — pinned to the top of the board below so you
  // don't have to search for whoever just got nominated. Tracked off BID,
  // not NOMINATION, on the backend (see LiveDraftWatcher
  // .current_nomination_id's docstring for why); null the rest of the time.
  const currentNominationId = live.lastResult?.current_nomination?.player_id ?? null;

  const filtered = useMemo(() => {
    const base = inflation.board.filter((p) => {
      if (hideDrafted && draftedIds.has(p.id as number)) return false;
      if (posFilter !== "ALL" && p.pos !== posFilter) return false;
      if (query && !p.name.toLowerCase().includes(query.toLowerCase()) && !p.team.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
    if (currentNominationId == null) return base;
    // Move the nominated player to the front WITHOUT overriding an active
    // search/position filter — if they don't match what you're currently
    // looking at, they simply don't show, same as any other player.
    const idx = base.findIndex((p) => p.id === currentNominationId);
    if (idx <= 0) return base;
    const nominated = base[idx];
    return [nominated, ...base.slice(0, idx), ...base.slice(idx + 1)];
  }, [inflation.board, hideDrafted, draftedIds, posFilter, query, currentNominationId]);

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

  // The allocation-aware ceiling composed with the room ceiling — same shape
  // used both for the value-targets panel and (below) the on-demand board
  // lookup. Pulled out so the two call sites cannot drift about what "the
  // suggested bid" means.
  const ceilingFor = useCallback((p: BoardPlayer, market: number) => {
    // Once every STARTING slot is filled, bidCeiling has no more allocation
    // decision to make (its own header comment: "bench slots are $1 filler
    // and are NOT in the DP"). The old code passed `null` here, which
    // bindingCeiling treats as UNCONSTRAINED — falling through to
    // "whatever the room can theoretically pay", the SAME undifferentiated
    // number for every remaining player regardless of value. A real,
    // hit-in-practice bug (a user filled their starters and $Max went to
    // one fixed price with nothing in reach on the targets panel), not the
    // design working as intended.
    //
    // A flat $1 for everyone would only trade one undifferentiated number
    // for another — flagged directly ("if I can get a player for $2 I
    // should [see that]"). Every remaining pick is now bench value, and a
    // bench player's worth is exactly his own market price — there's no
    // more "does this beat an alternative for my last open slot" question
    // to run through the DP for. Using `market` as the allocation ceiling
    // here expresses that directly: a $2 real bargain shows as $2 (capped
    // by room capacity below, same as ever), a $20 player still on the
    // board post-starters shows as the real stash he'd be, and the two are
    // finally distinguishable again.
    // Once starters are full, a bench candidate's ceiling is his market
    // value UNLESS this position has already reached "useful" depth
    // (`maxUseful` — one backup at QB/TE, none needed at K/DST, RB/WR
    // effectively uncapped) — see the roster-slot-priority note above. A
    // position already at its cap gets floored to $1: still biddable if
    // truly nothing else is available, but no longer competing with real
    // RB/WR value for your remaining budget.
    const atCap = ["QB", "TE", "K", "DST"].includes(p.pos)
      && (haveByPos[p.pos] || 0) >= maxUseful(p.pos, settings.roster as unknown as Record<string, number>, !!settings.superflex);
    const allocationCeiling = openStartSlots.length
      ? bidCeiling({
          player: p, slots: openStartSlots, budget: dpBudget,
          pool: availDollar, valueOf: valueOfPlayer, priceOf: priceOfPlayer,
        })
      : atCap ? 1 : market;
    // roadmap 3.4 — and the room's ability to pay. Position-aware (3.4a):
    // only opponents who still need THIS position count, so a rich team
    // stacked at running back stops holding up every back's ceiling.
    const room = priceCeilingFor(p.pos, {
      budgets: oppBudgets, openSpots: oppOpenSpots, counts: oppCounts,
      leagueRoster: settings.roster as unknown as Record<string, number>,
      superflex: !!settings.superflex, minBid: 1,
    });
    const { bid: ceiling, binding } = bindingCeiling({
      allocationCeiling: allocationCeiling ?? undefined,
      // priceCeilingFor already folded demand in, so hand bindingCeiling a
      // single synthetic capacity rather than the raw per-opponent list —
      // otherwise it would re-derive the ungated ceiling and the demand
      // gating would be silently discarded.
      capacities: [Math.max(0, room.ceiling - 1)],
      minBid: 1,
    });
    // "pass" means there is NO price worth paying — that is true ONLY when
    // your own allocation says he doesn't improve your reachable roster at
    // any price at all (ceiling <= 0). A positive ceiling below market is
    // NOT a pass: it is a real number, the most you should offer even for a
    // player the market will likely take past it. An earlier version hid
    // that number behind "pass" whenever it fell short of market, on an
    // "if you probably won't win, don't show a price" theory — flagged
    // directly ("there must be some price worth paying for the top
    // players... why not display a price?") because hiding a real,
    // computed number is a worse default than showing one that might not
    // win. `belowMarket` carries the nuance forward for the tooltip instead
    // of for suppression: still a real ceiling, just not one the market is
    // expected to honor.
    const pass = ceiling <= 0;
    const belowMarket = !pass && binding !== "opponents" && ceiling < market;
    return { allocationCeiling, bid: ceiling, binding, room, pass, belowMarket };
  }, [openStartSlots, dpBudget, availDollar, valueOfPlayer, priceOfPlayer,
      // `haveByPos` drives the maxUseful depth cap above. It is masked today —
      // `openStartSlots` changes identity on the same trigger (`minePlayers`)
      // — but that is an accident of how it happens to be memoised, not a
      // guarantee. Listed explicitly so a future change to openStartSlots
      // can't silently leave this reading a stale roster.
      haveByPos,
      oppBudgets, oppOpenSpots, oppCounts, settings.roster, settings.superflex]);

  const valueTargets = useMemo(() => {
    // Widen the candidate pool past the final count of 4: a "target" is a
    // player worth actually bidding on, and that can only be known AFTER
    // the ceiling is computed — surplus (our dollarValue vs. market) alone
    // says "the market undervalues him," not "he helps YOUR roster right
    // now." A player can rank #1 on surplus and still be a legitimate pass
    // (you're already full at his position), so filtering on surplus alone
    // used to let pass-labeled players sit in a panel titled "your targets"
    // — a real contradiction a user caught: a "target" that says "pass" reads
    // as the app arguing with itself. bidCeiling runs a DP per evaluation, so
    // this pool is capped small (not the whole board) rather than filtering
    // after mapping the DP over everything.
    const candidates = availDollar
      .filter((p) => ["QB", "RB", "WR", "TE"].includes(p.pos))
      .map((p) => {
        const market = marketById[p.id as number] ?? 1;
        const sug = suggestBid(p, { budget: myBudgetLeft, openSpots: Math.max(1, myOpenSpots), remainingDvSum, market });
        return { p, market, modelBid: sug.bid, modelPass: sug.pass, dollarValue: sug.dollarValue, surplus: (p.dollarValue ?? 1) - market };
      })
      .sort((a, b) => b.surplus - a.surplus)
      .slice(0, 10);

    return candidates
      .map((t) => ({ ...t, ...ceilingFor(t.p, t.market) }))
      .filter((t) => !t.pass)
      .slice(0, 4);
  }, [availDollar, marketById, myBudgetLeft, myOpenSpots, remainingDvSum, ceilingFor]);

  // Allocation ceiling for every undrafted QB/RB/WR/TE row on the MAIN BOARD,
  // not just the fixed 4-row "your targets" panel — the actual moment it
  // matters is whatever player is on screen when someone nominates them,
  // which could be any row. `bidCeiling`'s own header warns against mapping
  // it over the whole board, written when nothing had actually measured the
  // cost; a real benchmark (300-player undrafted pool, full DP) comes in
  // under 90ms total (~0.3ms/player), so computing it for the whole pool
  // ONCE per draft-state change is cheap enough to do unconditionally.
  // Keyed on `availDollar`/`ceilingFor` (draft state), deliberately NOT on
  // `filtered`/`query`/`posFilter` — typing in the search box must not
  // retrigger 300 DP evaluations; it only changes which rows are visible,
  // not what any of them are worth.
  const ceilingByPlayer = useMemo(() => {
    const m = new Map<number, ReturnType<typeof ceilingFor>>();
    for (const p of availDollar) {
      if (!["QB", "RB", "WR", "TE"].includes(p.pos)) continue;
      const market = marketById[p.id as number] ?? 1;
      m.set(p.id as number, ceilingFor(p, market));
    }
    return m;
  }, [availDollar, marketById, ceilingFor]);

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
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded border ${
                live.running
                  ? "bg-emerald-50 border-emerald-300 text-emerald-700"
                  : "bg-gray-50 border-gray-200 hover:border-gray-300"}`}
              title={live.running
                ? "Live sync is running in the background — click to open the panel"
                : "Follow the draft on ESPN/Yahoo and log picks automatically"}
            >
              <Radio className={`w-3.5 h-3.5 ${live.running ? "animate-pulse" : ""}`} /> Live
              {live.running && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
            </button>
            <button
              onClick={() => { setShowAav((v) => !v); setShowSettings(false); setShowKeepers(false); }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-gray-50 border border-gray-200 hover:border-gray-300"
              title="Paste real auction values from FantasyPros for this league"
            >
              <DollarSign className="w-3.5 h-3.5" /> Values
              {Object.keys(settings.aavOverrides ?? {}).length > 0 && (
                <span className="ml-0.5 text-2xs font-mono text-emerald-600">
                  {Object.keys(settings.aavOverrides ?? {}).length}
                </span>
              )}
            </button>
            <button onClick={() => { setShowKeepers((v) => !v); setShowSettings(false); setShowAav(false); }} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-gray-50 border border-gray-200 hover:border-gray-300">
              <Lock className="w-3.5 h-3.5" /> Keepers
            </button>
            <button onClick={() => { setShowSettings((v) => !v); setShowKeepers(false); setShowAav(false); }} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-gray-50 border border-gray-200 hover:border-gray-300">
              <Settings className="w-3.5 h-3.5" /> League
            </button>
          </div>
        </div>
      </header>

      {showLive && (
        <LiveDraftPanel
          leagueId={leagueId}
          settings={settings}
          live={live}
          config={liveConfig}
          onConfigChange={setLiveConfig}
          intervalMs={liveIntervalMs}
          onIntervalChange={setLiveIntervalMs}
          onClose={() => setShowLive(false)}
        />
      )}

      {showAav && (
        <AavPasteImport
          settings={settings}
          onSave={(patch) => patchLeague.mutate({ settings: { ...settings, ...patch } })}
          onClose={() => setShowAav(false)}
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
            <div className="grid grid-cols-[40px_minmax(120px,1fr)_64px_128px] sm:grid-cols-[44px_minmax(160px,1fr)_60px_64px_64px_64px_160px] gap-2 px-3 py-2 bg-white/80 text-xs uppercase tracking-wider text-gray-500 font-mono">
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
              <span className="text-right hidden sm:block">
                <Tip tip="The most you should actually pay (roadmap 3.3-3.5) — accounting for what's left to fill on your own roster AND what the room can afford. Often well below $Live, including for players worth targeting: $Live is what he's worth in the abstract, $Max is what paying for him costs YOU given everything else you still need. A '~' means the number is real but below expected market price — worth bidding up to, just not favored to win at. 'pass' means truly no price is worth it. QB/RB/WR/TE only — K/DST aren't in scope for this ceiling.">$Max</Tip>
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

                const nominatedNow = p.id === currentNominationId;
                const byeWarn = typeof p.id === "number" ? byeWarnByPlayer.get(p.id) : undefined;

                return (
                  <div
                    key={p.id}
                    className={`grid grid-cols-[40px_minmax(120px,1fr)_64px_128px] sm:grid-cols-[44px_minmax(160px,1fr)_60px_64px_64px_64px_160px] gap-2 px-3 py-2 items-center text-sm ${sold ? "opacity-40" : "hover:bg-gray-100"} ${nominatedNow ? "bg-amber-50 ring-1 ring-inset ring-amber-300" : ""}`}
                  >
                    <span className="flex items-center gap-1 text-xs font-mono">
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                      <span className={st.text}>{p.pos}</span>
                    </span>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {nominatedNow && (
                          <span className="flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-2xs font-medium text-amber-800" title="Currently up for auction in your live draft">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" /> Nominated
                          </span>
                        )}
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
                        {byeWarn && (
                          <span title={`Same wk ${byeWarn.week} bye as your ${p.pos}: ${byeWarn.names.join(", ")}. Not priced in — your call.`}>
                            <CalendarX className="w-3 h-3 text-amber-600" aria-label={`bye clash week ${byeWarn.week}`} />
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
                        {(() => {
                          // Mobile only — sm+ gets the dedicated $Max column
                          // below, driven by the same ceilingByPlayer map.
                          const c = ceilingByPlayer.get(p.id as number);
                          if (!c) return null;
                          const byRoom = c.binding === "opponents";
                          return (
                            <span
                              className={`ml-1 font-semibold cursor-help sm:hidden ${c.pass ? "text-gray-400" : byRoom ? "text-violet-700" : "text-sky-700"}`}
                              title={c.pass
                                ? "He doesn't improve your best reachable roster at any price you'd have to pay — skip him."
                                : byRoom
                                ? `Capped by the room's money: no opponent can bid more than $${c.bid - 1}, so you never have to pay above $${c.bid}.`
                                : c.belowMarket
                                ? "Your real ceiling — worth pursuing at this price or below, but the market is likely to take him higher."
                                : "The most you can pay and still end up with a roster at least as good as if you skipped him — accounting for what's left to fill."}
                            >
                              {c.pass ? "· pass" : `· max $${c.bid}${byRoom ? "*" : c.belowMarket ? "~" : ""}`}
                            </span>
                          );
                        })()}
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

                    {(() => {
                      // sm+ only — the allocation+room-aware ceiling (roadmap
                      // 3.3-3.5), for EVERY row, not just the fixed 4-row
                      // panel. Absent for K/DST (bidCeiling never covers
                      // them) and for a sold player (nothing left to decide).
                      const c = !sold ? ceilingByPlayer.get(p.id as number) : undefined;
                      if (!c) return <span className="hidden sm:block" />;
                      const byRoom = c.binding === "opponents";
                      return (
                        <span
                          className={`text-right font-mono text-sm tabular-nums hidden sm:block cursor-help ${c.pass ? "text-gray-400" : byRoom ? "text-violet-700" : "text-sky-700"}`}
                          title={c.pass
                            ? "He doesn't improve your best reachable roster at any price you'd have to pay — skip him."
                            : byRoom
                            ? `Capped by the room's money: no opponent can bid more than $${c.bid - 1}, so you never have to pay above $${c.bid} no matter what he's worth. This is what the room CAN pay, not what it wants to — a hard upper bound that tightens as budgets drain.`
                            : c.belowMarket
                            ? `Your real ceiling: the most you can pay and still end up with a roster at least as good as if you skipped him. He's worth pursuing at this price or below — the market is likely to take him higher, so treat this as your walk-away point, not a price you're favored to win at.`
                            : "Allocation ceiling: the most you can pay and still end up with a roster at least as good as if you skipped him — reserves a realistic price for every remaining starter, not $1."}
                        >
                          {c.pass ? "pass" : `$${c.bid}${byRoom ? "*" : c.belowMarket ? "~" : ""}`}
                        </span>
                      );
                    })()}

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

import { memo, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Crown, AlertTriangle, Zap, Settings, Check, Lock, ListOrdered, Radio, HelpCircle } from "lucide-react";
import { myPickNumbers, rankByAdp } from "@/engine/snake-engine.js";
import { runHotness } from "@/engine/positional-run.js";
import { roundsFor, currentOwners } from "@/engine/draft-order.js";
import type { BoardPlayer, SnakeLiveState } from "@/engine/snake-engine.js";
import { LeagueSettings, ApiLeague } from "@/lib/api";
import { useDraftStore } from "@/store/draftStore";
import type { DraftEntry } from "@/store/draftStore";
import { usePatchLeague } from "@/hooks/useLeague";
import { useByeWeeks } from "@/hooks/useByeWeeks";
import { posStyle } from "@/lib/posStyles";
import { isKeeper, decodeKeeper, encodeKeeper } from "@/lib/keeperPick";
import BoardControls from "@/components/board/BoardControls";
import ValueBar from "@/components/board/ValueBar";
import RosterPanel from "@/components/shared/RosterPanel";
import CommonOpponentsPopover from "@/components/shared/CommonOpponentsPopover";
import KeeperPlanner from "@/components/shared/KeeperPlanner";
import DraftOverview from "@/components/shared/DraftOverview";
import DraftLogModal from "@/components/shared/DraftLogModal";
import LiveDraftPanel from "@/components/shared/LiveDraftPanel";
import { useLiveDraft, LiveDraftConfig } from "@/hooks/useLiveDraft";
import TeamPicker from "@/components/shared/TeamPicker";
import DraftOrderBoard from "@/components/shared/DraftOrderBoard";
import InjuryBadge from "@/components/shared/InjuryBadge";
import Tip from "@/components/shared/Tip";
import ProjTip from "@/components/shared/ProjTip";
import PickClock from "./PickClock";
import NeedsPanel, { computeNeeds } from "./NeedsPanel";
import Recommendations from "./Recommendations";
import SettingsDrawer from "../auction/SettingsDrawer";

interface Props {
  league: ApiLeague;
  settings: LeagueSettings;
  board: BoardPlayer[];
  leagueId: number;
}

export default function SnakeRoom({ league, settings, board, leagueId }: Props) {
  const nav = useNavigate();
  const patchLeague = usePatchLeague(leagueId);
  const { picks, addPick, removePick, updatePick, hydrate } = useDraftStore();

  const [query, setQuery] = useState("");
  const [posFilter, setPosFilter] = useState("ALL");
  const [hideTaken, setHideTaken] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showKeepers, setShowKeepers] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const [showOrder, setShowOrder] = useState(false);

  // Lifted here (not owned inside LiveDraftPanel) so closing that panel
  // doesn't unmount the hook and kill the poll along with it — see
  // LiveDraftPanel.tsx's own header comment.
  const [liveConfig, setLiveConfig] = useState<LiveDraftConfig | null>(null);
  const [liveIntervalMs, setLiveIntervalMs] = useState(10_000);
  const liveDraft = useLiveDraft(leagueId, liveConfig, liveIntervalMs, () => void hydrate(leagueId));

  const draftedIds = useMemo(() => new Set(picks.map((p) => p.playerId).filter(Boolean) as number[]), [picks]);
  // Keepers occupy specific rounds, not the front of the draft, so they don't
  // advance the live "who's on the clock" counter — only in-draft picks do.
  const livePickCount = useMemo(() => picks.filter((p) => !isKeeper(p)).length, [picks]);
  const overallPick = livePickCount + 1;

  const myPickNums = useMemo(
    // Rounds come from the roster (or the draft-order board), so the clock
    // counts real picks instead of a fixed 18-round guess.
    () => myPickNumbers(settings, roundsFor(settings)),
    [settings.draftSlot, settings.teams, settings.myPicks, settings.rounds, settings.roster]
  );
  const nextMine = myPickNums.find((p) => p >= overallPick);
  const untilMine = nextMine != null ? nextMine - overallPick : null;

  const maxVbd = board.length ? Math.max(1, board[0].vbd) : 1;

  const minePlayers = useMemo(() => {
    const playerById = new Map(board.map((p) => [p.id as number, p]));
    return picks
      .filter((p) => p.mine && p.playerId)
      .map((p) => playerById.get(p.playerId!))
      .filter(Boolean) as BoardPlayer[];
  }, [picks, board]);

  const needs = useMemo(() => computeNeeds(minePlayers, settings), [minePlayers, settings]);

  // Chronological positions of every in-draft pick (mine and opponents',
  // keepers excluded — same reasoning as livePickCount: a keeper isn't a live
  // drafting decision, so it carries no positional-run signal). Feeds 3.2's
  // run detector; 3.1's survival margin reads `nextMine` directly below.
  const recentPickPositions = useMemo(() => {
    const byId = new Map(board.map((p) => [p.id as number, p.pos]));
    return picks
      .filter((p) => !isKeeper(p) && p.playerId != null)
      .slice()
      .sort((a, b) => a.overallPick - b.overallPick)
      .map((p) => byId.get(p.playerId!))
      .filter((pos): pos is NonNullable<typeof pos> => !!pos) as string[];
  }, [picks, board]);
  const runHotByPos = useMemo(
    () => runHotness(recentPickPositions, settings.teams),
    [recentPickPositions, settings.teams],
  );

  // Bye weeks, derived from the schedule (a missing week IS the bye). Undefined
  // while loading or if the season's schedule isn't loaded — pickScore treats a
  // missing map as "no bye information" and skips the penalty entirely rather
  // than guessing, so the recommender degrades to its pre-bye behaviour.
  const { data: byeByTeam } = useByeWeeks();
  const rosterByesByPos = useMemo(() => {
    const out: Record<string, (number | null)[]> = {};
    if (!byeByTeam) return out;
    for (const p of minePlayers) {
      if (!p.pos) continue;
      (out[p.pos] ||= []).push(p.team ? byeByTeam[p.team] ?? null : null);
    }
    return out;
  }, [minePlayers, byeByTeam]);

  // Live draft state consumed by the ported pickScore() recommender.
  const live = useMemo<SnakeLiveState>(() => {
    const avail = board.filter((p) => !draftedIds.has(p.id as number));
    const counts: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
    minePlayers.forEach((p) => { if (p.pos in counts) counts[p.pos]++; });

    const posRemaining: Record<string, number> = {};
    for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"])
      posRemaining[pos] = avail.filter((p) => p.pos === pos && p.vbd > 0).length;

    const bestVbd = avail.reduce((m, p) => Math.max(m, p.vbd), 1);

    // Per-player VBD cliff to the next-best available at the same position.
    const byPos: Record<string, BoardPlayer[]> = {};
    for (const p of avail) (byPos[p.pos] ||= []).push(p);
    const cliffById: Record<number, number> = {};
    for (const pos in byPos) {
      const list = byPos[pos].sort((a, b) => b.vbd - a.vbd);
      list.forEach((p, i) => {
        cliffById[p.id as number] = i + 1 < list.length ? +(p.vbd - list[i + 1].vbd).toFixed(1) : p.vbd;
      });
    }

    return {
      round: minePlayers.length + 1,
      teams: settings.teams,
      slot: settings.draftSlot,
      counts,
      // Superflex changes how many QBs are worth rostering, so the engine's
      // roster-capacity gate needs it rather than assuming a one-QB league.
      superflex: !!settings.superflex,
      roster: settings.roster as unknown as Record<string, number>,
      needs,
      bestVbd,
      posRemaining,
      adpRankById: rankByAdp(board),
      cliffById,
      poolSize: avail.length,
      byeByTeam,
      rosterByesByPos,
      // roadmap 3.1 — the overall pick number I next get to act on. Absence
      // (e.g. no picks made yet and slot unknown) disables the margin
      // entirely rather than guessing, same "missing data skips the effect"
      // treatment byeByTeam already gets above.
      nextPick: nextMine,
      // roadmap 3.2 — discounts that margin when a position is running hot.
      runHotByPos,
    };
  }, [board, draftedIds, minePlayers, needs, settings, byeByTeam, rosterByesByPos, nextMine, runHotByPos]);

  /** Committed keepers store their owner's name inside the pick's `slot`
   *  marker, which lives in the DB rather than league settings — so a rename
   *  has to rewrite them too, or those keepers stop being attributed to the
   *  team that holds them. */
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

  const draft = useCallback((p: BoardPlayer, mine: boolean, teamId?: number) => {
    // Fire-and-forget from the row's perspective — the optimistic pick already
    // landed. But addPick rethrows on failure after rolling that row back
    // (deliberately: a phantom pick would hide a player who is still
    // available), and nothing upstream was awaiting this, so a network failure
    // used to surface only as a silent unhandled rejection. Surface it instead.
    addPick({ playerId: p.id as number, mine, teamId }).catch(() => {
      alert(`Couldn't save the pick for ${p.name} — check your connection and try again.`);
    });
  }, [addPick]);

  const undo = useCallback((pickId: number) => removePick(pickId), [removePick]);

  const resetDraft = () => {
    if (confirm("Clear all draft picks? Keepers stay.")) {
      picks.filter((p) => !isKeeper(p)).forEach((p) => removePick(p.pickId));
    }
  };

  const filtered = useMemo(() => board.filter((p) => {
    if (hideTaken && draftedIds.has(p.id as number)) return false;
    if (posFilter !== "ALL" && p.pos !== posFilter) return false;
    if (query && !p.name.toLowerCase().includes(query.toLowerCase()) && !p.team.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [board, hideTaken, draftedIds, posFilter, query]);

  // Per-row lookups, built once per change instead of scanned per row. The
  // previous `picks.find()` + `board.findIndex()` inside the row map were both
  // O(rows x n) — ~600 x 600 comparisons every single render.
  const pickByPlayer = useMemo(() => {
    const m = new Map<number, typeof picks[number]>();
    for (const pk of picks) if (pk.playerId != null) m.set(pk.playerId, pk);
    return m;
  }, [picks]);

  const rankById = useMemo(() => {
    const m = new Map<number, number>();
    board.forEach((p, i) => m.set(p.id as number, i + 1));
    return m;
  }, [board]);

  const opponents = useMemo(
    () => (settings.opponents?.length
      ? settings.opponents
      : Array.from({ length: Math.max(0, settings.teams - 1) }, (_, i) => `Team ${i + 2}`)),
    [settings.opponents, settings.teams],
  );

  // Whose pick it is, straight from the draft-order board — so traded picks are
  // honoured rather than assuming plain serpentine.
  const onClockOwner = useMemo(() => {
    const owners = currentOwners(settings, roundsFor(settings));
    return owners[overallPick];
  }, [settings, overallPick]);

  // Rows read this through a STABLE getter rather than taking it as a prop:
  // it changes on every pick, and as a prop it would defeat row memoisation
  // and re-render the whole list each time. The dropdown only needs the value
  // at the moment it opens.
  const onClockRef = useRef(onClockOwner);
  onClockRef.current = onClockOwner;
  const getOnClock = useCallback(() => onClockRef.current, []);

  const pprLabel = settings.ppr === 1 ? "PPR" : settings.ppr === 0.5 ? "Half-PPR" : "Std";

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-gray-50/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <button onClick={() => nav("/")} className="text-gray-500 hover:text-gray-600 mr-1">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded bg-emerald-50 border border-emerald-300 grid place-items-center">
              <Zap className="w-4 h-4 text-emerald-600" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight leading-none">{league.name}</h1>
              <p className="text-xs text-gray-500 leading-none mt-0.5 font-mono">
                {settings.teams}-team · slot {settings.draftSlot} · {pprLabel}
                {settings.superflex ? " · Superflex" : ""}
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs">
            {/* The pick the app THINKS is next. Shown so a drift between this
                and the real room is visible before it mis-assigns picks. */}
            <Tip tip="Whose pick the app has next, from the draft order (including any traded picks). If this doesn't match the real draft, fix the order or log the missing picks.">
              <span className="hidden md:flex items-center gap-1.5 rounded border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-gray-500">
                <span className="text-gray-400">#{overallPick}</span>
                <span className={onClockOwner === "__me__" ? "font-semibold text-emerald-600" : "text-gray-700"}>
                  {onClockOwner === "__me__" ? "You" : onClockOwner ?? "—"}
                </span>
              </span>
            </Tip>
            <PickClock
              draftSlot={settings.draftSlot ?? 1}
              teams={settings.teams}
              overallPick={overallPick}
              myPicks={myPickNums}
            />
            <button
              onClick={() => setShowLive(true)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded border ${
                liveDraft.running
                  ? "bg-emerald-50 border-emerald-300 text-emerald-700"
                  : "bg-gray-50 border-gray-200 hover:border-gray-300"}`}
              title={liveDraft.running
                ? "Live sync is running in the background — click to open the panel"
                : "Follow the draft on ESPN/Yahoo and log picks automatically"}
            >
              <Radio className={`w-3.5 h-3.5 ${liveDraft.running ? "animate-pulse" : ""}`} /> Live
              {liveDraft.running && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
            </button>
            <button
              onClick={() => { setShowOrder(true); setShowSettings(false); setShowKeepers(false); }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-gray-50 border border-gray-200 hover:border-gray-300"
              title="The full draft order, with traded picks"
            >
              <ListOrdered className="w-3.5 h-3.5" /> Order
            </button>
            <button
              onClick={() => { setShowKeepers((v) => !v); setShowSettings(false); }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-gray-50 border border-gray-200 hover:border-gray-300"
            >
              <Lock className="w-3.5 h-3.5" /> Keepers
            </button>
            <button
              onClick={() => { setShowSettings((v) => !v); setShowKeepers(false); }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-gray-50 border border-gray-200 hover:border-gray-300"
            >
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
          format="snake"
          onOpenDraftOrder={() => { setShowSettings(false); setShowOrder(true); }}
          onRenames={renameTeamOnPicks}
        />
      )}

      {showLive && (
        <LiveDraftPanel
          settings={settings}
          live={liveDraft}
          config={liveConfig}
          onConfigChange={setLiveConfig}
          intervalMs={liveIntervalMs}
          onIntervalChange={setLiveIntervalMs}
          onClose={() => setShowLive(false)}
        />
      )}

      {showOrder && (
        <DraftOrderBoard
          settings={settings}
          onSave={(s) => patchLeague.mutate({ settings: s })}
          onRenames={renameTeamOnPicks}
          onClose={() => setShowOrder(false)}
        />
      )}

      {showKeepers && (
        <KeeperPlanner
          format="snake"
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
          <RosterPanel
            picks={picks}
            board={board}
            settings={settings}
            onReset={resetDraft}
            mode="snake"
          />

          <NeedsPanel
            mine={minePlayers}
            settings={settings}
            draftedCount={picks.length}
            untilMine={untilMine}
          />
        </aside>

        <section className="order-first lg:order-none">
          <Recommendations
            board={board}
            draftedIds={draftedIds}
            live={live}
            onDraft={(p) => draft(p, true)}
          />

          <BoardControls
            query={query} onQuery={setQuery}
            posFilter={posFilter} onPos={setPosFilter}
            hideLabel="hide taken" hideChecked={hideTaken} onHide={setHideTaken}
            accentColor="accent-emerald-500"
          />

          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <div className="grid grid-cols-[28px_1fr_auto] sm:grid-cols-[28px_44px_1fr_70px_140px] gap-2 px-3 py-2 bg-white/80 text-xs uppercase tracking-wider text-gray-500 font-mono">
              <span>#</span>
              <span className="hidden sm:block">Pos</span>
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
              <span className="hidden sm:block text-right">
                <Tip tip="Value Based Drafting: projected points above a replacement-level player at the same position. The bigger the number, the more this player wins you over a waiver-wire fill-in.">VBD</Tip>
              </span>
              <span className="text-right">
                <Tip tip="✓ = you drafted the player · ✕ = another team took them. Either way they come off the board.">Action</Tip>
              </span>
            </div>

            <div className="divide-y divide-gray-200 max-h-[60vh] overflow-y-auto">
              {filtered.map((p, i) => (
                <PlayerRow
                  key={p.id as number}
                  p={p}
                  idx={i}
                  pick={pickByPlayer.get(p.id as number)}
                  rank={rankById.get(p.id as number)}
                  maxVbd={maxVbd}
                  opponents={opponents}
                  getOnClock={getOnClock}
                  onDraft={draft}
                  onUndo={undo}
                />
              ))}
              {filtered.length === 0 && (
                <div className="px-3 py-8 text-center text-sm text-gray-500">No players match.</div>
              )}
            </div>
          </div>
        </section>

        <aside className="space-y-3">
          <DraftOverview
            picks={picks}
            board={board}
            settings={settings}
            mode="snake"
            onEditLog={() => setShowLog(true)}
          />
        </aside>
      </main>

      {showLog && (
        <DraftLogModal
          picks={picks}
          board={board}
          settings={settings}
          mode="snake"
          onClose={() => setShowLog(false)}
        />
      )}
    </div>
  );
}


/**
 * One player row.
 *
 * Memoised because the list is the whole player pool (~600 rows) and a single
 * pick used to re-render every one of them. Props are deliberately primitives,
 * stable callbacks, or objects whose identity only changes when that row's
 * data really does — so logging a pick now re-renders one row, not the board.
 */
const PlayerRow = memo(function PlayerRow({
  p, idx, pick, rank, maxVbd, opponents, getOnClock, onDraft, onUndo,
}: {
  p: BoardPlayer;
  idx: number;
  pick: DraftEntry | undefined;
  rank: number | undefined;
  maxVbd: number;
  opponents: string[];
  getOnClock: () => string | undefined;
  onDraft: (p: BoardPlayer, mine: boolean, teamId?: number) => void;
  onUndo: (pickId: number) => void;
}) {
  const st = posStyle(p.pos);
  const mine = pick?.mine ?? false;
  const taken = !!pick && !mine;
  const mktDiff = p.ecr != null && rank != null ? Math.round(rank - p.ecr) : null;

  return (
                  <div
                    className={`grid grid-cols-[28px_1fr_auto] sm:grid-cols-[28px_44px_1fr_70px_140px] gap-2 px-3 py-2 items-center text-sm ${
                      mine ? "bg-emerald-500/[0.06]" :
                      taken ? "bg-gray-100 opacity-50" :
                      "hover:bg-gray-100"
                    }`}
                  >
                    <span className="font-mono text-xs text-gray-400">{idx + 1}</span>

                    <span className="hidden sm:flex items-center gap-1 text-xs font-mono">
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                      <span className={st.text}>{p.pos}</span>
                    </span>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {mine && <Crown className="w-3 h-3 text-emerald-600 shrink-0" />}
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
                        <span className="sm:hidden">{p.pos} · vbd {p.vbd} · </span>
                        <ProjTip steps={p.projBreakdown} value={p.valuePoints} />
                        <span title={p.priorEquiv != null ? "Last season's scoring pace over a full 17 games — a reality check on the projection" : "No 2025 stats — rookie or missed season, so the projection leans on market rankings"}>
                          {p.priorEquiv != null ? ` · '25 pace ${p.priorEquiv}` : " · no '25"}
                        </span>
                        {p.age ? <span className="sm:hidden"> · {p.age}y</span> : null}
                        {mktDiff != null && (
                          <span
                            className={`ml-1 ${mktDiff > 0 ? "text-emerald-600" : "text-rose-500"}`}
                            title={`This tool ranks the player ${Math.abs(mktDiff)} spot${Math.abs(mktDiff) === 1 ? "" : "s"} ${mktDiff > 0 ? "lower than" : "higher than"} expert consensus — ${mktDiff > 0 ? "they'll likely still be there later" : "a potential value the market is sleeping on"}`}
                          >
                            mkt {mktDiff > 0 ? "+" : ""}{mktDiff}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="hidden sm:block">
                      <ValueBar pos={p.pos} vbd={p.vbd} maxVbd={maxVbd} />
                    </div>

                    <div className="flex items-center justify-end gap-1">
                      {pick ? (
                        <button
                          onClick={() => onUndo(pick!.pickId)}
                          className="text-xs font-mono px-2 py-1 rounded bg-gray-100 border border-gray-300 text-gray-500 hover:text-gray-700"
                        >
                          {mine ? "Mine" : "Taken"}{pick?.pending ? "…" : " ✕"}
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => onDraft(p, true)}
                            className="px-1.5 py-1 rounded text-xs bg-gray-50 border border-gray-300 text-gray-500 hover:text-emerald-600 hover:border-emerald-600"
                            title="I drafted this player"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <TeamPicker
                            opponents={opponents}
                            getOnClock={getOnClock}
                            onPick={(teamId) =>
                              teamId === null ? onDraft(p, true) : onDraft(p, false, teamId)}
                            className="flex-1"
                          />
                        </>
                      )}
                    </div>
                  </div>
  );
});

import { memo, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Crown, AlertTriangle, Zap, Settings, Check, Lock, ListOrdered, Radio, HelpCircle, CalendarX, Layers, Upload } from "lucide-react";
import { myPickNumbers, rankByAdp, isRookieFilterMatch } from "@/engine/snake-engine.js";
import { benchStackWarning, FLEX_SIBLING } from "@/engine/budget-path.js";
import { byeCollisions } from "@/engine/bye-weeks.js";
import { byeLineupMult } from "@/engine/bye-lineup-value.js";
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
import AthleticUploadImport from "@/components/shared/AthleticUploadImport";
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
  // Rookies-only view — see AuctionRoom for the reasoning; same control, same
  // late-draft use case (upside over an equally-valued veteran).
  const [rookiesOnly, setRookiesOnly] = useState(false);
  const [hideTaken, setHideTaken] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showKeepers, setShowKeepers] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const [showOrder, setShowOrder] = useState(false);
  const [showAthletic, setShowAthletic] = useState(false);

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

  // Real-time, unpriced board flag (a user's explicit ask: don't fold a
  // one-week event into another valuation multiplier — pickScore already
  // applies byeClash's small, capped penalty once a clash actually costs a
  // starter; this is deliberately looser and separate, surfacing every
  // same-position/same-week pairing against my OWN roster regardless, so I
  // decide in the moment). See bye-weeks.js byeCollisions.
  const myRosterByeNames = useMemo(() => {
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
      const collisions = byeCollisions(p.pos, bye, myRosterByeNames)
        .filter((c) => c.name !== p.name);
      if (collisions.length) m.set(p.id, { week: bye, names: collisions.map((c) => c.name) });
    }
    return m;
  }, [board, byeByTeam, myRosterByeNames]);

  // Real-time, unpriced "stacking one position at the expense of the other"
  // flag (roadmap 3.6g) — the display-only replacement for benchDepthMult
  // after both its auction-price and snake-selection-score versions were
  // gated and REJECTED (docs/ROADMAP.md 3.6f, 3.6f-snake): no measurable
  // benefit on the auction side, and measurably WORSE on the snake side —
  // baking the judgment into a score/price fires even when no real
  // alternative is on the board, which is exactly what corrupted the
  // snake result. Same "flag it, I decide live" pattern as byeWarnByPlayer.
  const haveByPos = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of minePlayers) m[p.pos as string] = (m[p.pos as string] || 0) + 1;
    return m;
  }, [minePlayers]);
  const stackWarnByPlayer = useMemo(() => {
    const m = new Map<number, { have: number; sibling: string; siblingHave: number; siblingCapacity: number }>();
    const roster = settings.roster as unknown as Record<string, number>;
    for (const p of board) {
      if (typeof p.id !== "number") continue;
      const have = haveByPos[p.pos as string] || 0;
      const w = benchStackWarning(p.pos, have, roster,
        haveByPos[(FLEX_SIBLING as Record<string, string>)[p.pos as string]] || 0);
      if (w) m.set(p.id, { ...w, have });
    }
    return m;
  }, [board, haveByPos, settings.roster]);

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
    // roadmap 3.6h — best available VBD per position, from the same sorted
    // lists cliffById already builds. Computed unconditionally (cheap); the
    // opportunity-cost step that reads it stays off unless a future gate
    // clears it (opportunityBenchAware is never set below).
    const bestVbdByPos: Record<string, number> = {};
    for (const pos in byPos) {
      const list = byPos[pos].sort((a, b) => b.vbd - a.vbd);
      list.forEach((p, i) => {
        cliffById[p.id as number] = i + 1 < list.length ? +(p.vbd - list[i + 1].vbd).toFixed(1) : p.vbd;
      });
      if (list.length) bestVbdByPos[pos] = list[0].vbd;
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
      bestVbdByPos,
      adpRankById: rankByAdp(board),
      cliffById,
      poolSize: avail.length,
      byeByTeam,
      rosterByesByPos,
      // Roadmap 2.4, gate-cleared (mean/SE 2.83 deployment over 1,800
      // replayed drafts scored on REALIZED weekly points — docs/ROADMAP.md
      // 2.4) — replaces byeClash's collision heuristic with the validated
      // deterministic lineup-value multiplier once real bye data is loaded.
      // Undefined while loading, same "missing data skips the effect"
      // treatment every other bye-aware field here already gets; pickScore
      // falls back to byeClash automatically when this key is absent.
      byeLineupMultFor: byeByTeam
        ? (p: BoardPlayer) => byeLineupMult(p, minePlayers, {
            pointsOf: (q: BoardPlayer) => q.valuePoints ?? q.vbd ?? 0,
            byeOf: (q: BoardPlayer) => (q.team ? byeByTeam[q.team] ?? null : null),
            rosterCfg: settings.roster as unknown as Record<string, number>,
          })
        : undefined,
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
    if (rookiesOnly && !isRookieFilterMatch(p)) return false;
    if (query && !p.name.toLowerCase().includes(query.toLowerCase()) && !p.team.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [board, hideTaken, draftedIds, posFilter, rookiesOnly, query]);

  /** Rookies still undrafted — the count shown on the toggle. */
  const rookieCount = useMemo(
    () => board.filter((p) => isRookieFilterMatch(p) && !draftedIds.has(p.id as number)).length,
    [board, draftedIds],
  );

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
    <div className="min-h-screen bg-paper text-ink font-sans">
      <header className="sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3.5 flex items-center gap-3.5 flex-wrap">
          <button onClick={() => nav("/")} className="text-faint hover:text-muted mr-0.5">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 grid place-items-center shadow-[0_4px_10px_rgba(5,150,105,0.25)]">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-base font-extrabold tracking-tight leading-none">{league.name}</h1>
              <p className="text-xs text-muted leading-none mt-1">
                {settings.teams}-team · slot {settings.draftSlot} · {pprLabel}
                {settings.superflex ? " · Superflex" : ""}
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs">
            {/* The pick the app THINKS is next. Shown so a drift between this
                and the real room is visible before it mis-assigns picks. */}
            <Tip tip="Whose pick the app has next, from the draft order (including any traded picks). If this doesn't match the real draft, fix the order or log the missing picks.">
              <span className="hidden md:flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 font-mono text-muted">
                <span className="text-faint">#{overallPick}</span>
                <span className={onClockOwner === "__me__" ? "font-semibold text-emerald-600" : "text-ink"}>
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
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full border font-semibold ${
                liveDraft.running
                  ? "bg-emerald-50 border-emerald-300 text-emerald-700"
                  : "bg-surface border-line text-muted hover:border-faint"}`}
              title={liveDraft.running
                ? "Live sync is running in the background — click to open the panel"
                : "Follow the draft on ESPN/Yahoo and log picks automatically"}
            >
              <Radio className={`w-3.5 h-3.5 ${liveDraft.running ? "animate-pulse" : ""}`} /> Live
              {liveDraft.running && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
            </button>
            <button
              onClick={() => { setShowOrder(true); setShowSettings(false); setShowKeepers(false); setShowAthletic(false); }}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-surface border border-line text-muted font-semibold hover:border-faint"
              title="The full draft order, with traded picks"
            >
              <ListOrdered className="w-3.5 h-3.5" /> Order
            </button>
            <button
              onClick={() => { setShowAthletic((v) => !v); setShowSettings(false); setShowKeepers(false); }}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-surface border border-line text-muted font-semibold hover:border-faint"
              title="Upload The Athletic's projections workbook as a second opinion (display only)"
            >
              <Upload className="w-3.5 h-3.5" /> Athletic
              {Object.keys(settings.athleticProjections ?? {}).length > 0 && (
                <span className="ml-0.5 text-2xs font-mono text-teal-600">
                  {Object.keys(settings.athleticProjections ?? {}).length}
                </span>
              )}
            </button>
            <button
              onClick={() => { setShowKeepers((v) => !v); setShowSettings(false); setShowAthletic(false); }}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-surface border border-line text-muted font-semibold hover:border-faint"
            >
              <Lock className="w-3.5 h-3.5" /> Keepers
            </button>
            <button
              onClick={() => { setShowSettings((v) => !v); setShowKeepers(false); setShowAthletic(false); }}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-surface border border-line text-muted font-semibold hover:border-faint"
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
          leagueId={leagueId}
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

      {showAthletic && (
        <AthleticUploadImport
          settings={settings}
          onSave={(patch) => patchLeague.mutate({ settings: { ...settings, ...patch } })}
          onClose={() => setShowAthletic(false)}
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

      <main className="max-w-6xl xl:max-w-[1400px] mx-auto px-4 py-5 grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_300px]">
        <aside className="space-y-3.5">
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
            rookiesOnly={rookiesOnly} onRookiesOnly={setRookiesOnly}
            rookieCount={rookieCount}
          />

          <div>
            <div className="grid grid-cols-[28px_1fr_auto] sm:grid-cols-[28px_44px_1fr_70px_140px] gap-2 px-4 py-1.5 mb-1 text-2xs uppercase tracking-wider text-faint font-mono font-semibold">
              <span>#</span>
              <span className="hidden sm:block">Pos</span>
              <span className="flex items-center gap-1">
                Player
                <a
                  href="/methodology"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="What do the projection and value labels mean?"
                  className="text-faint hover:text-muted normal-case"
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

            <div data-testid="player-list" className="flex flex-col gap-2 max-h-[62vh] overflow-y-auto pr-0.5">
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
                  byeWarn={byeWarnByPlayer.get(p.id as number)}
                  stackWarn={stackWarnByPlayer.get(p.id as number)}
                />
              ))}
              {filtered.length === 0 && (
                <div className="px-3 py-8 text-center text-sm text-muted">No players match.</div>
              )}
            </div>
          </div>
        </section>

        <aside className="space-y-3.5">
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
  p, idx, pick, rank, maxVbd, opponents, getOnClock, onDraft, onUndo, byeWarn, stackWarn,
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
  byeWarn: { week: number; names: string[] } | undefined;
  stackWarn: { have: number; sibling: string; siblingHave: number; siblingCapacity: number } | undefined;
}) {
  const st = posStyle(p.pos);
  const mine = pick?.mine ?? false;
  const taken = !!pick && !mine;
  const mktDiff = p.ecr != null && rank != null ? Math.round(rank - p.ecr) : null;

  return (
                  <div
                    className={`grid grid-cols-[28px_1fr_auto] sm:grid-cols-[28px_44px_1fr_70px_140px] gap-2 px-3 py-2.5 items-center text-sm rounded-2xl border ${
                      mine ? "bg-emerald-500/[0.05] border-emerald-200" :
                      taken ? "bg-raised border-line opacity-50" :
                      "bg-surface border-line hover:border-faint"
                    }`}
                  >
                    <span className="font-mono text-xs text-faint">{idx + 1}</span>

                    <span className={`hidden sm:flex w-9 h-9 -ml-1 rounded-xl ${st.badge} text-white text-2xs font-bold items-center justify-center`}>
                      {p.pos}
                    </span>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {mine && <Crown className="w-3 h-3 text-emerald-600 shrink-0" />}
                        <span className="font-semibold truncate">{p.name}</span>
                        <span className="font-mono text-xs text-faint shrink-0">{p.team}</span>
                      </div>
                      {/* Always its own line, at a fixed min-height, regardless of
                          player name length or which badges/icons apply — these
                          used to share a line with the name and reflow onto a
                          second line unpredictably depending on both, so the same
                          badge could sit next to the name for a short name and
                          wrap below it for a long one. Fixed position beats
                          fitting more on one line. */}
                      <div className="flex items-center gap-1.5 flex-wrap min-h-[18px] mt-0.5">
                        <InjuryBadge injury={p.injury} />
                        {p.tier && <span className="text-2xs font-mono font-bold bg-raised border border-line px-1.5 py-0.5 rounded-md text-muted" title={`Tier ${p.tier} at ${p.pos} — players in the same tier are roughly interchangeable; a new tier means a drop-off in value`}>T{p.tier}</span>}
                        {p.fpTier != null && <span className="text-2xs font-mono font-bold bg-indigo-50 px-1.5 py-0.5 rounded-md text-indigo-600" title={`FantasyPros' own consensus Tier ${p.fpTier} at ${p.pos} — their expert panel's judgment of drop-offs, separate from this app's computed tier above (a mechanical gap in value). Shown side by side, never blended.`}>FP{p.fpTier}</span>}
                        {p.athleticTier != null && <span className="text-2xs font-mono font-bold bg-teal-50 px-1.5 py-0.5 rounded-md text-teal-700" title={`The Athletic's projection (uploaded): Tier ${p.athleticTier} at ${p.pos} — same drop-off rule (≥18 pts) as your board's own tier, computed on ${p.athleticPoints} pts under this league's scoring (rank #${p.athleticRank} among uploaded players). A second opinion only — tested and NOT blended into valuation (roadmap 0.1b).`}>AT{p.athleticTier}</span>}
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
                        {stackWarn && (
                          <span title={`You already have ${stackWarn.have} ${p.pos}s and no backup ${stackWarn.sibling} yet (${stackWarn.siblingHave}/${stackWarn.siblingCapacity}) — worth diversifying before another ${p.pos}. Not priced in — your call.`}>
                            <Layers className="w-3 h-3 text-stone-500" aria-label={`stacked at ${p.pos}, thin at ${stackWarn.sibling}`} />
                          </span>
                        )}
                        {typeof p.id === "number" && <CommonOpponentsPopover playerId={p.id} />}
                      </div>
                      <div className="text-xs text-muted font-mono tabular-nums">
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

                    <div className="flex items-center justify-end gap-1.5">
                      {pick ? (
                        <button
                          onClick={() => onUndo(pick!.pickId)}
                          className="text-xs font-mono font-semibold px-3 py-1.5 rounded-lg bg-surface border border-line text-muted hover:text-ink"
                        >
                          {mine ? "Mine" : "Taken"}{pick?.pending ? "…" : " ✕"}
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => onDraft(p, true)}
                            className="w-8 h-8 grid place-items-center rounded-lg bg-surface border border-line text-muted hover:text-emerald-600 hover:border-emerald-600"
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

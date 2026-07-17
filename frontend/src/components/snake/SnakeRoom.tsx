import { useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Crown, AlertTriangle, Zap, Settings, Check, X, Lock } from "lucide-react";
import { snakePicks } from "@/engine/valuation-engine.js";
import type { BoardPlayer } from "@/engine/valuation-engine.js";
import { LeagueSettings, ApiLeague } from "@/lib/api";
import { useDraftStore } from "@/store/draftStore";
import { usePatchLeague } from "@/hooks/useLeague";
import { posStyle } from "@/lib/posStyles";
import { isKeeper } from "@/lib/keeperPick";
import BoardControls from "@/components/board/BoardControls";
import ValueBar from "@/components/board/ValueBar";
import RosterPanel from "@/components/shared/RosterPanel";
import CommonOpponentsPopover from "@/components/shared/CommonOpponentsPopover";
import KeeperPlanner from "@/components/shared/KeeperPlanner";
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
  const { picks, addPick, removePick } = useDraftStore();

  const [query, setQuery] = useState("");
  const [posFilter, setPosFilter] = useState("ALL");
  const [hideTaken, setHideTaken] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showKeepers, setShowKeepers] = useState(false);

  const draftedIds = useMemo(() => new Set(picks.map((p) => p.playerId).filter(Boolean) as number[]), [picks]);
  // Keepers occupy specific rounds, not the front of the draft, so they don't
  // advance the live "who's on the clock" counter — only in-draft picks do.
  const livePickCount = useMemo(() => picks.filter((p) => !isKeeper(p)).length, [picks]);
  const overallPick = livePickCount + 1;

  const myPickNums = useMemo(
    () => snakePicks(settings.draftSlot ?? 1, settings.teams),
    [settings.draftSlot, settings.teams]
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

  const draft = useCallback((p: BoardPlayer, mine: boolean) => {
    addPick({ playerId: p.id as number, mine });
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

  const pprLabel = settings.ppr === 1 ? "PPR" : settings.ppr === 0.5 ? "Half-PPR" : "Std";

  return (
    <div className="min-h-screen bg-paper text-ink font-sans">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <button onClick={() => nav("/")} className="rounded-md p-1 text-faint hover:bg-raised hover:text-ink">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand/10 ring-1 ring-brand/25">
              <Zap className="h-4 w-4 text-brand" />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-none tracking-tight">{league.name}</h1>
              <p className="mt-1 font-mono text-2xs leading-none text-faint">
                {settings.teams}-team · slot {settings.draftSlot} · {pprLabel}
                {settings.superflex ? " · Superflex" : ""}
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <PickClock
              draftSlot={settings.draftSlot ?? 1}
              teams={settings.teams}
              overallPick={overallPick}
            />
            <button onClick={() => { setShowKeepers((v) => !v); setShowSettings(false); }} className="btn-ghost px-2.5 py-1.5 text-xs">
              <Lock className="h-3.5 w-3.5" /> Keepers
            </button>
            <button onClick={() => { setShowSettings((v) => !v); setShowKeepers(false); }} className="btn-ghost px-2.5 py-1.5 text-xs">
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
          format="snake"
        />
      )}

      {showKeepers && (
        <KeeperPlanner
          format="snake"
          settings={settings}
          board={board}
          picks={picks}
          addPick={addPick}
          removePick={removePick}
          onClose={() => setShowKeepers(false)}
        />
      )}

      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-4 px-4 py-5 lg:grid-cols-[1fr_300px]">
        <section>
          <Recommendations
            board={board}
            draftedIds={draftedIds}
            needs={needs}
            teams={settings.teams}
            onDraft={(p) => draft(p, true)}
          />

          <BoardControls
            query={query} onQuery={setQuery}
            posFilter={posFilter} onPos={setPosFilter}
            hideLabel="hide taken" hideChecked={hideTaken} onHide={setHideTaken}
            accentColor="accent-brand"
          />

          <div className="card overflow-hidden">
            <div className="grid grid-cols-[32px_1fr_auto] items-center gap-2 border-b border-line bg-raised px-3 py-2 font-mono text-2xs uppercase tracking-wider text-faint sm:grid-cols-[32px_46px_1fr_84px_140px]">
              <span>#</span>
              <span className="hidden sm:block">Pos</span>
              <span>Player</span>
              <span className="hidden text-right sm:block">VBD</span>
              <span className="text-right">Action</span>
            </div>

            <div className="scroll-tidy max-h-[60vh] overflow-y-auto">
              {filtered.map((p, i) => {
                const st = posStyle(p.pos);
                const pickEntry = picks.find((pk) => pk.playerId === (p.id as number));
                const mine = pickEntry?.mine ?? false;
                const taken = !!pickEntry && !mine;
                const mktDiff = p.ecr != null
                  ? Math.round(board.findIndex((b) => b.id === p.id) + 1 - p.ecr)
                  : null;

                const rowBg = mine
                  ? "bg-emerald-50"
                  : taken
                  ? "bg-sunken opacity-55"
                  : i % 2 === 1
                  ? "bg-stripe hover:bg-hover"
                  : "bg-surface hover:bg-hover";

                return (
                  <div
                    key={p.id}
                    className={`grid grid-cols-[32px_1fr_auto] items-center gap-2 border-b border-l-[3px] border-b-hair px-3 py-2 text-sm transition-colors sm:grid-cols-[32px_46px_1fr_84px_140px] ${st.accent} ${rowBg}`}
                  >
                    <span className="font-mono text-2xs tnum text-faint">{i + 1}</span>

                    <span className="hidden items-center gap-1.5 sm:flex">
                      <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                      <span className={`font-mono text-2xs font-semibold ${st.text}`}>{p.pos}</span>
                    </span>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {mine && <Crown className="h-3 w-3 shrink-0 text-emerald-500" />}
                        <span className="truncate font-medium text-ink">{p.name}</span>
                        <span className="font-mono text-2xs text-faint">{p.team}</span>
                        {p.tier && <span className="chip border-line bg-raised text-muted">T{p.tier}</span>}
                        {p.risk >= 0.4 && <AlertTriangle className="h-3 w-3 text-amber-500" aria-label={`risk ${p.risk}`} />}
                        {typeof p.id === "number" && <CommonOpponentsPopover playerId={p.id} />}
                      </div>
                      <div className="font-mono text-2xs tnum text-faint sm:hidden">
                        {p.pos} · vbd {p.vbd} · {p.valuePoints}pt{p.age ? ` · ${p.age}y` : ""}
                      </div>
                      {mktDiff != null && (
                        <div className={`hidden font-mono text-2xs sm:block ${mktDiff > 0 ? "text-emerald-600" : "text-rose-500"}`}>
                          mkt {mktDiff > 0 ? "+" : ""}{mktDiff}
                        </div>
                      )}
                    </div>

                    <div className="hidden sm:block">
                      <ValueBar pos={p.pos} vbd={p.vbd} maxVbd={maxVbd} />
                    </div>

                    <div className="flex items-center justify-end gap-1">
                      {pickEntry ? (
                        <button
                          onClick={() => undo(pickEntry.pickId)}
                          className={`btn px-2 py-1 font-mono text-2xs ${
                            mine
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                              : "border-line bg-raised text-muted hover:text-ink"
                          }`}
                        >
                          {mine ? "Mine" : "Taken"} ✕
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => draft(p, true)}
                            className="btn border-line bg-surface px-1.5 py-1 text-muted hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
                            title="I drafted this player"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => draft(p, false)}
                            className="btn border-line bg-surface px-1.5 py-1 text-muted hover:bg-raised hover:text-ink"
                            title="Someone else drafted"
                          >
                            <X className="h-3.5 w-3.5" />
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
      </main>
    </div>
  );
}

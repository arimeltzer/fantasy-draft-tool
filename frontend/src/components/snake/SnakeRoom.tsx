import { useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Crown, AlertTriangle, Zap, Settings, Check, X } from "lucide-react";
import { snakePicks, rankByAdp } from "@/engine/snake-engine.js";
import type { BoardPlayer, SnakeLiveState } from "@/engine/snake-engine.js";
import { LeagueSettings, ApiLeague } from "@/lib/api";
import { useDraftStore } from "@/store/draftStore";
import { usePatchLeague } from "@/hooks/useLeague";
import { posStyle } from "@/lib/posStyles";
import BoardControls from "@/components/board/BoardControls";
import ValueBar from "@/components/board/ValueBar";
import RosterPanel from "@/components/shared/RosterPanel";
import CommonOpponentsPopover from "@/components/shared/CommonOpponentsPopover";
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

  const draftedIds = useMemo(() => new Set(picks.map((p) => p.playerId).filter(Boolean) as number[]), [picks]);
  const overallPick = picks.length + 1;

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
      roster: settings.roster as unknown as Record<string, number>,
      needs,
      bestVbd,
      posRemaining,
      adpRankById: rankByAdp(board),
      cliffById,
      poolSize: avail.length,
    };
  }, [board, draftedIds, minePlayers, needs, settings]);

  const draft = useCallback((p: BoardPlayer, mine: boolean) => {
    addPick({ playerId: p.id as number, mine });
  }, [addPick]);

  const undo = useCallback((pickId: number) => removePick(pickId), [removePick]);

  const resetDraft = () => {
    if (confirm("Clear all draft picks?")) picks.forEach((p) => removePick(p.pickId));
  };

  const filtered = useMemo(() => board.filter((p) => {
    if (hideTaken && draftedIds.has(p.id as number)) return false;
    if (posFilter !== "ALL" && p.pos !== posFilter) return false;
    if (query && !p.name.toLowerCase().includes(query.toLowerCase()) && !p.team.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [board, hideTaken, draftedIds, posFilter, query]);

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
            <PickClock
              draftSlot={settings.draftSlot ?? 1}
              teams={settings.teams}
              overallPick={overallPick}
            />
            <button
              onClick={() => setShowSettings((v) => !v)}
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
        />
      )}

      <main className="max-w-6xl mx-auto px-4 py-4 grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
        <section>
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
              <span>Player</span>
              <span className="hidden sm:block text-right">VBD</span>
              <span className="text-right">Action</span>
            </div>

            <div className="divide-y divide-gray-200 max-h-[60vh] overflow-y-auto">
              {filtered.map((p, i) => {
                const st = posStyle(p.pos);
                const pickEntry = picks.find((pk) => pk.playerId === (p.id as number));
                const mine = pickEntry?.mine ?? false;
                const taken = !!pickEntry && !mine;
                const mktDiff = p.ecr != null
                  ? Math.round(board.findIndex((b) => b.id === p.id) + 1 - p.ecr)
                  : null;

                return (
                  <div
                    key={p.id}
                    className={`grid grid-cols-[28px_1fr_auto] sm:grid-cols-[28px_44px_1fr_70px_140px] gap-2 px-3 py-2 items-center text-sm ${
                      mine ? "bg-emerald-500/[0.06]" :
                      taken ? "bg-gray-100 opacity-50" :
                      "hover:bg-gray-100"
                    }`}
                  >
                    <span className="font-mono text-xs text-gray-400">{i + 1}</span>

                    <span className="hidden sm:flex items-center gap-1 text-xs font-mono">
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                      <span className={st.text}>{p.pos}</span>
                    </span>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {mine && <Crown className="w-3 h-3 text-emerald-600 shrink-0" />}
                        <span className="font-medium truncate">{p.name}</span>
                        <span className="font-mono text-xs text-gray-500">{p.team}</span>
                        {p.tier && <span className="text-xs font-mono bg-gray-100 px-1 rounded text-gray-500">T{p.tier}</span>}
                        {p.risk >= 0.4 && <AlertTriangle className="w-3 h-3 text-amber-600" aria-label={`risk ${p.risk}`} />}
                        {typeof p.id === "number" && <CommonOpponentsPopover playerId={p.id} />}
                      </div>
                      <div className="text-xs text-gray-500 font-mono tabular-nums sm:hidden">
                        {p.pos} · vbd {p.vbd} · {p.valuePoints}pt{p.age ? ` · ${p.age}y` : ""}
                      </div>
                      {mktDiff != null && (
                        <div className={`text-xs font-mono hidden sm:block ${mktDiff > 0 ? "text-emerald-600" : "text-rose-500"}`}>
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
                          className="text-xs font-mono px-2 py-1 rounded bg-gray-100 border border-gray-300 text-gray-500 hover:text-gray-700"
                        >
                          {mine ? "Mine" : "Taken"} ✕
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => draft(p, true)}
                            className="px-1.5 py-1 rounded text-xs bg-gray-50 border border-gray-300 text-gray-500 hover:text-emerald-600 hover:border-emerald-600"
                            title="I drafted this player"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => draft(p, false)}
                            className="px-1.5 py-1 rounded text-xs bg-gray-50 border border-gray-300 text-gray-500 hover:text-gray-700 hover:border-gray-400"
                            title="Someone else drafted"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
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

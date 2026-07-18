import { useMemo, useState } from "react";
import { X, Trash2, Pencil, Check } from "lucide-react";
import { posStyle } from "@/lib/posStyles";
import { BoardPlayer } from "@/engine/valuation-engine.js";
import { LeagueSettings } from "@/lib/api";
import { DraftEntry, useDraftStore } from "@/store/draftStore";

interface Props {
  picks: DraftEntry[];
  board: BoardPlayer[];
  settings: LeagueSettings;
  mode: "auction" | "snake";
  onClose: () => void;
}

/** Full pick-by-pick draft log with inline editing: change the player, who
 *  drafted them, and (auction) the price paid — for fixing bad entries. */
export default function DraftLogModal({ picks, board, settings, mode, onClose }: Props) {
  const { updatePick, removePick } = useDraftStore();

  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [editingPlayer, setEditingPlayer] = useState<number | null>(null); // pickId
  const [playerQuery, setPlayerQuery] = useState("");
  const [priceDrafts, setPriceDrafts] = useState<Record<number, string>>({}); // pickId -> input text

  const opponents = useMemo(
    () => (settings.opponents?.length
      ? settings.opponents
      : Array.from({ length: Math.max(0, settings.teams - 1) }, (_, i) => `Team ${i + 2}`)),
    [settings.opponents, settings.teams],
  );

  const playerById = useMemo(() => new Map(board.map((p) => [p.id as number, p])), [board]);
  const draftedIds = useMemo(() => new Set(picks.map((p) => p.playerId).filter(Boolean) as number[]), [picks]);

  const ordered = useMemo(() => [...picks].sort((a, b) => a.overallPick - b.overallPick), [picks]);

  const shown = ordered.filter((p) => {
    if (teamFilter === "all") return true;
    if (teamFilter === "mine") return p.mine;
    if (teamFilter === "un") return !p.mine && p.teamId == null;
    return !p.mine && p.teamId === Number(teamFilter);
  });

  const ownerValue = (p: DraftEntry) => (p.mine ? "mine" : p.teamId != null ? String(p.teamId) : "un");

  const setOwner = (p: DraftEntry, v: string) => {
    if (v === "mine") updatePick(p.pickId, { mine: true, teamId: null });
    else if (v === "un") updatePick(p.pickId, { mine: false, teamId: null });
    else updatePick(p.pickId, { mine: false, teamId: Number(v) });
  };

  const commitPrice = (p: DraftEntry) => {
    const raw = priceDrafts[p.pickId];
    if (raw == null) return;
    const n = raw === "" ? null : Math.max(1, Math.round(Number(raw)));
    if (n !== p.price && (n == null || Number.isFinite(n))) updatePick(p.pickId, { price: n });
    setPriceDrafts((d) => { const nd = { ...d }; delete nd[p.pickId]; return nd; });
  };

  const matches = useMemo(() => {
    if (!playerQuery) return [];
    const q = playerQuery.toLowerCase();
    return board
      .filter((pl) => (pl.name.toLowerCase().includes(q) || pl.team.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [playerQuery, board]);

  const roundLabel = (overall: number) => {
    const round = Math.ceil(overall / settings.teams);
    const inRound = overall - (round - 1) * settings.teams;
    return `R${round}.${inRound}`;
  };

  return (
    <div className="fixed inset-0 z-40 bg-gray-900/40 flex items-start justify-center p-4 sm:p-8" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg border border-gray-300 bg-gray-50 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold">Draft log</h2>
          <span className="text-xs text-gray-500 font-mono">{picks.length} picks</span>
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            className="ml-auto text-xs px-2 py-1 rounded bg-white border border-gray-300 text-gray-600 focus:outline-none"
          >
            <option value="all">All teams</option>
            <option value="mine">You</option>
            {opponents.map((name, i) => (
              <option key={i} value={i}>{name}</option>
            ))}
            <option value="un">Unassigned</option>
          </select>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-1.5 text-2xs text-gray-400 border-b border-gray-200">
          Fix anything entered wrong mid-draft: change the player, who drafted them{mode === "auction" ? ", or the price paid" : ""}. Changes save immediately.
        </div>

        <div className="overflow-y-auto divide-y divide-gray-200">
          {shown.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-gray-500">No picks logged{teamFilter !== "all" ? " for this team" : ""}.</div>
          )}
          {shown.map((p) => {
            const pl = p.playerId != null ? playerById.get(p.playerId) : undefined;
            const st = pl ? posStyle(pl.pos) : null;
            const editing = editingPlayer === p.pickId;
            return (
              <div key={p.pickId} className="px-4 py-2 flex items-center gap-2 text-sm">
                <span className="font-mono text-xs text-gray-400 w-12 shrink-0" title={`Overall pick ${p.overallPick}`}>
                  {mode === "snake" ? roundLabel(p.overallPick) : `#${p.overallPick}`}
                </span>

                <div className="min-w-0 flex-1">
                  {editing ? (
                    <div className="relative">
                      <input
                        autoFocus
                        value={playerQuery}
                        onChange={(e) => setPlayerQuery(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Escape") { setEditingPlayer(null); setPlayerQuery(""); } }}
                        placeholder="Search player to swap in…"
                        className="w-full px-2 py-1 rounded bg-white border border-gray-300 text-xs focus:outline-none focus:border-gray-400"
                      />
                      {matches.length > 0 && (
                        <div className="absolute left-0 right-0 top-7 z-10 rounded border border-gray-300 bg-white shadow-lg max-h-48 overflow-y-auto">
                          {matches.map((m) => {
                            const mst = posStyle(m.pos);
                            const taken = draftedIds.has(m.id as number) && m.id !== p.playerId;
                            return (
                              <button
                                key={m.id}
                                onClick={() => {
                                  updatePick(p.pickId, { playerId: m.id as number });
                                  setEditingPlayer(null); setPlayerQuery("");
                                }}
                                className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-left hover:bg-gray-100"
                              >
                                <span className={`w-1.5 h-1.5 rounded-full ${mst.dot}`} />
                                <span className="truncate">{m.name}</span>
                                <span className="font-mono text-gray-400">{m.team} · {m.pos}</span>
                                {taken && <span className="ml-auto text-2xs text-rose-500 font-mono">already drafted</span>}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 min-w-0">
                      {st && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.dot}`} />}
                      <span className="truncate font-medium">{pl ? pl.name : <span className="text-gray-400 italic">Unknown player</span>}</span>
                      {pl && <span className="font-mono text-xs text-gray-500 shrink-0">{pl.team} · {pl.pos}</span>}
                      <button
                        onClick={() => { setEditingPlayer(p.pickId); setPlayerQuery(""); }}
                        title="Wrong player? Click to swap in the right one"
                        className="text-gray-400 hover:text-gray-600 shrink-0"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>

                <select
                  value={ownerValue(p)}
                  onChange={(e) => setOwner(p, e.target.value)}
                  title="Which team drafted this player"
                  className="text-xs px-1.5 py-1 rounded bg-white border border-gray-300 text-gray-600 focus:outline-none max-w-[110px]"
                >
                  <option value="mine">You</option>
                  {opponents.map((name, i) => (
                    <option key={i} value={i}>{name}</option>
                  ))}
                  <option value="un">Unassigned</option>
                </select>

                {mode === "auction" && (
                  <div className="flex items-center gap-0.5">
                    <span className="text-xs text-gray-400 font-mono">$</span>
                    <input
                      type="number"
                      min={1}
                      value={priceDrafts[p.pickId] ?? (p.price ?? "")}
                      onChange={(e) => setPriceDrafts((d) => ({ ...d, [p.pickId]: e.target.value }))}
                      onBlur={() => commitPrice(p)}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      title="Price paid — edit to fix a wrong entry"
                      className="w-14 px-1.5 py-1 rounded bg-white border border-gray-300 text-right font-mono text-xs text-gray-700 focus:outline-none focus:border-amber-500"
                    />
                    {priceDrafts[p.pickId] != null && (
                      <Check className="w-3 h-3 text-emerald-600" aria-label="Press Enter or click away to save" />
                    )}
                  </div>
                )}

                <button
                  onClick={() => { if (confirm(`Remove pick ${pl ? `of ${pl.name}` : `#${p.overallPick}`}?`)) removePick(p.pickId); }}
                  title="Delete this pick entirely (player returns to the board)"
                  className="text-gray-400 hover:text-rose-600 shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

import { Crown, RotateCcw } from "lucide-react";
import { posStyle } from "@/lib/posStyles";
import { BoardPlayer } from "@/engine/valuation-engine.js";
import { LeagueSettings } from "@/lib/api";
import { DraftEntry } from "@/store/draftStore";

interface Props {
  picks: DraftEntry[];
  board: BoardPlayer[];
  settings: LeagueSettings;
  onReset: () => void;
  mode: "auction" | "snake";
}

export default function RosterPanel({ picks, board, settings, onReset, mode }: Props) {
  const playerById = new Map(board.map((p) => [p.id as number, p]));
  const mine = picks
    .filter((p) => p.mine && p.playerId)
    .map((p) => ({ ...p, player: playerById.get(p.playerId!) }))
    .filter((p) => p.player);

  const slots: { slot: string; player: typeof mine[0] | null }[] = [];
  const r = settings.roster;
  const order: [string, number][] = [
    ["QB", r.QB], ["RB", r.RB], ["WR", r.WR], ["TE", r.TE],
    ["FLEX", r.FLEX], ["K", r.K], ["DST", r.DST],
  ];

  const pool = [...mine].sort((a, b) => (b.player!.valuePoints) - (a.player!.valuePoints));
  const used = new Set<number>();

  for (const [slot, n] of order) {
    for (let i = 0; i < n; i++) {
      let pick = null;
      if (slot === "FLEX") {
        pick = pool.find((p) => !used.has(p.playerId!) && ["RB", "WR", "TE"].includes(p.player!.pos));
      } else {
        pick = pool.find((p) => !used.has(p.playerId!) && p.player!.pos === slot);
      }
      if (pick) used.add(pick.playerId!);
      slots.push({ slot, player: pick || null });
    }
  }

  const bench = pool.filter((p) => !used.has(p.playerId!));

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-100 p-3">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <Crown className="w-4 h-4 text-gray-500" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-600">My roster</h2>
        </div>
        <button onClick={onReset} title="Reset draft" className="text-gray-500 hover:text-gray-600">
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="space-y-1">
        {slots.map((row, i) => {
          const st = row.player ? posStyle(row.player.player!.pos) : null;
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-xs text-gray-500 w-9">{row.slot}</span>
              {row.player ? (
                <>
                  <span className={`w-1.5 h-1.5 rounded-full ${st!.dot}`} />
                  <span className="truncate flex-1">{row.player.player!.name}</span>
                  {mode === "auction" && row.player.price != null && (
                    <span className="font-mono text-amber-700 text-xs">${row.player.price}</span>
                  )}
                </>
              ) : (
                <span className="text-gray-400 italic">empty</span>
              )}
            </div>
          );
        })}

        {bench.length > 0 && (
          <div className="pt-1.5 mt-1.5 border-t border-gray-200">
            <div className="font-mono text-xs text-gray-400 mb-1">BENCH</div>
            {bench.map((p) => {
              const st = posStyle(p.player!.pos);
              return (
                <div key={p.playerId} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-xs w-9 text-gray-500">{p.player!.pos}</span>
                  <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                  <span className="truncate flex-1">{p.player!.name}</span>
                  {mode === "auction" && p.price != null && (
                    <span className="font-mono text-amber-700 text-xs">${p.price}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {mine.length === 0 && (
          <div className="text-xs text-gray-500 italic">No picks yet.</div>
        )}
      </div>
    </div>
  );
}

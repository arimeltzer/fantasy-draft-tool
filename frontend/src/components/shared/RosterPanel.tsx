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
  const priceColor = mode === "auction" ? "text-gold" : "text-muted";

  return (
    <div className="card p-3.5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Crown className="h-3.5 w-3.5 text-faint" />
          <h2 className="eyebrow">My roster</h2>
        </div>
        <button onClick={onReset} title="Reset draft" className="rounded-md p-1 text-faint hover:bg-raised hover:text-ink">
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-0.5">
        {slots.map((row, i) => {
          const st = row.player ? posStyle(row.player.player!.pos) : null;
          return (
            <div
              key={i}
              className={`flex items-center gap-2 rounded-md border-l-[3px] px-2 py-1.5 text-xs ${
                row.player ? `${st!.accent} ${st!.rail}` : "border-l-transparent"
              }`}
            >
              <span className="w-9 font-mono text-2xs font-semibold text-faint">{row.slot}</span>
              {row.player ? (
                <>
                  <span className={`h-1.5 w-1.5 rounded-full ${st!.dot}`} />
                  <span className="flex-1 truncate text-ink">{row.player.player!.name}</span>
                  {mode === "auction" && row.player.price != null && (
                    <span className={`font-mono text-2xs ${priceColor}`}>${row.player.price}</span>
                  )}
                </>
              ) : (
                <span className="italic text-faint">empty</span>
              )}
            </div>
          );
        })}

        {bench.length > 0 && (
          <div className="mt-2 border-t border-hair pt-2">
            <div className="mb-1 px-2 font-mono text-2xs uppercase text-faint">Bench</div>
            {bench.map((p) => {
              const st = posStyle(p.player!.pos);
              return (
                <div key={p.playerId} className={`flex items-center gap-2 rounded-md border-l-[3px] px-2 py-1.5 text-xs ${st.accent} ${st.rail}`}>
                  <span className="w-9 font-mono text-2xs font-semibold text-faint">{p.player!.pos}</span>
                  <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                  <span className="flex-1 truncate text-ink">{p.player!.name}</span>
                  {mode === "auction" && p.price != null && (
                    <span className={`font-mono text-2xs ${priceColor}`}>${p.price}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {mine.length === 0 && (
          <div className="px-2 py-1 text-xs italic text-faint">No picks yet.</div>
        )}
      </div>
    </div>
  );
}

import { RotateCcw, CalendarX } from "lucide-react";
import { posStyle } from "@/lib/posStyles";
import Tip from "@/components/shared/Tip";
import { byeReport } from "@/engine/bye-weeks.js";
import { useByeWeeks } from "@/hooks/useByeWeeks";
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

  // Bye collisions across the whole roster. `short` already excludes shortfall
  // that is just an unfilled roster mid-draft, so this stays quiet until a bye
  // is genuinely the thing costing you a starter.
  const { data: byeByTeam } = useByeWeeks();
  const byeConflicts = byeByTeam
    ? byeReport(
        mine.map((p) => ({
          pos: p.player!.pos,
          bye: p.player!.team ? byeByTeam[p.player!.team] ?? null : null,
        })),
        r as unknown as Record<string, number>,
      )
    : [];

  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
      <div className="flex items-center justify-between mb-3.5">
        <Tip tip="Your picks, auto-arranged into the best starting lineup (highest projected points fill each slot first); everyone left goes to the bench.">
          <h2 className="text-xs font-bold text-muted">Your roster · {mine.length} of {slots.length + (r.BENCH ?? 0)}</h2>
        </Tip>
        <button onClick={onReset} title="Clear every pick in this draft and start over (asks for confirmation)" className="text-faint hover:text-muted">
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex flex-col gap-2.5">
        {slots.map((row, i) => {
          const st = row.player ? posStyle(row.player.player!.pos) : null;
          return (
            <div key={i} className={`flex items-center gap-2.5 ${row.player ? "" : "opacity-40"}`}>
              <span className={`w-[26px] h-[26px] rounded-lg text-white text-2xs font-bold grid place-items-center shrink-0 ${st ? st.badge : "bg-faint"}`}>
                {row.slot}
              </span>
              {row.player ? (
                <>
                  <span className="truncate flex-1 text-sm font-semibold">{row.player.player!.name}</span>
                  {mode === "auction" && row.player.price != null && (
                    <span className="font-mono text-xs font-semibold text-faint">${row.player.price}</span>
                  )}
                </>
              ) : (
                <span className="text-sm text-faint">Empty slot</span>
              )}
            </div>
          );
        })}

        {bench.length > 0 && (
          <div className="pt-2.5 mt-1 border-t border-hair flex flex-col gap-2.5">
            <div className="font-mono text-2xs font-bold text-faint tracking-wider">BENCH</div>
            {bench.map((p) => {
              const st = posStyle(p.player!.pos);
              return (
                <div key={p.playerId} className="flex items-center gap-2.5">
                  <span className={`w-[26px] h-[26px] rounded-lg text-white text-2xs font-bold grid place-items-center shrink-0 ${st.badge}`}>
                    {p.player!.pos}
                  </span>
                  <span className="truncate flex-1 text-sm font-semibold">{p.player!.name}</span>
                  {mode === "auction" && p.price != null && (
                    <span className="font-mono text-xs font-semibold text-faint">${p.price}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {mine.length === 0 && (
          <div className="text-xs text-faint italic">No picks yet.</div>
        )}
      </div>

      {byeConflicts.length > 0 && (
        <div className="pt-2.5 mt-3 border-t border-hair">
          <div className="flex items-center gap-1.5 mb-1.5">
            <CalendarX className="w-3.5 h-3.5 text-amber-600" />
            <Tip tip="Weeks where enough of your starters at one position share a bye that you cannot fill the slot. A bye costs you nothing on its own — only when it collides.">
              <span className="font-mono text-2xs font-bold text-faint tracking-wider">BYE CONFLICTS</span>
            </Tip>
          </div>
          {byeConflicts.map((c) => (
            <div key={`${c.week}-${c.pos}`} className="flex items-center gap-2 text-xs py-0.5">
              <span className="font-mono text-xs w-9 text-faint">wk {c.week}</span>
              <span className={`w-1.5 h-1.5 rounded-full ${posStyle(c.pos).dot}`} />
              <span className="flex-1 text-muted">
                {c.pos}: {c.available} of {c.starters} available
              </span>
              <span className="font-mono font-semibold text-amber-700">-{c.short}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { TrendingUp } from "lucide-react";
import { posStyle } from "@/lib/posStyles";
import Tip from "@/components/shared/Tip";
import { LeagueSettings } from "@/lib/api";
import { BoardPlayer } from "@/engine/valuation-engine.js";

interface Props {
  mine: BoardPlayer[];
  settings: LeagueSettings;
  draftedCount: number;
  untilMine?: number | null;   // snake pick timing; omit for auction
}

export interface Needs {
  QB: number; RB: number; WR: number; TE: number; FLEX: number;
  [key: string]: number;
}

export function computeNeeds(mine: BoardPlayer[], settings: LeagueSettings): Needs {
  const counts: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
  mine.forEach((p) => { if (p.pos in counts) counts[p.pos]++; });
  const r = settings.roster;
  const flexSurplus = Math.max(0, counts.RB - r.RB) + Math.max(0, counts.WR - r.WR) + Math.max(0, counts.TE - r.TE);
  return {
    QB: Math.max(0, r.QB - counts.QB),
    RB: Math.max(0, r.RB - counts.RB),
    WR: Math.max(0, r.WR - counts.WR),
    TE: Math.max(0, r.TE - counts.TE),
    FLEX: Math.max(0, r.FLEX - flexSurplus),
  };
}

export default function NeedsPanel({ mine, settings, draftedCount, untilMine }: Props) {
  const needs = computeNeeds(mine, settings);
  const hasNeeds = Object.values(needs).some((n) => n > 0);

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-100 p-3">
      <div className="flex items-center gap-2 mb-2">
        <TrendingUp className="w-4 h-4 text-gray-500" />
        <Tip tip="Starting-lineup spots you haven't filled yet, by position. Bench depth doesn't count against these.">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-600">Still need</h2>
        </Tip>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {(Object.entries(needs) as [string, number][]).filter(([, n]) => n > 0).map(([pos, n]) => {
          const st = posStyle(pos === "FLEX" ? "RB" : pos);
          return (
            <span
              key={pos}
              className={`text-xs font-mono px-2 py-1 rounded border ${
                pos === "FLEX" ? "bg-gray-100 border-gray-300 text-gray-600" : st.chip
              }`}
            >
              {pos} ×{n}
            </span>
          );
        })}
        {!hasNeeds && <span className="text-xs text-gray-500">Starters filled — draft for depth.</span>}
      </div>
      <div className={`pt-2.5 border-t border-gray-200 grid ${untilMine !== undefined ? "grid-cols-2" : "grid-cols-1"} gap-2 text-center`}>
        <div title="Total players drafted by all teams so far">
          <div className="font-mono text-base text-gray-700">{draftedCount}</div>
          <div className="text-xs uppercase text-gray-400">picks made</div>
        </div>
        {untilMine !== undefined && (
          <div title="Picks by other teams before you're on the clock again (based on your draft slot and the snake order)">
            <div className="font-mono text-base text-emerald-600">{untilMine ?? "—"}</div>
            <div className="text-xs uppercase text-gray-400">till your turn</div>
          </div>
        )}
      </div>
    </div>
  );
}

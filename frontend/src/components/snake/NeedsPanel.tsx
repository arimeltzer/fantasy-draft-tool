import { TrendingUp } from "lucide-react";
import { posStyle } from "@/lib/posStyles";
import { LeagueSettings } from "@/lib/api";
import { BoardPlayer } from "@/engine/valuation-engine.js";

interface Props {
  mine: BoardPlayer[];
  settings: LeagueSettings;
  draftedCount: number;
  untilMine: number | null;
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
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <div className="flex items-center gap-2 mb-2">
        <TrendingUp className="w-4 h-4 text-slate-400" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300">Still need</h2>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {(Object.entries(needs) as [string, number][]).filter(([, n]) => n > 0).map(([pos, n]) => {
          const st = posStyle(pos === "FLEX" ? "RB" : pos);
          return (
            <span
              key={pos}
              className={`text-[11px] font-mono px-2 py-1 rounded border ${
                pos === "FLEX" ? "bg-slate-800 border-slate-700 text-slate-300" : st.chip
              }`}
            >
              {pos} ×{n}
            </span>
          );
        })}
        {!hasNeeds && <span className="text-[11px] text-slate-500">Starters filled — draft for depth.</span>}
      </div>
      <div className="pt-2.5 border-t border-slate-800 grid grid-cols-2 gap-2 text-center">
        <div>
          <div className="font-mono text-base text-slate-200">{draftedCount}</div>
          <div className="text-[9px] uppercase text-slate-600">picks made</div>
        </div>
        <div>
          <div className="font-mono text-base text-emerald-400">{untilMine ?? "—"}</div>
          <div className="text-[9px] uppercase text-slate-600">till your turn</div>
        </div>
      </div>
    </div>
  );
}

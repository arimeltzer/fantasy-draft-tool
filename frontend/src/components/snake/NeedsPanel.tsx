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
    <div className="card p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <TrendingUp className="h-3.5 w-3.5 text-faint" />
        <h2 className="eyebrow">Still need</h2>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(Object.entries(needs) as [string, number][]).filter(([, n]) => n > 0).map(([pos, n]) => {
          const st = posStyle(pos === "FLEX" ? "RB" : pos);
          return (
            <span
              key={pos}
              className={`chip font-mono ${pos === "FLEX" ? "border-line bg-raised text-muted" : st.chip}`}
            >
              {pos} ×{n}
            </span>
          );
        })}
        {!hasNeeds && <span className="text-xs text-muted">Starters filled — draft for depth.</span>}
      </div>
      <div className="grid grid-cols-2 gap-2 border-t border-hair pt-3 text-center">
        <div>
          <div className="font-mono text-xl tnum text-ink">{draftedCount}</div>
          <div className="text-2xs uppercase tracking-wide text-faint">picks made</div>
        </div>
        <div>
          <div className="font-mono text-xl tnum text-brand">{untilMine ?? "—"}</div>
          <div className="text-2xs uppercase tracking-wide text-faint">till your turn</div>
        </div>
      </div>
    </div>
  );
}

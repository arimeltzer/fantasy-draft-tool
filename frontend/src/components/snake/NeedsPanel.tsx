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
  QB: number; RB: number; WR: number; TE: number; FLEX: number; K: number; DST: number;
  [key: string]: number;
}

/**
 * Starting-lineup shortfalls by position — INCLUDING K/DST, which this used
 * to silently drop (`counts` was never seeded with them, so `needs.K`/
 * `needs.DST` were always `undefined`). Two real consequences: the "Still
 * need" panel never told you a kicker or defense was still open, and
 * `pickScore`'s `needMult` never gave K/DST its "haven't got one yet"
 * priority bump for the SAME reason (`needs?.[pos] > 0` is false when the
 * key is missing) — every team needs exactly one of each, and the
 * recommender had no way to know it was still owed one. See CLAUDE.md.
 */
export function computeNeeds(mine: BoardPlayer[], settings: LeagueSettings): Needs {
  const counts: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
  mine.forEach((p) => { if (p.pos in counts) counts[p.pos]++; });
  const r = settings.roster;
  const flexSurplus = Math.max(0, counts.RB - r.RB) + Math.max(0, counts.WR - r.WR) + Math.max(0, counts.TE - r.TE);
  return {
    QB: Math.max(0, r.QB - counts.QB),
    RB: Math.max(0, r.RB - counts.RB),
    WR: Math.max(0, r.WR - counts.WR),
    TE: Math.max(0, r.TE - counts.TE),
    FLEX: Math.max(0, r.FLEX - flexSurplus),
    K: Math.max(0, r.K - counts.K),
    DST: Math.max(0, r.DST - counts.DST),
  };
}

export default function NeedsPanel({ mine, settings, draftedCount, untilMine }: Props) {
  const needs = computeNeeds(mine, settings);
  const hasNeeds = Object.values(needs).some((n) => n > 0);

  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
      <div className="flex items-center gap-2 mb-3.5">
        <TrendingUp className="w-4 h-4 text-faint" />
        <Tip tip="Starting-lineup spots you haven't filled yet, by position. Bench depth doesn't count against these.">
          <h2 className="text-xs font-bold text-muted">Still need</h2>
        </Tip>
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        {(Object.entries(needs) as [string, number][]).filter(([, n]) => n > 0).map(([pos, n]) => {
          const st = posStyle(pos === "FLEX" ? "RB" : pos);
          return (
            <span
              key={pos}
              className={`text-xs font-bold font-mono px-3 py-1.5 rounded-full ${
                pos === "FLEX" ? "bg-raised text-muted" : `${st.badge} text-white`
              }`}
            >
              {n} more {pos}
            </span>
          );
        })}
        {!hasNeeds && <span className="text-xs text-muted">Starters filled — draft for depth.</span>}
      </div>
      <div className={`pt-3.5 border-t border-hair grid ${untilMine !== undefined ? "grid-cols-2" : "grid-cols-1"} gap-2 text-center`}>
        <div title="Total players drafted by all teams so far">
          <div className="font-mono text-lg font-bold text-ink tabular-nums">{draftedCount}</div>
          <div className="text-2xs uppercase text-faint font-semibold">picks made</div>
        </div>
        {untilMine !== undefined && (
          <div title="Picks by other teams before you're on the clock again (based on your draft slot and the snake order)">
            <div className="font-mono text-lg font-bold text-emerald-600 tabular-nums">{untilMine ?? "—"}</div>
            <div className="text-2xs uppercase text-faint font-semibold">till your turn</div>
          </div>
        )}
      </div>
    </div>
  );
}

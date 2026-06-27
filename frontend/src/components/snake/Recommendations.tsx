import { Target, Check } from "lucide-react";
import { posStyle } from "@/lib/posStyles";
import { BoardPlayer } from "@/engine/valuation-engine.js";
import { Needs } from "./NeedsPanel";

interface Props {
  board: BoardPlayer[];
  draftedIds: Set<number>;
  needs: Needs;
  teams: number;
  onDraft: (p: BoardPlayer) => void;
}

export default function Recommendations({ board, draftedIds, needs, teams, onDraft }: Props) {
  const avail = board.filter((p) => !draftedIds.has(p.id as number));

  const scarce: Record<string, number> = {};
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    scarce[pos] = avail.filter((p) => p.pos === pos && p.vbd > 0).length;
  }

  const recs = avail.map((p) => {
    let bonus = 0;
    const reasons: string[] = [];
    const fillsStarter = (needs as Record<string, number>)[p.pos] > 0;
    const fillsFlex = ["RB","WR","TE"].includes(p.pos) && needs.FLEX > 0 && !fillsStarter;
    if (fillsStarter) { bonus += 8; reasons.push(`fills your ${p.pos}`); }
    else if (fillsFlex) { bonus += 4; reasons.push("FLEX-eligible"); }
    if (["QB","RB","WR","TE"].includes(p.pos) && scarce[p.pos] <= teams) {
      bonus += 4; reasons.push(`${p.pos} getting thin`);
    }
    const nextSame = avail.filter((q) => q.pos === p.pos && q.id !== p.id).sort((a, b) => b.vbd - a.vbd)[0];
    if (nextSame && (p.vbd - nextSame.vbd) > 18) reasons.push("last of tier");
    return { ...p, score: p.vbd + bonus, reasons };
  }).sort((a, b) => b.score - a.score).slice(0, 6);

  return (
    <div className="mb-4 rounded-xl border border-brand/25 bg-brand/[0.05] p-3.5 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        <Target className="h-4 w-4 text-brand" />
        <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-brand">Recommended now</h2>
        <span className="text-2xs text-muted">need-adjusted</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {recs.map((p, i) => {
          const st = posStyle(p.pos);
          return (
            <div key={p.id} className={`flex items-center gap-2.5 rounded-lg border border-line border-l-[3px] bg-surface px-2.5 py-2 shadow-card ${st.accent}`}>
              <span className="w-3 text-center font-mono text-2xs text-faint">{i + 1}</span>
              <span className={`chip font-mono ${st.chip}`}>{p.pos}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink">
                  {p.name} <span className="font-mono text-2xs text-faint">{p.team}</span>
                </div>
                {p.reasons.length > 0 && (
                  <div className="truncate text-2xs text-muted">{p.reasons.join(" · ")}</div>
                )}
              </div>
              <div className="text-right">
                <div className="font-mono text-xs tnum text-ink">{p.vbd}</div>
                <div className="text-[9px] uppercase text-faint">vbd</div>
              </div>
              <button
                onClick={() => onDraft(p)}
                className="btn ml-1 border-brand bg-brand p-1.5 text-white hover:bg-brand/90"
                title="Draft to my team"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

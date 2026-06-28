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
    <div className="mb-4 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.04] p-3">
      <div className="flex items-center gap-2 mb-2.5">
        <Target className="w-4 h-4 text-emerald-600" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Recommended now</h2>
        <span className="text-xs text-gray-500">need-adjusted</span>
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        {recs.map((p, i) => {
          const st = posStyle(p.pos);
          return (
            <div key={p.id} className="flex items-center gap-2.5 rounded-md bg-gray-50 border border-gray-200 px-2.5 py-2">
              <span className="text-xs font-mono text-gray-400 w-3">{i + 1}</span>
              <span className={`text-xs font-mono px-1.5 py-0.5 rounded border ${st.chip}`}>{p.pos}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">
                  {p.name} <span className="text-gray-500 font-mono text-xs">{p.team}</span>
                </div>
                {p.reasons.length > 0 && (
                  <div className="text-xs text-gray-500 truncate">{p.reasons.join(" · ")}</div>
                )}
              </div>
              <div className="text-right">
                <div className="font-mono text-xs text-gray-700 tabular-nums">{p.vbd}</div>
                <div className="text-xs text-gray-400 uppercase">vbd</div>
              </div>
              <button
                onClick={() => onDraft(p)}
                className="ml-1 p-1.5 rounded bg-emerald-50 border border-emerald-300 text-emerald-700 hover:bg-emerald-100"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

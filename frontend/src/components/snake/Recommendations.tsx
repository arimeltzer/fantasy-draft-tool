import { Target, Check } from "lucide-react";
import { posStyle } from "@/lib/posStyles";
import { pickScore } from "@/engine/snake-engine.js";
import type { BoardPlayer, SnakeLiveState } from "@/engine/snake-engine.js";

interface Props {
  board: BoardPlayer[];
  draftedIds: Set<number>;
  live: SnakeLiveState;
  onDraft: (p: BoardPlayer) => void;
}

export default function Recommendations({ board, draftedIds, live, onDraft }: Props) {
  const avail = board.filter((p) => !draftedIds.has(p.id as number));

  const recs = avail
    .map((p) => {
      const { score, reasons, blocked } = pickScore(p, live);
      return { ...p, score, reasons, blocked };
    })
    .filter((p) => !p.blocked && Number.isFinite(p.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

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

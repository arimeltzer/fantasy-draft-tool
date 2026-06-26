import { TrendingUp } from "lucide-react";
import { posStyle } from "@/lib/posStyles";
import { BoardPlayer } from "@/engine/valuation-engine.js";

interface Props {
  factor: number;
  targets: BoardPlayer[];
  myMax: number;
  remainingMoney: number;
  remainingSpots: number;
}

export default function NominationPanel({ factor, targets, myMax, remainingMoney, remainingSpots }: Props) {
  const advice =
    factor > 1.05
      ? "Room's overpaying — nominate pricey players you don't want to drain budgets, hold your targets."
      : factor < 0.95
      ? "Values are deflating — bargains are out there. Nominate your targets now."
      : "Even market. Nominate non-targets early; pounce when a tier is about to empty.";

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <div className="flex items-center gap-2 mb-2">
        <TrendingUp className="w-4 h-4 text-slate-400" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300">Nomination & targets</h2>
      </div>
      <p className="text-[11px] text-slate-500 leading-snug mb-2">{advice}</p>

      <div className="space-y-1">
        {targets.map((p) => {
          const st = posStyle(p.pos);
          const live = p.adjValue ?? p.parValue ?? 1;
          return (
            <div key={p.id} className="flex items-center gap-2 text-xs">
              <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
              <span className="truncate flex-1">{p.name}</span>
              <span className="font-mono text-amber-200">${live}</span>
              <span className={`font-mono text-[10px] ${live > myMax ? "text-rose-400" : "text-emerald-400"}`}>
                {live > myMax ? "over max" : "in reach"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-2 pt-2 border-t border-slate-800 grid grid-cols-2 gap-2 text-center text-[11px] font-mono">
        <div>
          <div className="text-slate-300">${remainingMoney}</div>
          <div className="text-[9px] uppercase text-slate-600">room $ left</div>
        </div>
        <div>
          <div className="text-slate-300">{remainingSpots}</div>
          <div className="text-[9px] uppercase text-slate-600">spots left</div>
        </div>
      </div>
    </div>
  );
}

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
    <div className="rounded-lg border border-gray-200 bg-gray-100 p-3">
      <div className="flex items-center gap-2 mb-2">
        <TrendingUp className="w-4 h-4 text-gray-500" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-600">Nomination & targets</h2>
      </div>
      <p className="text-xs text-gray-500 leading-snug mb-2">{advice}</p>

      <div className="space-y-1">
        {targets.map((p) => {
          const st = posStyle(p.pos);
          const live = p.adjValue ?? p.parValue ?? 1;
          return (
            <div key={p.id} className="flex items-center gap-2 text-xs">
              <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
              <span className="truncate flex-1">{p.name}</span>
              <span className="font-mono text-amber-700">${live}</span>
              <span className={`font-mono text-xs ${live > myMax ? "text-rose-400" : "text-emerald-600"}`}>
                {live > myMax ? "over max" : "in reach"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-2 pt-2 border-t border-gray-200 grid grid-cols-2 gap-2 text-center text-xs font-mono">
        <div>
          <div className="text-gray-600">${remainingMoney}</div>
          <div className="text-xs uppercase text-gray-400">room $ left</div>
        </div>
        <div>
          <div className="text-gray-600">{remainingSpots}</div>
          <div className="text-xs uppercase text-gray-400">spots left</div>
        </div>
      </div>
    </div>
  );
}

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
    <div className="card p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <TrendingUp className="h-3.5 w-3.5 text-faint" />
        <h2 className="eyebrow">Nomination &amp; targets</h2>
      </div>
      <p className="mb-3 text-xs leading-snug text-muted">{advice}</p>

      <div className="space-y-0.5">
        {targets.map((p) => {
          const st = posStyle(p.pos);
          const live = p.adjValue ?? p.parValue ?? 1;
          return (
            <div key={p.id} className={`flex items-center gap-2 rounded-md border-l-[3px] px-2 py-1.5 text-xs ${st.accent} ${st.rail}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
              <span className="flex-1 truncate text-ink">{p.name}</span>
              <span className="font-mono text-2xs text-gold">${live}</span>
              <span className={`font-mono text-[10px] ${live > myMax ? "text-rose-500" : "text-emerald-600"}`}>
                {live > myMax ? "over max" : "in reach"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-hair pt-3 text-center font-mono text-xs">
        <div>
          <div className="tnum text-ink">${remainingMoney}</div>
          <div className="text-2xs uppercase text-faint">room $ left</div>
        </div>
        <div>
          <div className="tnum text-ink">{remainingSpots}</div>
          <div className="text-2xs uppercase text-faint">spots left</div>
        </div>
      </div>
    </div>
  );
}

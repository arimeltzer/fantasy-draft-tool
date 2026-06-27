import { Wallet } from "lucide-react";

interface Props {
  budget: number;
  spent: number;
  openSpots: number;
  maxBid: number;
}

export default function BudgetTracker({ budget, spent, openSpots, maxBid }: Props) {
  const left = budget - spent;
  const avgPerSpot = openSpots > 0 ? (left / openSpots).toFixed(0) : "0";
  const pctSpent = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;

  return (
    <div className="rounded-xl border border-gold/25 bg-gold/[0.05] p-3.5 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        <Wallet className="h-3.5 w-3.5 text-gold" />
        <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-gold">Your money</h2>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="font-mono text-lg tnum text-gold">${left}</div>
          <div className="text-2xs uppercase text-faint">left</div>
        </div>
        <div>
          <div className="font-mono text-lg tnum text-ink">{openSpots}</div>
          <div className="text-2xs uppercase text-faint">spots</div>
        </div>
        <div>
          <div className="font-mono text-lg tnum text-emerald-600">${maxBid}</div>
          <div className="text-2xs uppercase text-faint">max bid</div>
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gold/15">
        <div className="h-full rounded-full bg-gold" style={{ width: `${pctSpent}%` }} />
      </div>
      <div className="mt-2 flex justify-between font-mono text-2xs text-muted">
        <span>spent ${spent}</span>
        <span>${avgPerSpot}/spot avg</span>
      </div>
    </div>
  );
}

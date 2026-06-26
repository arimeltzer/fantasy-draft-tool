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

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.05] p-3">
      <div className="flex items-center gap-2 mb-2">
        <Wallet className="w-4 h-4 text-amber-400" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-amber-200">Your money</h2>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="font-mono text-lg text-amber-200">${left}</div>
          <div className="text-[9px] uppercase text-slate-500">left</div>
        </div>
        <div>
          <div className="font-mono text-lg text-slate-200">{openSpots}</div>
          <div className="text-[9px] uppercase text-slate-500">spots</div>
        </div>
        <div>
          <div className="font-mono text-lg text-emerald-300">${maxBid}</div>
          <div className="text-[9px] uppercase text-slate-500">max bid</div>
        </div>
      </div>
      <div className="mt-2 pt-2 border-t border-amber-500/20 flex justify-between text-[11px] font-mono text-slate-400">
        <span>spent ${spent}</span>
        <span>${avgPerSpot}/spot avg</span>
      </div>
    </div>
  );
}

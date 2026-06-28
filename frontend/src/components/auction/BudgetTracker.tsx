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
    <div className="rounded-lg border border-amber-200 bg-amber-500/[0.05] p-3">
      <div className="flex items-center gap-2 mb-2">
        <Wallet className="w-4 h-4 text-amber-400" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-amber-700">Your money</h2>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="font-mono text-lg text-amber-700">${left}</div>
          <div className="text-xs uppercase text-gray-500">left</div>
        </div>
        <div>
          <div className="font-mono text-lg text-gray-700">{openSpots}</div>
          <div className="text-xs uppercase text-gray-500">spots</div>
        </div>
        <div>
          <div className="font-mono text-lg text-emerald-700">${maxBid}</div>
          <div className="text-xs uppercase text-gray-500">max bid</div>
        </div>
      </div>
      <div className="mt-2 pt-2 border-t border-amber-500/20 flex justify-between text-xs font-mono text-gray-500">
        <span>spent ${spent}</span>
        <span>${avgPerSpot}/spot avg</span>
      </div>
    </div>
  );
}

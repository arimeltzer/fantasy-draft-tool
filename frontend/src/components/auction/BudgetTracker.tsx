import Tip from "@/components/shared/Tip";

interface Props {
  budget: number;
  spent: number;
  openSpots: number;
  maxBid: number;
}

export default function BudgetTracker({ budget, spent, openSpots, maxBid }: Props) {
  const left = budget - spent;
  const pctSpent = budget > 0 ? Math.min(100, Math.max(0, (spent / budget) * 100)) : 0;

  return (
    <div className="rounded-2xl border border-line bg-gradient-to-br from-white to-amber-50/40 p-5 shadow-card">
      <div className="text-xs font-bold text-muted mb-2">Your budget</div>
      <Tip tip={`Auction budget you still have: $${budget} to start, $${spent} spent so far.`} underline={false}>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-3xl font-bold text-ink tabular-nums">${left}</span>
          <span className="text-sm text-faint font-medium">remaining</span>
        </div>
      </Tip>
      <div className="h-2 rounded-full bg-raised overflow-hidden my-3.5">
        <div
          className="h-full rounded-full bg-gradient-to-r from-amber-400 to-gold"
          style={{ width: `${pctSpent}%` }}
        />
      </div>
      <Tip tip="Roster spots you still have to fill (starters + bench)." underline={false}>
        <div className="flex justify-between text-xs text-muted font-medium">
          <span>${spent} spent</span>
          <span>{openSpots} slot{openSpots === 1 ? "" : "s"} left</span>
        </div>
      </Tip>
      <Tip tip="The most you can bid on any one player and still afford $1 for every remaining roster spot. Bidding above this strands you unable to fill your roster." underline={false}>
        <div className="mt-3.5 px-3.5 py-3 rounded-xl bg-sky-50 flex justify-between items-center">
          <span className="text-xs font-bold text-sky-800">Max bid</span>
          <span className="font-mono text-lg font-bold text-sky-800 tabular-nums">${maxBid}</span>
        </div>
      </Tip>
    </div>
  );
}

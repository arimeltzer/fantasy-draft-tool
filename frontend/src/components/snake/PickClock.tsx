import { snakePicks } from "@/engine/valuation-engine.js";

interface Props {
  draftSlot: number;
  teams: number;
  overallPick: number;
}

export default function PickClock({ draftSlot, teams, overallPick }: Props) {
  const myPicks = snakePicks(draftSlot, teams);
  const nextMine = myPicks.find((p) => p >= overallPick);
  const untilMine = nextMine != null ? nextMine - overallPick : null;

  return (
    <div className="hidden items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-xs shadow-card sm:flex">
      <span className="text-faint">Pick</span>
      <span className="font-semibold text-ink">{overallPick}</span>
      {untilMine != null && (
        <span className="text-brand">· you in {untilMine === 0 ? "now!" : untilMine}</span>
      )}
    </div>
  );
}

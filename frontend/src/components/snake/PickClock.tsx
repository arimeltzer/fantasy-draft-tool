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
    <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-slate-900 border border-slate-800 font-mono text-xs">
      <span className="text-slate-500">Pick</span>
      <span className="text-slate-200">{overallPick}</span>
      {untilMine != null && (
        <span className="text-emerald-400">· you in {untilMine === 0 ? "now!" : untilMine}</span>
      )}
    </div>
  );
}

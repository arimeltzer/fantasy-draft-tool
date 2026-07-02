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
    <div
      title={`The draft is on overall pick ${overallPick}.${untilMine != null ? ` Your next turn is pick ${nextMine} — ${untilMine === 0 ? "you're up now" : `${untilMine} pick${untilMine === 1 ? "" : "s"} away`}.` : " You have no picks left."}`}
      className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-gray-50 border border-gray-200 font-mono text-xs cursor-help">
      <span className="text-gray-500">Pick</span>
      <span className="text-gray-700">{overallPick}</span>
      {untilMine != null && (
        <span className="text-emerald-600">· you in {untilMine === 0 ? "now!" : untilMine}</span>
      )}
    </div>
  );
}

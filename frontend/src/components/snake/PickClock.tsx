import { snakePicks } from "@/engine/valuation-engine.js";

interface Props {
  draftSlot: number;
  teams: number;
  overallPick: number;
  /** Your actual picks — pass when the league has traded picks, so the clock
   *  counts down to a pick you really own rather than a serpentine guess. */
  myPicks?: number[];
}

export default function PickClock({ draftSlot, teams, overallPick, myPicks: owned }: Props) {
  const myPicks = owned?.length ? owned : snakePicks(draftSlot, teams);
  const nextMine = myPicks.find((p) => p >= overallPick);
  const untilMine = nextMine != null ? nextMine - overallPick : null;

  return (
    <div
      title={`The draft is on overall pick ${overallPick}.${untilMine != null ? ` Your next turn is pick ${nextMine} — ${untilMine === 0 ? "you're up now" : `${untilMine} pick${untilMine === 1 ? "" : "s"} away`}.` : " You have no picks left."}`}
      className="hidden sm:flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-surface border border-line font-mono text-xs font-semibold cursor-help">
      <span className="text-faint">Pick</span>
      <span className="text-ink">{overallPick}</span>
      {untilMine != null && (
        <span className="text-emerald-600">· you in {untilMine === 0 ? "now!" : untilMine}</span>
      )}
    </div>
  );
}

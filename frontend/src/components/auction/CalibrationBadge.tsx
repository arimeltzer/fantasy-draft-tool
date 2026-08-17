import { Scale } from "lucide-react";
import type { AuctionCalibration } from "@/engine/auction-calibration.js";
import { describeCalibration } from "@/engine/auction-calibration.js";

/**
 * Says out loud that market prices have been bent toward this league's habits.
 *
 * A silent price adjustment would be worse than none: every $Market figure on
 * the board would differ from the generic model with nothing on screen to
 * explain why, and a number you cannot account for is a number you stop
 * trusting mid-draft. So the badge states the sample it learned from and the
 * per-position effect, and stays visible (muted) when there is no history —
 * "not calibrated" is itself worth knowing before you bid.
 */
export default function CalibrationBadge({ cal }: { cal: AuctionCalibration | null | undefined }) {
  const on = !!cal?.usable;
  const detail = describeCalibration(cal);
  const moved = on
    ? Object.entries(cal!.posMult)
        .filter(([pos, m]) => (cal!.sample[pos] ?? 0) > 0 && Math.abs(m - 1) >= 0.03)
        .sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1))
        .slice(0, 3)
    : [];

  const tip = on
    ? `Market prices are adjusted for how this league actually spends, learned from ${cal!.pricedPicks} priced picks in your imported prior season. ${detail}. `
      + `Small samples are pulled toward neutral, and the adjustments cancel out across positions so the total money on the board is unchanged. `
      + `Your own $Value is deliberately NOT adjusted — the gap between value and price is the bargain signal.`
    : `Market prices use the generic model curve. ${detail}. `
      + `Import a prior season in the Keepers panel and the forecast will learn what your room overpays for.`;

  return (
    <div
      title={tip}
      className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded border font-mono text-xs cursor-help ${
        on ? "bg-sky-50 border-sky-200 text-sky-700" : "bg-gray-50 border-gray-200 text-gray-400"
      }`}
    >
      <Scale className="w-3.5 h-3.5" />
      {on
        ? (moved.length
            ? moved.map(([pos, m]) => `${pos}${m > 1 ? "+" : ""}${Math.round((m - 1) * 100)}%`).join(" ")
            : "league-neutral")
        : "generic prices"}
    </div>
  );
}

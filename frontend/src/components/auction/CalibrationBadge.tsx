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

  // Surfaced, not buried: the import lists end-of-season rosters, so a low
  // count means dropped players are missing and the shares lean toward picks
  // that worked. Worth knowing before you trust a price.
  const thin = on && cal!.coverage != null && cal!.coverage < 0.75;
  // Multiple drafts let the premise be tested rather than assumed. A failed
  // test is worth as much screen space as a passed one: it means the swings
  // are noise, and the numbers beside it should be discounted accordingly.
  const stab = on ? cal!.stability : null;
  const unstable = !!stab && !stab.persists;

  const tip = on
    ? `Market prices are adjusted for how this league actually spends, learned from ${cal!.pricedPicks} priced picks in your imported prior season. ${detail}. `
      + `Small samples are pulled toward neutral, and the adjustments cancel out across positions so the total money on the board is unchanged. `
      + `Your own $Value is deliberately NOT adjusted — the gap between value and price is the bargain signal.`
      + (thin
        ? ` ⚠ Only ${Math.round(cal!.coverage! * 100)}% of a full draft carries a price: the import reads end-of-season rosters, so players who were drafted and later dropped are missing and these shares tilt toward picks that worked out.`
        : "")
      + (stab
        ? (stab.persists
          ? ` Checked across ${stab.seasons.length} drafts (${stab.seasons.join(", ")}): this league's own history predicts its next draft ${Math.round(stab.lift * 100)}% better than the generic split, so the habit is real and not one year's noise.`
          : ` ⚠ Checked across ${stab.seasons.length} drafts (${stab.seasons.join(", ")}): this league's history does NOT predict its own next draft better than the generic split. The year-to-year swings look like noise, so the adjustment has been shrunk twice as hard — treat it as weak.`)
        : (cal!.seasons && cal!.seasons.length > 1
          ? ""
          : " Only one draft was available, so whether this is a durable habit or one year's accident is unknown — import earlier seasons to find out."))
    : `Market prices use the generic model curve. ${detail}. `
      + `Import a prior season in the Keepers panel (the Keepers button) and the forecast will learn what your room overpays for — no need to recreate the league.`;

  return (
    <div
      title={tip}
      className={`hidden sm:flex items-center gap-1.5 px-3.5 py-2 rounded-full border font-mono text-xs font-semibold cursor-help ${
        !on ? "bg-surface border-line text-faint"
        : (thin || unstable) ? "bg-amber-50 border-amber-200 text-amber-700"
        : "bg-sky-50 border-sky-200 text-sky-700"
      }`}
    >
      <Scale className="w-3.5 h-3.5" />
      {on
        ? (moved.length
            ? moved.map(([pos, m]) => `${pos}${m > 1 ? "+" : ""}${Math.round((m - 1) * 100)}%`).join(" ")
            : "league-neutral")
        : "generic prices"}
      {thin && <span title="partial draft data">*</span>}
      {stab && <span title={stab.persists
        ? `holds up across ${stab.seasons.length} drafts`
        : `does not repeat across ${stab.seasons.length} drafts`}>{stab.persists ? " ✓" : " ?"}</span>}
    </div>
  );
}

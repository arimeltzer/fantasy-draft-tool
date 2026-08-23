import type { InjuryInfo } from "@/lib/api";

/**
 * Injury flag on a player row.
 *
 * Deliberately loud for the severe cases. The failure this exists to prevent is
 * drafting someone who is on IR without noticing, so "out" is a filled red chip
 * rather than a subtle icon — you should not be able to miss it while moving
 * fast. Questionable is amber and quiet, because it is genuinely common and a
 * badge that cries wolf gets tuned out.
 *
 * The valuation is untouched: this reports the status, it does not silently
 * discount the player. What an injury is worth depends on your league's IR
 * spot, bench depth and how long the absence is — none of which the app knows.
 */
const TONE: Record<InjuryInfo["severity"], string> = {
  out: "border-rose-600 bg-rose-600 text-white",
  doubtful: "border-rose-300 bg-rose-50 text-rose-700",
  questionable: "border-amber-300 bg-amber-50 text-amber-800",
  note: "border-line bg-raised text-muted",
};

export default function InjuryBadge({ injury }: { injury: InjuryInfo | null | undefined }) {
  if (!injury?.status) return null;
  const label = injury.short || injury.status.slice(0, 3).toUpperCase();
  const detail = [
    injury.status,
    injury.type,
    injury.chance != null ? `${injury.chance}% to play` : null,
  ].filter(Boolean).join(" · ");

  return (
    <span
      title={detail}
      aria-label={`Injury: ${detail}`}
      className={`shrink-0 rounded-md border px-1.5 py-px text-2xs font-bold leading-tight ${TONE[injury.severity] ?? TONE.note}`}
    >
      {label}
    </span>
  );
}

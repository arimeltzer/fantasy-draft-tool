import { Flame } from "lucide-react";

interface Props {
  factor: number;
  /** False once too little priced value is left for the ratio to mean
   *  anything — see applyInflation's INFLATION_MIN_COVERAGE. */
  reliable?: boolean;
  /** True when the raw ratio was outside INFLATION_CLAMP and got bounded. */
  clamped?: boolean;
  /** The unclamped ratio, for the tooltip only. */
  raw?: number;
}

export default function InflationBadge({ factor, reliable = true, clamped = false, raw }: Props) {
  const hot  = factor > 1.05;
  const cold = factor < 0.95;

  // THE CAUSE HERE USED TO BE STATED BACKWARDS, which is what made a user
  // distrust the number: "hot" was described as teams OVERpaying. It is the
  // opposite. factor = money still in the room / par value still on the
  // board. Overpaying drains money faster than it removes board value, so it
  // pushes the ratio DOWN (verified: identical draft, 10 picks at 2x par ->
  // 0.76; the same 10 picks at $1 -> 1.23). The CONSEQUENCE half of the old
  // text was right both times; only the cause was inverted.
  const explain = hot
    ? "The room has UNDERpaid so far — early players went cheap, so there's more money left than there is value on the board. Expect the players still out there to go ABOVE par."
    : cold
    ? "The room has OVERpaid so far — the money is draining faster than the talent, so what's left should go BELOW par. This is when bargains appear."
    : "Prices are tracking par values so far.";

  const unreliableNote = !reliable
    ? " NOTE: almost no priced value is left on the board, so this ratio is "
      + "mostly leftover dollars divided by scraps — treat it as 'the room "
      + "didn't spend everything', not as a real multiplier."
    : "";
  const clampNote = clamped && raw != null
    ? ` Raw ratio was x${raw.toFixed(2)}, bounded for display and pricing.`
    : "";

  const label = reliable ? `inflation ×${factor.toFixed(2)}` : "inflation n/a";

  return (
    <div
      title={`Live inflation multiplier applied to every $Live price. ${explain}${clampNote}${unreliableNote}`}
      className={`hidden sm:flex items-center gap-1.5 px-3.5 py-2 rounded-full border font-mono text-xs font-semibold cursor-help ${
        !reliable ? "bg-surface border-line text-faint" :
        hot  ? "bg-rose-50 border-rose-200 text-rose-600" :
        cold ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700" :
               "bg-surface border-line text-muted"
      }`}
    >
      <Flame className="w-3.5 h-3.5" />
      {label}{reliable && clamped ? "*" : ""}
    </div>
  );
}

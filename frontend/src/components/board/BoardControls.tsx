import { Search, X, Sparkles } from "lucide-react";

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "K", "DST"] as const;

interface Props {
  query: string;
  onQuery: (q: string) => void;
  posFilter: string;
  onPos: (p: string) => void;
  hideLabel: string;
  hideChecked: boolean;
  onHide: (v: boolean) => void;
  accentColor?: string;
  /** Rookies-only toggle. Optional so any other consumer of this control is
   *  unaffected; both draft rooms pass it. */
  rookiesOnly?: boolean;
  onRookiesOnly?: (v: boolean) => void;
  /** How many rookies are in the CURRENT pool, so the button can say whether
   *  turning it on will show anything. */
  rookieCount?: number;
}

export default function BoardControls({
  query, onQuery, posFilter, onPos, hideLabel, hideChecked, onHide, accentColor = "accent-amber-500",
  rookiesOnly, onRookiesOnly, rookieCount,
}: Props) {
  return (
    <div className="flex items-center gap-2 mb-3 flex-wrap">
      <div className="relative flex-1 min-w-[160px]">
        <Search className="w-3.5 h-3.5 text-faint absolute left-3.5 top-1/2 -translate-y-1/2" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search player or team"
          className="w-full pl-9 pr-8 py-2.5 rounded-full bg-surface border border-line text-sm text-ink placeholder:text-faint focus:outline-none focus:border-gold/60 shadow-card"
        />
        {query && (
          <button
            onClick={() => onQuery("")}
            title="Clear search"
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 grid place-items-center rounded-full bg-raised text-muted hover:text-ink hover:bg-hover"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        {POSITIONS.map((pos) => (
          <button
            key={pos}
            onClick={() => onPos(pos)}
            className={`px-3 py-2 rounded-full border font-mono font-semibold ${posFilter === pos ? "bg-ink border-ink text-white" : "bg-surface border-line text-muted hover:text-ink hover:border-faint"}`}
          >
            {pos}
          </button>
        ))}
      </div>
      {onRookiesOnly && (
        <button
          onClick={() => onRookiesOnly(!rookiesOnly)}
          aria-pressed={!!rookiesOnly}
          title={
            "Show only rookies still on the board. Late in a draft an unproven "
            + "rookie's upside can be worth more than an equally-priced veteran's "
            + "known ceiling — this makes them findable without scrolling.\n\n"
            + "Their projections come from the ADP/ECR rookie curve, not from "
            + "prior-season stats they don't have, so treat the numbers as a "
            + "market read rather than a measurement."
            + (rookieCount != null ? `\n\n${rookieCount} rookie${rookieCount === 1 ? "" : "s"} in the current pool.` : "")
          }
          className={`flex items-center gap-1 px-3 py-2 rounded-full border font-mono text-xs font-semibold ${
            rookiesOnly
              ? "bg-violet-100 border-violet-300 text-violet-800"
              : "bg-surface border-line text-muted hover:text-ink hover:border-faint"
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          rookies
          {rookieCount != null && <span className="opacity-70">{rookieCount}</span>}
        </button>
      )}
      <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none px-1">
        <input type="checkbox" checked={hideChecked} onChange={(e) => onHide(e.target.checked)} className={accentColor} />
        {hideLabel}
      </label>
    </div>
  );
}

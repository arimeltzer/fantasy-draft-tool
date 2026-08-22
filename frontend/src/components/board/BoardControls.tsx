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
    <div className="flex items-center gap-2 mb-2 flex-wrap">
      <div className="relative flex-1 min-w-[160px]">
        <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search player or team"
          className="w-full pl-8 pr-7 py-1.5 rounded bg-gray-50 border border-gray-200 text-sm focus:outline-none focus:border-gray-400"
        />
        {query && (
          <button
            onClick={() => onQuery("")}
            title="Clear search"
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-200"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 text-xs">
        {POSITIONS.map((pos) => (
          <button
            key={pos}
            onClick={() => onPos(pos)}
            className={`px-2 py-1.5 rounded border font-mono ${posFilter === pos ? "bg-gray-300 border-gray-400 text-white" : "bg-gray-50 border-gray-200 text-gray-500 hover:text-gray-700"}`}
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
          className={`flex items-center gap-1 px-2 py-1.5 rounded border font-mono text-xs ${
            rookiesOnly
              ? "bg-violet-100 border-violet-300 text-violet-800"
              : "bg-gray-50 border-gray-200 text-gray-500 hover:text-gray-700"
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          rookies
          {rookieCount != null && <span className="opacity-70">{rookieCount}</span>}
        </button>
      )}
      <label className={`flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none`}>
        <input type="checkbox" checked={hideChecked} onChange={(e) => onHide(e.target.checked)} className={accentColor} />
        {hideLabel}
      </label>
    </div>
  );
}

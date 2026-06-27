import { Search } from "lucide-react";
import { posStyle } from "@/lib/posStyles";

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
}

export default function BoardControls({
  query, onQuery, posFilter, onPos, hideLabel, hideChecked, onHide, accentColor = "accent-brand",
}: Props) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="relative min-w-[180px] flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search player or team"
          className="field pl-9"
        />
      </div>

      <div className="flex items-center gap-1 rounded-lg border border-line bg-surface p-1 shadow-card">
        {POSITIONS.map((pos) => {
          const active = posFilter === pos;
          const st = pos === "ALL" ? null : posStyle(pos);
          return (
            <button
              key={pos}
              onClick={() => onPos(pos)}
              className={`rounded-md px-2 py-1 font-mono text-2xs font-semibold transition-colors ${
                active
                  ? "bg-ink text-white"
                  : `text-muted hover:bg-raised ${st ? st.text : ""}`
              }`}
            >
              {pos}
            </button>
          );
        })}
      </div>

      <label className="flex cursor-pointer select-none items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-2 text-xs text-muted shadow-card">
        <input
          type="checkbox"
          checked={hideChecked}
          onChange={(e) => onHide(e.target.checked)}
          className={`h-3.5 w-3.5 ${accentColor}`}
        />
        {hideLabel}
      </label>
    </div>
  );
}

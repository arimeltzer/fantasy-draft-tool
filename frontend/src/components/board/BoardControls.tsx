import { Search } from "lucide-react";

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
  query, onQuery, posFilter, onPos, hideLabel, hideChecked, onHide, accentColor = "accent-amber-500",
}: Props) {
  return (
    <div className="flex items-center gap-2 mb-2 flex-wrap">
      <div className="relative flex-1 min-w-[160px]">
        <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search player or team"
          className="w-full pl-8 pr-3 py-1.5 rounded bg-slate-900 border border-slate-800 text-sm focus:outline-none focus:border-slate-600"
        />
      </div>
      <div className="flex items-center gap-1 text-[11px]">
        {POSITIONS.map((pos) => (
          <button
            key={pos}
            onClick={() => onPos(pos)}
            className={`px-2 py-1.5 rounded border font-mono ${posFilter === pos ? "bg-slate-700 border-slate-600 text-white" : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"}`}
          >
            {pos}
          </button>
        ))}
      </div>
      <label className={`flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer select-none`}>
        <input type="checkbox" checked={hideChecked} onChange={(e) => onHide(e.target.checked)} className={accentColor} />
        {hideLabel}
      </label>
    </div>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, X } from "lucide-react";
import { api } from "@/lib/api";

interface Props {
  playerId: number;
  season?: number;
}

export default function CommonOpponentsPopover({ playerId, season = 2026 }: Props) {
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["common-opponents", playerId, season],
    queryFn: () => api.commonOpponents(playerId, season),
    enabled: open,
  });

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-slate-500 hover:text-slate-300 p-0.5"
        title="Common opponents (2025 → 2026)"
      >
        <Info className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-6 z-50 w-64 rounded-lg border border-slate-700 bg-slate-900 shadow-xl p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Common Opponents</span>
            <button onClick={() => setOpen(false)}><X className="w-3.5 h-3.5 text-slate-500" /></button>
          </div>

          {isLoading && <div className="text-xs text-slate-500 py-2">Loading…</div>}

          {data && (
            <>
              {data.count === 0 ? (
                <div className="text-xs text-slate-500 py-2">No 2025 overlap with 2026 schedule.</div>
              ) : (
                <>
                  <div className="text-[11px] text-slate-400 mb-2 font-mono">
                    {data.count} {data.count === 1 ? "game" : "games"} · avg {data.avgFp} fp
                  </div>
                  <div className="space-y-1">
                    {data.games.map((g) => (
                      <div key={g.opp + g.week} className="flex items-center justify-between text-xs">
                        <span className="font-mono text-slate-300">vs {g.opp}</span>
                        <span className="font-mono text-emerald-400">{g.fp2025.toFixed(1)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

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
        className="rounded p-0.5 text-faint hover:text-ink"
        title="Common opponents (2025 → 2026)"
      >
        <Info className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-6 z-50 w-64 rounded-xl border border-line bg-surface p-3 shadow-pop">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Common Opponents</span>
            <button onClick={() => setOpen(false)}><X className="h-3.5 w-3.5 text-faint hover:text-ink" /></button>
          </div>

          {isLoading && <div className="py-2 text-xs text-muted">Loading…</div>}

          {data && (
            <>
              {data.count === 0 ? (
                <div className="py-2 text-xs text-muted">No 2025 overlap with 2026 schedule.</div>
              ) : (
                <>
                  <div className="mb-2 font-mono text-2xs text-muted">
                    {data.count} {data.count === 1 ? "game" : "games"} · avg {data.avgFp} fp
                  </div>
                  <div className="space-y-1">
                    {data.games.map((g) => (
                      <div key={g.opp + g.week} className="flex items-center justify-between text-xs">
                        <span className="font-mono text-muted">vs {g.opp}</span>
                        <span className="font-mono text-emerald-600">{g.fp2025.toFixed(1)}</span>
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

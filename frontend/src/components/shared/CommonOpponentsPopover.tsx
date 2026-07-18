import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, X } from "lucide-react";
import { api } from "@/lib/api";

interface Props {
  playerId: number;
  season?: number;
}

const POP_W = 256;   // w-64
const POP_MAX_H = 288; // max-h-72

export default function CommonOpponentsPopover({ playerId, season = 2026 }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["common-opponents", playerId, season],
    queryFn: () => api.commonOpponents(playerId, season),
    enabled: open,
  });

  const toggle = () => {
    if (!open && btnRef.current) {
      // Fixed positioning so the popover escapes the player list's
      // overflow-y-auto container (absolute children get clipped by it).
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
      const below = r.bottom + 4;
      const top = below + POP_MAX_H > window.innerHeight
        ? Math.max(8, r.top - POP_MAX_H - 4)
        : below;
      setPos({ top, left });
    }
    setOpen((v) => !v);
  };

  return (
    <div className="relative inline-block">
      <button
        ref={btnRef}
        onClick={toggle}
        className="text-gray-500 hover:text-gray-600 p-0.5"
        title="Common opponents (2025 → 2026)"
      >
        <Info className="w-3.5 h-3.5" />
      </button>

      {open && pos && (
        <div
          className="fixed z-50 w-64 max-h-72 overflow-y-auto rounded-lg border border-gray-300 bg-gray-50 shadow-xl p-3"
          style={{ top: pos.top, left: pos.left }}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Common Opponents</span>
            <button onClick={() => setOpen(false)}><X className="w-3.5 h-3.5 text-gray-500" /></button>
          </div>

          {isLoading && <div className="text-xs text-gray-500 py-2">Loading…</div>}

          {data && (
            <>
              {data.count === 0 ? (
                <div className="text-xs text-gray-500 py-2">No 2025 overlap with 2026 schedule.</div>
              ) : (
                <>
                  <div className="text-xs text-gray-500 mb-2 font-mono">
                    {data.count} {data.count === 1 ? "game" : "games"} · avg {data.avgFp} fp
                  </div>
                  <div className="space-y-1">
                    {data.games.map((g) => (
                      <div key={g.opp + g.week} className="flex items-center justify-between text-xs">
                        <span className="font-mono text-gray-600">vs {g.opp}</span>
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

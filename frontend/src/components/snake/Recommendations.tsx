import { Target, Check } from "lucide-react";
import { posStyle } from "@/lib/posStyles";
import Tip from "@/components/shared/Tip";
import { pickScore } from "@/engine/snake-engine.js";
import type { BoardPlayer, SnakeLiveState } from "@/engine/snake-engine.js";

interface Props {
  board: BoardPlayer[];
  draftedIds: Set<number>;
  live: SnakeLiveState;
  onDraft: (p: BoardPlayer) => void;
}

export default function Recommendations({ board, draftedIds, live, onDraft }: Props) {
  const avail = board.filter((p) => !draftedIds.has(p.id as number));

  const SLOTS = 6;
  const MAX_PER_POS = 2;

  const scored = avail
    .map((p) => {
      const { score, reasons, blocked } = pickScore(p, live);
      return { ...p, score, reasons, blocked };
    })
    .filter((p) => Number.isFinite(p.score))
    .sort((a, b) => b.score - a.score);

  // Cap how many of one position can fill the panel. You make ONE pick here, so
  // the 3rd- and 4th-best quarterback are not choices — they are the same
  // choice repeated, crowding out the best available at every other position.
  // Before this, the round a position's gate opened could fill four of six
  // slots with it, which reads as advice to draft four of them.
  const open = scored.filter((p) => !p.blocked);
  const perPos: Record<string, number> = {};
  const recs = open.filter((p) => {
    if ((perPos[p.pos] ?? 0) >= MAX_PER_POS) return false;
    perPos[p.pos] = (perPos[p.pos] ?? 0) + 1;
    return true;
  }).slice(0, SLOTS);

  // Backfill rather than show a short panel: with the cap in place a thin pool
  // can leave gaps, and dropping to the next-best repeat beats empty slots.
  if (recs.length < SLOTS) {
    const shown = new Set(recs.map((p) => p.id));
    recs.push(...open.filter((p) => !shown.has(p.id)).slice(0, SLOTS - recs.length));
  }
  // Last resort: every candidate is gated (roster full, or all too early).
  // Falling back to raw value keeps the panel useful instead of blank.
  if (recs.length === 0) {
    recs.push(...scored.slice().sort((a, b) => b.vbd - a.vbd).slice(0, SLOTS)
      .map((p) => ({ ...p, reasons: [p.blocked ? `${p.blocked} — shown on value` : "best available"] })));
  }

  return (
    <div className="mb-4 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.04] p-3">
      <div className="flex items-center gap-2 mb-2.5">
        <Target className="w-4 h-4 text-emerald-600" />
        <Tip tip="The model's best picks for you right now — not just the highest-ranked players, but the best mix of value, your open roster spots, and how fast each position is drying up.">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Recommended now</h2>
        </Tip>
        <Tip tip="Scores are adjusted for what your roster still needs — a position you've filled scores lower even if the player ranks higher overall.">
          <span className="text-xs text-gray-500">need-adjusted</span>
        </Tip>
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        {recs.map((p, i) => {
          const st = posStyle(p.pos);
          return (
            <div key={p.id} className="flex items-center gap-2.5 rounded-md bg-gray-50 border border-gray-200 px-2.5 py-2">
              <span className="text-xs font-mono text-gray-400 w-3">{i + 1}</span>
              <span className={`text-xs font-mono px-1.5 py-0.5 rounded border ${st.chip}`}>{p.pos}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">
                  {p.name} <span className="text-gray-500 font-mono text-xs">{p.team}</span>
                </div>
                {p.reasons.length > 0 && (
                  <div className="text-xs text-gray-500 truncate">{p.reasons.join(" · ")}</div>
                )}
              </div>
              <div className="text-right" title="Projected points above a replacement-level player at this position">
                <div className="font-mono text-xs text-gray-700 tabular-nums">{p.vbd}</div>
                <div className="text-xs text-gray-400 uppercase">vbd</div>
              </div>
              <button
                onClick={() => onDraft(p)}
                title="Draft this player to your team"
                className="ml-1 p-1.5 rounded bg-emerald-50 border border-emerald-300 text-emerald-700 hover:bg-emerald-100"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

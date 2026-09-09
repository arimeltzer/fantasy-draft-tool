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
  //
  // vbd > 0 is a real gate here, not just the cap's tiebreak: reported live
  // — round 1, with QB and TE both round-gated closed (blocked, so excluded
  // from `open` already) and RB/WR maxed out at MAX_PER_POS, the ONLY
  // positions left unblocked to backfill slots 5-6 with were K and DST,
  // whose best available player was still genuinely replacement-level
  // (0 VBD) this early. A 0-VBD "recommendation" is not a recommendation —
  // it's exactly as good as the guy on waivers — so it must never fill a
  // slot just because it's the only unblocked position left standing.
  const open = scored.filter((p) => !p.blocked && p.vbd > 0);
  const perPos: Record<string, number> = {};
  const recs = open.filter((p) => {
    if ((perPos[p.pos] ?? 0) >= MAX_PER_POS) return false;
    perPos[p.pos] = (perPos[p.pos] ?? 0) + 1;
    return true;
  }).slice(0, SLOTS);

  // NO backfill past the cap above — reported live: once starters filled
  // and every other position hit its own roster/bench cap (a normal
  // mid-late-draft state, not the endgame gate below), DST was the ONLY
  // position left unblocked, and a since-removed backfill step here
  // refilled all 6 slots with different defenses, ignoring MAX_PER_POS
  // entirely: "recommended six defenses ... wasting picks I could have
  // used to build my bench." That step existed to avoid a short panel
  // from a genuinely thin pool, but a thin pool concentrated in ONE
  // position is exactly the scenario the cap exists to stop — filling the
  // gap from `open` without the cap just readmits the 3rd/4th/5th/6th-best
  // repeat the cap's own comment above already argues isn't a real choice.
  // `perPos` already reflects every candidate that fit under the cap
  // (the filter above runs over all of `open`, not just the first SLOTS),
  // so there is nothing left to add here without breaking it — a short
  // panel is the honest outcome, same "short panel beats bad advice"
  // trade already made for the vbd > 0 gate just above.
  // Last resort: every candidate is gated (roster full, or all too early).
  // Falling back to raw value keeps the panel useful instead of blank.
  if (recs.length === 0) {
    recs.push(...scored.slice().sort((a, b) => b.vbd - a.vbd).slice(0, SLOTS)
      .map((p) => ({ ...p, reasons: [p.blocked ? `${p.blocked} — shown on value` : "best available"] })));
  }

  return (
    <div className="mb-4 rounded-2xl border-[1.5px] border-emerald-500/25 bg-emerald-500/[0.04] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Target className="w-4 h-4 text-emerald-600" />
        <Tip tip="The model's best picks for you right now — not just the highest-ranked players, but the best mix of value, your open roster spots, and how fast each position is drying up.">
          <h2 className="text-xs font-bold uppercase tracking-wider text-emerald-700">Recommended now</h2>
        </Tip>
        <Tip tip="Scores are adjusted for what your roster still needs — a position you've filled scores lower even if the player ranks higher overall.">
          <span className="text-xs text-muted">need-adjusted</span>
        </Tip>
      </div>
      <div className="grid sm:grid-cols-2 gap-2.5">
        {recs.map((p, i) => {
          const st = posStyle(p.pos);
          return (
            <div key={p.id} className="flex items-center gap-2.5 rounded-xl bg-surface border border-line px-3 py-2.5">
              <span className="text-xs font-mono text-faint w-3">{i + 1}</span>
              <span className={`w-6 h-6 rounded-md ${st.badge} text-white text-[9px] font-bold grid place-items-center shrink-0`}>{p.pos}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate">
                  {p.name} <span className="text-faint font-mono text-xs">{p.team}</span>
                </div>
                {p.reasons.length > 0 && (
                  <div className="text-xs text-muted truncate">{p.reasons.join(" · ")}</div>
                )}
              </div>
              <div className="text-right" title="Projected points above a replacement-level player at this position">
                <div className="font-mono text-xs font-bold text-ink tabular-nums">{p.vbd}</div>
                <div className="text-2xs text-faint uppercase font-semibold">vbd</div>
              </div>
              <button
                onClick={() => onDraft(p)}
                title="Draft this player to your team"
                className="ml-1 w-7 h-7 grid place-items-center rounded-lg bg-emerald-50 border border-emerald-300 text-emerald-700 hover:bg-emerald-100"
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

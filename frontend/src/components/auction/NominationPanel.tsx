import { TrendingUp, Gavel, Target } from "lucide-react";
import { posStyle } from "@/lib/posStyles";
import Tip from "@/components/shared/Tip";
import type { BoardPlayer } from "@/engine/auction-engine.js";

interface NomItem {
  p: BoardPlayer;
  score: number;
  isDump: boolean;
  market: number;
  effectiveDv: number;
}

interface TargetItem {
  p: BoardPlayer;
  market: number;
  /** PRIMARY suggested bid (roadmap 3.3+3.4+3.4a composed) — cleared the
   *  auction-sim kill gate at every noise level (roadmap 3.5). */
  bid: number;
  pass: boolean;
  dollarValue: number;
  surplus: number;
  /** roadmap 3.3 — allocation-aware ceiling alone; null when there is no
   *  open starting slot to evaluate against. */
  allocationCeiling?: number | null;
  /** Which constraint set the primary bid: my roster allocation, or the
   *  room's money. */
  binding?: "allocation" | "opponents" | "budget" | "none";
  /** The ceiling is real but below the modeled market price — worth
   *  pursuing at this number, but the room is expected to take him higher.
   *  Not a reason to hide the number (that used to be "pass"). */
  belowMarket?: boolean;
  /** Bench-phase "one strong backup" nudge (QB/RB/WR): the ceiling is above
   *  market because this position has zero bench bodies yet. */
  backupBoosted?: boolean;
  /** suggestBid()'s OWN independent-pricing number — shown alongside, not
   *  hidden, because the two methods disagreeing is itself informative. */
  modelBid: number;
  modelPass: boolean;
}

interface Props {
  factor: number;
  phase: "early" | "mid" | "late";
  nominations: NomItem[];
  valueTargets: TargetItem[];
  myMax: number;
  oppBudgets: number[];
  richThreshold: number;
}

const PHASE_ADVICE: Record<Props["phase"], string> = {
  early: "Early — nominate players you DON'T want while opponents are flush. Never expose your targets.",
  mid:   "Mid — keep draining budgets; float mid-tier targets only when the price is right.",
  late:  "Late — opponents are short. Nominate your targets and grab value; dump cheap filler to bleed last dollars.",
};

export default function NominationPanel({ factor, phase, nominations, valueTargets, myMax, oppBudgets, richThreshold }: Props) {
  const rich = oppBudgets.filter((b) => b > richThreshold).length;

  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
      <div className="flex items-center gap-2 mb-1">
        <Gavel className="w-4 h-4 text-faint" />
        <Tip tip="Who to put up for bid when it's your turn to nominate — you don't have to want the player; nominating players you don't want drains other teams' budgets.">
          <h2 className="text-xs font-bold text-muted">Nomination strategy</h2>
        </Tip>
        <span className={`ml-auto text-xs font-mono font-bold px-2 py-0.5 rounded-full cursor-help ${
          phase === "early" ? "bg-sky-50 text-sky-700"
          : phase === "mid" ? "bg-amber-50 text-amber-700"
          : "bg-emerald-50 text-emerald-700"
        }`} title="Draft phase, based on how many opponents still have big budgets. The nomination advice below changes with the phase.">{phase}</span>
      </div>
      <p className="text-xs text-muted leading-snug mb-3">{PHASE_ADVICE[phase]}</p>

      <div className="flex items-center justify-between text-xs font-mono mb-3.5 pb-3.5 border-b border-hair">
        <Tip tip={`How many opponents still have more than $${richThreshold} to spend. While most are flush, avoid nominating players you actually want — they'll get bid up.`}>
          <span className="text-faint">opponents flush (&gt;${richThreshold})</span>
        </Tip>
        <span className="text-ink font-semibold">{rich} / {oppBudgets.length}</span>
      </div>

      {/* Who to nominate next */}
      <div className="mb-4">
        <div className="text-2xs font-bold uppercase tracking-wider text-faint mb-2">
          <Tip tip="Who to put on the block — 'drain' a room you don't want, or 'target' one you do when the room's flush. The model's best nominations right now.">Nominate next</Tip>
        </div>
        <div className="flex flex-col gap-1.5">
          {nominations.map(({ p, isDump, market }) => {
            const st = posStyle(p.pos);
            return (
              <div key={p.id} className="flex items-center gap-2 text-xs">
                <span className={`w-[18px] h-[18px] rounded-md ${st.badge} text-white text-[8px] font-bold grid place-items-center shrink-0`}>{p.pos}</span>
                <span className="truncate flex-1 font-semibold">{p.name}</span>
                <span className="font-mono text-faint" title="Expected sale price based on market rankings">${market}</span>
                <span
                  className={`text-2xs font-bold px-2 py-0.5 rounded-full cursor-help ${isDump ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}
                  title={isDump
                    ? "Salary dump: nominate to drain opponents' budgets — let them win the bid"
                    : "One of your value targets: nominate when opponents are low on cash"}
                >
                  {isDump ? "DRAIN" : "TARGET"}
                </span>
              </div>
            );
          })}
          {nominations.length === 0 && <div className="text-xs text-faint">No players left.</div>}
        </div>
      </div>

      {/* Your value targets with suggested bids */}
      <div>
        <div className="flex items-center gap-1 text-2xs font-bold uppercase tracking-wider text-faint mb-2">
          <Target className="w-3 h-3" />
          <Tip tip="Players whose model value most exceeds their expected price — the best bargains left. The bid is the most you should pay, accounting for what's left to fill on your own roster AND what the room can actually afford (roadmap 3.3-3.5: measured to beat independent pricing head-to-head). A '~' means the market is expected to go higher — it's your walk-away point, not a price you're favored to win at. 'pass' means he doesn't improve your reachable roster at ANY price.">Targets to consider</Tip>
        </div>
        <div className="flex flex-col gap-2.5">
          {valueTargets.map(({ p, bid, market, pass, binding, belowMarket, backupBoosted, modelBid, modelPass }) => {
            const st = posStyle(p.pos);
            const overMax = bid > myMax;
            const byRoom = binding === "opponents";
            return (
              <div key={p.id}>
                <div className="flex items-center gap-2 text-xs">
                  <span className={`w-[18px] h-[18px] rounded-md ${st.badge} text-white text-[8px] font-bold grid place-items-center shrink-0`}>{p.pos}</span>
                  <span className="truncate flex-1 font-semibold">{p.name}</span>
                  <span
                    className={`font-mono font-bold shrink-0 cursor-help ${overMax ? "text-rose-500" : pass ? "text-faint" : byRoom ? "text-violet-700" : backupBoosted ? "text-teal-700" : "text-sky-700"}`}
                    title={overMax
                      ? "Suggested bid is above the max you can afford while filling your roster"
                      : pass
                      ? "He doesn't improve your best reachable roster at any price you'd have to pay — skip him."
                      : byRoom
                      ? `Capped by the room's money: no opponent can bid more than $${bid - 1}, so you never have to pay above $${bid} no matter what he's worth. This is what the room CAN pay, not what it wants to — a hard upper bound that tightens as budgets drain.`
                      : backupBoosted
                      ? `Boosted above market: you have no backup at ${p.pos} yet, and landing one strong backup is worth paying up for.`
                      : belowMarket
                      ? `Your real ceiling: the most you can pay and still end up with a roster at least as good as if you skipped him. He's worth pursuing at this price — the market (~$${market}) is likely to take him higher, so treat this as your walk-away point, not a price you're favored to win at.`
                      : "Allocation ceiling: the most you can pay and still end up with a roster at least as good as if you skipped him — reserves a realistic price for every remaining starter, not $1."}
                  >
                    {pass ? "pass" : `bid $${bid}${byRoom ? "*" : backupBoosted ? "↑" : belowMarket ? "~" : ""}`}
                  </span>
                </div>
                <div className="pl-6 text-2xs text-faint font-mono">
                  <span title="Expected sale price based on market rankings">mkt ${market}</span>
                  <span
                    className="ml-1.5 cursor-help"
                    title={`suggestBid()'s own independent-pricing number, shown for comparison — ${modelPass ? "it would pass on this player." : `it would bid $${modelBid}.`} The bid above beat this method head-to-head (roadmap 3.5).`}
                  >
                    · model {modelPass ? "pass" : `$${modelBid}`}
                  </span>
                </div>
              </div>
            );
          })}
          {valueTargets.length === 0 && <div className="text-xs text-faint">No value targets.</div>}
        </div>
      </div>

      <div className="mt-3.5 pt-3.5 border-t border-hair flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 text-faint font-semibold"><TrendingUp className="w-3 h-3" /> inflation</span>
        <span
          className={`font-mono font-bold cursor-help ${factor > 1.05 ? "text-rose-500" : factor < 0.95 ? "text-emerald-600" : "text-muted"}`}
          title={factor > 1.05
            ? "Above 1: the room is overpaying, so remaining players will cost more than par"
            : factor < 0.95
            ? "Below 1: the room is underpaying — bargains available on remaining players"
            : "Near 1: prices are tracking par values"}
        >
          ×{factor}
        </span>
      </div>
    </div>
  );
}

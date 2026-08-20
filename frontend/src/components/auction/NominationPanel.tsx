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
  binding?: "allocation" | "opponents" | "none";
  /** The ceiling is real but below the modeled market price — worth
   *  pursuing at this number, but the room is expected to take him higher.
   *  Not a reason to hide the number (that used to be "pass"). */
  belowMarket?: boolean;
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
    <div className="rounded-lg border border-gray-200 bg-gray-100 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Gavel className="w-4 h-4 text-gray-500" />
        <Tip tip="Who to put up for bid when it's your turn to nominate — you don't have to want the player; nominating players you don't want drains other teams' budgets.">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-600">Nomination strategy</h2>
        </Tip>
        <span className={`ml-auto text-xs font-mono px-1.5 py-0.5 rounded border cursor-help ${
          phase === "early" ? "bg-sky-50 border-sky-200 text-sky-700"
          : phase === "mid" ? "bg-amber-50 border-amber-200 text-amber-700"
          : "bg-emerald-50 border-emerald-200 text-emerald-700"
        }`} title="Draft phase, based on how many opponents still have big budgets. The nomination advice below changes with the phase.">{phase}</span>
      </div>
      <p className="text-xs text-gray-500 leading-snug mb-2">{PHASE_ADVICE[phase]}</p>

      <div className="flex items-center justify-between text-xs font-mono mb-2 pb-2 border-b border-gray-200">
        <Tip tip={`How many opponents still have more than $${richThreshold} to spend. While most are flush, avoid nominating players you actually want — they'll get bid up.`}>
          <span className="text-gray-500">opponents flush (&gt;${richThreshold})</span>
        </Tip>
        <span className="text-gray-700">{rich} / {oppBudgets.length}</span>
      </div>

      {/* Who to nominate next */}
      <div className="space-y-1 mb-3">
        <div className="text-2xs uppercase tracking-wider text-gray-400 mb-1">
          <Tip tip="The model's best nominations right now. 'Drain' = a player you don't want, nominated to make opponents spend. 'Target' = a player you do want, timed for when the room can't outbid you.">Nominate next</Tip>
        </div>
        {nominations.map(({ p, isDump, market }) => {
          const st = posStyle(p.pos);
          return (
            <div key={p.id} className="flex items-center gap-2 text-xs">
              <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
              <span className="truncate flex-1">{p.name}</span>
              <span className="font-mono text-gray-500" title="Expected sale price based on market rankings">${market}</span>
              <span
                className={`font-mono text-xs px-1 rounded cursor-help ${isDump ? "text-rose-600" : "text-emerald-600"}`}
                title={isDump
                  ? "Salary dump: nominate to drain opponents' budgets — let them win the bid"
                  : "One of your value targets: nominate when opponents are low on cash"}
              >
                {isDump ? "drain" : "target"}
              </span>
            </div>
          );
        })}
        {nominations.length === 0 && <div className="text-xs text-gray-400">No players left.</div>}
      </div>

      {/* Your value targets with suggested bids */}
      <div className="space-y-1">
        <div className="flex items-center gap-1 text-2xs uppercase tracking-wider text-gray-400 mb-1">
          <Target className="w-3 h-3" />
          <Tip tip="Players whose model value most exceeds their expected price — the best bargains left. The bid is the most you should pay, accounting for what's left to fill on your own roster AND what the room can actually afford (roadmap 3.3-3.5: measured to beat independent pricing head-to-head). A '~' means the market is expected to go higher — it's your walk-away point, not a price you're favored to win at. 'pass' means he doesn't improve your reachable roster at ANY price.">your targets — suggested bid</Tip>
        </div>
        {valueTargets.map(({ p, bid, market, pass, binding, belowMarket, modelBid, modelPass }) => {
          const st = posStyle(p.pos);
          const overMax = bid > myMax;
          const byRoom = binding === "opponents";
          return (
            <div key={p.id} className="text-xs">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.dot}`} />
                <span className="truncate flex-1">{p.name}</span>
                <span
                  className={`font-mono shrink-0 cursor-help ${overMax ? "text-rose-500" : pass ? "text-gray-400" : byRoom ? "text-violet-700" : "text-sky-700"}`}
                  title={overMax
                    ? "Suggested bid is above the max you can afford while filling your roster"
                    : pass
                    ? "He doesn't improve your best reachable roster at any price you'd have to pay — skip him."
                    : byRoom
                    ? `Capped by the room's money: no opponent can bid more than $${bid - 1}, so you never have to pay above $${bid} no matter what he's worth. This is what the room CAN pay, not what it wants to — a hard upper bound that tightens as budgets drain.`
                    : belowMarket
                    ? `Your real ceiling: the most you can pay and still end up with a roster at least as good as if you skipped him. He's worth pursuing at this price — the market (~$${market}) is likely to take him higher, so treat this as your walk-away point, not a price you're favored to win at.`
                    : "Allocation ceiling: the most you can pay and still end up with a roster at least as good as if you skipped him — reserves a realistic price for every remaining starter, not $1."}
                >
                  {pass ? "pass" : `bid $${bid}${byRoom ? "*" : belowMarket ? "~" : ""}`}
                </span>
              </div>
              <div className="pl-3.5 text-2xs text-gray-400 font-mono">
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
        {valueTargets.length === 0 && <div className="text-xs text-gray-400">No value targets.</div>}
      </div>

      <div className="mt-2 pt-2 border-t border-gray-200 flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 text-gray-400"><TrendingUp className="w-3 h-3" /> inflation</span>
        <span
          className={`font-mono cursor-help ${factor > 1.05 ? "text-rose-500" : factor < 0.95 ? "text-emerald-600" : "text-gray-500"}`}
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

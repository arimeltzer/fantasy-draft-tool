/* =====================================================================
   SNAKE ENGINE — snake-specific pick scheduling and recommendations.

   Swap this file to upgrade the snake algorithm independently of auction.
   All shared VBD machinery (scoring, projectValue, valueBoard) lives in
   engine-core.js and is re-exported here for convenience.

   THE SNAKE PIPELINE:
     valueBoard() → pickScore(candidate, liveState) → ranked recommendations
     snakePicks() → pick-clock timing
   ===================================================================== */
import { DEFAULT_PARAMS } from "./engine-core.js";
import { byeClash } from "./bye-weeks.js";

export {
  DEFAULT_PARAMS, SCORING_PRESETS, DEFAULT_SCORING, defaultScoring, resolveScoring,
  points, ageMultiplier, projectPoints, projectValue, replacementRanks, valueBoard,
  rankByAdp,
} from "./engine-core.js";

/* ------------------------------------------------------------------ *
 * SNAKE-SPECIFIC PARAMS — ported from the offline research model.
 *
 * SLOT_DEFAULT is the config every draft slot uses. SLOTS is an empty
 * override map kept for reinstating a per-slot config that earns its
 * place on held-out evidence — the ten that used to live there did not
 * (roadmap 0.2; see the comment on SLOTS). Tune here.
 * ------------------------------------------------------------------ */
export const DEFAULT_SNAKE_PARAMS = {
  ...DEFAULT_PARAMS,

  teMinRound:  4,    // no TE1 before this round
  te2MinRound: 7,    // no TE2 before this round
  riskGateRounds:    3,     // block high-risk players in rounds 1..N
  riskGateThreshold: 0.60,  // risk >= this is "high risk"
  adpAbs:     12,    // ADP absolute-floor unit (slot-10 injury-year guard)
  adpAbsCeil: 25,    // floor applies to adp_rank <= this

  // Bye-week collision penalty. Deliberately SMALL: a bye clash is a real
  // cost (you field an empty starter slot for one week) but a tiny one next
  // to being wrong about a player for seventeen. These are set so that even a
  // pathological stack cannot flip a meaningfully better player — the cap is
  // ~1.5 VBD points on a 120-point back. Not fitted; there is no held-out
  // evidence behind them, and a bigger number would need some.
  byeClashStep: 0.04,   // per already-rostered starter sharing the bye
  byeClashMax:  0.12,   // hard cap on the total penalty

  // Survival urgency cap (roadmap 3.1 — SIMPLIFIED). Deliberately SMALL and
  // deliberately unfitted, same discipline as byeClashStep/Max above: this is
  // a capped multiplier, not a modeled quantity, so there is no sigma to
  // sweep and no held-out coefficient to justify a bigger number. 0.15 caps
  // the boost at +15% for a player expected to be gone before my next pick,
  // decaying linearly to 0 at a full round of margin.
  survivalUrgencyMax: 0.15,

  // Positional run discount (roadmap 3.2). Deliberately SMALL and unfitted,
  // same discipline as byeClashStep/Max and survivalUrgencyMax: at hotness=1
  // (every recent pick at this position, the most extreme case possible),
  // the ADP-implied margin shrinks by at most 30% — enough to turn a
  // marginal "safe" read into "urgent" for a player already close to that
  // line, not enough to manufacture urgency for one comfortably inside it.
  runMarginDiscount: 0.30,

  // The config every draft slot now uses — see SLOTS below for why there is
  // only one. Held-out simulation could not distinguish ten tuned configs from
  // this single shared one, so this is the whole per-slot strategy.
  SLOT_DEFAULT: {
    QB_MIN: 8, QB2_MIN: 9,
    WR_P1: 1.35, WR_P2: 1.25, WR_P3: 1.12, WR_P4: 1.06,
    ADP_W: 0.15, AGE29: 1.00, AGE31: 1.00, adpAbsActive: false,
  },

  /**
   * COLLAPSED — roadmap 0.2, and empty on purpose.
   *
   * This held ten per-draft-slot configs, ~10 parameters each, described as
   * "10-team grid-searched (2021-2025)". The search itself was never in this
   * repository, so 100 numbers could be trusted but not reproduced or audited.
   * `draft-sim.mjs` was built to test them the one way still available — out
   * of sample — by replaying identical leagues (common random numbers) and
   * changing only whether the agent used its per-slot config or this default:
   *
   *     2021-2025, where they were fitted : +10.67 pts, mean/SE 4.24
   *     2017-2020, held out               : + 2.53 pts, mean/SE 1.16
   *
   * Better exactly where they were tuned, indistinguishable from noise
   * everywhere else. The gap between those two numbers is the overfitting:
   * five seasons of draft-to-draft variance carried forward as though it were
   * draft-position strategy.
   *
   * Note the held-out mean is still nominally positive, so the finding is NOT
   * "these hurt you" — it is "they buy nothing measurable while costing 100
   * unverifiable parameters", and parsimony decides it.
   *
   * The MECHANISM is kept, not deleted: `resolveSlotConfig` still consults
   * this map first, so a per-slot config can be reinstated the moment one
   * earns its place on held-out evidence. What was removed is unvalidated
   * values, not the ability to have values.
   *
   * Consequence worth knowing: `adpAbsActive` was true only for slot 10, so
   * the ADP absolute floor (`adpAbs` / `adpAbsCeil` below) is now inert
   * everywhere. Those params are left in place because the gate they feed is
   * still wired; they simply have nothing turning them on.
   */
  SLOTS: {},
};

/** Resolve the slot config: exact per-slot for 10-team, else the generic fallback. */
export function resolveSlotConfig(P, teams, slot) {
  if (teams === 10 && slot && P.SLOTS[slot]) return P.SLOTS[slot];
  return P.SLOT_DEFAULT;
}

/**
 * How many of a position are worth rostering at all.
 *
 * The old rule gave EVERY position a two-deep bench allowance (`starter + 2`),
 * which is right for the positions you actually carry depth at and nonsense for
 * the ones you don't. In a one-QB league that made a third quarterback score
 * 0.88 — identical "worth drafting for depth" credit to a third running back —
 * and nothing ever blocked a fourth. Watching the recommender hand out three
 * QBs and three TEs ahead of startable skill players is what surfaced it.
 *
 * A backup at a one-starter position only plays when the starter is hurt, and a
 * third never plays at all. Depth is worth real points at RB/WR, where byes and
 * injuries are covered every week and the FLEX gives a fourth or fifth body
 * somewhere to start.
 */
export function maxUseful(pos, roster = {}, superflex = false) {
  const starters = roster[pos] || 0;
  if (pos === "K" || pos === "DST") return Math.max(1, starters);   // never benched
  if (pos === "QB") return starters + (superflex ? 2 : 1);
  if (pos === "TE") return starters + 1;
  // RB/WR are bounded only by the bench itself. A fixed allowance here would
  // block a perfectly sensible sixth running back in a deep-bench league, and
  // the runaway this cap exists to stop is a one-starter position, not these.
  return starters + (roster.FLEX || 0) + Math.max(2, roster.BENCH || 6);
}

function needMult(pos, have, roster, needs, flexEligible, superflex) {
  if (have === 0) return 1.30;
  const belowStarter = (needs?.[pos] || 0) > 0 || (flexEligible && (needs?.FLEX || 0) > 0);
  if (belowStarter) return 1.15;
  if (have >= maxUseful(pos, roster, superflex)) return 0.65;   // full
  // Past the starters but still useful. Kept at the tuned 0.88 for the
  // positions that genuinely bank depth; a one-starter position's backup is
  // insurance, not depth, so it should not outrank a startable RB or WR.
  const insuranceOnly = (pos === "QB" && !superflex) || pos === "TE";
  return insuranceOnly ? 0.60 : 0.88;
}

/**
 * Score one candidate for the next snake pick, given live draft state.
 * Ported from the offline model's pick_score() — steps applied in order.
 *
 * liveState = {
 *   round,          // MY current round (my picks made + 1)
 *   teams, slot,    // league size + my draft slot
 *   counts,         // { QB, RB, ... } my drafted counts per position
 *   roster,         // league roster config (starters per position)
 *   needs,          // computeNeeds() output (starter shortfalls incl. FLEX)
 *   bestVbd,        // best available VBD (urgency gate + tier cliff)
 *   posRemaining,   // { pos: # available with vbd>0 }
 *   adpRankById,    // { id: adp rank } from rankByAdp(board)
 *   poolSize,       // # available players
 * }
 *
 * Returns { score, reasons[], blocked? }. Blocked candidates get -Infinity.
 */
export function pickScore(player, liveState, P = DEFAULT_SNAKE_PARAMS) {
  const s = liveState;
  const cfg = resolveSlotConfig(P, s.teams, s.slot);
  const pos = player.pos;
  const round = s.round || 1;
  const have = (s.counts && s.counts[pos]) || 0;
  const flexEligible = pos === "RB" || pos === "WR" || pos === "TE";
  const adpRank = (s.adpRankById && s.adpRankById[player.id]) || (s.poolSize + 1);
  const superflex = !!s.superflex;
  const reasons = [];

  // 2. Hard gates (positional discipline)
  // Roster capacity first: no round makes an unrosterable body the right pick.
  // Without this the only thing discouraging a third QB was a soft multiplier,
  // which a high-VBD quarterback simply out-scored.
  const cap = maxUseful(pos, s.roster || {}, superflex);
  if (have >= cap) return { score: -Infinity, blocked: `enough ${pos} (${have})` };
  if (pos === "QB" && have === 0 && round < cfg.QB_MIN) return { score: -Infinity, blocked: "QB too early" };
  if (pos === "QB" && have >= 1 && round < cfg.QB2_MIN) return { score: -Infinity, blocked: "QB2 too early" };
  if (pos === "TE" && have === 0 && round < P.teMinRound) return { score: -Infinity, blocked: "TE too early" };
  if (pos === "TE" && have >= 1 && round < P.te2MinRound) return { score: -Infinity, blocked: "TE2 too early" };
  if (round <= P.riskGateRounds && (player.risk || 0) >= P.riskGateThreshold)
    return { score: -Infinity, blocked: "high risk early" };

  // 1. Base = vbd × need_mult
  const nm = needMult(pos, have, s.roster || {}, s.needs, flexEligible, superflex);
  let base = player.vbd * nm;
  if (nm >= 1.30) reasons.push(`no ${pos} yet`);
  else if (nm >= 1.15) reasons.push(`fills ${pos}`);

  // 3. Scarcity signal
  if (["QB", "RB", "WR", "TE"].includes(pos)) {
    const posRem = (s.posRemaining && s.posRemaining[pos]) || 0;
    const cliff = (s.cliffById && s.cliffById[player.id]) || 0;
    if (posRem < 2) { base *= Math.min(1.25, 1.10 + cliff / 800); reasons.push(`${pos} nearly gone`); }
    else if (posRem < 4) { base *= 1.08; reasons.push(`${pos} thinning`); }
  }

  // 4. Roster urgency (additive, rounds 3+, VBD-gated)
  if (round >= 3 && player.vbd >= 0.65 * (s.bestVbd || 1)) {
    if ((pos === "RB" || pos === "WR") && (s.needs?.[pos] || 0) > 0) {
      base += Math.min(80, (round - 2) * 20); reasons.push(`need ${pos} starter`);
    } else if ((pos === "QB" || pos === "TE") && round >= 6 && (s.needs?.[pos] || 0) > 0) {
      base += Math.min(40, (round - 5) * 8); reasons.push(`need ${pos}`);
    }
  }

  // 5. WR era premium (rounds 1-9)
  if (pos === "WR") {
    if (round <= 3) {
      if (adpRank <= 12) base *= cfg.WR_P1;
      else if (adpRank <= 24) base *= cfg.WR_P2;
      else if (adpRank <= 48) base *= cfg.WR_P3;
      else if (adpRank <= 72) base *= cfg.WR_P4;
    } else if (round <= 6) {
      if (adpRank <= 24) base *= 1.15;
      else if (adpRank <= 72) base *= 1.08;
    } else if (round <= 9) {
      if (adpRank <= 72) base *= 1.05;
    }
  }

  // 5b. WR age penalty
  if (pos === "WR" && player.age) {
    if (player.age >= 31) { base *= cfg.AGE31; if (cfg.AGE31 < 1) reasons.push("aging WR"); }
    else if (player.age >= 29) { base *= cfg.AGE29; if (cfg.AGE29 < 1) reasons.push("aging WR"); }
  }

  // 6. ADP tiebreaker (rounds 6-12)
  if (round >= 6 && round <= 12 && adpRank <= s.poolSize) {
    const adpPct = 1 - (adpRank - 1) / Math.max(1, s.poolSize);
    const adpSignal = player.vbd * nm * (0.5 + adpPct);
    base = (1 - cfg.ADP_W) * base + cfg.ADP_W * adpSignal;
  }

  // 6b. ADP absolute floor (slot 10, rounds 1-5) — injury-year projection guard
  if (cfg.adpAbsActive && round <= 5 && adpRank <= P.adpAbsCeil) {
    base = Math.max(base, (P.adpAbsCeil + 1 - adpRank) * P.adpAbs);
  }

  // 7. Late-round youth / momentum (rounds 10+)
  if (round >= 10) {
    const youth = player.age ? Math.max(0, (26 - player.age) * 0.015) : 0;
    const momentum = Math.max(-0.04, Math.min(0.08, (player.trend || 0) / 600));
    base *= (1 + youth + momentum);
    if (momentum > 0.02) reasons.push("trending up");
  }

  // 8. Bye-week collision.
  // Applied LAST, after the ADP blend in step 6 — that blend recomputes `base`
  // from a weighted average, so a penalty applied before it would be silently
  // diluted by (1 - ADP_W) rather than charged in full.
  // Only bites when the roster genuinely cannot cover the position that week;
  // see byeClash() for why "already have enough bodies" costs nothing.
  const bye = s.byeByTeam && player.team ? s.byeByTeam[player.team] : null;
  if (bye) {
    const clash = byeClash(
      bye,
      (s.rosterByesByPos && s.rosterByesByPos[pos]) || [],
      (s.roster && s.roster[pos]) || 0,
      { step: P.byeClashStep, max: P.byeClashMax },
    );
    if (clash.mult < 1) {
      base *= clash.mult;
      reasons.push(`bye wk ${bye} clash (${clash.sharing + 1} ${pos}s)`);
    }
  }

  // 9. Survival margin (roadmap 3.1 — SIMPLIFIED; see survival.js header).
  // "Will he last to my next pick" answered as a deterministic pick-count
  // margin, not a modeled probability: margin = adpRank - nextPick. adpRank
  // approximates the overall pick where the market expects him gone, so a
  // LARGE adpRank relative to nextPick means the market has him lasting well
  // past my next turn (safe, no urgency); a SMALL or negative margin means
  // the market expects him gone before I pick again (urgent). `teams` is the
  // natural unit — one full round of cushion is the point past which "wait a
  // round" stops being a real option in a snake draft, so margin is read as
  // a fraction of a round, capped at 1.
  //
  // A capped-multiplier read, matching how needMult/byeClash already scale
  // `base` rather than adding a separately-weighted term — keeps this in the
  // same units as steps 1/8 instead of introducing a new scale to tune.
  //
  // Positional run discount (roadmap 3.2, see positional-run.js). A run
  // shrinks the trust placed in adpRank's cushion BEFORE the margin logic
  // runs: adpRank describes normal pace, and a run is the room demonstrating
  // it isn't drafting at normal pace right now. `s.runHotByPos` is computed
  // ONCE per pick by the caller (same pattern as posRemaining/needs), not
  // per-candidate — it is a property of the whole recent pick log, not of
  // one player. Capped at runMarginDiscount, same unfitted-constant
  // discipline as every other multiplier here.
  if (s.teams && Number.isFinite(s.nextPick) && adpRank <= s.poolSize) {
    let marginRounds = (adpRank - s.nextPick) / s.teams;
    const hot = (s.runHotByPos && s.runHotByPos[pos]) || 0;
    if (hot > 0) marginRounds *= (1 - P.runMarginDiscount * hot);
    if (marginRounds < 1) {
      const urgency = 1 + P.survivalUrgencyMax * Math.min(1, Math.max(0, 1 - marginRounds));
      base *= urgency;
      if (marginRounds < 0) reasons.push("won't last");
      if (hot > 0.5) reasons.push(`${pos} run`);
    }
  }

  // "last of tier" note when there's a big VBD cliff to the next at this position
  if ((s.cliffById && s.cliffById[player.id] || 0) > 18) reasons.push("last of tier");

  return { score: base, reasons };
}

/* ------------------------------------------------------------------ *
 * PICK SCHEDULE — which overall picks belong to a given draft slot
 * ------------------------------------------------------------------ */
export function snakePicks(slot, teams, rounds = 18) {
  const out = [];
  for (let r = 1; r <= rounds; r++)
    out.push(r % 2 === 1 ? (r - 1) * teams + slot : r * teams - slot + 1);
  return out;
}

/**
 * The overall pick numbers YOU actually own — the single source of truth for
 * pick timing and for what a keeper costs you.
 *
 * Serpentine order is only the default. Leagues trade picks, which breaks the
 * assumption that a draft slot determines your picks: you can hold two picks in
 * one round and none in another. When `settings.myPicks` is set it wins
 * outright, so a traded-pick league gets correct keeper costs and pick-clock
 * timing instead of a tidy formula that happens to be wrong.
 */
export function myPickNumbers(settings = {}, rounds = 18) {
  const override = settings.myPicks;
  if (Array.isArray(override) && override.length) {
    return [...new Set(override.filter((n) => Number.isFinite(n) && n > 0))]
      .sort((a, b) => a - b);
  }
  return snakePicks(settings.draftSlot ?? 1, settings.teams ?? 12, rounds);
}

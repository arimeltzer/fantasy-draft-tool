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

export {
  DEFAULT_PARAMS, SCORING_PRESETS, defaultScoring,
  points, ageMultiplier, projectPoints, projectValue, replacementRanks, valueBoard,
  rankByAdp,
} from "./engine-core.js";

/* ------------------------------------------------------------------ *
 * SNAKE-SPECIFIC PARAMS — ported from the offline research model.
 *
 * SLOTS holds the grid-searched per-draft-slot configs for a 10-team
 * league; SLOT_DEFAULT is the generic fallback for other league sizes
 * or when the draft slot is unknown. Tune here.
 * ------------------------------------------------------------------ */
export const DEFAULT_SNAKE_PARAMS = {
  ...DEFAULT_PARAMS,

  teMinRound:  4,    // no TE1 before this round
  te2MinRound: 7,    // no TE2 before this round
  riskGateRounds:    3,     // block high-risk players in rounds 1..N
  riskGateThreshold: 0.60,  // risk >= this is "high risk"
  adpAbs:     12,    // ADP absolute-floor unit (slot-10 injury-year guard)
  adpAbsCeil: 25,    // floor applies to adp_rank <= this

  // Generic config (non-10-team, or unknown slot): slot-1-like baseline.
  SLOT_DEFAULT: {
    QB_MIN: 8, QB2_MIN: 9,
    WR_P1: 1.35, WR_P2: 1.25, WR_P3: 1.12, WR_P4: 1.06,
    ADP_W: 0.15, AGE29: 1.00, AGE31: 1.00, adpAbsActive: false,
  },

  // 10-team grid-searched configs (2021–2025). WR tiers:
  //   baseline 1.35/1.25/1.12/1.06 · heavy 1.50/1.35/1.18/1.08 · max 1.60/1.40/1.20/1.10
  SLOTS: {
    1:  { QB_MIN: 7, QB2_MIN: 10, WR_P1: 1.35, WR_P2: 1.25, WR_P3: 1.12, WR_P4: 1.06, ADP_W: 0.15, AGE29: 1.00, AGE31: 1.00, adpAbsActive: false },
    2:  { QB_MIN: 8, QB2_MIN: 9,  WR_P1: 1.35, WR_P2: 1.25, WR_P3: 1.12, WR_P4: 1.06, ADP_W: 0.15, AGE29: 1.00, AGE31: 1.00, adpAbsActive: false },
    3:  { QB_MIN: 8, QB2_MIN: 9,  WR_P1: 1.35, WR_P2: 1.25, WR_P3: 1.12, WR_P4: 1.06, ADP_W: 0.15, AGE29: 1.00, AGE31: 1.00, adpAbsActive: false },
    4:  { QB_MIN: 7, QB2_MIN: 9,  WR_P1: 1.60, WR_P2: 1.40, WR_P3: 1.20, WR_P4: 1.10, ADP_W: 0.05, AGE29: 0.90, AGE31: 0.82, adpAbsActive: false },
    5:  { QB_MIN: 8, QB2_MIN: 9,  WR_P1: 1.60, WR_P2: 1.40, WR_P3: 1.20, WR_P4: 1.10, ADP_W: 0.15, AGE29: 0.90, AGE31: 0.82, adpAbsActive: false },
    6:  { QB_MIN: 8, QB2_MIN: 9,  WR_P1: 1.35, WR_P2: 1.25, WR_P3: 1.12, WR_P4: 1.06, ADP_W: 0.15, AGE29: 0.90, AGE31: 0.82, adpAbsActive: false },
    7:  { QB_MIN: 7, QB2_MIN: 9,  WR_P1: 1.50, WR_P2: 1.35, WR_P3: 1.18, WR_P4: 1.08, ADP_W: 0.15, AGE29: 1.00, AGE31: 1.00, adpAbsActive: false },
    8:  { QB_MIN: 7, QB2_MIN: 9,  WR_P1: 1.35, WR_P2: 1.25, WR_P3: 1.12, WR_P4: 1.06, ADP_W: 0.15, AGE29: 1.00, AGE31: 1.00, adpAbsActive: false },
    9:  { QB_MIN: 7, QB2_MIN: 9,  WR_P1: 1.35, WR_P2: 1.25, WR_P3: 1.12, WR_P4: 1.06, ADP_W: 0.15, AGE29: 1.00, AGE31: 1.00, adpAbsActive: false },
    10: { QB_MIN: 7, QB2_MIN: 9,  WR_P1: 1.35, WR_P2: 1.25, WR_P3: 1.12, WR_P4: 1.06, ADP_W: 0.15, AGE29: 1.00, AGE31: 1.00, adpAbsActive: true },
  },
};

/** Resolve the slot config: exact per-slot for 10-team, else the generic fallback. */
export function resolveSlotConfig(P, teams, slot) {
  if (teams === 10 && slot && P.SLOTS[slot]) return P.SLOTS[slot];
  return P.SLOT_DEFAULT;
}

function needMult(pos, have, roster, needs, flexEligible) {
  if (have === 0) return 1.30;
  const belowStarter = (needs?.[pos] || 0) > 0 || (flexEligible && (needs?.FLEX || 0) > 0);
  if (belowStarter) return 1.15;
  const starter = roster?.[pos] || 0;
  if (have < starter + 2) return 0.88;   // filling bench
  return 0.65;                            // full
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
  const reasons = [];

  // 2. Hard gates (positional discipline)
  if (pos === "QB" && have === 0 && round < cfg.QB_MIN) return { score: -Infinity, blocked: "QB too early" };
  if (pos === "QB" && have >= 1 && round < cfg.QB2_MIN) return { score: -Infinity, blocked: "QB2 too early" };
  if (pos === "TE" && have === 0 && round < P.teMinRound) return { score: -Infinity, blocked: "TE too early" };
  if (pos === "TE" && have >= 1 && round < P.te2MinRound) return { score: -Infinity, blocked: "TE2 too early" };
  if (round <= P.riskGateRounds && (player.risk || 0) >= P.riskGateThreshold)
    return { score: -Infinity, blocked: "high risk early" };

  // 1. Base = vbd × need_mult
  const nm = needMult(pos, have, s.roster || {}, s.needs, flexEligible);
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

export * from "./engine-core.js";

import type { EngineParams, BoardPlayer } from "./engine-core.js";

export interface SlotConfig {
  QB_MIN: number; QB2_MIN: number;
  WR_P1: number; WR_P2: number; WR_P3: number; WR_P4: number;
  ADP_W: number; AGE29: number; AGE31: number;
  adpAbsActive: boolean;
}

export interface SnakeParams extends EngineParams {
  teMinRound: number;
  te2MinRound: number;
  riskGateRounds: number;
  riskGateThreshold: number;
  adpAbs: number;
  adpAbsCeil: number;
  byeClashStep: number;
  byeClashMax: number;
  /** roadmap 3.1 — capped urgency boost when adpRank-nextPick margin is thin. */
  survivalUrgencyMax: number;
  /** roadmap 3.2 — max shrink of that margin when the position is running hot. */
  runMarginDiscount: number;
  SLOT_DEFAULT: SlotConfig;
  SLOTS: Record<number, SlotConfig>;
}

export interface SnakeLiveState {
  round: number;
  teams: number;
  slot?: number;
  counts: Record<string, number>;
  /** Two QB-ish starting spots, so more quarterbacks are worth rostering. */
  superflex?: boolean;
  roster: Record<string, number>;
  needs: Record<string, number>;
  bestVbd: number;
  posRemaining: Record<string, number>;
  adpRankById: Record<number, number>;
  cliffById?: Record<number, number>;
  poolSize: number;
  /** Team -> bye week, derived from the schedule (a missing week IS the bye). */
  byeByTeam?: Record<string, number | null>;
  /** Byes of the players already on MY roster, grouped by position. */
  rosterByesByPos?: Record<string, (number | null)[]>;
  /** Roadmap 2.4, gate-cleared (mean/SE 2.83 deployment, 4.23 isolation over
   *  1,800 replayed drafts — see docs/ROADMAP.md 2.4). When present, REPLACES
   *  the byeClash step entirely rather than adding to it: a deterministic
   *  week-by-week lineup value multiplier (bye-lineup-value.js
   *  byeLineupMult), scored on REALIZED outcomes in the gate that validated
   *  it, in place of byeClash's collision heuristic. Absent = byeClash runs
   *  as before, so a caller that hasn't wired real roster data through this
   *  degrades to the prior, still-correct behaviour rather than guessing. */
  byeLineupMultFor?: (player: BoardPlayer) => number;
  /** roadmap 3.1 — the overall pick number I next get to act on. Absent
   *  disables the survival margin entirely (opt-in by presence). */
  nextPick?: number;
  /** roadmap 3.2 — per-position run hotness in [0,1], from positional-run.js
   *  runHotness() over the recent pick log. Absent = no discount applied. */
  runHotByPos?: Record<string, number>;
}

export interface PickScoreResult {
  score: number;
  reasons: string[];
  blocked?: string;
}

export declare const DEFAULT_SNAKE_PARAMS: SnakeParams;

export declare function resolveSlotConfig(P: SnakeParams, teams: number, slot?: number): SlotConfig;
export declare function pickScore(
  player: BoardPlayer, liveState: SnakeLiveState, P?: SnakeParams
): PickScoreResult;
/** How many of a position are worth rostering, given starters + FLEX. */
export declare function maxUseful(
  pos: string, roster?: Record<string, number>, superflex?: boolean,
): number;
export declare function snakePicks(slot: number, teams: number, rounds?: number): number[];
/** Overall pick numbers you own: `settings.myPicks` when set (traded picks),
 *  otherwise serpentine from `draftSlot`. */
export declare function myPickNumbers(
  settings: { teams?: number; draftSlot?: number; myPicks?: number[] },
  rounds?: number,
): number[];

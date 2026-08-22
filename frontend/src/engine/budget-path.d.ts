import type { BoardPlayer } from "./engine-core.js";

export declare const FLEX_ELIGIBLE: readonly ["RB", "WR", "TE"];
export declare const DP_POSITIONS: readonly ["QB", "RB", "WR", "TE"];
export declare const TOP_K_PER_POS: number;

export interface ReachableRoster<T = BoardPlayer> {
  feasible: boolean;
  /** Total value of the best still-fillable roster. */
  value: number;
  /** The players making it up — one per slot when feasible. */
  picks: T[];
  /** Dollars actually allocated; leftover under budget is legitimate. */
  spend: number;
}

export declare function flexDistributions(
  n: number,
): { RB: number; WR: number; TE: number }[];

/** Which starting slots are still open, plus how many bench/K/DST spots
 *  still need a minimum bid reserved. */
export declare function remainingStartingSlots(
  roster?: Record<string, number>,
  myPlayers?: { pos?: string }[],
): { slots: string[]; reserveSpots: number };

export declare const BACKUP_BOOST_MULT: number;
export declare const BACKUP_BOOST_POSITIONS: string[];

/** Bench-phase "one strong backup" ceiling nudge for QB/RB/WR — returns
 *  BACKUP_BOOST_MULT when `have` is exactly at the starter count (zero bench
 *  bodies at this position yet), 1 otherwise. */
export declare function firstBackupBoost(
  pos: string,
  have: number,
  roster?: Record<string, number>,
): number;

export declare function reachableRoster<T = BoardPlayer>(args: {
  slots: string[];
  budget: number;
  pool: T[];
  valueOf: (p: T) => number;
  priceOf: (p: T) => number;
}): ReachableRoster<T>;

/** Most you can pay for `player` and be no worse off than skipping him.
 *  Runs a DP per probe — call for the player on the block and the few
 *  shown, never mapped across a full board. */
export declare function bidCeiling<T = BoardPlayer>(args: {
  player: T;
  slots: string[];
  budget: number;
  pool: T[];
  valueOf: (p: T) => number;
  priceOf: (p: T) => number;
  minBid?: number;
}): number;

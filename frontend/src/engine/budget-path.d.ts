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

/** Roadmap 3.7 — this room's historical bench-tier price per position, from
 *  stored prior drafts' picks near the league's first-backup rank in
 *  nomination order. `usable: false` (the common case — most leagues import
 *  1-2 seasons) means every position fell back to $1. */
export declare const BENCH_WINDOW: number;
export declare const BENCH_RESERVE_MIN_PICKS: number;
export declare const BENCH_RESERVE_SHRINK_K0: number;

export interface HistoricalBenchReserve {
  reserve: Record<string, number>;
  usable: boolean;
  sample: Record<string, number>;
  notes: string[];
}

export declare function historicalBenchReserve(
  draftPicks: { pos?: string; bid?: number | null; overall?: number | null; season?: number }[] | null | undefined,
  league?: { teams?: number; roster?: Record<string, number> },
): HistoricalBenchReserve;

/** The starter-phase reserve in real dollars — today's flat $1/slot with the
 *  first still-missing QB/RB/WR backup upgraded to its historical-anchor
 *  price, capped by how many reserve slots are actually left to spend it on. */
export declare function benchReserveDollars(
  roster?: Record<string, number>,
  myPlayers?: { pos?: string }[],
  reserveSpots?: number,
  historical?: Record<string, number>,
): number;

/** Roadmap 3.8 — positions eligible for the joint last-starter + bench
 *  slot (2+-starter positions only, derived from `roster`). */
export declare function bonusBackupPositions(roster?: Record<string, number>): string[];

/** Roadmap 3.8 — appends one bonus, position-locked slot per qualifying
 *  position exactly while `have[pos] === 1` (about to buy the LAST
 *  starter). Pass the result to `bidCeiling`'s `slots`; keep using the
 *  true `openStartSlots.length` for the DP-vs-bench phase switch. */
export declare function withBonusBackupSlots(
  slots: string[],
  roster?: Record<string, number>,
  myPlayers?: { pos?: string }[],
): string[];

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

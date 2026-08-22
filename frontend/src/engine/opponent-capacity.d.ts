/** What each opponent could bid on one player right now: their money minus a
 *  reserve for every slot they still have to fill. 0 for a full roster. */
export declare function opponentCapacities(
  budgets?: number[],
  openSpots?: number[],
  minBid?: number,
): number[];

/** Most any player can sell for — one increment above the richest opponent.
 *  Floors at minBid. Pure arithmetic: this bound cannot be beaten. */
export declare function priceCeiling(capacities?: number[], minBid?: number): number;

/** Extra bodies past the starters an opponent plausibly rosters, by position. */
export declare const OPP_BENCH_ALLOWANCE: Record<string, number>;
/** Positions nobody rosters more than one of, whatever the settings claim. */
export declare const SINGLETON_POSITIONS: readonly ["K", "DST"];

/** How many more at `pos` an opponent would plausibly still take. 0 means
 *  they are out of that market and cannot bid there. */
export declare function opponentDemand(
  pos: string,
  leagueRoster?: Record<string, number>,
  theirCounts?: Record<string, number>,
  superflex?: boolean,
): number;

/** Position-aware ceiling (roadmap 3.4a): only opponents who still need the
 *  position count. WEAKER than `priceCeiling` — it adds a behavioural
 *  assumption, so `arithmetic` is returned alongside as the hard bound. */
export declare function priceCeilingFor(
  pos: string,
  args?: {
    budgets?: number[];
    openSpots?: number[];
    counts?: Record<string, number>[];
    leagueRoster?: Record<string, number>;
    superflex?: boolean;
    minBid?: number;
  },
): { ceiling: number; arithmetic: number; gated: boolean; bidders: number };

/** Cap an expected price by what the room can actually pay. `capped` marks
 *  the point where money, not value, is setting the price. */
export declare function cappedPrice(
  market: number,
  capacities?: number[],
  minBid?: number,
): { price: number; ceiling: number; capped: boolean };

/** Compose 3.3's allocation ceiling with 3.4's room ceiling AND the bidder's
 *  own remaining cash, reporting which constraint binds.
 *
 *  `budgetCeiling` is `maxBid(budgetLeft, openSpots)` — everything you hold
 *  minus the $1 each remaining slot still needs. Omit it and the composition
 *  behaves exactly as before it existed. */
export declare function bindingCeiling(args: {
  allocationCeiling?: number;
  budgetCeiling?: number;
  capacities?: number[];
  minBid?: number;
}): { bid: number; binding: "allocation" | "opponents" | "budget" | "none" };

/** Per-opponent positional counts from the pick log. Extracted into the
 *  engine so the derivation is directly testable. */
export declare function opponentCountsFromPicks(
  picks?: { mine?: boolean; teamId?: number | null; playerId?: number | null }[],
  posById?: Map<number, string> | Record<number, string>,
  nOpponents?: number,
): Record<string, number>[];

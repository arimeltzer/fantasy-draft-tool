/** What each opponent could bid on one player right now: their money minus a
 *  reserve for every slot they still have to fill. 0 for a full roster. */
export declare function opponentCapacities(
  budgets?: number[],
  openSpots?: number[],
  minBid?: number,
): number[];

/** Most any player can sell for — one increment above the richest opponent.
 *  Floors at minBid. */
export declare function priceCeiling(capacities?: number[], minBid?: number): number;

/** Cap an expected price by what the room can actually pay. `capped` marks
 *  the point where money, not value, is setting the price. */
export declare function cappedPrice(
  market: number,
  capacities?: number[],
  minBid?: number,
): { price: number; ceiling: number; capped: boolean };

/** Compose 3.3's allocation ceiling with 3.4's room ceiling, reporting which
 *  constraint binds. */
export declare function bindingCeiling(args: {
  allocationCeiling?: number;
  capacities?: number[];
  minBid?: number;
}): { bid: number; binding: "allocation" | "opponents" | "none" };

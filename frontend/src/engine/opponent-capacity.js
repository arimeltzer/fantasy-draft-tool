/* =====================================================================
   OPPONENT CAPACITY — roadmap 3.4. "A price is set by the second bidder.
   If only two teams can afford $50, that is the cap."

   THE CORE MOVE IS SMALL AND DELIBERATE: `auction-engine.js` already exports
   `maxBid(budget, openSpots)`, and the room already applies it to ME. This
   applies it to everyone else. Raw remaining budget is the wrong quantity —
   an opponent holding $180 with fifteen slots still to fill cannot bid $180
   on anything, because a dollar has to survive for every remaining spot.
   Using raw budget would overstate what the room can pay, and would do it
   worst exactly mid-draft, where the number would matter most.

   CAPACITY, NOT WILLINGNESS — and that distinction is the honesty of this
   module. It reports what the room CAN pay, never what it WANTS to pay. An
   opponent sitting on $90 who has no need at running back will not bid on
   your running back, and this still counts their $90. So:

     - As an UPPER BOUND it is hard. Money that does not exist cannot be bid,
       so no player sells above `bestOpponentCapacity + minBid` no matter how
       badly anyone wants him.
     - As a POINT ESTIMATE it is biased high, increasingly so as opponents
       fill their needs.

   Consequently the only sanctioned use is CAPPING an expected price
   (`min(market, ceiling)`). Capping can only move a price down toward
   something genuinely unpayable — the safe direction. Predicting that a
   player will go cheap because nobody WANTS him is not attempted here and
   would need a model of opponent need this module deliberately does not have.
   ===================================================================== */
import { maxBid } from "./auction-engine.js";

/**
 * What each opponent could bid on a single player right now.
 *
 * Routed through the shipped `maxBid` rather than reimplementing the reserve
 * arithmetic, so my side and their side cannot drift apart about what a
 * budget can buy.
 *
 * @param budgets    remaining dollars per opponent.
 * @param openSpots  remaining roster slots per opponent, same order. A team
 *                   with none is full and cannot bid at all.
 * @param minBid     league minimum bid.
 * @returns number[] — capacity per opponent, 0 for a team that cannot bid.
 */
export function opponentCapacities(budgets = [], openSpots = [], minBid = 1) {
  return budgets.map((budget, i) => {
    const spots = openSpots[i] ?? 0;
    // A full roster cannot absorb another player at any price. maxBid would
    // happily return a positive number here (it floors at minBid), so this
    // has to be caught before it, not after.
    if (spots <= 0) return 0;
    if (!Number.isFinite(budget) || budget < minBid) return 0;
    return Math.max(0, maxBid(budget, spots, minBid));
  });
}

/**
 * The most any single player can sell for, given what the room can afford.
 *
 * One increment above the richest opponent: I win by outbidding the best
 * anyone else can do. Returns `minBid` when nobody can bid at all — the
 * floor, not zero, because a player still costs the minimum.
 */
export function priceCeiling(capacities = [], minBid = 1) {
  const top = capacities.reduce((m, c) => Math.max(m, c || 0), 0);
  return Math.max(minBid, top + minBid);
}

/**
 * Cap an expected price by what the room can actually pay.
 *
 * @returns { price, ceiling, capped } — `capped` true when the room's money,
 *          not the player's market value, is what sets the price. That flag
 *          is the interesting part: it marks the moment the draft stops
 *          being about value and starts being about who has cash left.
 */
export function cappedPrice(market, capacities = [], minBid = 1) {
  const ceiling = priceCeiling(capacities, minBid);
  const m = Number.isFinite(market) ? market : minBid;
  const price = Math.max(minBid, Math.min(m, ceiling));
  return { price, ceiling, capped: ceiling < m };
}

/**
 * Which constraint actually binds a bid: my own roster allocation (3.3) or
 * the room's ability to pay (3.4).
 *
 * Composing them is the point of building the two together — 3.3 answers
 * "what can I afford given what I still have to fill", 3.4 answers "what
 * will the room force me to pay". Neither alone is the actionable number.
 *
 * @returns { bid, binding } where `binding` is "allocation" | "opponents"
 *          | "none". Naming the binding constraint is more useful than the
 *          number alone: it is the difference between "I can't afford him"
 *          and "I don't have to pay that much".
 */
export function bindingCeiling({ allocationCeiling, capacities = [], minBid = 1 }) {
  const roomCeiling = priceCeiling(capacities, minBid);
  const alloc = Number.isFinite(allocationCeiling) ? allocationCeiling : Infinity;

  // Allocation ceiling of 0 is a real verdict from 3.3 ("he does not improve
  // your best reachable roster at any price"), not a missing value — it must
  // win, and must not be read as "unconstrained".
  if (alloc <= 0) return { bid: 0, binding: "allocation" };

  if (alloc <= roomCeiling) {
    return { bid: alloc, binding: Number.isFinite(allocationCeiling) ? "allocation" : "none" };
  }
  return { bid: roomCeiling, binding: "opponents" };
}

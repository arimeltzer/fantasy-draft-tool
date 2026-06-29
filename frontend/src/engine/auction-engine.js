/* =====================================================================
   AUCTION ENGINE — auction-specific valuation and live inflation.

   Swap this file to upgrade the auction algorithm independently of snake.
   All shared VBD machinery (scoring, projectValue, valueBoard) lives in
   engine-core.js and is re-exported here for convenience.

   THE AUCTION PIPELINE:
     valueBoard() → auctionValues() → applyInflation() → live $ per player
   ===================================================================== */
import { DEFAULT_PARAMS } from "./engine-core.js";

export {
  DEFAULT_PARAMS, SCORING_PRESETS, defaultScoring,
  points, ageMultiplier, projectValue, replacementRanks, valueBoard,
} from "./engine-core.js";

/* ------------------------------------------------------------------ *
 * AUCTION-SPECIFIC PARAMS — extend DEFAULT_PARAMS with auction knobs.
 * This is the object to tune when optimizing the auction algorithm.
 * ------------------------------------------------------------------ */
export const DEFAULT_AUCTION_PARAMS = {
  ...DEFAULT_PARAMS,
  auction: {
    minBid: 1, // floor bid; every drafted player costs at least this
  },
};

/* ------------------------------------------------------------------ *
 * PAR VALUES — VBD → dollar values
 *
 * Discretionary dollars (above the $1 minimum bids) are distributed
 * among positive-VBD players in proportion to their VBD share.
 * ------------------------------------------------------------------ */
export function auctionValues(board, auctionLeague, P = DEFAULT_AUCTION_PARAMS) {
  const { teams, budget, rosterSize } = auctionLeague;
  const totalMoney = teams * budget;
  const totalSpots = teams * rosterSize;
  const min = P.auction.minBid;
  const discretionary = totalMoney - totalSpots * min;

  const pool = board.filter((p) => p.vbd > 0);
  const sumVBD = pool.reduce((s, p) => s + p.vbd, 0) || 1;

  return board.map((p) => {
    const par = p.vbd > 0 ? min + (p.vbd / sumVBD) * discretionary : min;
    return { ...p, parValue: Math.max(min, Math.round(par)) };
  });
}

/* ------------------------------------------------------------------ *
 * LIVE INFLATION — reprice remaining players as the draft progresses
 *
 * draftedPrices = [{ id, price }]  actual winning bids observed so far
 * Returns { factor, board: [...with adjValue], spent, remainingMoney, remainingSpots }
 * ------------------------------------------------------------------ */
export function applyInflation(boardWithPar, draftedPrices, auctionLeague, P = DEFAULT_AUCTION_PARAMS) {
  const { teams, budget, rosterSize } = auctionLeague;
  const min = P.auction.minBid;
  const totalMoney = teams * budget;
  const totalSpots = teams * rosterSize;

  const paidById = new Map(draftedPrices.map((d) => [d.id, d.price]));
  const spent = draftedPrices.reduce((s, d) => s + d.price, 0);
  const filledSpots = draftedPrices.length;

  const remainingMoney = totalMoney - spent;
  const remainingSpots = totalSpots - filledSpots;
  const remainingDiscretionary = remainingMoney - remainingSpots * min;

  const undrafted = boardWithPar.filter((p) => !paidById.has(p.id) && p.parValue > min);
  const remainingParDiscretionary = undrafted.reduce((s, p) => s + (p.parValue - min), 0) || 1;

  const factor = +(remainingDiscretionary / remainingParDiscretionary).toFixed(3);

  const board = boardWithPar.map((p) => {
    if (paidById.has(p.id)) return { ...p, paid: paidById.get(p.id), adjValue: null };
    const adj = p.parValue > min
      ? Math.max(min, Math.round(min + (p.parValue - min) * factor))
      : min;
    return { ...p, paid: null, adjValue: adj };
  });

  return { factor, board, spent, remainingMoney, remainingSpots };
}

/** Most you can bid and still fill your remaining roster spots at $1 each. */
export function maxBid(myBudgetLeft, myOpenSpots, minBid = 1) {
  return Math.max(minBid, myBudgetLeft - (myOpenSpots - 1) * minBid);
}

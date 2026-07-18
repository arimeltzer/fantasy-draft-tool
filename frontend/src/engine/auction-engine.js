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
  rankByAdp,
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

  // ── Ported strategy knobs (offline research model) ──────────────────────
  // Share of league discretionary money allocated to each position.
  POS_ALLOC:    { QB: 0.072, RB: 0.36, WR: 0.39, TE: 0.113, K: 0.015, DST: 0.015 },
  POS_ALLOC_14: { QB: 0.072, RB: 0.38, WR: 0.38, TE: 0.113, K: 0.015, DST: 0.015 },
  // Opponent price curve: market = LOG_A − LOG_B·ln(adpRank), LOG_B derived from picks.
  LOG_A: 55, LOG_A_14: 70,
  // Bid shaping
  ratioScaleBase: 0.70, ratioScaleSlope: 0.35, ratioScaleClamp: [0.50, 1.40],
  qbMarketCap: 0.90,        // QBs bid at most this × market (unless nearly out of spots)
  // Nomination strategy
  richBudgetThreshold: 40,  // an opponent with > this many $ is "rich"
  dumpRatio: 0.70,          // effective_dv < market × this → salary dump
  effectiveDvFloor: 0.50,   // effective_dv = max(dollarValue, market × this)
};

function posAlloc(P, teams) { return teams >= 14 ? P.POS_ALLOC_14 : P.POS_ALLOC; }
function logA(P, teams)     { return teams >= 14 ? P.LOG_A_14 : P.LOG_A; }

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

/* ==================================================================== *
 * PORTED AUCTION STRATEGY — dollar values, market prices, bids, noms
 * ==================================================================== */

/**
 * Position-allocation dollar values (alternative to parValue): each position's
 * share of league money is split among its positive-VBD players by VBD share.
 * Adds `dollarValue` to every board row.
 */
export function dollarValues(board, auctionLeague, P = DEFAULT_AUCTION_PARAMS) {
  const { teams, budget, rosterSize, benchSpots } = auctionLeague;
  const min = P.auction.minBid;
  const bench = benchSpots ?? Math.max(0, rosterSize - 9);
  const leagueAvail = teams * (budget - bench * min);
  const alloc = posAlloc(P, teams);

  const posSum = {};
  for (const p of board) if (p.vbd > 0) posSum[p.pos] = (posSum[p.pos] || 0) + p.vbd;

  return board.map((p) => {
    const posDollars = (alloc[p.pos] || 0) * leagueAvail;
    const share = p.vbd > 0 && posSum[p.pos] ? p.vbd / posSum[p.pos] : 0;
    const dollarValue = p.vbd > 0 ? Math.max(min, Math.round(share * posDollars)) : min;
    return { ...p, dollarValue };
  });
}

/**
 * Expected auction price for a player. Prefers real FantasyPros AAV (average
 * auction value) when available — it already reflects true market behavior
 * (recovery premiums, positional runs, etc.) that the modeled curve below can
 * only approximate. Falls back to the logarithmic ADP-rank curve otherwise
 * (e.g. deep sleepers/rookies FantasyPros hasn't priced, or no AAV pulled yet).
 */
export function marketPrice(adpRank, auctionLeague, P = DEFAULT_AUCTION_PARAMS, pos, aav) {
  const min = P.auction.minBid;
  // Trust AAV only when it's a plausible price: no player can cost more than
  // one team's whole budget. Anything above that is corrupted data (e.g. a
  // rank mis-parsed as a dollar figure) — ignore it and use the curve.
  if (aav != null && aav > 0 && aav <= auctionLeague.budget) {
    return Math.max(min, Math.round(aav));
  }
  if (!adpRank || adpRank < 1) return min;
  const { teams, rosterSize } = auctionLeague;
  const totalPicks = Math.max(2, teams * rosterSize);
  const A = logA(P, teams);
  const B = (A - 2) / Math.log(totalPicks);
  let price = A - B * Math.log(adpRank);
  if (pos === "WR" && teams >= 14) {
    if (adpRank <= 28) price *= 1.12;
    else if (adpRank <= 56) price *= 1.06;
  }
  return Math.max(min, Math.round(price));
}

/**
 * Fair-share bid suggestion for a player I want.
 * myState = { budget, openSpots, remainingDvSum, market }
 * Returns { bid, market, dollarValue, pass } — pass=true when bid < market
 * (the model never overpays; a pass means let it go at market).
 */
export function suggestBid(player, myState, P = DEFAULT_AUCTION_PARAMS) {
  const min = P.auction.minBid;
  const { budget, openSpots, remainingDvSum, market } = myState;
  const dv = player.dollarValue ?? min;

  const surplus = Math.max(0, budget - openSpots * min);
  const shareFrac = remainingDvSum > 0 ? dv / remainingDvSum : 0;
  const fairShare = surplus * shareFrac;

  const valueRatio = market > 0 ? dv / market : 1;
  const [lo, hi] = P.ratioScaleClamp;
  const ratioScale = Math.min(hi, Math.max(lo, P.ratioScaleBase + valueRatio * P.ratioScaleSlope));

  const hardMax = Math.max(min, budget - (openSpots - 1) * min);
  const ceil = Math.min(hardMax, Math.max(dv, market));
  let bid = Math.max(min, Math.min(ceil, Math.round(fairShare * ratioScale)));

  if (player.pos === "QB") {
    bid = openSpots <= 2
      ? Math.min(hardMax, market + 1)
      : Math.min(bid, Math.max(min, Math.round(market * P.qbMarketCap)));
  }

  return { bid, market, dollarValue: dv, pass: bid < market };
}

/**
 * Nomination priority score for one player.
 * draftState = { oppBudgets:number[], marketById:{id:$}, fractionDone:0..1 }
 * Returns { score, isDump, market, effectiveDv, richFrac }.
 * High score = nominate now; salary dumps peak while opponents are flush,
 * personal targets go negative until opponents are budget-poor.
 */
export function nominationScore(player, draftState, P = DEFAULT_AUCTION_PARAMS) {
  const min = P.auction.minBid;
  const dv = player.dollarValue ?? min;
  const market = (draftState.marketById && draftState.marketById[player.id]) ?? min;
  const effectiveDv = Math.max(dv, market * P.effectiveDvFloor);
  const isDump = effectiveDv < market * P.dumpRatio;

  const opp = draftState.oppBudgets || [];
  const nOpp = Math.max(1, opp.length);
  const richFrac = opp.filter((b) => b > P.richBudgetThreshold).length / nOpp;
  const budgetPoor = 1 - richFrac;
  const fractionDone = draftState.fractionDone ?? 0;
  const competitors = opp.filter((b) => b > min).length;

  const score = isDump
    ? (market - effectiveDv) * competitors * richFrac * (2 - fractionDone)
    : (effectiveDv - market) * (1 + budgetPoor * 2) - richFrac * market * 0.3;

  return { score, isDump, market, effectiveDv, richFrac };
}

/** Nomination phase from how many opponents are still flush. */
export function nominationPhase(richFrac) {
  if (richFrac > 0.60) return "early";
  if (richFrac >= 0.30) return "mid";
  return "late";
}

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

/** Positions a FLEX slot accepts — a team's FLEX need is demand at all three. */
const FLEX_ELIGIBLE = ["RB", "WR", "TE"];

/**
 * How many EXTRA bodies past the starting requirement a team plausibly
 * rosters at each position.
 *
 * Stated constants, unfitted — same discipline as `byeClashStep` and
 * `survivalUrgencyMax`. Deliberately generous rather than tight: gating a
 * position OFF wrongly is the expensive error (it tells you a player will go
 * cheap and then he does not), so when in doubt this assumes demand exists.
 *
 * NOT `maxUseful()` from snake-engine, deliberately. That returns
 * `starters + FLEX + max(2, BENCH)` for RB/WR — nine backs in a standard
 * league — because its job is to avoid BLOCKING a defensible sixth RB on my
 * own roster. Reusing it here would gate essentially nothing.
 */
export const OPP_BENCH_ALLOWANCE = { QB: 1, RB: 3, WR: 3, TE: 1, K: 0, DST: 0 };

/** Positions nobody rosters more than one of, whatever the settings claim. */
export const SINGLETON_POSITIONS = ["K", "DST"];

/**
 * How many more players at `pos` an opponent would plausibly still take.
 *
 * Zero means they are done at that position and cannot be a bidder there —
 * which is the entire point of 3.4a: a rich team with no need at a position
 * must not hold up that position's ceiling.
 *
 * @param pos           position being bid on.
 * @param leagueRoster  the league's roster requirements.
 * @param theirCounts   how many that team already owns, by position.
 * @param superflex     a second QB-ish starting slot changes QB demand.
 */
export function opponentDemand(pos, leagueRoster = {}, theirCounts = {}, superflex = false) {
  const have = theirCounts[pos] || 0;

  // K/DST are capped at exactly one, regardless of what the roster settings
  // say. A team that has its kicker is out of the kicker market entirely, and
  // treating it otherwise leaves a filled team alive as a phantom bidder.
  if (SINGLETON_POSITIONS.includes(pos)) return Math.max(0, 1 - have);

  const starters = (leagueRoster[pos] || 0) + (pos === "QB" && superflex ? 1 : 0);
  // FLEX is demand at every eligible position — the team can fill it with any
  // of them, so any of them can still attract a bid.
  const flex = FLEX_ELIGIBLE.includes(pos) ? (leagueRoster.FLEX || 0) : 0;
  const cap = starters + flex + (OPP_BENCH_ALLOWANCE[pos] ?? 0);
  return Math.max(0, cap - have);
}

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
 * Per-opponent positional counts, from the pick log.
 *
 * Extracted into the engine rather than left inline in `AuctionRoom` for the
 * same reason `remainingStartingSlots` was in 3.3: it is real derivation
 * logic, and derivation buried in a component can only be tested through
 * fixture gymnastics that end up proving very little.
 *
 * @param picks     draft entries: { mine, teamId, playerId }.
 * @param posById   player id -> position.
 * @param nOpponents how many opponent slots to produce.
 * @returns Record<pos, count>[] — one entry per opponent, index = teamId.
 */
export function opponentCountsFromPicks(picks = [], posById = new Map(), nOpponents = 0) {
  const counts = Array.from({ length: Math.max(0, nOpponents) }, () => ({}));
  const lookup = posById instanceof Map ? (id) => posById.get(id) : (id) => posById[id];
  for (const p of picks) {
    if (!p || p.mine) continue;
    const t = p.teamId;
    if (t == null || t < 0 || t >= counts.length) continue;
    if (p.playerId == null) continue;
    const pos = lookup(p.playerId);
    if (pos) counts[t][pos] = (counts[t][pos] || 0) + 1;
  }
  return counts;
}

/**
 * The ceiling for a SPECIFIC position — only opponents who still need that
 * position count (roadmap 3.4a).
 *
 * THIS IS A WEAKER CLAIM THAN `priceCeiling`, ON PURPOSE, AND CALLERS SHOULD
 * KNOW WHICH THEY HOLD. `priceCeiling` is arithmetic: money that does not
 * exist cannot be bid, so it cannot be beaten. This one adds a BEHAVIOURAL
 * assumption — that a team at its positional cap will not bid — and if an
 * opponent takes a fourth tight end anyway, this number was wrong in the
 * unsafe direction: it said the player would be cheap and he was not.
 *
 * So it is returned ALONGSIDE the arithmetic bound, never instead of it.
 *
 * @returns { ceiling, arithmetic, gated, bidders } — `gated` true when demand
 *          actually tightened the number, `bidders` how many opponents can
 *          still want this position.
 */
export function priceCeilingFor(pos, {
  budgets = [], openSpots = [], counts = [], leagueRoster = {},
  superflex = false, minBid = 1,
} = {}) {
  const caps = opponentCapacities(budgets, openSpots, minBid);
  const arithmetic = priceCeiling(caps, minBid);

  const eligible = caps.map((c, i) =>
    (opponentDemand(pos, leagueRoster, counts[i] || {}, superflex) > 0 ? c : 0));
  const ceiling = priceCeiling(eligible, minBid);

  return {
    ceiling,
    arithmetic,
    gated: ceiling < arithmetic,
    bidders: eligible.filter((c) => c > 0).length,
  };
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
export function bindingCeiling({
  allocationCeiling, budgetCeiling, capacities = [], minBid = 1,
}) {
  const roomCeiling = priceCeiling(capacities, minBid);
  const alloc = Number.isFinite(allocationCeiling) ? allocationCeiling : Infinity;
  // MY OWN CASH. Omitted entirely until a user reported $Max telling them to
  // bid many times what they had left: with starters full the room passes
  // `allocationCeiling = market`, which is a property of the PLAYER, and the
  // only other cap here was the room's money — so nothing in the composition
  // knew what the bidder could actually afford. A ceiling above your own
  // maximum bid isn't conservative, it actively invites the overspend.
  // Callers pass `maxBid(budgetLeft, openSpots)`: everything you hold minus
  // the $1 each remaining slot still needs.
  const mine = Number.isFinite(budgetCeiling) ? Math.max(0, budgetCeiling) : Infinity;

  // Allocation ceiling of 0 is a real verdict from 3.3 ("he does not improve
  // your best reachable roster at any price"), not a missing value — it must
  // win, and must not be read as "unconstrained".
  if (alloc <= 0) return { bid: 0, binding: "allocation" };
  // Likewise a real verdict, and it outranks the rest: no money, no bid.
  if (mine <= 0) return { bid: 0, binding: "budget" };

  // Lowest cap wins. Ties resolve toward the constraint the user can act on:
  // "you can't afford more" is more actionable than "he isn't worth more".
  const bid = Math.min(alloc, mine, roomCeiling);
  if (bid === mine && mine < alloc) return { bid, binding: "budget" };
  if (bid === roomCeiling && roomCeiling < alloc) return { bid, binding: "opponents" };
  return { bid, binding: Number.isFinite(allocationCeiling) ? "allocation" : "none" };
}

/**
 * auction-sim.mjs — simulate whole auctions against the SHIPPED engine
 * ======================================================================
 * Roadmap 3.5. Built for one reason: 3.3 (budget-path DP), 3.4 (room price
 * ceiling) and 3.4a (opponent positional demand) all shipped unmeasured —
 * each one's own header says so. This is the harness that measures them.
 * See docs/ROADMAP.md 3.5 for the pre-registration this file implements;
 * do not change the mechanics below without updating that record first.
 *
 * MECHANICS. An open (English) auction reduced to its outcome: every
 * eligible team forms a willingness-to-pay (WTP) for the nominated player,
 * the highest WTP wins, and the price is one increment above the
 * second-highest WTP (floored at minBid) — exactly what an ascending
 * auction converges to, and exactly the mechanic 3.4's `priceCeiling` is
 * built on. A tied top bid is broken by the RNG, not by team index, so no
 * arm is systematically favoured by tie order.
 *
 * NOMINATION IS FIXED. Both arms nominate in the same order — sorted once,
 * up front, by static dollar value — so the comparison isolates BIDDING,
 * not nomination strategy. That is scope, stated in the pre-registration,
 * not discovered here.
 *
 * THE TWO ARMS:
 *   - "control"   — `suggestBid()`, the shipped independent-pricing bid.
 *   - "treatment" — `min(allocationCeiling, roomCeiling)`, composing 3.3's
 *     opportunity-cost DP with 3.4/3.4a's room cap via `bindingCeiling()`.
 *     K/DST fall outside the DP's `DP_POSITIONS` by design (see
 *     budget-path.js) and the shipped UI never runs `bidCeiling` for them
 *     either, so the treatment arm falls back to the SAME control bid there
 *     — a scope limit carried over, not a new gap invented for this file.
 *   A third mode, "passive" (never bids), exists only for the selftest's
 *   crippled-agent check and is not a real strategy.
 *
 * CIRCULARITY MITIGATION, DELIBERATELY DIFFERENT FROM 3.1's. Both arms
 * price off the SAME static market curve, so any privileged-knowledge edge
 * is shared and cancels; what differs between arms is allocation strategy
 * alone. Two residual hazards get explicit countermeasures:
 *   1. Bots use their OWN need rule (`botWTPMultiplier`), a different SHAPE
 *      and different constants than `opponentDemand()` — never that
 *      function itself, or 3.4a would be validated by construction.
 *   2. Bot pricing carries noise (`botNoise`), and the noise level is a
 *      parameter callers sweep rather than one convenience value baked in.
 *
 * STATED SIMPLIFICATIONS (each one is a real difference from the live UI,
 * named rather than silently carried):
 *   - Market prices and dollar values are computed ONCE, up front, from the
 *     static board. The live UI recomputes both under `applyInflation` as
 *     the draft proceeds; this harness does not track live inflation. Both
 *     arms see the identical static numbers, so the comparison stays fair
 *     even though neither arm sees what a real room's inflation would show.
 *   - Opponent budgets/rosters are read directly off simulator state, i.e.
 *     the treatment arm has perfect knowledge of the room. That mirrors the
 *     live UI too: `oppBudgets`/`oppCounts` there come from the actual pick
 *     log, which is exactly this kind of public information in a real
 *     auction (everyone can see what everyone else has spent and drafted).
 *
 * SCORING. `bestLineupPoints()` from draft-sim.mjs, on ACTUAL season points
 * — the identical yardstick the snake harness already uses. This is NOT
 * title share; see the pre-registration for why that substitution is
 * consistency with 0.2 rather than a fresh dodge.
 */
import { maxUseful } from "./snake-engine.js";
import { rankByAdp } from "./engine-core.js";
import { dollarValues, marketPrice, maxBid, suggestBid } from "./auction-engine.js";
import {
  DP_POSITIONS, FLEX_ELIGIBLE, remainingStartingSlots, bidCeiling,
} from "./budget-path.js";
import {
  SINGLETON_POSITIONS, priceCeilingFor, bindingCeiling,
} from "./opponent-capacity.js";
import { mulberry32, bestLineupPoints } from "./draft-sim.mjs";

/** Every roster field the auction fills, including the ones budget-path's
 *  DP does not optimize over (K/DST, BENCH, SF) — this is the harness's own
 *  count of "how many bodies", not a stand-in for `remainingStartingSlots`,
 *  which only ever answers "how many STARTING slots". */
export function totalRosterSize(roster = {}) {
  const r = roster || {};
  return (r.QB ?? 0) + (r.RB ?? 0) + (r.WR ?? 0) + (r.TE ?? 0) + (r.FLEX ?? 0)
    + (r.K ?? 0) + (r.DST ?? 0) + (r.BENCH ?? 0) + (r.SF ?? 0);
}

function countBy(players) {
  const c = {};
  for (const p of players) c[p.pos] = (c[p.pos] || 0) + 1;
  return c;
}

/**
 * How eager a BOT is to buy this position, as a multiplier on market price.
 * Deliberately NOT `opponentDemand()` — different shape (a continuous
 * urgency tier rather than a linear cap-minus-have), different constants
 * (`BOT_URGENT_MULT`, `BOT_BENCH_SHARE`), and it answers "how much would I
 * pay" rather than opponentDemand's "am I still a bidder at all". Using the
 * agent's own opponent model to drive the bots would validate 3.4a by
 * construction — see the header.
 */
export const BOT_URGENT_MULT = 1.15;   // pays above market to fill an unmet starter
export const BOT_BENCH_SHARE = 4;      // bench spread thinly across positions, own constant

export function botWTPMultiplier(pos, roster, counts, superflex = false) {
  const have = counts[pos] || 0;
  if (SINGLETON_POSITIONS.includes(pos)) return have >= 1 ? 0 : 1.05;
  const starters = (roster[pos] || 0) + (pos === "QB" && superflex ? 1 : 0);
  if (have < starters) return BOT_URGENT_MULT;
  const flexRoom = FLEX_ELIGIBLE.includes(pos) ? (roster.FLEX || 0) : 0;
  const benchRoom = Math.max(1, Math.round((roster.BENCH || 0) / BOT_BENCH_SHARE));
  if (have < starters + flexRoom + benchRoom) return 1.0;
  return 0;
}

/**
 * Resolve one nomination's bids into a sale.
 *
 * Second-price, exactly: the price is the second-highest bid plus one
 * dollar, never more than the winner's own bid (so a lone or tied bidder
 * cannot be charged above what they offered) and never below `minBid`.
 * Returns null when nobody bids at all — the player goes unsold this pass.
 *
 * @param bids   [{ team, bid }], bid === 0 means "did not bid / ineligible".
 * @returns { winners, price, top, second } — `winners` may hold more than
 *          one team when the top bid ties; the caller breaks the tie.
 */
export function resolveSale(bids, minBid = 1) {
  const active = bids.filter((b) => b.bid > 0);
  if (!active.length) return null;
  active.sort((a, b) => b.bid - a.bid);
  const top = active[0].bid;
  const second = active[1] ? active[1].bid : 0;
  const price = Math.max(minBid, Math.min(top, second + minBid));
  const winners = active.filter((b) => b.bid === top).map((b) => b.team);
  return { winners, price, top, second };
}

/**
 * Run one auction. `agentTeam` plays `agentMode` ("control" | "treatment");
 * every other team is a bot. Returns each team's final roster and spend.
 */
export function simulateAuction({
  board, teams = 10, roster, budget = 200, minBid = 1,
  agentTeam = 0, agentMode = "control", superflex = false,
  botNoise = 0.15, seed = 1,
}) {
  const rng = mulberry32(seed);
  const totalSlots = totalRosterSize(roster);
  const auctionLeague = { teams, budget, rosterSize: totalSlots, benchSpots: roster.BENCH ?? 0 };

  const ranks = rankByAdp(board);
  const marketById = new Map(
    board.map((p) => [p.id, marketPrice(ranks[p.id], auctionLeague, undefined, p.pos, p.aav)]),
  );
  const withDollar = dollarValues(board, auctionLeague);
  const dollarById = new Map(withDollar.map((p) => [p.id, p.dollarValue]));

  // Nomination order is FIXED before any team acts — sorted once, by static
  // dollar value, so nomination cannot drift with either arm's choices.
  const nominationOrder = withDollar.slice().sort((a, b) => (b.dollarValue - a.dollarValue) || (a.id - b.id));

  const state = Array.from({ length: teams }, () => ({ budget, players: [] }));
  let available = board.slice();
  let remainingDvSum = withDollar.reduce((s, p) => s + (p.dollarValue ?? minBid), 0);

  const valueOf = (p) => p.vbd ?? 0;
  const priceOf = (p) => marketById.get(p.id) ?? minBid;

  const log = [];

  for (const player of nominationOrder) {
    if (!available.some((p) => p.id === player.id)) continue;
    if (state.every((t) => t.players.length >= totalSlots)) break;

    const market = marketById.get(player.id) ?? minBid;
    const bids = state.map((t, i) => {
      const openSpots = totalSlots - t.players.length;
      if (openSpots <= 0) return { team: i, bid: 0 };
      const counts = countBy(t.players);

      if (i === agentTeam) {
        // Test-only mode: never bids. Used by the selftest to confirm the
        // comparison is wired the right way round (a bidder who never buys
        // anything must lose to one who does).
        if (agentMode === "passive") return { team: i, bid: 0 };
        if (counts[player.pos] >= maxUseful(player.pos, roster, superflex)) return { team: i, bid: 0 };

        if (agentMode === "control" || !DP_POSITIONS.includes(player.pos)) {
          const dv = dollarById.get(player.id) ?? minBid;
          const sug = suggestBid(
            { ...player, dollarValue: dv },
            { budget: t.budget, openSpots: Math.max(1, openSpots), remainingDvSum, market },
          );
          return { team: i, bid: Math.min(sug.bid, maxBid(t.budget, openSpots, minBid)) };
        }

        // treatment: allocation-aware ceiling (3.3) composed with the room
        // ceiling (3.4/3.4a) — the same call shape AuctionRoom.tsx uses.
        // No open STARTING slots is not "worth nothing" — it means the DP
        // has nothing left to optimize and defers entirely to the room
        // ceiling, exactly as `bindingCeiling` already treats a non-finite
        // allocationCeiling (AuctionRoom passes `null` for the same case,
        // which `?? undefined` turns into the same non-finite value).
        const { slots: openStartSlots, reserveSpots } = remainingStartingSlots(roster, t.players);
        const dpBudget = Math.max(0, t.budget - reserveSpots);
        const allocationCeiling = openStartSlots.length
          ? bidCeiling({ player, slots: openStartSlots, budget: dpBudget, pool: available, valueOf, priceOf, minBid })
          : undefined;

        const oppBudgets = [], oppOpenSpots = [], oppCounts = [];
        state.forEach((o, j) => {
          if (j === i) return;
          oppBudgets.push(o.budget);
          oppOpenSpots.push(totalSlots - o.players.length);
          oppCounts.push(countBy(o.players));
        });
        const room = priceCeilingFor(player.pos, {
          budgets: oppBudgets, openSpots: oppOpenSpots, counts: oppCounts,
          leagueRoster: roster, superflex, minBid,
        });
        const { bid: ceiling } = bindingCeiling({
          allocationCeiling, capacities: [Math.max(0, room.ceiling - minBid)], minBid,
        });
        return { team: i, bid: Math.min(ceiling, maxBid(t.budget, openSpots, minBid)) };
      }

      const mult = botWTPMultiplier(player.pos, roster, counts, superflex);
      if (mult <= 0) return { team: i, bid: 0 };
      const noise = 1 + (rng() * 2 - 1) * botNoise;
      const wtp = Math.max(minBid, Math.round(market * mult * noise));
      return { team: i, bid: Math.min(wtp, maxBid(t.budget, openSpots, minBid)) };
    });

    const sale = resolveSale(bids, minBid);
    available = available.filter((p) => p.id !== player.id);
    remainingDvSum -= dollarById.get(player.id) ?? minBid;
    if (!sale) continue;

    const winner = sale.winners.length === 1
      ? sale.winners[0]
      : sale.winners[Math.floor(rng() * sale.winners.length)];
    state[winner].budget -= sale.price;
    state[winner].players.push(player);
    log.push({ id: player.id, pos: player.pos, team: winner, price: sale.price });
  }

  return {
    rosters: state.map((t) => t.players),
    spend: state.map((t) => budget - t.budget),
    log,
  };
}

/**
 * PAIRED comparison of "control" vs "treatment" at one seat, on one board.
 * Same board, same seed, same bots — every bot draw is identical until the
 * agent's own choice diverges, exactly `pairedCompare`'s discipline in
 * draft-sim.mjs, carried over rather than reinvented.
 */
export function pairedCompareAuction({
  board, pointsById, roster, teams = 10, budget = 200, minBid = 1,
  agentTeam = 0, superflex = false, botNoise = 0.15, seeds = [1, 2, 3, 4, 5],
  modeA = "control", modeB = "treatment",
}) {
  const rows = [];
  for (const seed of seeds) {
    const a = simulateAuction({
      board, teams, roster, budget, minBid, agentTeam, superflex, botNoise, seed,
      agentMode: modeA,
    });
    const b = simulateAuction({
      board, teams, roster, budget, minBid, agentTeam, superflex, botNoise, seed,
      agentMode: modeB,
    });
    const aPts = bestLineupPoints(a.rosters[agentTeam], pointsById, roster);
    const bPts = bestLineupPoints(b.rosters[agentTeam], pointsById, roster);
    rows.push({ seed, control: aPts, treatment: bPts, diff: +(bPts - aPts).toFixed(1) });
  }
  const diffs = rows.map((r) => r.diff);
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, diffs.length - 1));
  return {
    rows,
    meanDiff: +mean.toFixed(2),
    sdDiff: +sd.toFixed(2),
    seDiff: +(sd / Math.sqrt(diffs.length)).toFixed(2),
    treatmentWins: diffs.filter((d) => d > 0).length,
    n: diffs.length,
  };
}

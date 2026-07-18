/* ================================================================== *
 * keeperReco.js — keeper *selection* recommendation (pure)
 * ------------------------------------------------------------------ *
 * Turns keeper candidates into a strategic keep/hold call. The core
 * idea: a keeper is worth its value MINUS what the resource you spend
 * (dollars in auction, a specific draft pick in snake) would otherwise
 * get you — then adjusted for positional scarcity and roster fit.
 *
 *   Keeper Value (KV) = surplus + scarcity + fit
 *
 *   • Auction surplus = inflation-adjusted market value − keeper price.
 *   • Snake  surplus  = VBD(kept) − VBD(best player available at the
 *     ACTUAL overall pick you forfeit). That pick comes from your draft
 *     slot via the serpentine schedule, so draft position matters:
 *     slot 1 forfeiting round 3 gives up pick 25; slot 12 gives up 36.
 *
 * The set optimizer enumerates every subset up to maxKeepers, charges
 * each snake keeper a DISTINCT forfeited pick (so a second keeper in the
 * same round costs an earlier, better pick), and keeps a candidate only
 * when its marginal KV clears a flexibility threshold — so it can, and
 * often will, recommend fewer than the max (or none).
 *
 * Pure + node-tested (keeperReco.selftest.mjs).
 * ================================================================== */
import { snakePicks } from "./valuation-engine.js";

/** Market draft order: who leaves the board when. ADP → ECR → our VBD rank.
 *  Returns the board annotated with a 1-based `marketIdx`. */
export function marketOrder(board) {
  const ranked = board.map((p, i) => ({
    p,
    // lower = drafted earlier by the market
    mr: p.adp != null ? p.adp : p.ecr != null ? p.ecr : i + 1,
  }));
  ranked.sort((a, b) => a.mr - b.mr);
  return ranked.map((x, i) => ({ ...x.p, marketIdx: i + 1 }));
}

/** Best player (by our VBD) still on the board at overall pick P, given the
 *  set of removed (kept, all-teams) ids. Null if nothing is left. */
export function expectedAtPick(marketBoard, P, keptIds) {
  let best = null;
  for (const p of marketBoard) {
    if (keptIds.has(p.id)) continue;
    if (p.marketIdx < P) continue; // market took them before your pick
    if (!best || p.vbd > best.vbd) best = p;
  }
  return best;
}

/** Wheel factor by draft slot: ends of the snake (long gaps between picks)
 *  amplify scarcity; the middle is neutral. ~1.0 center → ~1.25 at the turns. */
export function wheelFactor(slot, teams) {
  if (!teams || teams < 2) return 1;
  const center = (teams + 1) / 2;
  const norm = Math.abs(slot - center) / (center - 1); // 0 center … 1 ends
  return +(1 + 0.25 * norm).toFixed(3);
}

/** Positional scarcity: VBD cliff from this player to the next AVAILABLE
 *  (non-kept) player at his position — the drop you can't replace in the draft. */
export function scarcityBonus(player, board, keptIds, factor = 1) {
  const samePos = board
    .filter((p) => p.pos === player.pos && (p.id === player.id || !keptIds.has(p.id)))
    .sort((a, b) => b.vbd - a.vbd);
  const idx = samePos.findIndex((p) => p.id === player.id);
  const next = idx >= 0 ? samePos[idx + 1] : samePos[0];
  const gap = next ? Math.max(0, player.vbd - next.vbd) : Math.max(0, player.vbd);
  return +(gap * factor).toFixed(1);
}

/** Roster-fit nudge for a chosen keeper set: reward filling a starter slot,
 *  gently penalize stacking a third+ at a position with few starting spots. */
function fitAdjust(player, chosenSameposCountBefore, roster) {
  const starters = {
    QB: roster.QB ?? 0, RB: (roster.RB ?? 0) + (roster.FLEX ?? 0),
    WR: (roster.WR ?? 0) + (roster.FLEX ?? 0), TE: (roster.TE ?? 0),
    K: roster.K ?? 0, DST: roster.DST ?? 0,
  }[player.pos] ?? 1;
  if (chosenSameposCountBefore < Math.max(1, Math.ceil(starters * 0.6))) return +2;
  if (chosenSameposCountBefore >= starters) return -4; // overloading
  return 0;
}

/* ------------------------------------------------------------------ *
 * Per-candidate value
 * ------------------------------------------------------------------ *
 * candidate = { id, player (BoardPlayer, incl. parValue/adjValue for auction),
 *               cost: { basis, price, round } }  // from keeperCost()
 * ------------------------------------------------------------------ */

export function auctionCandidateValue(cand, board, keptIds, scarceFactor = 1) {
  const p = cand.player;
  const market = p.adjValue ?? p.parValue ?? 0;
  const cost = cand.cost.price ?? 1;
  const surplus = +(market - cost).toFixed(1);
  const scarcity = scarcityBonus(p, board, keptIds, scarceFactor);
  return { market, cost, surplus, scarcity, forfeit: null, forfeitPick: null };
}

export function snakeCandidateValue(cand, board, marketBoard, keptIds, myPicks, assignedRound, scarceFactor) {
  const p = cand.player;
  const round = assignedRound ?? cand.cost.round ?? 1;
  const forfeitPick = myPicks[round - 1] ?? round * 999; // beyond the board if unknown
  const exp = expectedAtPick(marketBoard, forfeitPick, keptIds);
  const forfeitVbd = exp ? exp.vbd : 0;
  const surplus = +(p.vbd - forfeitVbd).toFixed(1);
  const scarcity = scarcityBonus(p, board, keptIds, scarceFactor);
  return { market: p.vbd, cost: round, surplus, scarcity, forfeit: exp, forfeitPick };
}

/* ------------------------------------------------------------------ *
 * Set optimizer
 * ------------------------------------------------------------------ *
 * ctx = {
 *   format: "auction" | "snake",
 *   board, marketBoard,            // marketBoard = marketOrder(board)
 *   settings: { teams, draftSlot, roster },
 *   allKeptIds: Set<number>,       // every team's committed keepers (pool depletion)
 *   maxKeepers, flexFloor,         // flexFloor = min marginal KV to bother keeping
 * }
 * Returns { best: {ids, totalKV, items}, ranked: [...per candidate], byId }.
 * ------------------------------------------------------------------ */
export function recommendKeepers(candidates, ctx) {
  const {
    format, board, marketBoard, settings,
    allKeptIds = new Set(), maxKeepers = candidates.length,
    flexFloor = 3,
  } = ctx;
  const roster = settings.roster ?? {};
  const teams = settings.teams ?? 12;
  const slot = settings.draftSlot ?? 1;
  const myPicks = format === "snake" ? snakePicks(slot, teams, 30) : [];
  const scarceFactor = format === "snake" ? wheelFactor(slot, teams) : 1;

  // Evaluate one subset: assign distinct forfeited rounds (snake) and sum KV.
  const evalSubset = (subset) => {
    const items = [];
    if (format === "snake") {
      // Assign each keeper a distinct round: start from its nominal round and
      // walk to an earlier (cheaper-numbered / better) unused round on collision.
      const used = new Set();
      const order = [...subset].sort((a, b) => (a.cost.round ?? 99) - (b.cost.round ?? 99));
      const assign = {};
      for (const c of order) {
        let r = c.cost.round ?? 1;
        while (used.has(r) && r > 1) r -= 1;
        used.add(r);
        assign[c.id] = r;
      }
      const posSeen = {};
      for (const c of order) {
        const v = snakeCandidateValue(c, board, marketBoard, allKeptIds, myPicks, assign[c.id], scarceFactor);
        const before = posSeen[c.player.pos] ?? 0;
        const fit = fitAdjust(c.player, before, roster);
        posSeen[c.player.pos] = before + 1;
        const kv = +(v.surplus + v.scarcity + fit).toFixed(1);
        items.push({ cand: c, ...v, fit, kv, round: assign[c.id] });
      }
    } else {
      const posSeen = {};
      const order = [...subset].sort((a, b) => (b.player.parValue ?? 0) - (a.player.parValue ?? 0));
      for (const c of order) {
        const v = auctionCandidateValue(c, board, allKeptIds, scarceFactor);
        const before = posSeen[c.player.pos] ?? 0;
        const fit = fitAdjust(c.player, before, roster);
        posSeen[c.player.pos] = before + 1;
        const kv = +(v.surplus + v.scarcity + fit).toFixed(1);
        items.push({ cand: c, ...v, fit, kv });
      }
    }
    // Only count keepers whose marginal KV clears the flexibility floor.
    const kept = items.filter((it) => it.kv > flexFloor);
    const totalKV = +kept.reduce((s, it) => s + it.kv, 0).toFixed(1);
    return { items, kept, totalKV };
  };

  // Enumerate subsets up to maxKeepers (candidate count is tiny).
  const all = [];
  const n = candidates.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    const subset = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(candidates[i]);
    if (subset.length > maxKeepers) continue;
    all.push(subset);
  }

  let best = { ids: [], totalKV: 0, items: [] };
  for (const subset of all) {
    const { kept, totalKV } = evalSubset(subset);
    // The realized set is only the keepers that cleared the floor.
    if (totalKV > best.totalKV) {
      best = { ids: kept.map((it) => it.cand.id), totalKV, items: kept };
    }
  }

  // Per-candidate view = evaluate each alone (its standalone KV + verdict).
  const soloById = {};
  for (const c of candidates) {
    const { items } = evalSubset([c]);
    soloById[c.id] = items[0];
  }
  const bestIds = new Set(best.ids);
  const ranked = candidates
    .map((c) => ({ ...soloById[c.id], recommended: bestIds.has(c.id) }))
    .sort((a, b) => b.kv - a.kv);

  return { best, ranked, byId: soloById, params: { flexFloor, slot, teams, scarceFactor } };
}

/** Human-readable draft-impact summary for the recommended set. */
export function draftImpact(best, ctx) {
  const { format, settings } = ctx;
  if (format === "auction") {
    const spend = best.items.reduce((s, it) => s + (it.cost || 0), 0);
    return {
      keepers: best.items.length,
      spend,
      budgetLeft: (settings.budget ?? 200) - spend,
      forfeitedPicks: null,
    };
  }
  return {
    keepers: best.items.length,
    spend: null,
    budgetLeft: null,
    forfeitedPicks: best.items.map((it) => ({ round: it.round, overall: it.forfeitPick })),
  };
}

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
 * OPPORTUNITY-COST-AWARE QB/TE VALUATION (roadmap 3.12). Snake surplus used
 * to credit a kept player his FULL VBD regardless of whether he'd actually
 * start — overstating a redundant QB/TE keeper (a backup at a one-starter
 * position, "insurance not depth") the same way a live-draft pick would be
 * overstated crediting him full VBD. Proposed directly after roadmap 3.11/
 * 3.11b both tried to fix that overstatement at DRAFT TIME (scaling the
 * live pick-scoring discount up for a real upgrade) and were gated and
 * REJECTED — the fix belongs at the KEEPER DECISION instead: "maybe the
 * solution is to update the keeper recommendation process to consider the
 * opportunity costs in light of the gates we've established." A second+
 * QB/TE keeper (`isInsuranceOnly`, evaluated against OTHER keepers already
 * chosen in the same subset — mirrors `needMult`'s own `have >= 1` trigger)
 * has his VBD discounted by `INSURANCE_MULT` before computing surplus —
 * the SAME shipped, always-on flat discount `pickScore` already applies to
 * a live QB2/TE2 pick, reused in a NEW consumer rather than a new,
 * unvalidated number (the same no-new-gate precedent 3.6c/3.6e already
 * established for reusing an already-shipped constant this way). NOT
 * itself independently backtested for KEEPER decisions specifically — no
 * harness in this repo scores keeper-SELECTION quality the way
 * `draft-sim.mjs` scores draft-time picks — a real, stated limitation.
 *
 * Pure + node-tested (keeperReco.selftest.mjs).
 * ================================================================== */
import { myPickNumbers, snakePicks } from "./valuation-engine.js";
import { keeperCost } from "./keeper.js";
import { isInsuranceOnly, INSURANCE_MULT } from "./snake-engine.js";

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
 *  set of removed (kept, all-teams) ids. Null if nothing is left.
 *  `pos`, optional (roadmap 3.13), scopes the search to one position —
 *  "who's the best PLAYER left" vs "who's the best {POS} left" are the
 *  same loop, just filtered differently; every existing caller omits it
 *  and is unaffected. */
export function expectedAtPick(marketBoard, P, keptIds, pos = null) {
  let best = null;
  for (const p of marketBoard) {
    if (pos && p.pos !== pos) continue;
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

/**
 * Which of YOUR picks a round-R keeper actually costs.
 *
 * Indexing `myPicks[round-1]` only works when you own exactly one pick per
 * round — true under serpentine, false once picks are traded. Look the round
 * up instead: if you hold two picks in it, the earlier (more valuable) one is
 * the honest cost; if you hold none, you forfeit the next pick you do own.
 */
export function pickForRound(myPicks, round, teams) {
  if (!myPicks?.length) return round * (teams || 12);
  const roundOf = (p) => Math.ceil(p / (teams || 12));
  const inRound = myPicks.filter((p) => roundOf(p) === round);
  if (inRound.length) return Math.min(...inRound);
  const later = myPicks.filter((p) => roundOf(p) > round);
  if (later.length) return Math.min(...later);
  return myPicks[myPicks.length - 1];
}

/** Your NEXT pick strictly after `afterPick` — "if I spend THIS pick on the
 *  keeper, when do I get to act again?" Null with no later pick owned. */
function nextPickAfter(myPicks, afterPick) {
  if (!myPicks?.length) return null;
  const later = myPicks.filter((p) => p > afterPick);
  return later.length ? Math.min(...later) : null;
}

/**
 * Roadmap 3.13 — "if I keep this player, will I be able to draft a
 * comparable or better one at his position myself anyway, with my OWN
 * next pick?" Asked directly after shipping 3.12: does keeping a QB in an
 * early-ish round foreclose drafting a stronger one live? Answered
 * concretely rather than left as an unmeasured worry — this is the same
 * `expectedAtPick` lookup the surplus math already trusts, scoped to ONE
 * position and evaluated at the pick you'll ACTUALLY be on the clock for
 * next (not just "the next player at this position in market order",
 * which says nothing about whether YOUR draft slot gets a turn before
 * someone else takes him).
 *
 * DELIBERATELY NOT QB/TE-ONLY — asked directly: "is there a reason to
 * limit to QBs, or should we build for all positions?" The underlying
 * question (what's realistically still there at this position by the
 * time I act again) is meaningful everywhere; what differs is how to
 * READ the answer, left to the caller/UI rather than baked in here:
 *   - QB (non-superflex) and TE (`isInsuranceOnly`): you only ever
 *     NEED one starter, so a comparable-or-better fallback is a real
 *     "you may not need to keep him" signal.
 *   - RB/WR/superflex-QB: you'll happily roster several — a strong
 *     fallback here is depth CONTEXT, not a foreclosed opportunity, since
 *     both the kept player and whoever you draft later make the team
 *     better rather than compete for the same one roster spot.
 * Snake-only (auction has no fixed personal "next pick" sequence to check
 * against — nominations are simultaneous, not a personal draft slot).
 *
 * @returns null when there's no later pick owned, or nothing is left at
 *          the position; otherwise { player, pick, round, gap } — `gap`
 *          is `player.vbd - fallback.vbd` (small/negative = a near-equal
 *          or better option is realistically still there anyway).
 */
export function positionalFallback(player, marketBoard, keptIds, myPicks, forfeitPick, teams) {
  const nextPick = nextPickAfter(myPicks, forfeitPick);
  if (nextPick == null) return null;
  const fallback = expectedAtPick(marketBoard, nextPick, keptIds, player.pos);
  if (!fallback) return null;
  return {
    player: fallback,
    pick: nextPick,
    round: teams ? Math.ceil(nextPick / teams) : null,
    gap: +(player.vbd - fallback.vbd).toFixed(1),
  };
}

/**
 * @param sameposKeptBefore how many OTHER keepers already chosen in this
 *        same subset play this candidate's position — mirrors
 *        `needMult`'s own `have` count, just counted over keepers instead
 *        of a live roster (see roadmap 3.12, this file's header).
 * @param roster league starter counts, for the same-position starter
 *        threshold `isInsuranceOnly` needs.
 * @param superflex league superflex flag — a superflex league's SECOND QB
 *        is real depth, not insurance, exactly as `needMult` already treats it.
 */
export function snakeCandidateValue(
  cand, board, marketBoard, keptIds, myPicks, assignedRound, scarceFactor, teams,
  sameposKeptBefore = 0, roster = {}, superflex = false,
) {
  const p = cand.player;
  const round = assignedRound ?? cand.cost.round ?? 1;
  const forfeitPick = pickForRound(myPicks, round, teams);
  const exp = expectedAtPick(marketBoard, forfeitPick, keptIds);
  const forfeitVbd = exp ? exp.vbd : 0;
  // Roadmap 3.12 — a QB/TE keeper past this position's starter count is
  // insurance, not depth, the SAME reasoning (and the SAME shipped
  // constant) `pickScore`'s own needMult already applies to a live QB2/TE2
  // pick. Crediting him full VBD here would repeat the exact overstatement
  // roadmap 3.11/3.11b traced the harm to when they tried to fix it at
  // draft time instead — fixing it HERE, at the keeper decision, is what
  // was proposed as the better home for it.
  //
  // `roster[p.pos] ?? 1`, NOT `|| 0` — a real bug caught by 3.13's own
  // selftest (a QB candidate scored with no `roster` argument, the
  // default `{}`, came back insurance-discounted despite being the ONLY
  // QB in the subset). `roster[pos] || 0` silently reads "no roster
  // info supplied" as "zero starters needed", which flags a SOLE QB/TE
  // keeper as redundant against a starter requirement of zero — wrong for
  // every real league, which always fields at least one QB and one TE.
  // Defaulting the unknown-starter-count case to 1 (not 0) is the safe
  // assumption for the only two positions this branch ever runs for.
  const starters = roster[p.pos] ?? 1;
  const insuranceDiscounted = isInsuranceOnly(p.pos, superflex) && sameposKeptBefore >= starters;
  const keptValue = insuranceDiscounted ? +(p.vbd * INSURANCE_MULT).toFixed(1) : p.vbd;
  const surplus = +(keptValue - forfeitVbd).toFixed(1);
  const scarcity = scarcityBonus(p, board, keptIds, scarceFactor);
  // Roadmap 3.13 — display-only; never feeds surplus/kv. See the function's
  // own header for what this answers and why it's not QB/TE-scoped.
  const fallback = positionalFallback(p, marketBoard, keptIds, myPicks, forfeitPick, teams);
  return {
    market: p.vbd, keptValue, insuranceDiscounted, cost: round, surplus, scarcity,
    forfeit: exp, forfeitPick, positionalFallback: fallback,
  };
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
  const superflex = !!settings.superflex;
  // Honors settings.myPicks when the league has traded picks; otherwise this is
  // the serpentine schedule, unchanged.
  const myPicks = format === "snake" ? myPickNumbers({ ...settings, teams }, 30) : [];
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
      // Roadmap 3.12 — which of this subset's same-position keepers is
      // treated as the starter (full value) vs insurance (discounted): the
      // HIGHEST-VBD one, not whichever happens to be processed first by
      // round order below (that order exists for round ASSIGNMENT, an
      // unrelated concern). A separate VBD-descending rank per position.
      const byPosVbdDesc = {};
      for (const c of subset) (byPosVbdDesc[c.player.pos] ||= []).push(c);
      for (const list of Object.values(byPosVbdDesc)) list.sort((a, b) => b.player.vbd - a.player.vbd);
      const posRank = {};
      for (const list of Object.values(byPosVbdDesc)) list.forEach((c, i) => { posRank[c.id] = i; });

      const posSeen = {};
      for (const c of order) {
        const before = posSeen[c.player.pos] ?? 0;
        const v = snakeCandidateValue(
          c, board, marketBoard, allKeptIds, myPicks, assign[c.id], scarceFactor, teams,
          posRank[c.id], roster, superflex,
        );
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
        // Auction KV is in DOLLARS: surplus + a small fit nudge. Positional
        // scarcity is deliberately NOT added — it's already priced into the
        // market/par value (you can re-buy a scarce player for money), and it's
        // measured in fantasy points, not dollars, so adding it would be a
        // unit mismatch that swamps the surplus. Kept on the item for display.
        const kv = +(v.surplus + fit).toFixed(1);
        items.push({ cand: c, ...v, fit, kv });
      }
    }
    // Only count keepers whose marginal KV clears the flexibility floor.
    const kept = items.filter((it) => it.kv > flexFloor);
    const totalKV = +kept.reduce((s, it) => s + it.kv, 0).toFixed(1);
    return { items, kept, totalKV };
  };

  // Enumerate subsets of size 0..maxKeepers. This USED to walk every mask of
  // the full power set (2^n) and discard anything over maxKeepers afterward
  // — "candidate count is tiny" was true for a short bench list, but a real
  // Yahoo pull's `myCandidates` (a full roster, sometimes IR/bench-heavy)
  // measured at n=24 -> 2.0s of blocked main-thread time, n=26 -> 7.9s,
  // n=28 -> 32.0s, doubling every ~2 candidates as 2^n does — reported live
  // as the whole keeper page (an unrelated dropdown included, since this
  // runs synchronously inside a render) going unresponsive. maxKeepers is
  // always small in practice (a keeper rule capping how many you can even
  // keep), so walking combinations of size 0..maxKeepers directly — the
  // ONLY subsets this ever kept, identical output, nothing approximated —
  // is sum(C(n,0..maxKeepers)) instead of 2^n: at n=28/maxKeepers=3 that's
  // 3,589 instead of 268,435,456.
  const all = [];
  const n = candidates.length;
  (function combinations(start, chosen) {
    all.push(chosen.slice());
    if (chosen.length === maxKeepers) return;
    for (let i = start; i < n; i++) {
      chosen.push(candidates[i]);
      combinations(i + 1, chosen);
      chosen.pop();
    }
  })(0, []);

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

/* ------------------------------------------------------------------ *
 * Predict OPPONENTS' keepers → who won't be in the draft pool
 * ------------------------------------------------------------------ *
 * Given every team's roster + draft cost (from the ESPN import), assume
 * each opponent keeps their best-value players (same logic you'd use):
 * the top `maxKeepers` whose keeper surplus clears `floor`. Removing them
 * from the pool makes your own "who's available at my forfeited pick"
 * (snake) and market values (auction) reflect who's actually gone.
 *
 * Because we don't know each opponent's draft slot, snake surplus is
 * scored against a slot-agnostic MID-round pick. This is a heuristic — the
 * UI shows the predictions so they can be overridden.
 *
 * candidates: [{ player_id, is_mine, owner, bid, round }]  (KeeperCandidate)
 * ctx: { format, board (priced), marketBoard, settings, rule, floor, baseKept,
 *        committedIds, committedByOwner }
 *   committedIds       - players already entered as keepers (excluded from prediction)
 *   committedByOwner   - {owner: count} of keepers you've already confirmed for a
 *                        team, so we only predict the team's REMAINING slots.
 * Returns { keptIds: Set<number>, byTeam: { [owner]: [{id,name,pos,surplus,cost}] } }.
 * ------------------------------------------------------------------ */
export function predictOpponentKeepers(candidates, ctx) {
  const {
    format, board, marketBoard, settings, rule, floor = 0,
    baseKept = new Set(), committedIds = new Set(), committedByOwner = {},
  } = ctx;
  const teams = settings.teams ?? 12;
  const maxK = rule?.maxKeepers ?? 1;
  const roundBasis = rule?.basis === "round";
  const byId = new Map(board.map((p) => [p.id, p]));

  // What each opponent's round-R keeper actually costs THEM. Use their real
  // picks when we know them — an explicit traded-pick list first, else their
  // draft slot — and only fall back to a slot-agnostic mid-round guess when we
  // know nothing. A team drafting 1st and a team drafting last forfeit very
  // different players for the same round, which changes who they keep.
  const teamPicks = settings.teamPicks ?? {};
  const teamSlots = settings.teamSlots ?? {};
  const picksForOwner = (owner) => {
    const explicit = teamPicks[owner];
    if (Array.isArray(explicit) && explicit.length) {
      return [...new Set(explicit.filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
    }
    const slot = teamSlots[owner];
    return slot ? snakePicks(slot, teams, 30) : null;
  };

  const groups = {};
  for (const c of candidates) {
    if (c.is_mine || c.player_id == null) continue;
    if (committedIds.has(c.player_id)) continue; // already a confirmed keeper
    const player = byId.get(c.player_id);
    if (!player) continue;
    (groups[c.owner] ||= []).push({ c, player });
  }

  const keptIds = new Set(baseKept);
  const byTeam = {};
  for (const [owner, list] of Object.entries(groups)) {
    const slots = Math.max(0, maxK - (committedByOwner[owner] ?? 0));
    if (slots === 0) { byTeam[owner] = []; continue; }
    const scored = list.map(({ c, player }) => {
      const base = roundBasis ? c.round : c.bid;
      const waiver = roundBasis ? null : c.waiver ?? null; // FAAB is a price-basis concept
      const fa = base == null;
      const cost = keeperCost({ base: fa ? null : base, waiver, fa, kept: 0 }, rule);
      let surplus;
      if (roundBasis) {
        const owned = picksForOwner(owner);
        const pick = owned
          ? pickForRound(owned, Math.max(1, cost.round), teams)
          // Nothing known about this team's picks — mid-round is the least-wrong
          // guess (better than assuming they pick 1st or last).
          : (Math.max(1, cost.round) - 1) * teams + Math.ceil(teams / 2);
        const exp = expectedAtPick(marketBoard, pick, keptIds);
        surplus = +(player.vbd - (exp ? exp.vbd : 0)).toFixed(1);
      } else {
        const market = player.parValue ?? player.adjValue ?? 0;
        surplus = +(market - (cost.price ?? 1)).toFixed(1);
      }
      return { id: c.player_id, name: player.name, pos: player.pos, surplus, cost, base: fa ? null : base };
    });
    scored.sort((a, b) => b.surplus - a.surplus);
    const kept = scored.filter((s) => s.surplus > floor).slice(0, slots);
    byTeam[owner] = kept;
    for (const k of kept) keptIds.add(k.id);
  }
  return { keptIds, byTeam };
}

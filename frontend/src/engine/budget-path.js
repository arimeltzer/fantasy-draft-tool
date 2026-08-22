/* =====================================================================
   BUDGET PATH — roadmap 3.3. "Given remaining budget, remaining holes and
   expected prices, what roster is reachable?"

   THE GAP THIS CLOSES. `maxBid()` reserves ONE DOLLAR per remaining slot:
   `budget - (openSpots - 1) * $1`. That is the most pessimistic reserve
   possible, and it is precisely why the tool prices players independently —
   under a $1 reserve almost any bid is "affordable", so affordability never
   constrains anything. The real question is not "can I still fill the roster
   with $1 scrubs" but "what is the best roster still reachable after this
   purchase".

   EXACT DP, NOT GREEDY, AND THE DISTINCTION MATTERS. Greedy (take the best
   player you can afford at each slot in turn) is not merely suboptimal here;
   it is the exact failure mode this step exists to prevent — it spends down
   on the first slot and leaves nothing for the rest. So this is a real
   knapsack, solved exactly over the candidates it is given.

   THE OBJECTIVE IS INJECTED (roadmap restructure's standing commitment).
   Every entry point takes `valueOf(player) -> number` and
   `priceOf(player) -> number`. Callers pass VBD and expected market price
   today; a later ΔP(title) drops into `valueOf` without touching the DP.

   TWO APPROXIMATIONS, STATED RATHER THAN DISCOVERED LATER:
     1. Bench slots are $1 filler and are NOT in the DP. Real auction benches
        largely ARE minimum-bid filler, and modelling them would multiply the
        state space to agonize over a decision nobody agonizes over. Callers
        pass STARTING slots and subtract bench reserve from the budget.
     2. Candidates are pruned to the top TOP_K_PER_POS by value per position.
        The DP is exact over what it is handed; it is not handed the 300th
        WR, who cannot enter an optimal starting lineup at any price.
   ===================================================================== */

/** Positions a FLEX slot accepts. */
export const FLEX_ELIGIBLE = ["RB", "WR", "TE"];

/** Per-position candidate cap. The DP is exact over what it receives; this
 *  bounds what it receives. 24 is comfortably deeper than any real starting
 *  requirement plus FLEX at a single position. */
export const TOP_K_PER_POS = 24;

/** Budget ceiling for the DP's dollar dimension — guards a pathological
 *  settings value from allocating an enormous table. */
const MAX_BUDGET = 400;

const NEG = -Infinity;

/**
 * Ways to distribute `n` identical FLEX slots across the eligible positions.
 * FLEX is why the position pools are not disjoint, and enumerating the
 * assignment is what keeps the DP exact: within each branch every position's
 * candidate pool IS disjoint, so "choose k distinct" per position composes
 * correctly across positions.
 */
export function flexDistributions(n) {
  if (!n) return [{ RB: 0, WR: 0, TE: 0 }];
  const out = [];
  for (let rb = 0; rb <= n; rb++)
    for (let wr = 0; wr <= n - rb; wr++)
      out.push({ RB: rb, WR: wr, TE: n - rb - wr });
  return out;
}

/**
 * Choose EXACTLY k distinct candidates, for every k up to maxK and every
 * total cost up to budget.
 *
 * Standard 0/1 knapsack with a count dimension. Items outermost with both
 * inner loops descending is what enforces "each candidate at most once" —
 * `best[k-1][...]` is still the previous item's table when read.
 *
 * @returns { best, pick } where best[k][c] is the max value using exactly k
 *          candidates at total cost EXACTLY c (NEG if unreachable), and
 *          pick[k][c] is the candidate index last added there.
 */
function positionTable(cands, maxK, budget, valueOf, priceOf) {
  const best = Array.from({ length: maxK + 1 }, () => new Float64Array(budget + 1).fill(NEG));
  const pick = Array.from({ length: maxK + 1 }, () => new Int32Array(budget + 1).fill(-1));
  best[0][0] = 0;

  for (let i = 0; i < cands.length; i++) {
    const price = Math.max(0, Math.round(priceOf(cands[i])));
    const val = valueOf(cands[i]) || 0;
    if (price > budget) continue;
    for (let k = maxK; k >= 1; k--) {
      const prevRow = best[k - 1];
      const row = best[k];
      const pickRow = pick[k];
      for (let c = budget; c >= price; c--) {
        const prev = prevRow[c - price];
        if (prev === NEG) continue;
        const cand = prev + val;
        if (cand > row[c]) { row[c] = cand; pickRow[c] = i; }
      }
    }
  }
  return { best, pick };
}

/** Reconstruct which candidates a (k, cost) cell used. */
function reconstruct(cands, table, k, cost, priceOf) {
  const out = [];
  let kk = k, cc = cost;
  while (kk > 0) {
    const i = table.pick[kk][cc];
    if (i < 0) break;
    out.push(cands[i]);
    cc -= Math.max(0, Math.round(priceOf(cands[i])));
    kk -= 1;
  }
  return out;
}

/** Positions the DP actually optimizes over. K/DST are excluded for the same
 *  reason bench is: they are minimum-bid filler in practice, and modelling
 *  them would add state to agonize over a decision nobody agonizes over.
 *  They still cost money, so callers reserve for them — see
 *  `remainingStartingSlots().reserveSpots`. */
export const DP_POSITIONS = ["QB", "RB", "WR", "TE"];

/**
 * Which starting slots are still open, given the roster requirements and who
 * is already owned.
 *
 * FLEX is credited AFTER the dedicated slots: a third WR in a 2-WR league
 * fills FLEX rather than counting as an unmet WR need — the same
 * surplus-then-flex order `draft-sim.mjs`'s `needsFrom` already uses, kept
 * consistent deliberately so the auction and snake sides cannot disagree
 * about what "still needed" means.
 *
 * @returns { slots, reserveSpots } — `slots` feeds the DP; `reserveSpots` is
 *          how many bench/K/DST spots still need a minimum bid held back.
 */
export function remainingStartingSlots(roster = {}, myPlayers = []) {
  const have = {};
  for (const p of myPlayers) if (p && p.pos) have[p.pos] = (have[p.pos] || 0) + 1;

  const slots = [];
  const surplus = {};
  for (const pos of DP_POSITIONS) {
    const want = roster[pos] || 0;
    const got = have[pos] || 0;
    for (let i = got; i < want; i++) slots.push(pos);
    if (FLEX_ELIGIBLE.includes(pos)) surplus[pos] = Math.max(0, got - want);
  }

  const flexWant = roster.FLEX || 0;
  const flexFilled = Math.min(flexWant, FLEX_ELIGIBLE.reduce((s, pos) => s + (surplus[pos] || 0), 0));
  for (let i = flexFilled; i < flexWant; i++) slots.push("FLEX");

  // Everything the DP does not optimize still occupies budget at minimum bid.
  let reserveSpots = 0;
  for (const pos of ["K", "DST"]) reserveSpots += Math.max(0, (roster[pos] || 0) - (have[pos] || 0));
  const benchWant = roster.BENCH || 0;
  const startersOwned = DP_POSITIONS.reduce(
    (s, pos) => s + Math.min(have[pos] || 0, (roster[pos] || 0)), 0,
  ) + flexFilled + ["K", "DST"].reduce((s, pos) => s + Math.min(have[pos] || 0, roster[pos] || 0), 0);
  const totalOwned = Object.values(have).reduce((s, n) => s + n, 0);
  reserveSpots += Math.max(0, benchWant - Math.max(0, totalOwned - startersOwned));

  return { slots, reserveSpots };
}

/**
 * Bench-phase "one strong backup" priority — a ROSTER-CONSTRUCTION goal, not
 * a value comparison. A user's own stated ranking: "(1) points over the
 * season ... (2) having one strong backup at QB, RB, and WR." Once every
 * starting slot is filled, the ceiling composition (`AuctionRoom.tsx
 * ceilingFor`) had already prevented over-DEPTH (`maxUseful`'s $1 floor for
 * QB/TE/K/DST) but priced a team's FIRST bench body at a position the same
 * as its fourth: plain market value either way. This closes that specific
 * gap by nudging the ceiling above market for exactly the transition from
 * zero bench bodies to one, at exactly the three positions asked for.
 *
 * `BOOST_MULT` is deliberately the SAME 1.15 `needMult()` already uses on the
 * snake side for "below a starter slot" — reusing an existing, already-tuned
 * shape of nudge rather than inventing a fresh unfitted number. Small and
 * secondary on purpose: this is priority #2, meant to break a near-tie in
 * market's favor, not override it — `dollarValue`/`market` remain the
 * dominant signal (priority #1).
 *
 * TE/K/DST are excluded — they already have a depth policy via `maxUseful`'s
 * floor, and boosting there would fight it rather than complement it (a K/DST
 * backup is never useful at all, so there is nothing to prioritize toward).
 *
 * `have` counts EVERYONE at the position, starters included — the same
 * approximation `remainingStartingSlots` already makes about FLEX ownership
 * (a dedicated FLEX starter drawn from this position is not distinguished
 * from a bench body), stated rather than hidden.
 */
export const BACKUP_BOOST_MULT = 1.15;
export const BACKUP_BOOST_POSITIONS = ["QB", "RB", "WR"];

export function firstBackupBoost(pos, have, roster = {}) {
  if (!BACKUP_BOOST_POSITIONS.includes(pos)) return 1;
  const starters = roster[pos] || 0;
  // Self-contained rather than relying on the caller to only invoke this once
  // starters are full: EXACT equality, not `have - starters <= 0`, so a
  // roster that has not yet filled its starters at this position (have <
  // starters) does not read as "zero backups" and get boosted early — a real
  // edge case a selftest caught, not a hypothetical one. A league with no
  // starting requirement here at all (`starters === 0`) has no "backup"
  // concept either way.
  return starters > 0 && (have || 0) === starters ? BACKUP_BOOST_MULT : 1;
}

/* =====================================================================
   HISTORICAL-ANCHOR BENCH RESERVE — roadmap 3.7. See docs/ROADMAP.md 3.7
   for the full pre-registration; this is the "replacement design" recorded
   there after the FIRST design (anchoring a meaningful bench slot's reserve
   to marketPrice()'s LIVE number) was caught and rejected before any code
   shipped: "most bidders overspend early... the price for a decent bench
   player falls quickly. I wouldn't want to hold back on a starter in early
   rounds based on bench values that will tank." Live price early in a draft
   carries no information yet about whether THIS room's people overspend
   early, so anchoring to it would systematically over-protect budget in the
   starter phase. Anchoring to THIS ROOM's own historical bench-tier price
   instead sidesteps that bias entirely — it is a property of the room's
   past behavior, not of a single moment mid-draft.

   MECHANISM. For QB/RB/WR — the same three positions `firstBackupBoost`
   already prioritizes a first backup at (roadmap 3.6e) — the league-wide
   "first backup tier" in one historical draft is the small window of picks
   at that position landing just past the league's total STARTER demand
   (`teams * roster[pos]`), read in NOMINATION ORDER (`overall`, confirmed
   real order by roadmap 3.7's precondition —
   data-pipeline/espn_draft_order_probe.py). Their raw prices are pooled
   across seasons, RECENCY_DECAY-weighted the same way
   auction-calibration.js weights positional shares, then shrunk hard toward
   the flat $1 fallback by sample size.

   RAW PRICE, NOT A PAR-RATIO — a stated simplification, not an oversight.
   A ratio to that season's own par value would transfer better across
   player-pool shifts, but the client does not carry per-season VBD or even
   per-season teams/budget for historical drafts, so there is nothing to
   ratio against. This assumes the room's total budget hasn't changed across
   the pooled seasons — most leagues are stable on this; one that changed
   budget mid-history gets a skewed number, a real accepted limitation.

   SPARSER THAN POSITIONAL-SHARE CALIBRATION, ON PURPOSE, AND SHRUNK
   ACCORDINGLY. `calibrateAuction` pools ~20-30 priced picks per position per
   SEASON; this pools only the WINDOW (a few) per position per season — an
   order of magnitude sparser. Its MIN_PICKS/SHRINK_K0 do not transfer
   numerically, so this uses its own, more conservative constants. Most
   leagues import only 1-2 seasons of history today, so this will typically
   land below MIN_PICKS and correctly fall back to $1 — the honest behavior,
   not a defect.
   ===================================================================== */

/** Ranks past the league's starter-demand threshold pooled per season —
 *  the "first backup tier" window, not a single point (more picks per
 *  season without reaching into what's clearly second- or third-string). */
export const BENCH_WINDOW = 3;

/** Below this many pooled (RECENCY_DECAY-weighted) window picks at a
 *  position, there isn't enough signal to move off the $1 fallback at all —
 *  roughly 2 seasons' worth, given ~BENCH_WINDOW picks/season. */
export const BENCH_RESERVE_MIN_PICKS = 6;

/** Shrink prior strength, in units of pooled window picks. Deliberately a
 *  SEPARATE constant from auction-calibration.js's SHRINK_K0 (40) — that
 *  constant was tuned against a pool an order of magnitude denser than this
 *  one, so reusing it numerically would under-shrink a much noisier signal. */
export const BENCH_RESERVE_SHRINK_K0 = 12;

/** Same recency weighting auction-calibration.js uses for positional
 *  shares — a league's turnover in WHO sets prices applies here too. */
const BENCH_RESERVE_DECAY = 0.8;

/**
 * This room's historical bench-tier price per position, from stored prior
 * drafts. `draftPicks` — [{ pos, bid, overall, season }], the same shape
 * `settings.keeperImport.draftPicks` already carries (ESPN only; Yahoo/paste
 * import supply no nomination order and are excluded from this signal,
 * though they still feed `auction-calibration.js`'s position-share model,
 * which doesn't need order).
 *
 * @returns { reserve, usable, sample, notes } — `reserve[pos]` is a dollar
 *          amount, `usable` false means every position fell back to $1 (the
 *          normal case for a league with little imported history).
 */
export function historicalBenchReserve(draftPicks, { teams, roster } = {}) {
  const fallback = {};
  for (const pos of BACKUP_BOOST_POSITIONS) fallback[pos] = 1;
  if (!teams || !roster || !Array.isArray(draftPicks) || !draftPicks.length) {
    return { reserve: fallback, usable: false, sample: {}, notes: ["no prior-draft history"] };
  }

  // Group by season; a pick with no `overall` cannot be ranked in nomination
  // order and is dropped from THIS signal only (it still counts for
  // auction-calibration.js's position-share model, which needs no order).
  const bySeason = {};
  for (const p of draftPicks) {
    if (!p || !Number.isFinite(p.overall) || !Number.isFinite(p.bid) || p.bid <= 0) continue;
    const season = Number.isFinite(p.season) ? p.season : 0;
    (bySeason[season] ||= []).push(p);
  }
  const seasons = Object.keys(bySeason).map(Number).sort((a, b) => b - a);
  if (!seasons.length) {
    return { reserve: fallback, usable: false, sample: {},
             notes: ["no ordered prior-draft picks (overall pick number missing)"] };
  }
  const newest = seasons[0];

  const reserve = {};
  const sample = {};
  for (const pos of BACKUP_BOOST_POSITIONS) {
    const threshold = teams * (roster[pos] || 0);
    if (threshold <= 0) { reserve[pos] = 1; sample[pos] = 0; continue; }

    let wSum = 0, priceSum = 0, n = 0;
    for (const season of seasons) {
      const picks = bySeason[season]
        .filter((p) => p.pos === pos)
        .sort((a, b) => a.overall - b.overall);
      const windowPicks = picks.slice(threshold, threshold + BENCH_WINDOW);
      if (!windowPicks.length) continue;
      const w = Math.pow(BENCH_RESERVE_DECAY, newest - season);
      for (const p of windowPicks) { wSum += w; priceSum += w * p.bid; n++; }
    }
    sample[pos] = n;
    if (n < BENCH_RESERVE_MIN_PICKS || wSum <= 0) { reserve[pos] = 1; continue; }

    const observed = priceSum / wSum;
    // Same empirical-Bayes shrink-toward-fallback shape auction-calibration.js
    // uses for positional shares (there toward 1x neutral; here toward $1).
    const shrunk = 1 + (observed - 1) * (n / (n + BENCH_RESERVE_SHRINK_K0));
    reserve[pos] = Math.max(1, Math.round(shrunk));
  }

  const usable = BACKUP_BOOST_POSITIONS.some((pos) => (sample[pos] || 0) >= BENCH_RESERVE_MIN_PICKS);
  const notes = usable ? [] : [
    `fewer than ${BENCH_RESERVE_MIN_PICKS} ordered window picks at any position ` +
    "(most leagues' 1-2 imported seasons land here) — reserve stays $1 filler",
  ];
  return { reserve, usable, sample, notes };
}

/**
 * The starter-phase reserve in real dollars: today's flat $1-per-slot
 * baseline, with the FIRST still-missing backup at each of QB/RB/WR
 * (`firstBackupBoost`'s own zero-to-one condition, reused rather than
 * re-derived) upgraded from $1 to this room's historical bench-tier price —
 * capped by however many bench/K/DST slots are actually left to spend it on.
 *
 * Deliberately NOT a DP dimension — see the module header's stated
 * approximation. This differentiates the SCALAR `reserveSpots` already
 * subtracts from budget, nothing more.
 */
export function benchReserveDollars(roster = {}, myPlayers = [], reserveSpots = 0, historical = {}) {
  if (!reserveSpots) return 0;
  const have = {};
  for (const p of myPlayers) if (p && p.pos) have[p.pos] = (have[p.pos] || 0) + 1;

  let extra = 0;
  let slotsLeft = reserveSpots;
  for (const pos of BACKUP_BOOST_POSITIONS) {
    if (slotsLeft <= 0) break;
    const starters = roster[pos] || 0;
    // Same exact-equality condition firstBackupBoost uses: zero backups yet,
    // not "under-filled" — a starter shortfall at this position isn't a
    // bench question at all.
    if (starters <= 0 || (have[pos] || 0) !== starters) continue;
    const anchor = Math.max(1, Math.round(historical[pos] ?? 1));
    if (anchor <= 1) continue;   // no differentiated signal -> stays flat $1
    extra += anchor - 1;
    slotsLeft -= 1;
  }
  return reserveSpots + extra;
}

/**
 * The best roster still reachable.
 *
 * @param slots    array of position strings for the slots still to fill, e.g.
 *                 ["QB","RB","RB","WR","WR","TE","FLEX"]. Bench excluded —
 *                 see the header.
 * @param budget   dollars available for those slots.
 * @param pool     available players.
 * @param valueOf  (player) -> number.   THE SEAM.
 * @param priceOf  (player) -> number.   Expected cost.
 * @returns { feasible, value, picks, spend }  `spend` is dollars actually
 *          allocated (<= budget); leftover is real, not an error.
 */
export function reachableRoster({ slots, budget, pool, valueOf, priceOf }) {
  const cap = Math.max(0, Math.min(MAX_BUDGET, Math.floor(budget)));
  const need = {};
  let numFlex = 0;
  for (const s of slots || []) {
    if (s === "FLEX") numFlex++;
    else need[s] = (need[s] || 0) + 1;
  }
  if (!slots || !slots.length) return { feasible: true, value: 0, picks: [], spend: 0 };

  // Candidates per position, best-value first, pruned. Sorting by value (not
  // price) is what makes the top-K cut safe: a pruned player is one the DP
  // would only ever pick as a cheap filler, and cheap filler at a STARTING
  // slot is already the losing branch.
  const byPos = {};
  for (const p of pool || []) (byPos[p.pos] ||= []).push(p);
  for (const pos of Object.keys(byPos)) {
    byPos[pos].sort((a, b) => (valueOf(b) || 0) - (valueOf(a) || 0));
    byPos[pos] = byPos[pos].slice(0, TOP_K_PER_POS);
  }

  let bestOverall = { feasible: false, value: NEG, picks: [], spend: 0 };

  for (const dist of flexDistributions(numFlex)) {
    const want = { ...need };
    for (const pos of FLEX_ELIGIBLE) if (dist[pos]) want[pos] = (want[pos] || 0) + dist[pos];

    // Per-position tables for exactly the counts this branch wants.
    const positions = Object.keys(want).filter((pos) => want[pos] > 0);
    const tables = {};
    let branchOk = true;
    for (const pos of positions) {
      const cands = byPos[pos] || [];
      if (cands.length < want[pos]) { branchOk = false; break; }   // not enough bodies
      tables[pos] = positionTable(cands, want[pos], cap, valueOf, priceOf);
    }
    if (!branchOk) continue;

    // Merge positions over the dollar dimension. cur[c] = best total value
    // using exactly c dollars across the positions merged so far.
    let cur = new Float64Array(cap + 1).fill(NEG);
    cur[0] = 0;
    const splits = [];   // per merge step, which cost went to this position
    for (const pos of positions) {
      const row = tables[pos].best[want[pos]];
      const next = new Float64Array(cap + 1).fill(NEG);
      const split = new Int32Array(cap + 1).fill(-1);
      for (let c = 0; c <= cap; c++) {
        if (cur[c] === NEG) continue;
        for (let d = 0; d + c <= cap; d++) {
          if (row[d] === NEG) continue;
          const tot = cur[c] + row[d];
          if (tot > next[c + d]) { next[c + d] = tot; split[c + d] = d; }
        }
      }
      cur = next;
      splits.push({ pos, split });
    }

    // Best total at ANY cost within budget — leftover money is fine.
    let bestC = -1, bestV = NEG;
    for (let c = 0; c <= cap; c++) if (cur[c] > bestV) { bestV = cur[c]; bestC = c; }
    if (bestC < 0 || bestV === NEG) continue;

    if (bestV > bestOverall.value) {
      // Walk the merge splits backwards to recover each position's spend.
      const picks = [];
      let c = bestC;
      for (let i = splits.length - 1; i >= 0; i--) {
        const { pos, split } = splits[i];
        const d = split[c];
        if (d < 0) break;
        picks.push(...reconstruct(byPos[pos], tables[pos], want[pos], d, priceOf));
        c -= d;
      }
      bestOverall = { feasible: true, value: bestV, picks, spend: bestC };
    }
  }

  if (!bestOverall.feasible) return { feasible: false, value: 0, picks: [], spend: 0 };
  return bestOverall;
}

/**
 * The most you can pay for this player and be no worse off than skipping him.
 *
 * Largest `p` such that
 *   valueOf(player) + reachable(slots minus his slot, budget - p, pool minus him)
 *     >= reachable(slots, budget, pool)
 *
 * Monotone in `p` (the right-hand term is non-increasing as `p` grows), so a
 * binary search is exact rather than a heuristic scan.
 *
 * Returns 0 when he does not belong on the roster at any price — which is a
 * real answer, not a failure.
 *
 * COST: two DP runs per evaluation of the predicate, times ~log2(budget)
 * evaluations. Call it for the player on the block and the handful shown,
 * not for every row of a 400-player board.
 */
export function bidCeiling({ player, slots, budget, pool, valueOf, priceOf, minBid = 1 }) {
  const cap = Math.max(0, Math.min(MAX_BUDGET, Math.floor(budget)));
  if (!player || !slots || !slots.length) return 0;

  const baseline = reachableRoster({ slots, budget: cap, pool, valueOf, priceOf });
  if (!baseline.feasible) return 0;

  // Which slot does he occupy? Prefer his own position; fall back to FLEX.
  const idxOwn = slots.indexOf(player.pos);
  const idxFlex = FLEX_ELIGIBLE.includes(player.pos) ? slots.indexOf("FLEX") : -1;
  const idx = idxOwn >= 0 ? idxOwn : idxFlex;
  if (idx < 0) return 0;   // no slot he can fill

  const restSlots = slots.slice(0, idx).concat(slots.slice(idx + 1));
  const restPool = (pool || []).filter((p) => p.id !== player.id);
  const val = valueOf(player) || 0;

  const okAt = (p) => {
    if (p > cap) return false;
    const rest = reachableRoster({
      slots: restSlots, budget: cap - p, pool: restPool, valueOf, priceOf,
    });
    if (!rest.feasible) return false;
    return val + rest.value >= baseline.value;
  };

  if (!okAt(minBid)) return 0;

  let lo = minBid, hi = cap;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (okAt(mid)) lo = mid; else hi = mid - 1;
  }
  return lo;
}

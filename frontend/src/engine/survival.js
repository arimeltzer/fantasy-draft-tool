/* =====================================================================
   SURVIVAL — P(player still available at my next pick), roadmap 3.1

   STATUS: the probabilistic core below (pSurvive/sigmaFor/expectedBest/
   survivalCosts) is TESTED BUT NOT WIRED IN. pickScore's step 9 uses a much
   simpler deterministic margin instead (nextPick - adpRank, as a fraction of
   a round) computed inline in snake-engine.js. This file keeps the fuller
   model as documented, correct infrastructure — same treatment this repo
   gives every other measured-but-not-adopted result (rookie draft capital,
   outcome-distribution follow-ups) — because the reason it was set aside is
   not that it was wrong, it is that it did not clearly earn its complexity.

   WHY IT WAS SET ASIDE. Two solidly-evidenced findings plus an architectural
   one — NOT three, see the correction below:
     1. Season-clustered robustness (added after the pooled-SE gate passed,
        because pooling 10,800 paired drafts as independent when they share
        boards within a season is optimistic) came back at mean/SE +1.59
        across 9 seasons — the pre-registered pooled bar (mean/SE >= 2)
        passed, but the more conservative one did not, and 2/9 seasons were
        negative. One season (2024, +70.1) carried a large share of the
        pooled effect.
     2. That same season was one of the thinnest for ADP coverage even AFTER
        fixing the real bug this step surfaced (adp_probe.fetch_adp had no
        429 retry, unlike every other FantasyPros loop in this pipeline —
        see git history). Missing ADP falls back to p=1 ("assume available"),
        which is sane for one missing player and a source of large uniform
        cost for an entire thin season. The fix corrected zero coverage;
        partial thinness is a smaller version of the identical mechanism.
     3. Architectural: needMult/byeClash already covered need and byes in
        pickScore before this step started. The only genuinely missing piece
        was a next-pick lookahead, and answering that does not require
        modeling uncertainty at all.

   CORRECTION, caught before it settled anywhere but this file and
   ROADMAP.md: an earlier draft cited a third finding, "the sigma sweep found
   the gate's verdict insensitive to cv across a 5x range (mean/SE
   12.5-17.1)". That number is the TEMPERATURE sweep (cv held fixed at 0.35),
   mistakenly cited as the cv sweep. The only run that ever swept multiple cv
   values was underpowered (12 seeds) and possibly predated the ADP-fetch
   fix — not clean evidence either way. σ's sensitivity is genuinely
   UNRESOLVED. The simplification does not need it: findings 1-3 above stand
   on their own.

   None of the above proves the probabilistic model is WRONG — the
   pre-registered gate did clear. It proves the strongest result concentrates
   in the season most exposed to the exact fragility that produced a false
   result earlier in the same investigation, and that a simpler mechanism
   reusing already-shipped, already-validated signals captures the same "who
   will not last" direction with far less surface area to get wrong.
   Parsimony decides it, same as 0.2's slot configs.

   The snake question is not "who is best" but "who will not last". Two
   players of equal value are not equal choices: if one will still be there
   in two rounds and the other will not, taking the one who would have
   survived burns the pick on someone you could have had for free. That
   question is still answered — just not by what's below.

   THE OBJECTIVE IS INJECTED, NOT INLINED (roadmap restructure). Every
   function here takes `valueOf(player) -> number`. Nothing here knows or
   cares what value means. This held for the shipped simplification too:
   the margin multiplies `base`, which is computed from whatever valueOf
   pickScore's caller used.
   ===================================================================== */

/**
 * Abramowitz & Stegun 7.1.26 — max error ~1.5e-7, which is several orders
 * of magnitude finer than anything downstream can resolve. Written out
 * rather than pulled from a dependency: the whole engine ships to the
 * browser and this is ten lines.
 */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF. */
export function normCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Dispersion of a player's actual draft position, in picks.
 *
 * NOTE THIS IS MODELLED, NOT MEASURED, AND THE ROADMAP SAYS SO. There is no
 * ADP dispersion anywhere in this project — `fantasy_players` carries a
 * consensus `adp` with no spread, and FantasyPros publishes a mean. So `cv`
 * is not a fitted constant; roadmap 3.1 pre-registers it as SWEPT, with the
 * sensitivity of the gate result to it being the actual finding. If the gate
 * is insensitive, the number did not matter. If it is sensitive, this needs
 * real draft data before it ships.
 *
 * Form: proportional to depth, with a floor. Pick 1 is close to certain;
 * a player going around pick 100 can move twenty spots without anyone
 * blinking. A constant sigma would get both ends wrong.
 */
export function sigmaFor(adp, { cv = 0.35, floor = 2 } = {}) {
  return Math.max(floor, cv * Math.max(1, adp));
}

/**
 * P(player with this ADP is still on the board at overall pick `n`).
 *
 * Draft position is normal around ADP, truncated below at pick 1 — nobody
 * goes before the first pick, and for an elite player that truncation is a
 * meaningful share of the mass rather than a rounding detail.
 */
export function pSurvive(adp, n, opts = {}) {
  if (!Number.isFinite(adp) || !Number.isFinite(n)) return 1;
  const sigma = sigmaFor(adp, opts);
  const tail = 1 - normCdf((n - adp) / sigma);          // P(D > n)
  const below = normCdf((1 - adp) / sigma);             // P(D < 1), truncated away
  const p = tail / Math.max(1e-9, 1 - below);
  return Math.min(1, Math.max(0, p));
}

/**
 * Expected value of the best player still available to me at pick `n`.
 *
 * Exact under independence of survival events. Sort by value descending;
 * player j is the best available exactly when j survives and everyone better
 * does not:
 *
 *     E = Σ_j  V(j) · p(j) · Π_{k<j} (1 - p(k))
 *
 * Independence is an approximation and a knowing one — picks compete for the
 * same slots, so survivals are negatively correlated in reality. Modelling
 * that needs a draft-flow model this step deliberately does not have (3.2's
 * positional-run detection is where that would live).
 */
export function expectedBest(entries) {
  let running = 1, total = 0;
  for (const e of entries) {
    total += e.v * e.p * running;
    running *= (1 - e.p);
  }
  return total;
}

/**
 * The cost, per candidate, of spending this pick on them.
 *
 *   cost(i) = E[best available next pick]  −  E[best available next pick | i taken]
 *
 * This is algebraically the two-ply lookahead. Maximising `V(i) + E_next(¬i)`
 * and maximising `V(i) − cost(i)` pick the same player, because they differ
 * by `E_next(all)`, which is identical for every candidate. The subtracted
 * form is used because it is a SMALL correction on the same scale as value,
 * so it drops into `pickScore` beside the other adjustments instead of
 * swamping them with a large constant-ish term.
 *
 * Reading it: cost is ~0 for a player who will be gone anyway (taking him
 * costs your next pick nothing — he was never going to be there), and large
 * for a player who would have survived (you could have had him later and
 * spent this pick on someone who would not have lasted). It is exactly the
 * "who will not last" signal, priced.
 *
 * O(n log n): computed for every candidate in one pass via prefix sums,
 * rather than recomputing the expectation n times.
 *
 * @param candidates  available players
 * @param nextPick    overall pick number of MY next pick (null => no next
 *                    pick, e.g. the final round: nothing to preserve, so
 *                    every cost is 0 and this reduces to plain value)
 * @param adpOf       (player) -> ADP/expected draft position
 * @param valueOf     (player) -> number.  THE SEAM. VBD today, ΔP(title) later.
 * @returns Map id -> { p, cost }
 */
export function survivalCosts({ candidates, nextPick, adpOf, valueOf, sigma = {} }) {
  const out = new Map();
  if (!candidates || !candidates.length) return out;

  // No next pick — nothing to preserve for, so the lookahead term vanishes
  // entirely and this correctly degenerates to the plain-value ranking.
  if (!Number.isFinite(nextPick)) {
    for (const c of candidates) out.set(c.id, { p: 1, cost: 0 });
    return out;
  }

  const entries = candidates
    .map((c) => ({
      id: c.id,
      v: valueOf(c) || 0,
      // Clamp below 1: a candidate certain to survive would make the
      // prefix-product division below singular, and "certain" is not a
      // claim this model has the data to make anyway.
      p: Math.min(0.999999, pSurvive(adpOf(c), nextPick, sigma)),
    }))
    .sort((a, b) => b.v - a.v);

  // term_j = V(j)·p(j)·Π_{k<j}(1-p(k)); prefix[j] = Σ_{k<j} term_k
  const n = entries.length;
  const term = new Array(n);
  const prefix = new Array(n + 1);
  prefix[0] = 0;
  let running = 1;
  for (let j = 0; j < n; j++) {
    term[j] = entries[j].v * entries[j].p * running;
    prefix[j + 1] = prefix[j] + term[j];
    running *= (1 - entries[j].p);
  }
  const total = prefix[n];

  // Dropping candidate i leaves terms before i untouched and rescales every
  // term after it by 1/(1-p_i) — the factor i contributed to their prefix
  // product and no longer does.
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    const after = (total - prefix[i + 1]) / (1 - e.p);
    const without = prefix[i] + after;
    out.set(e.id, { p: e.p, cost: Math.max(0, total - without) });
  }
  return out;
}

/**
 * My next pick's overall number under plain serpentine order.
 *
 * `myPickNumbers()` in snake-engine is the real source of truth once traded
 * picks exist; this is the simulator-side convenience for the untraded case.
 * Returns null in the final round — there is no next pick to preserve.
 */
export function nextPickNumber(round, teams, slot, rounds = 15) {
  if (round >= rounds) return null;
  const r = round + 1;
  return r % 2 === 1 ? (r - 1) * teams + slot : r * teams - slot + 1;
}

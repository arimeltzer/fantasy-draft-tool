#!/usr/bin/env node
/**
 * Selftest — survival.js (roadmap 3.1)
 *
 * The load-bearing test here is `survivalCosts` against a brute-force
 * recomputation. The shipped version computes every candidate's cost in one
 * O(n log n) pass using prefix sums and a division by (1-p_i); the definition
 * says "drop candidate i and recompute the whole expectation". Those must
 * agree to floating point, or the optimisation is quietly answering a
 * different question than the one documented.
 */
import {
  normCdf, sigmaFor, pSurvive, expectedBest, survivalCosts, nextPickNumber,
} from "./survival.js";

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { console.error(`✗ ${msg}`); failed++; } };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) < eps, `${msg} (got ${a}, want ${b})`);

/* ---------------------------------------------------------------- normCdf */
near(normCdf(0), 0.5, 1e-9, "normCdf(0) = 0.5");
near(normCdf(1.96), 0.975, 1e-4, "normCdf(1.96) ≈ 0.975");
near(normCdf(-1.96), 0.025, 1e-4, "normCdf(-1.96) ≈ 0.025");
near(normCdf(1) - normCdf(-1), 0.6827, 1e-3, "±1σ ≈ 68.27%");
ok(normCdf(-8) >= 0 && normCdf(8) <= 1, "normCdf stays in [0,1] in the tails");

/* --------------------------------------------------------------- sigmaFor */
ok(sigmaFor(1, { cv: 0.35, floor: 2 }) === 2, "sigma floor binds at the top of the board");
near(sigmaFor(100, { cv: 0.35, floor: 2 }), 35, 1e-9, "sigma = cv × adp when above the floor");
ok(sigmaFor(200) > sigmaFor(50), "sigma grows with depth");

/* --------------------------------------------------------------- pSurvive */
ok(pSurvive(10, 5) > 0.9, "a pick-10 player is very likely to survive to pick 5");
ok(pSurvive(10, 40) < 0.05, "a pick-10 player is very unlikely to survive to pick 40");
near(pSurvive(50, 50), 0.5, 0.02, "at n = adp, survival ≈ 0.5");
{
  // Monotone decreasing in n, for a fixed player.
  let mono = true;
  for (let n = 1; n < 120; n++) if (pSurvive(60, n + 1) > pSurvive(60, n) + 1e-12) mono = false;
  ok(mono, "pSurvive is monotone decreasing in pick number");
}
{
  // Monotone increasing in adp, at a fixed pick.
  let mono = true;
  for (let a = 1; a < 120; a++) if (pSurvive(a, 60) > pSurvive(a + 1, 60) + 1e-12) mono = false;
  ok(mono, "pSurvive is monotone increasing in ADP (later ADP = likelier to last)");
}
ok(pSurvive(1, 1) <= 1 && pSurvive(1, 1) >= 0, "pSurvive(1,1) stays in [0,1] under truncation");
ok(pSurvive(NaN, 10) === 1, "unknown ADP degrades to 'assume available' rather than NaN");

/* ------------------------------------------------------------ expectedBest */
{
  // Hand-computed: two candidates, values 100 and 50, survival 0.5 and 1.0.
  //   E = 100(0.5) + 50(1.0)(1-0.5) = 50 + 25 = 75
  const e = expectedBest([{ v: 100, p: 0.5 }, { v: 50, p: 1 }]);
  near(e, 75, 1e-9, "expectedBest matches the hand-computed two-candidate case");
}
near(expectedBest([]), 0, 1e-12, "expectedBest of nothing is 0");
near(expectedBest([{ v: 42, p: 1 }]), 42, 1e-12, "a single certain candidate returns its value");
near(expectedBest([{ v: 42, p: 0 }]), 0, 1e-12, "a candidate who never survives contributes 0");

/* ----------------------------------------------------------- survivalCosts */
const valueOf = (p) => p.vbd;
const adpOf = (p) => p.adp;
const mkPool = () => ([
  { id: "a", vbd: 120, adp: 3 },
  { id: "b", vbd: 110, adp: 8 },
  { id: "c", vbd: 100, adp: 30 },
  { id: "d", vbd: 90,  adp: 55 },
  { id: "e", vbd: 80,  adp: 90 },
  { id: "f", vbd: 70,  adp: 140 },
]);

{
  const pool = mkPool();
  const costs = survivalCosts({ candidates: pool, nextPick: 25, adpOf, valueOf });
  ok(costs.size === pool.length, "a cost is returned for every candidate");
  for (const [id, r] of costs) ok(r.cost >= -1e-9, `cost is non-negative for ${id}`);
}

{
  // THE test: prefix-sum shortcut vs the literal definition.
  const pool = mkPool();
  const nextPick = 25;
  const sigma = {};
  const costs = survivalCosts({ candidates: pool, nextPick, adpOf, valueOf, sigma });

  const entries = pool
    .map((c) => ({ id: c.id, v: valueOf(c), p: Math.min(0.999999, pSurvive(adpOf(c), nextPick, sigma)) }))
    .sort((a, b) => b.v - a.v);
  const full = expectedBest(entries);

  let worst = 0;
  for (const c of pool) {
    const bruteWithout = expectedBest(entries.filter((e) => e.id !== c.id));
    const bruteCost = full - bruteWithout;
    worst = Math.max(worst, Math.abs(bruteCost - costs.get(c.id).cost));
  }
  ok(worst < 1e-9, `prefix-sum costs equal brute-force recomputation (max diff ${worst})`);
}

{
  // Direction of the whole idea: between two equally valuable players, the one
  // who would have survived costs more to take now.
  const pool = [
    { id: "gone",  vbd: 100, adp: 5 },    // will not last to pick 40
    { id: "stays", vbd: 100, adp: 200 },  // certain to last
    { id: "filler", vbd: 60, adp: 210 },
  ];
  const costs = survivalCosts({ candidates: pool, nextPick: 40, adpOf, valueOf });
  ok(
    costs.get("stays").cost > costs.get("gone").cost,
    "taking a player who would have survived costs more than taking one who would not",
  );
  ok(costs.get("gone").cost < 1, "a player certain to be gone costs ~nothing to take now");
}

{
  // No next pick (final round): nothing to preserve, so the lookahead vanishes
  // and ranking must fall back to plain value.
  const pool = mkPool();
  const costs = survivalCosts({ candidates: pool, nextPick: null, adpOf, valueOf });
  let allZero = true;
  for (const [, r] of costs) if (r.cost !== 0) allZero = false;
  ok(allZero, "no next pick => every cost is 0 (degenerates to plain value)");
}

{
  const costs = survivalCosts({ candidates: [], nextPick: 20, adpOf, valueOf });
  ok(costs.size === 0, "empty candidate list returns an empty map");
}

{
  // THE SEAM: valueOf is genuinely injected, not VBD hardcoded anywhere.
  // Reversing the value function must change which candidate is expensive.
  const pool = mkPool();
  const byVbd = survivalCosts({ candidates: pool, nextPick: 60, adpOf, valueOf });
  const byInverse = survivalCosts({
    candidates: pool, nextPick: 60, adpOf, valueOf: (p) => 200 - p.vbd,
  });
  let differs = false;
  for (const [id, r] of byVbd) if (Math.abs(r.cost - byInverse.get(id).cost) > 1e-6) differs = true;
  ok(differs, "swapping valueOf changes the costs — the objective is injected, not inlined");
}

{
  // Sigma is a real knob (roadmap 3.1 sweeps it). A tighter room should make a
  // top player's survival to a distant pick even less likely.
  const tight = pSurvive(10, 30, { cv: 0.10 });
  const loose = pSurvive(10, 30, { cv: 0.80 });
  ok(loose > tight, "a noisier room (higher cv) makes an early player likelier to last");
}

/* ------------------------------------------------------- nextPickNumber */
// 10-team, slot 3: round 1 = pick 3, round 2 = pick 18, round 3 = pick 23.
ok(nextPickNumber(1, 10, 3, 15) === 18, "slot 3 of 10, after round 1, next pick is 18");
ok(nextPickNumber(2, 10, 3, 15) === 23, "slot 3 of 10, after round 2, next pick is 23");
ok(nextPickNumber(15, 10, 3, 15) === null, "final round has no next pick");
// Slot 1 and slot `teams` are the turn ends — the tightest and loosest waits.
ok(nextPickNumber(1, 10, 1, 15) === 20, "slot 1 waits the longest (1 -> 20)");
ok(nextPickNumber(1, 10, 10, 15) === 11, "slot 10 picks back-to-back (10 -> 11)");

/* ------------------------------------------------------------------ done */
console.log(`\n✓ survival: passed ${passed} / ${passed + failed}`);
if (failed) process.exit(1);

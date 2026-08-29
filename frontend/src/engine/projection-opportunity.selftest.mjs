/* Node-runnable fixture tests for projection-opportunity.js —
 * `node projection-opportunity.selftest.mjs`.
 * Mirrors data-pipeline/projection_opportunity.py's own selftest coverage
 * (in data-pipeline/backtest_selftest.py); `opportunity_parity.py` asserts
 * the two stay numerically identical on the one field that matters, `proj`.
 */
import { DEFAULT_PARAMS } from "./engine-core.js";
import {
  OPPORTUNITY_K, applyOpportunityModel, computeLeagueEfficiency, opportunity,
  projectPointsOpportunity,
} from "./projection-opportunity.js";

let pass = 0, fail = 0;
function eq(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error(`✗ ${msg}\n    got  ${g}\n    want ${w}`); }
}
function ok(cond, msg, detail = "") {
  if (cond) { pass++; } else { fail++; console.error(`✗ ${msg}${detail ? "  " + detail : ""}`); }
}
function approx(a, b, tol = 1e-9) { return Math.abs(a - b) <= tol; }

const SC = { ptsPerPassYd: 0.04, ptsPerPassTD: 4, ptsPerInt: -2, ptsPerRushYd: 0.1, ptsPerRushTD: 6,
             ptsPerRec: 0.5, ptsPerRecYd: 0.1, ptsPerRecTD: 6, ptsPerFumble: -2, ptsPerCompletion: 0 };

// ── opportunity(): field sums per position ──────────────────────────────
eq(opportunity({ carries: 15, targets: 5 }, "RB"), 20, "RB sums carries+targets");
eq(opportunity({ targets: 8, carries: 99 }, "WR"), 8, "WR sums targets only");
eq(opportunity({ attempts: 30, carries: 4 }, "QB"), 34, "QB sums attempts+carries");
eq(opportunity({ carries: 15 }, "K"), 0, "no opportunity concept -> 0");
eq(opportunity(null, "RB"), 0, "missing line -> 0");

// ── computeLeagueEfficiency: pooled points-per-opportunity ──────────────
const rateRows = Array.from({ length: 10 }, (_, i) => ({
  pos: "TE", last: { targets: 100, recYd: 700, recTD: 5, gp: 17 },
  last2: i === 0 ? { targets: 50, recYd: 300, recTD: 2, gp: 17 } : null,
}));
const rates = computeLeagueEfficiency(rateRows, SC);
ok(!!rates.TE, "TE rate computed from a pooled sample");
const expectedTotalPts = 10 * (0.1 * 700 + 6 * 5) + (0.1 * 300 + 6 * 2);
const expectedTotalOpp = 10 * 100 + 50;
ok(approx(rates.TE.rate, expectedTotalPts / expectedTotalOpp),
   "league_efficiency computes points-per-opportunity", JSON.stringify(rates.TE));
ok(!rates.K, "a position with no opportunity concept has no rate at all");

// ── projectPointsOpportunity: fallback and shrinkage ─────────────────────
const kicker = { pos: "K", age: 28, last: { gp: 17 }, last2: null };
eq(projectPointsOpportunity(kicker, SC, rates, 2.0, DEFAULT_PARAMS), null,
   "a position with no opportunity concept -> null (caller falls back)");

const rookie = { pos: "TE", age: 23, last: null, last2: null };
eq(projectPointsOpportunity(rookie, SC, rates, 2.0, DEFAULT_PARAMS), null,
   "a true rookie (no prior volume) -> null");

const lucky = { pos: "TE", age: 25,
  last: { gp: 17, targets: 100, recYd: 500, recTD: 12 }, last2: null };
const k0 = projectPointsOpportunity(lucky, SC, rates, 0.0, DEFAULT_PARAMS);
ok(k0 && approx(k0.efficiency, k0.ownEfficiency), "k=0 uses the player's own unshrunk rate exactly",
   JSON.stringify(k0));
const k4 = projectPointsOpportunity(lucky, SC, rates, 4.0, DEFAULT_PARAMS);
ok(Math.abs(k4.efficiency - rates.TE.rate) < Math.abs(k0.efficiency - rates.TE.rate),
   "more shrinkage pulls a lucky rate toward the league average",
   `k0=${k0.efficiency} k4=${k4.efficiency} league=${rates.TE.rate}`);

const bigSample = { pos: "TE", age: 25,
  last: { gp: 17, targets: 400, recYd: 2000, recTD: 40 }, last2: null };
const smallSample = { pos: "TE", age: 25,
  last: { gp: 17, targets: 25, recYd: 125, recTD: 5 }, last2: null };
const bigK1 = projectPointsOpportunity(bigSample, SC, rates, 1.0, DEFAULT_PARAMS);
const smallK1 = projectPointsOpportunity(smallSample, SC, rates, 1.0, DEFAULT_PARAMS);
ok(Math.abs(bigK1.efficiency - bigK1.ownEfficiency) < Math.abs(smallK1.efficiency - smallK1.ownEfficiency),
   "a big sample is shrunk proportionally less than a small one",
   `400 targets moved ${Math.abs(bigK1.efficiency - bigK1.ownEfficiency).toFixed(4)}, ` +
   `25 targets moved ${Math.abs(smallK1.efficiency - smallK1.ownEfficiency).toFixed(4)}`);

// ── applyOpportunityModel: coverage + pipeline shape ──────────────────────
{
  const mk = (id, pos, vp, last) => ({ id, pos, age: 25, valuePoints: vp, last, last2: null });
  const pool = [
    mk("te1", "TE", 100, { gp: 17, targets: 100, recYd: 700, recTD: 5 }), // usable -> replaced
    mk("te2", "TE", 50, null),                                             // rookie -> untouched
    mk("rb1", "RB", 200, { gp: 17, carries: 250, rushYd: 1200, rushTD: 8 }), // K=0 for RB -> untouched
  ];
  const out = applyOpportunityModel(pool, SC, OPPORTUNITY_K, DEFAULT_PARAMS);
  const by = Object.fromEntries(out.map((p) => [p.id, p]));
  ok(by.te1.valuePoints !== 100 && by.te1.opportunityBased === true,
     "a usable TE gets replaced by the opportunity model", JSON.stringify(by.te1));
  eq(by.te2.valuePoints, 50, "a TE with no usable volume passes through untouched");
  eq(by.rb1.valuePoints, 200, "RB stays at K=0 -> untouched (didn't clear the gate)");

  const allZero = applyOpportunityModel(pool, SC, { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 });
  ok(allZero === pool, "every K at 0 short-circuits to the identical array (no-op, not just no-change)");
}

console.log(`\nprojection-opportunity.selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

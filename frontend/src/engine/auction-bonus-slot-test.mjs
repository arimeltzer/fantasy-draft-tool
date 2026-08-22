/**
 * auction-bonus-slot-test.mjs — roadmap 3.8's pre-registered stratified gate.
 * =========================================================================
 * THE QUESTION. Does jointly valuing "the last starter at a 2+-starter
 * position" together with "the bench slot that follows it"
 * ("treatment-bonus") draft better rosters than pricing that last starter
 * alone ("treatment" — 3.3's shipped DP, unaugmented)? See
 * docs/ROADMAP.md 3.8 for the full pre-registration; do not change the
 * mechanics below without updating that record first.
 *
 * UNLIKE 3.7's GATE, no simulated "historical" data needs building here —
 * `withBonusBackupSlots` derives everything from the CURRENT pool and
 * roster shape, nothing external. This is the whole reason the mechanism
 * is a cleaner fix than 3.7's: no anchor data, no sample-size problem, no
 * shrinkage constants to get wrong.
 *
 * STRATIFIED into the same calm / early-overspend buckets 3.7 used (via
 * auction-sim.mjs's existing `botNoise` knob) — not because a directional
 * bias is specifically predicted here, but for consistency with the
 * sibling step and because the harness already supports it at no extra
 * cost. See auction-bench-test.mjs's header for why these two botNoise
 * values stand in for the scenario.
 *
 * SCORING: realizedWeeklyPoints (real byes, real per-week outcomes) — the
 * same bye-coverage-only yardstick every gate in this phase uses. Per its
 * own stated limitation, blind to injury/inactive substitution.
 *
 * PRE-REGISTERED BAR (docs/ROADMAP.md 3.8): mean/SE > 2 on realized weekly
 * points, IN EACH BUCKET SEPARATELY.
 *
 *   node frontend/src/engine/auction-bonus-slot-test.mjs --data results/draft_seasons.json
 */
import { readFileSync } from "node:fs";
import { projectAll, finalizeBoard, marketAnchor, defaultScoring, MARKET_ANCHOR_W }
  from "./engine-core.js";
import { pairedCompareAuction } from "./auction-sim.mjs";

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const DATA = argOf("data", "results/draft_seasons.json");
const TEAMS = Number(argOf("teams", 10));
const BUDGET = Number(argOf("budget", 200));
const SEEDS = Number(argOf("seeds", 10));
const WEEKS = Number(argOf("weeks", 17));
const SLOTS = argOf("slots", "").split(",").filter(Boolean).map(Number);

const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 };
const LEAGUE = { teams: TEAMS, roster: ROSTER, superflex: false };

const raw = JSON.parse(readFileSync(DATA, "utf8"));
const sc = defaultScoring(0.5);
const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);

function boardFor(season) {
  const players = raw[season].players.map((p) => ({
    ...p, proj: {}, ecr: p.adp ?? undefined, adp: p.adp ?? undefined,
  }));
  let scored = projectAll(players, sc);
  scored = marketAnchor(scored, MARKET_ANCHOR_W);
  return finalizeBoard(scored, LEAGUE);
}

// calm vs early-overspend — same two botNoise values 3.7's gate used, for
// consistency (see auction-bench-test.mjs's header for the reasoning).
const SCENARIOS = { calm: 0.05, "early-overspend": 0.35 };

function stats(diffs) {
  const n = diffs.length;
  if (!n) return null;
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, se, t: se > 0 ? mean / se : 0, wins: diffs.filter((d) => d > 0).length };
}

function report(label, diffs) {
  const r = stats(diffs);
  if (!r) { console.log(`\n${label}: no data`); return null; }
  console.log(`\n${label}`);
  console.log(`  auctions simulated : ${r.n}`);
  console.log(`  mean difference     : ${r.mean >= 0 ? "+" : ""}${r.mean.toFixed(2)} realized pts`);
  console.log(`  standard error      : ${r.se.toFixed(2)}`);
  console.log(`  mean / SE           : ${r.t.toFixed(2)}  ${Math.abs(r.t) > 2
    ? "(distinguishable from noise)" : "(NOT distinguishable from noise)"}`);
  console.log(`  wins                : ${r.wins}/${r.n}`);
  return r;
}

const buckets = {};
for (const scenario of Object.keys(SCENARIOS)) buckets[scenario] = [];

console.log(`3.8 gate — ${SEEDS} seeds/slot, $${BUDGET} budget, scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
console.log("scored on REALIZED weekly lineups (bye-coverage half only)\n");

for (const evalSeason of Object.keys(raw).map(Number).sort()) {
  const s = raw[evalSeason];
  if (!s.weekly || !s.byes || !Object.keys(s.weekly).length) {
    console.log(`${evalSeason}: no weekly/bye data exported — skipped`);
    continue;
  }
  const board = boardFor(evalSeason);
  const projById = Object.fromEntries(board.map((p) => [p.id, p.valuePoints ?? p.vbd ?? 0]));

  for (const [scenario, botNoise] of Object.entries(SCENARIOS)) {
    const slotsToRun = SLOTS.length ? SLOTS : Array.from({ length: TEAMS }, (_, i) => i + 1);
    const perSlot = [];
    for (const slot of slotsToRun) {
      const r = pairedCompareAuction({
        board, pointsById: projById, roster: ROSTER, teams: TEAMS, budget: BUDGET,
        agentTeam: slot - 1, botNoise, seeds,
        modeA: "treatment", modeB: "treatment-bonus",
        weeklyActual: s.weekly, byeByTeam: s.byes, weeks: WEEKS,
      });
      perSlot.push(r);
      buckets[scenario].push(...r.rows.map((row) => row.diff));
    }
    const mean = perSlot.reduce((sum, r) => sum + r.meanDiff, 0) / Math.max(1, perSlot.length);
    console.log(`${evalSeason} [${scenario}]  treatment-bonus vs treatment: `
      + `${mean >= 0 ? "+" : ""}${mean.toFixed(1)} pts`);
  }
}

console.log("\n=== VERDICT (pre-registered bar: mean/SE > 2, PER BUCKET) ===");
const results = {};
for (const scenario of Object.keys(SCENARIOS)) {
  results[scenario] = report(
    `${scenario.toUpperCase()} — treatment-bonus vs shipped treatment`,
    buckets[scenario],
  );
}
for (const scenario of Object.keys(SCENARIOS)) {
  const r = results[scenario];
  if (!r) { console.log(`\n${scenario}: insufficient data.`); continue; }
  if (r.t > 2) {
    console.log(`\n${scenario}: CLEARS THE BAR — joint last-starter+bench valuation beats `
      + "pricing the starter alone here.");
  } else if (r.mean < 0 && Math.abs(r.t) > 2) {
    console.log(`\n${scenario}: WORSE than pricing the starter alone. Do not ship for this scenario.`);
  } else {
    console.log(`\n${scenario}: INDISTINGUISHABLE from pricing the starter alone. Ships nothing `
      + "for this scenario per the pre-registered bar.");
  }
}
console.log("\nNOTE: this measures the BYE-COVERAGE half of the question only (realizedWeeklyPoints");
console.log("models byes, not injury/inactive substitution). See docs/ROADMAP.md 3.8.");

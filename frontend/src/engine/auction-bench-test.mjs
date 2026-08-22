/**
 * auction-bench-test.mjs — roadmap 3.7's pre-registered stratified gate.
 * =========================================================================
 * THE QUESTION. Does anchoring the starter-phase bench reserve to THIS
 * ROOM's own historical bench-tier prices ("treatment-hist") draft better
 * rosters than today's flat $1/slot reserve ("treatment" — 3.3's shipped
 * DP, unchanged otherwise)? See docs/ROADMAP.md 3.7 for the full
 * pre-registration; do not change the mechanics below without updating
 * that record first.
 *
 * WHY STRATIFIED, NOT ONE POOLED NUMBER. A single aggregate mean/SE could
 * hide exactly the failure mode under discussion: if the historical-anchor
 * version helps in calm rooms and hurts in early-overspend rooms (or vice
 * versa), those could average out to a result that looks fine while being
 * wrong in the specific scenario this step exists for. So two scenario
 * buckets are reported separately, each held to its own bar.
 *
 * BUCKETS BUILT FROM EXISTING KNOBS ONLY — the pre-registration's own
 * instruction, not new machinery. Nomination order is fixed by static
 * dollar value descending (auction-sim.mjs), so the earliest nominations
 * ARE the highest-value players; `botNoise` is multiplicative
 * (`wtp = market * mult * noise`), so turning it up concentrates its
 * LARGEST dollar deviations on exactly those early, expensive nominations
 * — the "most bidders overspend early" dynamic the user named, produced
 * from the sweep parameter auction-sim-test.mjs (3.5) already exercises,
 * not a new "timing" knob invented for this gate.
 *   calm            — botNoise = 0.05, bots price close to baseline.
 *   early-overspend — botNoise = 0.35, the upper end of 3.5's own sweep.
 *
 * HOW THE "HISTORICAL" RESERVE IS BUILT, SELF-CONTAINED. For each
 * evaluation season, up to `--hist-seasons` PRIOR seasons in the same
 * dataset are each run once as a full simulated auction (same bot
 * scenario, agentTeam plays "control" — its own arm barely matters, the
 * reserve pools the WHOLE league's picks, not one team's). Each run's
 * `log` is already in nomination order (simulateAuction pushes sales in
 * the order they're nominated), so `overall = log index + 1` feeds
 * `historicalBenchReserve` directly — no separate ordering step needed.
 * This stands in for "the room's own prior-season ESPN draft", the real
 * data source `historicalBenchReserve` is built to consume.
 *
 * SCORING: realizedWeeklyPoints (real byes, real per-week outcomes — see
 * auction-sim.mjs's presence-gated upgrade), the SAME bye-coverage-only
 * yardstick 2.4 validated on the snake side, applied to the auction side
 * for the first time. Per its own stated limitation, an injured/inactive
 * starter is still started and scores his real 0 — this gate measures the
 * BYE-COVERAGE half of "is it worth reserving more for bench" and is BLIND
 * to the INJURY-INSURANCE half (the half the user actually named as their
 * priority). Read any result here as a LOWER BOUND, not the whole answer.
 *
 * PRE-REGISTERED BAR (docs/ROADMAP.md 3.7): mean/SE > 2 on realized weekly
 * points, IN EACH BUCKET SEPARATELY. A result inside that bar in either
 * bucket ships nothing FOR THAT SCENARIO.
 *
 *   node frontend/src/engine/auction-bench-test.mjs --data results/draft_seasons.json
 */
import { readFileSync } from "node:fs";
import { projectAll, finalizeBoard, marketAnchor, defaultScoring, MARKET_ANCHOR_W }
  from "./engine-core.js";
import { simulateAuction, pairedCompareAuction } from "./auction-sim.mjs";
import { historicalBenchReserve } from "./budget-path.js";

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const DATA = argOf("data", "results/draft_seasons.json");
const TEAMS = Number(argOf("teams", 10));
const BUDGET = Number(argOf("budget", 200));
const SEEDS = Number(argOf("seeds", 10));
const WEEKS = Number(argOf("weeks", 17));
const HIST_SEASONS = Number(argOf("hist-seasons", 2));
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

// calm vs early-overspend — see header for why these two botNoise values
// stand in for the scenario without inventing a new parameter.
const SCENARIOS = { calm: 0.05, "early-overspend": 0.35 };

/** This room's `benchReserve`, built from up to HIST_SEASONS prior seasons
 *  of a simulated draft under the SAME scenario's bot behavior. Returns
 *  `{ reserve, usable, seasonsUsed }`. */
function historyFor(evalSeason, botNoise, seedBase) {
  const priorSeasons = Object.keys(raw).map(Number)
    .filter((s) => s < evalSeason)
    .sort((a, b) => b - a)
    .slice(0, HIST_SEASONS);
  const picks = [];
  for (const season of priorSeasons) {
    const board = boardFor(season);
    const run = simulateAuction({
      board, teams: TEAMS, roster: ROSTER, budget: BUDGET,
      agentTeam: 0, agentMode: "control", botNoise, seed: seedBase + season,
    });
    run.log.forEach((entry, i) => {
      picks.push({ pos: entry.pos, bid: entry.price, overall: i + 1, season });
    });
  }
  const hist = historicalBenchReserve(picks, { teams: TEAMS, roster: ROSTER });
  return { ...hist, seasonsUsed: priorSeasons };
}

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

console.log(`3.7 gate — ${SEEDS} seeds/slot, $${BUDGET} budget, hist-seasons=${HIST_SEASONS}, `
  + `scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
console.log("scored on REALIZED weekly lineups (bye-coverage half only — see header)\n");

for (const evalSeason of Object.keys(raw).map(Number).sort()) {
  const s = raw[evalSeason];
  if (!s.weekly || !s.byes || !Object.keys(s.weekly).length) {
    console.log(`${evalSeason}: no weekly/bye data exported — skipped`);
    continue;
  }
  const board = boardFor(evalSeason);
  const projById = Object.fromEntries(board.map((p) => [p.id, p.valuePoints ?? p.vbd ?? 0]));

  for (const [scenario, botNoise] of Object.entries(SCENARIOS)) {
    const hist = historyFor(evalSeason, botNoise, 9000);
    if (!hist.seasonsUsed.length) {
      console.log(`${evalSeason} [${scenario}]: no PRIOR season in this dataset — skipped (nothing to anchor on)`);
      continue;
    }

    const slotsToRun = SLOTS.length ? SLOTS : Array.from({ length: TEAMS }, (_, i) => i + 1);
    const perSlot = [];
    for (const slot of slotsToRun) {
      const r = pairedCompareAuction({
        board, pointsById: projById, roster: ROSTER, teams: TEAMS, budget: BUDGET,
        agentTeam: slot - 1, botNoise, seeds,
        modeA: "treatment", modeB: "treatment-hist",
        benchReserve: hist.reserve,
        weeklyActual: s.weekly, byeByTeam: s.byes, weeks: WEEKS,
      });
      perSlot.push(r);
      buckets[scenario].push(...r.rows.map((row) => row.diff));
    }
    const mean = perSlot.reduce((sum, r) => sum + r.meanDiff, 0) / Math.max(1, perSlot.length);
    console.log(`${evalSeason} [${scenario}]  hist usable=${hist.usable} `
      + `(seasons ${hist.seasonsUsed.join(",")}, QB/RB/WR reserve `
      + `${hist.reserve.QB}/${hist.reserve.RB}/${hist.reserve.WR})  `
      + `treatment-hist vs treatment: ${mean >= 0 ? "+" : ""}${mean.toFixed(1)} pts`);
  }
}

console.log("\n=== VERDICT (pre-registered bar: mean/SE > 2, PER BUCKET) ===");
const results = {};
for (const scenario of Object.keys(SCENARIOS)) {
  results[scenario] = report(
    `${scenario.toUpperCase()} — treatment-hist vs shipped treatment (flat $1 reserve)`,
    buckets[scenario],
  );
}
for (const scenario of Object.keys(SCENARIOS)) {
  const r = results[scenario];
  if (!r) { console.log(`\n${scenario}: insufficient data.`); continue; }
  if (r.t > 2) {
    console.log(`\n${scenario}: CLEARS THE BAR — the historical-anchor reserve beats the flat `
      + "$1 reserve here.");
  } else if (r.mean < 0 && Math.abs(r.t) > 2) {
    console.log(`\n${scenario}: WORSE than the flat $1 reserve. Do not ship for this scenario.`);
  } else {
    console.log(`\n${scenario}: INDISTINGUISHABLE from the flat $1 reserve. Ships nothing for `
      + "this scenario per the pre-registered bar.");
  }
}
console.log("\nNOTE: this measures the BYE-COVERAGE half of the reservation question only");
console.log("(realizedWeeklyPoints models byes, not injury/inactive substitution) — a LOWER");
console.log("BOUND on the value of smarter reservation, not the whole answer. See docs/ROADMAP.md 3.7.");

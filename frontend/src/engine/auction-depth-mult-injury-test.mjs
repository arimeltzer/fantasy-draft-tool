/**
 * auction-depth-mult-injury-test.mjs — 3.6f-injury-check, auction side.
 * =======================================================================
 * Same diagnostic as snake-bench-depth-injury-test.mjs — see that file's
 * header for the full design-issue writeup — applied to the AUCTION side
 * of 3.6f, whose gate FAILED (reverted from AuctionRoom.tsx) under the
 * plain no-injury harness. "treatment-depth" mode still lives in
 * auction-sim.mjs as dead code specifically so this re-test could run
 * without re-adding anything to the shipped room.
 *
 * ONE oracle is built per season, reused across every scenario/slot/seed —
 * required so a real player shared by both arms' rosters draws the
 * identical weekly pattern in both (see makeInjuryOracle's own docstring).
 *
 * NOT a new pre-registered kill gate in its own right — a robustness check
 * on 3.6f's already-decided result, same bar for comparability (mean/SE >
 * 2 per bucket). See docs/ROADMAP.md 3.6f-injury-check.
 *
 *   node frontend/src/engine/auction-depth-mult-injury-test.mjs --data results/draft_seasons.json
 */
import { readFileSync } from "node:fs";
import { projectAll, finalizeBoard, marketAnchor, defaultScoring, MARKET_ANCHOR_W }
  from "./engine-core.js";
import { pairedCompareAuction } from "./auction-sim.mjs";
import { makeInjuryOracle, INJURY_MISS_RATE } from "./draft-sim.mjs";

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const DATA = argOf("data", "results/draft_seasons.json");
const TEAMS = Number(argOf("teams", 10));
const BUDGET = Number(argOf("budget", 200));
const SEEDS = Number(argOf("seeds", 10));
const WEEKS = Number(argOf("weeks", 17));
const SLOTS = argOf("slots", "").split(",").filter(Boolean).map(Number);
const INJURY_SEED = Number(argOf("injury-seed", 101));

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

console.log(`3.6f-injury-check (auction) — ${SEEDS} seeds/slot, $${BUDGET} budget, `
  + `scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
console.log(`injury rates: QB ${(INJURY_MISS_RATE.QB * 100).toFixed(1)}% RB ${(INJURY_MISS_RATE.RB * 100).toFixed(1)}% `
  + `WR ${(INJURY_MISS_RATE.WR * 100).toFixed(1)}% TE ${(INJURY_MISS_RATE.TE * 100).toFixed(1)}% (real, calibrated)`);
console.log("scored on REALIZED weekly lineups, WITH randomized starter unavailability\n");

for (const evalSeason of Object.keys(raw).map(Number).sort()) {
  const s = raw[evalSeason];
  if (!s.weekly || !s.byes || !Object.keys(s.weekly).length) {
    console.log(`${evalSeason}: no weekly/bye data exported — skipped`);
    continue;
  }
  const board = boardFor(evalSeason);
  const projById = Object.fromEntries(board.map((p) => [p.id, p.valuePoints ?? p.vbd ?? 0]));
  const injuryOracle = makeInjuryOracle(INJURY_SEED + evalSeason, INJURY_MISS_RATE, WEEKS);

  for (const [scenario, botNoise] of Object.entries(SCENARIOS)) {
    const slotsToRun = SLOTS.length ? SLOTS : Array.from({ length: TEAMS }, (_, i) => i + 1);
    const perSlot = [];
    for (const slot of slotsToRun) {
      const r = pairedCompareAuction({
        board, pointsById: projById, roster: ROSTER, teams: TEAMS, budget: BUDGET,
        agentTeam: slot - 1, botNoise, seeds,
        modeA: "treatment", modeB: "treatment-depth",
        weeklyActual: s.weekly, byeByTeam: s.byes, weeks: WEEKS,
        injuryOracle,
      });
      perSlot.push(r);
      buckets[scenario].push(...r.rows.map((row) => row.diff));
    }
    const mean = perSlot.reduce((sum, r) => sum + r.meanDiff, 0) / Math.max(1, perSlot.length);
    console.log(`${evalSeason} [${scenario}]  treatment-depth vs treatment (injury-aware): `
      + `${mean >= 0 ? "+" : ""}${mean.toFixed(1)} pts`);
  }
}

console.log("\n=== VERDICT (same bar as 3.6f for comparability: mean/SE > 2, PER BUCKET) ===");
const results = {};
for (const scenario of Object.keys(SCENARIOS)) {
  results[scenario] = report(
    `${scenario.toUpperCase()} — treatment-depth vs shipped treatment (injury-aware scoring)`,
    buckets[scenario],
  );
}
for (const scenario of Object.keys(SCENARIOS)) {
  const r = results[scenario];
  if (!r) { console.log(`\n${scenario}: insufficient data.`); continue; }
  if (r.t > 2) {
    console.log(`\n${scenario}: CLEARS THE BAR under injury-aware scoring — diminishing RB/WR `
      + "bench depth beats the flat bench ceiling once bench players can actually be needed.");
  } else if (r.mean < 0 && Math.abs(r.t) > 2) {
    console.log(`\n${scenario}: WORSE than the flat bench ceiling, even with injuries modeled.`);
  } else {
    console.log(`\n${scenario}: STILL indistinguishable from the flat bench ceiling, even with `
      + "real injury rates applied. That locates the null somewhere other than the no-injury "
      + "harness gap — a real finding, not a failure.");
  }
}
console.log("\nNOTE: compare directly against the same-seed, same-slots plain run from "
  + "auction-depth-mult-test.mjs — see docs/ROADMAP.md 3.6f-injury-check.");

/**
 * auction-sim-test.mjs — roadmap 3.5's kill gate for 3.3/3.4/3.4a
 * ===================================================================
 * Three shipped steps have never been measured against each other:
 *   3.3  allocation-aware bid ceilings (exact DP over remaining slots)
 *   3.4  room price ceilings (what opponents can actually pay)
 *   3.4a opponent positional demand (who is still a bidder at all)
 * All three only ever act through ONE code path — the "treatment" bid in
 * auction-sim.mjs, `min(allocationCeiling, roomCeiling)` — so this gate
 * measures them together, as shipped, not as three separate ablations.
 *
 * Unlike roadmap 0.2's per-slot configs, none of these three were FITTED to
 * any season — 3.3 is an exact DP, 3.4/3.4a are arithmetic plus stated,
 * unfitted constants (`OPP_BENCH_ALLOWANCE`, etc.). So there is no
 * in-sample/held-out split to report here; every season is an honest read.
 * What DOES need reporting, per the roadmap 3.5 pre-registration, is bot
 * pricing noise as a swept parameter rather than one convenient setting —
 * a room that prices itself perfectly makes any optimizer look artificially
 * good, so the noise level the edge survives at is the actual finding.
 *
 *   node frontend/src/engine/auction-sim-test.mjs --data results/draft_seasons.json
 */
import { readFileSync } from "node:fs";
import { projectAll, finalizeBoard, marketAnchor, defaultScoring, MARKET_ANCHOR_W }
  from "./engine-core.js";
import { pairedCompareAuction } from "./auction-sim.mjs";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const DATA = argOf("data", "results/draft_seasons.json");
const TEAMS = Number(argOf("teams", 10));
const SEEDS = Number(argOf("seeds", 10));
const BUDGET = Number(argOf("budget", 200));
const NOISE_LEVELS = argOf("noise", "0.05,0.15,0.30").split(",").map(Number);

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
  scored = marketAnchor(scored, MARKET_ANCHOR_W);   // the board the app ships
  return finalizeBoard(scored, LEAGUE);
}

console.log(`slots 1-${TEAMS}, ${SEEDS} seeds/slot, $${BUDGET} budget, `
  + `noise levels ${NOISE_LEVELS.join("/")}\n`);

// bucket[noise] = all per-draft diffs (treatment - control) across every
// season and slot at that noise level.
const bucket = {};
for (const n of NOISE_LEVELS) bucket[n] = [];

for (const season of Object.keys(raw).map(Number).sort()) {
  const board = boardFor(season);
  const pointsById = raw[season].actual;

  for (const botNoise of NOISE_LEVELS) {
    const perSlot = [];
    for (let slot = 1; slot <= TEAMS; slot++) {
      const r = pairedCompareAuction({
        board, pointsById, roster: ROSTER, teams: TEAMS, budget: BUDGET,
        agentTeam: slot - 1, botNoise, seeds,
      });
      perSlot.push({ slot, ...r });
      bucket[botNoise].push(...r.rows.map((row) => row.diff));
    }
    const mean = perSlot.reduce((s, r) => s + r.meanDiff, 0) / Math.max(1, perSlot.length);
    const wins = perSlot.filter((r) => r.meanDiff > 0).length;
    console.log(`${season}  noise ${botNoise}  treatment vs control: `
      + `${mean >= 0 ? "+" : ""}${mean.toFixed(1)} pts, `
      + `treatment better at ${wins}/${perSlot.length} slots`);
  }
}

function summarize(label, diffs) {
  if (!diffs.length) return null;
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, diffs.length - 1));
  const se = sd / Math.sqrt(diffs.length);
  const t = se > 0 ? mean / se : 0;
  console.log(`\n${label}`);
  console.log(`  auctions simulated : ${diffs.length}`);
  console.log(`  mean difference     : ${mean >= 0 ? "+" : ""}${mean.toFixed(2)} pts`);
  console.log(`  standard error      : ${se.toFixed(2)}`);
  console.log(`  mean / SE           : ${t.toFixed(2)}  ${Math.abs(t) > 2
    ? "(distinguishable from noise)" : "(NOT distinguishable from noise)"}`);
  console.log(`  treatment wins      : ${diffs.filter((d) => d > 0).length}/${diffs.length}`);
  return { mean, se, t };
}

console.log("\n=== BY NOISE LEVEL ===");
const results = {};
for (const n of NOISE_LEVELS) results[n] = summarize(`noise = ${n}`, bucket[n]);

console.log("\n=== VERDICT ===");
const allBeat = NOISE_LEVELS.every((n) => results[n] && results[n].t > 2 && results[n].mean > 0);
const anyLose = NOISE_LEVELS.some((n) => results[n] && results[n].mean < 0 && results[n].t < -2);
if (allBeat) {
  console.log("Allocation-aware bidding (3.3+3.4+3.4a) BEATS independent pricing");
  console.log("at every swept noise level. Ship it as the default bidding mode.");
} else if (anyLose) {
  console.log("Allocation-aware bidding LOSES to independent pricing at at least one");
  console.log("noise level. Do not promote it to the default without narrowing when");
  console.log("it helps.");
} else {
  console.log("Allocation-aware bidding is not clearly distinguishable from");
  console.log("independent pricing across the swept noise levels. It does not clear");
  console.log("the bar to replace suggestBid() as the default, however elegant the");
  console.log("DP is on its own terms.");
}

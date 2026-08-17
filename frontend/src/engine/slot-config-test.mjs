/**
 * slot-config-test.mjs — roadmap 0.2: do the ten per-slot configs earn their keep?
 * ================================================================================
 * `DEFAULT_SNAKE_PARAMS.SLOTS` holds ten per-draft-slot configs, ~10 parameters
 * each, fitted on 2021-2025. The grid search that produced them is not in this
 * repository, so they cannot be reproduced — only trusted. This tests them the
 * one way that is still available: out of sample.
 *
 * THE TEST. For each season and each draft slot, simulate the same league twice
 * with common random numbers, changing only whether our agent uses its per-slot
 * config or the single shared SLOT_DEFAULT. Score the resulting roster on its
 * best legal lineup of ACTUAL points. The difference is attributable to the
 * config alone.
 *
 * WHY THE SPLIT MATTERS. 2021-2025 is where the configs were fitted, so a win
 * there is not evidence of anything — an overfit model always looks good on its
 * own training data. 2017-2020 was not available to whoever tuned them, and is
 * the only honest read. The two are reported separately and a gap between them
 * IS the overfitting measurement.
 *
 * READING THE RESULT. `meanDiff` is per-season-per-slot points. Compare it to
 * `seDiff`: a mean of +3 with a standard error of +40 is not a finding. The
 * summary prints the ratio so a difference indistinguishable from draft noise
 * cannot be read as a win.
 *
 *   node frontend/src/engine/slot-config-test.mjs --data results/draft_seasons.json
 */
import { readFileSync } from "node:fs";
import { projectAll, finalizeBoard, marketAnchor, defaultScoring, MARKET_ANCHOR_W }
  from "./engine-core.js";
import { DEFAULT_SNAKE_PARAMS } from "./snake-engine.js";
import { pairedCompare } from "./draft-sim.mjs";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const DATA = argOf("data", "results/draft_seasons.json");
const TEAMS = Number(argOf("teams", 10));
const ROUNDS = Number(argOf("rounds", 15));
const SEEDS = Number(argOf("seeds", 12));
// The configs were fitted from this season onward; everything earlier is held out.
const FIT_FROM = Number(argOf("fitFrom", 2021));

const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0, BENCH: 8 };
const LEAGUE = { teams: TEAMS, roster: ROSTER, superflex: false };

const raw = JSON.parse(readFileSync(DATA, "utf8"));
const sc = defaultScoring(0.5);
const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);

/** Per-slot configs stripped out, so the agent falls back to SLOT_DEFAULT. */
const sharedOnly = JSON.parse(JSON.stringify(DEFAULT_SNAKE_PARAMS));
sharedOnly.SLOTS = {};

function boardFor(season) {
  const players = raw[season].players.map((p) => ({
    ...p, proj: {}, ecr: p.adp ?? undefined, adp: p.adp ?? undefined,
  }));
  let scored = projectAll(players, sc);
  scored = marketAnchor(scored, MARKET_ANCHOR_W);   // the board the app ships
  return finalizeBoard(scored, LEAGUE);
}

const bucket = { fitted: [], held: [] };
console.log(`slots 1-${TEAMS}, ${SEEDS} seeds/slot, ${ROUNDS} rounds\n`);

for (const season of Object.keys(raw).map(Number).sort()) {
  const board = boardFor(season);
  const pointsById = raw[season].actual;
  const where = season >= FIT_FROM ? "fitted" : "held";
  const perSlot = [];

  for (let slot = 1; slot <= TEAMS; slot++) {
    if (!DEFAULT_SNAKE_PARAMS.SLOTS[slot]) continue;
    const r = pairedCompare({
      board, pointsById, roster: ROSTER, teams: TEAMS, rounds: ROUNDS,
      slot, configA: DEFAULT_SNAKE_PARAMS, configB: sharedOnly, seeds,
    });
    perSlot.push({ slot, ...r });
    bucket[where].push(...r.rows.map((row) => row.diff));
  }

  const mean = perSlot.reduce((s, r) => s + r.meanDiff, 0) / Math.max(1, perSlot.length);
  const wins = perSlot.filter((r) => r.meanDiff > 0).length;
  console.log(`${season} [${where === "fitted" ? "IN-SAMPLE" : "held out"}] `
    + `per-slot vs shared: ${mean >= 0 ? "+" : ""}${mean.toFixed(1)} pts, `
    + `per-slot better at ${wins}/${perSlot.length} slots`);
  for (const r of perSlot) {
    const sig = Math.abs(r.meanDiff) > 2 * r.seDiff ? "  *" : "";
    console.log(`    slot ${String(r.slot).padStart(2)}: `
      + `${r.meanDiff >= 0 ? "+" : ""}${r.meanDiff.toFixed(1)} ± ${r.seDiff.toFixed(1)}`
      + `  (won ${r.aWins}/${r.n})${sig}`);
  }
}

function summarize(label, diffs) {
  if (!diffs.length) return null;
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, diffs.length - 1));
  const se = sd / Math.sqrt(diffs.length);
  const t = se > 0 ? mean / se : 0;
  console.log(`\n${label}`);
  console.log(`  drafts simulated : ${diffs.length}`);
  console.log(`  mean difference  : ${mean >= 0 ? "+" : ""}${mean.toFixed(2)} pts`);
  console.log(`  standard error   : ${se.toFixed(2)}`);
  console.log(`  mean / SE        : ${t.toFixed(2)}  ${Math.abs(t) > 2
    ? "(distinguishable from noise)" : "(NOT distinguishable from noise)"}`);
  console.log(`  per-slot wins    : ${diffs.filter((d) => d > 0).length}/${diffs.length}`);
  return { mean, se, t };
}

const held = summarize("HELD OUT (the honest read)", bucket.held);
const fitted = summarize("IN-SAMPLE (where they were fitted — not evidence)", bucket.fitted);

console.log("\n=== VERDICT ===");
if (!held) {
  console.log("No held-out seasons. Export seasons before " + FIT_FROM
    + " or this proves nothing.");
} else if (held.t > 2) {
  console.log("Per-slot configs BEAT the shared config out of sample. Keep them.");
} else if (held.mean < 0) {
  console.log("Per-slot configs are WORSE out of sample than one shared config.");
  console.log("That is the signature of overfitting: 100 numbers fitted to five");
  console.log("seasons, carrying noise forward as if it were draft-slot strategy.");
  console.log("Collapse SLOTS to SLOT_DEFAULT.");
} else {
  console.log("Per-slot configs are INDISTINGUISHABLE from one shared config out");
  console.log("of sample. They buy nothing measurable and cost 100 parameters of");
  console.log("surface area. Collapse SLOTS to SLOT_DEFAULT on parsimony.");
}
if (held && fitted) {
  console.log(`\nin-sample ${fitted.mean >= 0 ? "+" : ""}${fitted.mean.toFixed(2)} vs `
    + `held-out ${held.mean >= 0 ? "+" : ""}${held.mean.toFixed(2)} — `
    + `the gap IS the overfitting.`);
}

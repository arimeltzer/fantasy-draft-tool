/**
 * survival-test.mjs — roadmap 3.1: does the survival lookahead earn its place?
 * ============================================================================
 * Pre-registered in docs/ROADMAP.md 3.1 before any of this was written. This
 * script only runs the gate that was fixed there; it does not get to choose the
 * bar after seeing the numbers.
 *
 * THE TEST. For each season and each draft slot, simulate the same league twice
 * with common random numbers, changing ONLY whether our agent runs the two-ply
 * survival lookahead. Score the resulting roster on its best legal lineup of
 * ACTUAL points. Everything else — pool, seed, opponent behaviour — is
 * identical, so the difference is attributable to the lookahead alone.
 *
 * GATE (both required, from the pre-registration):
 *   1. pooled mean/SE >= 2.  0.2 set the scale on this exact harness: 4.24 read
 *      as real, 1.16 as noise.
 *   2. positive mean at a MAJORITY of draft slots.  A gain that lives in one
 *      seat is the signature 0.2 found in the per-slot configs, and is not
 *      shippable as a general mechanism.
 *
 * SIGMA IS SWEPT, NOT FITTED. There is no ADP dispersion anywhere in this
 * project, so `cv` cannot be fitted against anything here. The pre-registration
 * therefore asks a different question — is the GATE OUTCOME SENSITIVE to it?
 * Insensitive means the number was not doing work and a default is honest.
 * Sensitive means this needs real draft data before it ships, which is a
 * finding rather than a failure. Picking the best cv off this sweep and
 * shipping it would be exactly the move that put 100 unauditable numbers in
 * SLOTS.
 *
 * THE CIRCULARITY CONTROL, AND WHY IT IS NOT OPTIONAL. `pSurvive` is derived
 * from ADP and these opponents draft BY ADP, so the agent has privileged
 * knowledge of exactly how the room behaves. draft-sim's own header warns that
 * "a config that only beats ADP bots has proved little." The sweep over bot
 * `temperature` is what separates a real edge from that artifact: temperature
 * is how loosely bots follow ADP (higher = noisier room). If the edge decays to
 * nothing as the room stops being ADP-faithful, the headline number is mostly
 * self-fulfilling and gets reported that way.
 *
 *   node frontend/src/engine/survival-test.mjs --data results/draft_seasons.json
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

// Wide on purpose. 0.35 is a plausible middle, but the point is to see whether
// the answer MOVES across the range, not to find a winner inside it.
const CVS = (argOf("cvs", "0.15,0.25,0.35,0.50,0.75") || "").split(",").map(Number);
// draft-sim's default is 4. Lower = the room follows ADP tightly; higher = the
// room wanders and ADP stops predicting it.
const TEMPS = (argOf("temps", "1,2,4,8,16") || "").split(",").map(Number);
const BASE_CV = Number(argOf("baseCv", 0.35));

const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0, BENCH: 8 };
const LEAGUE = { teams: TEAMS, roster: ROSTER, superflex: false };

const raw = JSON.parse(readFileSync(DATA, "utf8"));
const sc = defaultScoring(0.5);
const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);
const seasons = Object.keys(raw).map(Number).sort();

function boardFor(season) {
  const players = raw[season].players.map((p) => ({
    ...p, proj: {}, ecr: p.adp ?? undefined, adp: p.adp ?? undefined,
  }));
  let scored = projectAll(players, sc);
  scored = marketAnchor(scored, MARKET_ANCHOR_W);   // the board the app ships
  return finalizeBoard(scored, LEAGUE);
}

const boards = new Map(seasons.map((s) => [s, boardFor(s)]));

/** Pool every (season, slot) paired diff into one mean/SE and a per-slot sign count. */
function runArm({ cv, temperature }) {
  const all = [];
  const slotMeans = [];
  for (let slot = 1; slot <= TEAMS; slot++) {
    const perSlot = [];
    for (const season of seasons) {
      const r = pairedCompare({
        board: boards.get(season), pointsById: raw[season].actual,
        roster: ROSTER, teams: TEAMS, rounds: ROUNDS, slot, seeds, temperature,
        configA: DEFAULT_SNAKE_PARAMS, configB: DEFAULT_SNAKE_PARAMS,
        agentA: { survival: true, sigma: { cv } },   // survival ON
        agentB: {},                                   // shipped engine
      });
      for (const row of r.rows) perSlot.push(row.diff);
    }
    all.push(...perSlot);
    slotMeans.push(perSlot.reduce((s, d) => s + d, 0) / Math.max(1, perSlot.length));
  }
  const n = all.length;
  const mean = all.reduce((s, d) => s + d, 0) / Math.max(1, n);
  const sd = Math.sqrt(all.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(Math.max(1, n));
  return {
    n, mean, se, ratio: se > 0 ? mean / se : 0,
    slotsPositive: slotMeans.filter((m) => m > 0).length, slotMeans,
  };
}

const f = (x, d = 2) => (x >= 0 ? "+" : "") + x.toFixed(d);

console.log(`survival lookahead vs shipped engine`);
console.log(`${seasons.length} seasons (${seasons[0]}-${seasons[seasons.length - 1]}), `
  + `slots 1-${TEAMS}, ${SEEDS} seeds/slot/season, ${ROUNDS} rounds\n`);

console.log(`--- SIGMA SWEEP (temperature ${4}, draft-sim's default room) ---`);
console.log(`cv is the coefficient of variation of draft position. NOT fitted —`);
console.log(`the question is whether the verdict moves across this range.\n`);
console.log(`  cv     n      mean diff    mean/SE   slots>0   verdict`);
const bySigma = [];
for (const cv of CVS) {
  const r = runArm({ cv, temperature: 4 });
  bySigma.push({ cv, ...r });
  const passes = r.ratio >= 2 && r.slotsPositive > TEAMS / 2;
  console.log(
    `  ${cv.toFixed(2)}   ${String(r.n).padStart(5)}  ${f(r.mean).padStart(9)}  `
    + `${f(r.ratio).padStart(8)}   ${String(r.slotsPositive).padStart(2)}/${TEAMS}     `
    + (passes ? "PASS" : "fail"),
  );
}

const ratios = bySigma.map((r) => r.ratio);
const spread = Math.max(...ratios) - Math.min(...ratios);
const verdicts = new Set(bySigma.map((r) => (r.ratio >= 2 && r.slotsPositive > TEAMS / 2)));
console.log(`\n  mean/SE ranges ${f(Math.min(...ratios))} to ${f(Math.max(...ratios))} `
  + `(spread ${spread.toFixed(2)})`);
console.log(`  -> the sweep ${verdicts.size === 1 ? "does NOT change the verdict" : "CHANGES the verdict"}`
  + ` across the cv range`);
if (verdicts.size === 1) {
  console.log(`     sigma is not load-bearing here; a stated default is honest.`);
} else {
  console.log(`     sigma IS load-bearing: this needs real draft-position data`);
  console.log(`     before it can ship, per the pre-registration.`);
}

console.log(`\n--- CIRCULARITY CONTROL: EDGE vs ROOM FAITHFULNESS (cv ${BASE_CV}) ---`);
console.log(`pSurvive comes from ADP and these bots draft by ADP. If the edge`);
console.log(`only exists in an ADP-faithful room, it is largely self-fulfilling.`);
console.log(`Higher temperature = the room follows ADP more loosely.\n`);
console.log(`  temp   n      mean diff    mean/SE   slots>0`);
const byTemp = [];
for (const temperature of TEMPS) {
  const r = runArm({ cv: BASE_CV, temperature });
  byTemp.push({ temperature, ...r });
  console.log(
    `  ${String(temperature).padStart(4)}   ${String(r.n).padStart(5)}  ${f(r.mean).padStart(9)}  `
    + `${f(r.ratio).padStart(8)}   ${String(r.slotsPositive).padStart(2)}/${TEAMS}`,
  );
}
const tight = byTemp[0], loose = byTemp[byTemp.length - 1];
console.log(`\n  tightest room (temp ${tight.temperature}): ${f(tight.mean)} pts, mean/SE ${f(tight.ratio)}`);
console.log(`  loosest  room (temp ${loose.temperature}): ${f(loose.mean)} pts, mean/SE ${f(loose.ratio)}`);
if (loose.ratio < 2 && tight.ratio >= 2) {
  console.log(`  -> the edge DECAYS as the room stops following ADP. Report the`);
  console.log(`     headline number as conditional on an ADP-faithful room.`);
} else if (loose.ratio >= 2) {
  console.log(`  -> the edge SURVIVES a room that does not follow ADP closely,`);
  console.log(`     so it is not merely an artifact of the bots' own rule.`);
} else {
  console.log(`  -> no edge at either end; the circularity question is moot.`);
}

const base = bySigma.find((r) => Math.abs(r.cv - BASE_CV) < 1e-9) || bySigma[0];
const pass = base.ratio >= 2 && base.slotsPositive > TEAMS / 2;
console.log(`\n=== GATE (pre-registered) ===`);
console.log(`  1. pooled mean/SE >= 2         : ${f(base.ratio)}  ${base.ratio >= 2 ? "PASS" : "FAIL"}`);
console.log(`  2. positive at majority of slots: ${base.slotsPositive}/${TEAMS}  `
  + `${base.slotsPositive > TEAMS / 2 ? "PASS" : "FAIL"}`);
console.log(`  -> ${pass ? "GATE CLEARS" : "GATE DOES NOT CLEAR"} at cv ${BASE_CV}`);
console.log(`\n  per-slot means at cv ${BASE_CV}:`);
console.log(`    ${base.slotMeans.map((m, i) => `s${i + 1} ${f(m, 1)}`).join("  ")}`);

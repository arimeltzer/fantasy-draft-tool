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

// A season with near-zero ADP coverage is not a thin signal, it is NO signal:
// pSurvive() falls back to p=1 (assume available) for anyone missing ADP,
// which is a sane default for one missing player and a source of large,
// uniform, signal-free "costs" when an ENTIRE season is missing it -- because
// then every candidate gets the same fallback rather than a real spread.
// This bit the gate for real: export_draft_seasons.py's fetch_adp had no 429
// retry, so a rate-limited pull silently produced adp:null for a whole
// season, and two runs 15 minutes apart landed opposite pass/fail verdicts
// depending on which one got rate-limited. fetch_adp is now paced and
// retried (see adp_probe.py), but a season failing anyway should be EXCLUDED
// here, not silently pooled in — the harness should not need the upstream
// fix to be perfect to stay honest. Threshold matches export's own "thin"
// warning (MIN_ADP_PLAYERS players).
const MIN_ADP_PLAYERS = 120;
const allSeasons = Object.keys(raw).map(Number).sort();
const seasons = allSeasons.filter((s) => {
  const withAdp = raw[s].players.filter((p) => p.adp).length;
  if (withAdp < MIN_ADP_PLAYERS) {
    console.log(`  ! EXCLUDING ${s}: only ${withAdp} players have ADP (need `
      + `${MIN_ADP_PLAYERS}+) — likely a rate-limited export, not a real thin market`);
    return false;
  }
  return true;
});
if (seasons.length < allSeasons.length) {
  console.log(`  -> proceeding with ${seasons.length}/${allSeasons.length} seasons: `
    + `${seasons.join(", ")}\n`);
}

function boardFor(season) {
  const players = raw[season].players.map((p) => ({
    ...p, proj: {}, ecr: p.adp ?? undefined, adp: p.adp ?? undefined,
  }));
  let scored = projectAll(players, sc);
  scored = marketAnchor(scored, MARKET_ANCHOR_W);   // the board the app ships
  return finalizeBoard(scored, LEAGUE);
}

const boards = new Map(seasons.map((s) => [s, boardFor(s)]));

const meanOf = (xs) => xs.reduce((s, d) => s + d, 0) / Math.max(1, xs.length);
const seOf = (xs) => {
  if (xs.length < 2) return Infinity;
  const m = meanOf(xs);
  const sd = Math.sqrt(xs.reduce((s, d) => s + (d - m) ** 2, 0) / (xs.length - 1));
  return sd / Math.sqrt(xs.length);
};

/**
 * Run one arm and report the effect three ways, because the naive one is wrong.
 *
 * THE NAIVE SE IS OPTIMISTIC AND KNOWING THAT IS THE POINT. Pooling every
 * paired draft treats 10,800 rows as independent observations. They are not:
 * seeds inside one (season, slot) share a board and a draft position, and every
 * slot inside one season shares the board outright. Clustered data pooled flat
 * understates the standard error, which inflates mean/SE — the one number the
 * gate reads. So the arm also reports the effect CLUSTERED by slot and by
 * season, treating each cluster's own mean as a single observation.
 *
 * Season is the most conservative of the three and the most honest: there are
 * only 9 of them, and a result driven by one or two good seasons would show up
 * here as a large spread and a small ratio while the pooled number still looked
 * decisive.
 */
function runArm({ cv, temperature }) {
  const all = [];
  const slotMeans = [];
  const bySeason = new Map(seasons.map((s) => [s, []]));

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
      for (const row of r.rows) { perSlot.push(row.diff); bySeason.get(season).push(row.diff); }
    }
    all.push(...perSlot);
    slotMeans.push(meanOf(perSlot));
  }

  const seasonMeans = seasons.map((s) => meanOf(bySeason.get(s)));
  const mean = meanOf(all);
  // se === 0 means every cluster agreed exactly. That is infinite precision,
  // not absent signal, and reporting it as a ratio of 0 would read as the
  // opposite of what happened (and would drag the conservative minimum down).
  const ratioOf = (se) => (se > 0 ? mean / se : (mean === 0 ? 0 : Infinity));
  const sePooled = seOf(all);
  return {
    n: all.length, mean,
    se: sePooled, ratio: ratioOf(sePooled),
    ratioSlot: ratioOf(seOf(slotMeans)),
    ratioSeason: ratioOf(seOf(seasonMeans)),
    slotsPositive: slotMeans.filter((m) => m > 0).length, slotMeans,
    seasonsPositive: seasonMeans.filter((m) => m > 0).length, seasonMeans,
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

console.log(`\n  --- ROBUSTNESS: the pooled SE above is OPTIMISTIC ---`);
console.log(`  It treats every paired draft as independent. Seeds inside one`);
console.log(`  (season, slot) share a board and a draft position, so the pooled`);
console.log(`  SE is understated and inflates the very ratio the gate reads.`);
console.log(`  Clustered, each cluster mean counted once:`);
console.log(`    mean effect            ${f(base.mean)} pts`);
console.log(`    mean/SE, pooled        ${f(base.ratio)}   (optimistic — reported for the gate)`);
console.log(`    mean/SE, by slot       ${f(base.ratioSlot)}   (${base.slotsPositive}/${TEAMS} slots positive)`);
console.log(`    mean/SE, by season     ${f(base.ratioSeason)}   (${base.seasonsPositive}/${seasons.length} seasons positive)`);
const conservative = Math.min(base.ratioSlot, base.ratioSeason);
console.log(`  -> most conservative clustering gives ${f(conservative)}, which `
  + `${conservative >= 2 ? "STILL clears" : "does NOT clear"} the bar of 2`);

console.log(`\n  per-slot means at cv ${BASE_CV}:`);
console.log(`    ${base.slotMeans.map((m, i) => `s${i + 1} ${f(m, 1)}`).join("  ")}`);
console.log(`  per-season means at cv ${BASE_CV}:`);
console.log(`    ${base.seasonMeans.map((m, i) => `${seasons[i]} ${f(m, 1)}`).join("  ")}`);

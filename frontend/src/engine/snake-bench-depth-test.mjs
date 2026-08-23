/**
 * snake-bench-depth-test.mjs — roadmap 3.6f-snake's pre-registered gate.
 * ========================================================================
 * THE QUESTION. Does multiplying `needMult`'s bench-depth score for RB/WR by
 * `benchDepthMult` (diminishing returns past a startable 4th body at one
 * position, doubly discounted while the FLEX-sibling position hasn't
 * reached its own capacity — `benchDepthAware: true`) draft better rosters
 * than the shipped agent (the flat 0.88 bench multiplier, unchanged)? See
 * docs/ROADMAP.md 3.6f-snake for the full pre-registration; do not change
 * the mechanics below without updating that record first.
 *
 * A REAL PRIOR AGAINST THIS: the auction-side version of the same claim
 * (same benchDepthMult function, same constants) FAILED its own gate —
 * mean/SE -0.08 / -0.33, indistinguishable from noise. This tests whether
 * the snake recommender's different mechanism (pick PRIORITY, not price)
 * changes that answer. Built and gated BEFORE any wiring into SnakeRoom.tsx
 * — unlike the auction side, nothing ships here ahead of this result.
 *
 * SCORING: realizedWeeklyPoints, same yardstick every gate in this phase
 * uses — never the projection-based hindsight score draft-sim.mjs uses
 * elsewhere, which would let the treatment arm's own incentive grade its
 * own homework.
 *
 * STRATIFIED over `temperature` (the bot-noise knob simulateDraft already
 * exposes) as the snake-side analogue of the auction gate's calm/
 * early-overspend split — a disciplined near-ADP room vs a noisier one.
 *
 * PRE-REGISTERED BAR (docs/ROADMAP.md 3.6f-snake): mean/SE > 2 on realized
 * weekly points, IN EACH BUCKET SEPARATELY.
 *
 *   node frontend/src/engine/snake-bench-depth-test.mjs --data results/draft_seasons.json
 */
import { readFileSync } from "node:fs";
import { projectAll, finalizeBoard, marketAnchor, defaultScoring, MARKET_ANCHOR_W }
  from "./engine-core.js";
import { simulateDraft, realizedWeeklyPoints } from "./draft-sim.mjs";

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const DATA = argOf("data", "results/draft_seasons.json");
const TEAMS = Number(argOf("teams", 10));
const ROUNDS = Number(argOf("rounds", 15));
const SEEDS = Number(argOf("seeds", 12));
const WEEKS = Number(argOf("weeks", 17));
const SLOTS = argOf("slots", "1,4,7,10").split(",").map(Number);

const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0, BENCH: 8 };
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

// "calm" = disciplined bots hewing close to ADP; "chaotic" = noisier bots
// reaching further — the snake-side stand-in for the auction gate's
// calm/early-overspend split (both express "how disciplined is the room").
const SCENARIOS = { calm: 3, chaotic: 8 };

function stats(diffs) {
  const n = diffs.length;
  if (!n) return null;
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, se, t: se > 0 ? mean / se : 0, wins: diffs.filter((d) => d > 0).length };
}

/** One paired draft: same league/seed/opponents, only benchDepthAware differs. */
function runPair(board, slot, seed, temperature, projById, weekly, byes) {
  const team = slot - 1;
  const mk = (extra) => simulateDraft({
    board, teams: TEAMS, rounds: ROUNDS, roster: ROSTER, seed, temperature,
    byeByTeam: byes,
    agents: { [team]: { slot, ...extra } },
  }).rosters[team];
  const a = mk({ benchDepth: true });
  const b = mk({});
  const score = (r) => realizedWeeklyPoints(r, projById, weekly, byes, ROSTER, WEEKS);
  return score(a) - score(b);
}

function report(label, diffs) {
  const r = stats(diffs);
  if (!r) { console.log(`\n${label}: no data`); return null; }
  console.log(`\n${label}`);
  console.log(`  drafts simulated    : ${r.n}`);
  console.log(`  mean difference     : ${r.mean >= 0 ? "+" : ""}${r.mean.toFixed(2)} realized pts`);
  console.log(`  standard error      : ${r.se.toFixed(2)}`);
  console.log(`  mean / SE           : ${r.t.toFixed(2)}  ${Math.abs(r.t) > 2
    ? "(distinguishable from noise)" : "(NOT distinguishable from noise)"}`);
  console.log(`  wins                : ${r.wins}/${r.n}`);
  return r;
}

const buckets = {};
for (const scenario of Object.keys(SCENARIOS)) buckets[scenario] = [];

console.log(`3.6f-snake gate — ${SEEDS} seeds x slots [${SLOTS.join(",")}], ${ROUNDS} rounds, `
  + `scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
console.log("scored on REALIZED weekly lineups (set by projection, scored on reality)\n");

for (const season of Object.keys(raw).map(Number).sort()) {
  const s = raw[season];
  if (!s.weekly || !s.byes || !Object.keys(s.weekly).length) {
    console.log(`${season}: no weekly/bye data exported — skipped`);
    continue;
  }
  const board = boardFor(season);
  const projById = Object.fromEntries(board.map((p) => [p.id, p.valuePoints ?? p.vbd ?? 0]));

  for (const [scenario, temperature] of Object.entries(SCENARIOS)) {
    const diffs = [];
    for (const slot of SLOTS) {
      for (const seed of seeds) {
        diffs.push(runPair(board, slot, seed, temperature, projById, s.weekly, s.byes));
      }
    }
    buckets[scenario].push(...diffs);
    const mean = diffs.reduce((sum, d) => sum + d, 0) / Math.max(1, diffs.length);
    console.log(`${season} [${scenario}]  benchDepth vs shipped: `
      + `${mean >= 0 ? "+" : ""}${mean.toFixed(1)} pts`);
  }
}

console.log("\n=== VERDICT (pre-registered bar: mean/SE > 2, PER BUCKET) ===");
const results = {};
for (const scenario of Object.keys(SCENARIOS)) {
  results[scenario] = report(
    `${scenario.toUpperCase()} — benchDepthAware vs shipped agent`,
    buckets[scenario],
  );
}
for (const scenario of Object.keys(SCENARIOS)) {
  const r = results[scenario];
  if (!r) { console.log(`\n${scenario}: insufficient data.`); continue; }
  if (r.t > 2) {
    console.log(`\n${scenario}: CLEARS THE BAR — diminishing RB/WR bench depth beats the shipped `
      + "agent here.");
  } else if (r.mean < 0 && Math.abs(r.t) > 2) {
    console.log(`\n${scenario}: WORSE than the shipped agent. Do not ship for this scenario.`);
  } else {
    console.log(`\n${scenario}: INDISTINGUISHABLE from the shipped agent. Ships nothing for this `
      + "scenario per the pre-registered bar.");
  }
}
console.log("\nNOTE: this measures snake-side RB/WR bench-depth pick priority only — see "
  + "docs/ROADMAP.md 3.6f-snake.");

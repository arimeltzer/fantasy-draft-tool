/**
 * snake-opportunity-bench-test.mjs — roadmap 3.6h's pre-registered gate.
 * ========================================================================
 * THE QUESTION. Does an OPPORTUNITY-COST-AWARE bench-depth discount —
 * `needMult`'s `opportunityBenchAware` step, which only discounts a deep
 * RB/WR candidate when a real, comparably-valued alternative is actually
 * available on the board right now (`bestVbdByPos`) — draft better rosters
 * than the shipped agent (no discount at all)? See docs/ROADMAP.md 3.6h for
 * the full pre-registration; do not change the mechanics below without
 * updating that record first.
 *
 * WHY THIS IS A DIFFERENT CLAIM FROM 3.6f-snake, NOT A RE-RUN OF IT.
 * 3.6f-snake's `benchDepthAware` discounted by roster COUNT alone and was
 * REJECTED (-10 to -29 realized pts) — the diagnosis was that a blind
 * discount fires even with no real alternative on the board, corrupting an
 * otherwise-correct pick. `opportunityBenchAware` is built specifically to
 * never do that: it is a no-op whenever `bestVbdByPos` shows nothing real
 * to redirect toward. If the diagnosis is right, this should not repeat
 * 3.6f-snake's failure; if it's wrong (the harm came from somewhere else),
 * this will likely fail the same way.
 *
 * SCORING: realizedWeeklyPoints, same yardstick every gate in this phase
 * uses. STRATIFIED over `temperature`, same calm/chaotic split as
 * 3.6f-snake for direct comparability.
 *
 * PRE-REGISTERED BAR (docs/ROADMAP.md 3.6h): mean/SE > 2 on realized
 * weekly points, IN EACH BUCKET SEPARATELY.
 *
 *   node frontend/src/engine/snake-opportunity-bench-test.mjs --data results/draft_seasons.json
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

const SCENARIOS = { calm: 3, chaotic: 8 };

function stats(diffs) {
  const n = diffs.length;
  if (!n) return null;
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, se, t: se > 0 ? mean / se : 0, wins: diffs.filter((d) => d > 0).length };
}

/** One paired draft: same league/seed/opponents, only opportunityBench differs. */
function runPair(board, slot, seed, temperature, projById, weekly, byes) {
  const team = slot - 1;
  const mk = (extra) => simulateDraft({
    board, teams: TEAMS, rounds: ROUNDS, roster: ROSTER, seed, temperature,
    byeByTeam: byes,
    agents: { [team]: { slot, ...extra } },
  }).rosters[team];
  const a = mk({ opportunityBench: true });
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

console.log(`3.6h gate — ${SEEDS} seeds x slots [${SLOTS.join(",")}], ${ROUNDS} rounds, `
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
    console.log(`${season} [${scenario}]  opportunityBench vs shipped: `
      + `${mean >= 0 ? "+" : ""}${mean.toFixed(1)} pts`);
  }
}

console.log("\n=== VERDICT (pre-registered bar: mean/SE > 2, PER BUCKET) ===");
const results = {};
for (const scenario of Object.keys(SCENARIOS)) {
  results[scenario] = report(
    `${scenario.toUpperCase()} — opportunityBenchAware vs shipped agent`,
    buckets[scenario],
  );
}
for (const scenario of Object.keys(SCENARIOS)) {
  const r = results[scenario];
  if (!r) { console.log(`\n${scenario}: insufficient data.`); continue; }
  if (r.t > 2) {
    console.log(`\n${scenario}: CLEARS THE BAR — opportunity-cost-aware bench pricing beats the `
      + "shipped agent here.");
  } else if (r.mean < 0 && Math.abs(r.t) > 2) {
    console.log(`\n${scenario}: WORSE than the shipped agent. Do not ship for this scenario.`);
  } else {
    console.log(`\n${scenario}: INDISTINGUISHABLE from the shipped agent. Ships nothing for this `
      + "scenario per the pre-registered bar.");
  }
}
console.log("\nNOTE: this measures snake-side opportunity-cost-aware RB/WR bench pricing only — "
  + "see docs/ROADMAP.md 3.6h.");

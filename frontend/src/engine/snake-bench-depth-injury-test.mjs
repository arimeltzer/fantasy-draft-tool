/**
 * snake-bench-depth-injury-test.mjs — 3.6f-injury-check, snake side.
 * ====================================================================
 * THE DESIGN ISSUE THIS EXISTS TO ANSWER. `realizedWeeklyPoints` (the scorer
 * every 3.6f-family gate uses) only ever benches a rostered player for a
 * BYE — flagged directly, and confirmed correct: "bench players by
 * definition won't move the needle much [in that harness], but [bench
 * depth] provides the injury protection we skipped. If you randomized
 * injuries to starters, I'll bet we would see a different result." A bench
 * player in the plain harness can never be needed for anything a bye
 * doesn't already cover — and bye coverage is ALREADY priced separately
 * (`byeLineupMult`/`byeClash`) — so a bench-depth comparison run on that
 * harness is close to a foregone null by construction, independent of
 * whether the real-world effect exists.
 *
 * THE FIX. `draft-sim.mjs`'s `realizedWeeklyPoints` now takes an optional
 * `injuryOracle` (see `makeInjuryOracle`) — a deterministic per-(player,
 * week) OUT flag, calibrated to REAL weekly absence rates among startable
 * players (`INJURY_MISS_RATE`: QB 5.2%, RB 10.1%, WR 7.7%, TE 8.5%, 2019-
 * 2024 nflverse `load_player_stats`, ~2-5k player-weeks per position). This
 * script re-runs the EXACT SAME comparison as `snake-bench-depth-test.mjs`
 * (benchDepthAware on vs off) with that oracle applied, so bench depth
 * finally has a real, calibrated chance to be needed for something other
 * than a bye.
 *
 * ONE oracle is built per (season, scenario) and reused across EVERY paired
 * draft in that cell — required so a real player who lands on both arms'
 * rosters (common early picks especially) draws the identical weekly
 * pattern in both, preserving the common-random-numbers design this whole
 * file relies on (see makeInjuryOracle's own docstring).
 *
 * NOT a new pre-registered kill gate in its own right — this is a
 * ROBUSTNESS CHECK on 3.6f-snake's already-pre-registered comparison, using
 * the same bar (mean/SE > 2 per bucket) for comparability, but its purpose
 * is diagnostic: does the null survive a harness that can actually see the
 * effect being tested? See docs/ROADMAP.md 3.6f-injury-check.
 *
 *   node frontend/src/engine/snake-bench-depth-injury-test.mjs --data results/draft_seasons.json
 */
import { readFileSync } from "node:fs";
import { projectAll, finalizeBoard, marketAnchor, defaultScoring, MARKET_ANCHOR_W }
  from "./engine-core.js";
import { simulateDraft, realizedWeeklyPoints, makeInjuryOracle, INJURY_MISS_RATE }
  from "./draft-sim.mjs";

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const DATA = argOf("data", "results/draft_seasons.json");
const TEAMS = Number(argOf("teams", 10));
const ROUNDS = Number(argOf("rounds", 15));
const SEEDS = Number(argOf("seeds", 12));
const WEEKS = Number(argOf("weeks", 17));
const SLOTS = argOf("slots", "1,4,7,10").split(",").map(Number);
const INJURY_SEED = Number(argOf("injury-seed", 101));

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

/** One paired draft: same league/seed/opponents, only benchDepthAware differs. */
function runPair(board, slot, seed, temperature, projById, weekly, byes, injuryOracle) {
  const team = slot - 1;
  const mk = (extra) => simulateDraft({
    board, teams: TEAMS, rounds: ROUNDS, roster: ROSTER, seed, temperature,
    byeByTeam: byes,
    agents: { [team]: { slot, ...extra } },
  }).rosters[team];
  const a = mk({ benchDepth: true });
  const b = mk({});
  const score = (r) => realizedWeeklyPoints(r, projById, weekly, byes, ROSTER, WEEKS, injuryOracle);
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

console.log(`3.6f-injury-check (snake) — ${SEEDS} seeds x slots [${SLOTS.join(",")}], ${ROUNDS} rounds`);
console.log(`injury rates: QB ${(INJURY_MISS_RATE.QB * 100).toFixed(1)}% RB ${(INJURY_MISS_RATE.RB * 100).toFixed(1)}% `
  + `WR ${(INJURY_MISS_RATE.WR * 100).toFixed(1)}% TE ${(INJURY_MISS_RATE.TE * 100).toFixed(1)}% (real, calibrated)`);
console.log("scored on REALIZED weekly lineups, WITH randomized starter unavailability\n");

for (const season of Object.keys(raw).map(Number).sort()) {
  const s = raw[season];
  if (!s.weekly || !s.byes || !Object.keys(s.weekly).length) {
    console.log(`${season}: no weekly/bye data exported — skipped`);
    continue;
  }
  const board = boardFor(season);
  const projById = Object.fromEntries(board.map((p) => [p.id, p.valuePoints ?? p.vbd ?? 0]));
  // One oracle per season, reused across every scenario/slot/seed in that
  // season — see the file header on why this must be shared, not rebuilt
  // per draft.
  const injuryOracle = makeInjuryOracle(INJURY_SEED + season, INJURY_MISS_RATE, WEEKS);

  for (const [scenario, temperature] of Object.entries(SCENARIOS)) {
    const diffs = [];
    for (const slot of SLOTS) {
      for (const seed of seeds) {
        diffs.push(runPair(board, slot, seed, temperature, projById, s.weekly, s.byes, injuryOracle));
      }
    }
    buckets[scenario].push(...diffs);
    const mean = diffs.reduce((sum, d) => sum + d, 0) / Math.max(1, diffs.length);
    console.log(`${season} [${scenario}]  benchDepth vs shipped (injury-aware): `
      + `${mean >= 0 ? "+" : ""}${mean.toFixed(1)} pts`);
  }
}

console.log("\n=== VERDICT (same bar as 3.6f-snake for comparability: mean/SE > 2, PER BUCKET) ===");
const results = {};
for (const scenario of Object.keys(SCENARIOS)) {
  results[scenario] = report(
    `${scenario.toUpperCase()} — benchDepthAware vs shipped agent (injury-aware scoring)`,
    buckets[scenario],
  );
}
for (const scenario of Object.keys(SCENARIOS)) {
  const r = results[scenario];
  if (!r) { console.log(`\n${scenario}: insufficient data.`); continue; }
  if (r.t > 2) {
    console.log(`\n${scenario}: CLEARS THE BAR under injury-aware scoring — diminishing RB/WR `
      + "bench depth beats the shipped agent once bench players can actually be needed.");
  } else if (r.mean < 0 && Math.abs(r.t) > 2) {
    console.log(`\n${scenario}: WORSE than the shipped agent, even with injuries modeled.`);
  } else {
    console.log(`\n${scenario}: STILL indistinguishable from the shipped agent, even with real `
      + "injury rates applied. That locates the null somewhere other than the no-injury harness "
      + "gap — a real finding, not a failure.");
  }
}
console.log("\nNOTE: compare directly against the same-seed, same-slots plain run from "
  + "snake-bench-depth-test.mjs — see docs/ROADMAP.md 3.6f-injury-check.");

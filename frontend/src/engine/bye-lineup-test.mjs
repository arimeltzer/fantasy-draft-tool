/**
 * bye-lineup-test.mjs — roadmap 2.4's pre-registered gate.
 * ========================================================
 * THE QUESTION. Does valuing players by a week-by-week, bye-aware lineup
 * calculation draft better rosters than the shipped heuristic (`byeClash`, a
 * small capped collision penalty)?
 *
 * THE CIRCULARITY THIS AVOIDS. Scoring the agent on the metric it optimises
 * is meaningless — a bye-aware agent trivially wins a bye-aware projected
 * score. So both arms are scored on REALIZED outcomes: lineups set week by
 * week against the real bye schedule, from PROJECTIONS, and scored on what
 * each player actually did that week (`realizedWeeklyPoints`). The agent
 * optimises projections; the scoreboard is reality.
 *
 * PRE-REGISTERED BAR (docs/ROADMAP.md 2.4): the bye-aware arm must beat the
 * current agent by more than 2 standard errors on realized weekly points.
 * Anything inside that is draft noise and ships nothing.
 *
 * TWO ARMS, reported separately, because they answer different questions:
 *   deployment — 2.4 multiplier vs the SHIPPED byeClash heuristic. Should we
 *                change the product?
 *   isolation  — bye-aware vs bye-BLIND, same machinery both sides. Is there
 *                any signal in the bye schedule at all? A null here means the
 *                deployment result is noise whichever way it points.
 *
 * EXPECTED MAGNITUDE, pre-registered before the run: the gap between a
 * well- and badly-constructed bench is plausibly 10-25 points of ~1500. A
 * null result is entirely possible and is a real finding, not a failure.
 *
 *   node frontend/src/engine/bye-lineup-test.mjs --data results/draft_seasons.json
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

function stats(diffs) {
  const n = diffs.length;
  if (!n) return null;
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, se, t: se > 0 ? mean / se : 0, wins: diffs.filter((d) => d > 0).length };
}

/** One paired draft: same league, same seed, only the agent config differs. */
function runPair(board, season, slot, seed, armA, armB, projById, weekly, byes) {
  const team = slot - 1;
  // `sched` is per-ARM: the shipped control needs the real schedule so its
  // byeClash penalty can fire, while the bye-BLIND isolation control must be
  // given none. Passing one schedule to both would have made the two controls
  // identical — which is exactly the bug that showed up on the first run.
  const mk = ({ sched = null, ...extra }) => simulateDraft({
    board, teams: TEAMS, rounds: ROUNDS, roster: ROSTER, seed,
    byeByTeam: sched,
    agents: { [team]: { slot, ...extra } },
  }).rosters[team];
  const a = mk(armA);
  const b = mk(armB);
  const score = (r) => realizedWeeklyPoints(r, projById, weekly, byes, ROSTER, WEEKS);
  return score(a) - score(b);
}

const buckets = { deployment: [], isolation: [] };
const perSeason = [];

console.log(`2.4 gate — ${SEEDS} seeds x slots [${SLOTS.join(",")}], ${ROUNDS} rounds, ${WEEKS} weeks`);
console.log("scored on REALIZED weekly lineups (set by projection, scored on reality)\n");

for (const season of Object.keys(raw).map(Number).sort()) {
  const s = raw[season];
  if (!s.weekly || !s.byes || !Object.keys(s.weekly).length) {
    console.log(`${season}: no weekly/bye data exported — skipped`);
    continue;
  }
  const board = boardFor(season);
  const projById = Object.fromEntries(board.map((p) => [p.id, p.valuePoints ?? p.vbd ?? 0]));
  const byes = s.byes;
  const weekly = s.weekly;
  const byeCfg = { byeByTeam: byes, weeks: WEEKS };

  const dep = [], iso = [];
  for (const slot of SLOTS) {
    for (const seed of seeds) {
      // DEPLOYMENT: 2.4's multiplier vs the SHIPPED byeClash heuristic. The
      // control gets the real schedule so byeClash actually fires; the 2.4 arm
      // gets it too, but its hook replaces byeClash rather than stacking with
      // it (see pickScore step 8).
      dep.push(runPair(board, season, slot, seed,
        { byeLineup: byeCfg, sched: byes },
        { sched: byes },
        projById, weekly, byes));
      // ISOLATION: bye-aware vs bye-blind, identical machinery either side and
      // NO byeClash in either — the blind arm gets an empty schedule, so
      // `byeLineupMult` computes the same marginal ratio with byes that never
      // bite. Any difference here is the bye signal itself.
      iso.push(runPair(board, season, slot, seed,
        { byeLineup: byeCfg },
        { byeLineup: { byeByTeam: {}, weeks: WEEKS } },
        projById, weekly, byes));
    }
  }
  buckets.deployment.push(...dep);
  buckets.isolation.push(...iso);
  const d = stats(dep), i = stats(iso);
  perSeason.push({ season, d, i });
  console.log(`${season}  deployment ${d.mean >= 0 ? "+" : ""}${d.mean.toFixed(1)} ± ${d.se.toFixed(1)} `
    + `(won ${d.wins}/${d.n})   isolation ${i.mean >= 0 ? "+" : ""}${i.mean.toFixed(1)} ± ${i.se.toFixed(1)}`);
}

function report(label, diffs) {
  const r = stats(diffs);
  if (!r) { console.log(`\n${label}: no data`); return null; }
  console.log(`\n${label}`);
  console.log(`  drafts          : ${r.n}`);
  console.log(`  mean difference : ${r.mean >= 0 ? "+" : ""}${r.mean.toFixed(2)} realized pts`);
  console.log(`  standard error  : ${r.se.toFixed(2)}`);
  console.log(`  mean / SE       : ${r.t.toFixed(2)}  ${Math.abs(r.t) > 2
    ? "(distinguishable from noise)" : "(NOT distinguishable from noise)"}`);
  console.log(`  wins            : ${r.wins}/${r.n}`);
  return r;
}

const dep = report("DEPLOYMENT — 2.4 lineup value vs shipped byeClash", buckets.deployment);
const iso = report("ISOLATION — bye-aware vs bye-blind (is there any signal?)", buckets.isolation);

console.log("\n=== VERDICT (pre-registered bar: mean/SE > 2) ===");
if (!dep || !iso) {
  console.log("Insufficient data — export weekly outcomes and byes first.");
} else if (dep.t > 2) {
  console.log("2.4 BEATS the shipped heuristic on realized weekly points. Ship it.");
  if (iso.t <= 2) {
    console.log("CAUTION: the isolation arm is NOT significant, so the deployment win");
    console.log("may be coming from something other than bye-awareness. Investigate");
    console.log("before wiring anything in.");
  }
} else if (dep.mean < 0 && Math.abs(dep.t) > 2) {
  console.log("2.4 is WORSE than the shipped heuristic. Do not ship; keep byeClash.");
} else {
  console.log("2.4 is INDISTINGUISHABLE from the shipped heuristic on realized points.");
  console.log("Per the pre-registered bar this ships NOTHING.");
  if (Math.abs(iso.t) <= 2) {
    console.log("The isolation arm is also null, which locates the result: over a full");
    console.log("season the bye schedule carries little draft-time signal once the");
    console.log("roster is otherwise sensibly built. That is a finding, not a failure —");
    console.log("and it matches the user's own instinct that a bye is 'only one week'.");
  }
}

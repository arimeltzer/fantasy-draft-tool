/**
 * keeper-quality-test.mjs — roadmap 3.11: should the flat 0.60 QB/TE
 * insurance discount scale with how much better the candidate is than
 * what's already kept/owned?
 * =====================================================================
 * THE QUESTION. `needMult`'s `insuranceOnly` branch applies ONE flat 0.60x
 * multiplier to every QB/TE candidate past a rostered starter, whether he
 * is a marginal upgrade or a league-winning one. Asked directly: "If I keep
 * a good second-string QB in a lower round, would my team still benefit
 * from a stronger starting QB?" — DISCOUNT-ONLY per explicit scope
 * ("Discount-only first, gate as a follow-up"); this never touches
 * QB_MIN/QB2_MIN/teMinRound/te2MinRound.
 *
 * WHY THIS NEEDS KEEPER PRE-SEEDING, NOT AN ORGANIC DRAFT. A model-optimal
 * agent never intentionally rosters a worse player when a better one is
 * openly available — the ONLY way a team's best-owned QB/TE can trail the
 * board is a player locked in before the draft, i.e. a keeper. Every
 * scenario here pre-seeds a kept QB via `draft-sim.mjs`'s `cfg.keeper`
 * (roadmap 3.11's own harness addition) at a fixed EARLY forfeited round
 * (a genuinely cheap keeper slot, `--forfeitRound`, default 1) and varies
 * ONLY how good the kept player himself is, by his rank among that
 * season's real QBs (`--qbRanks`, default a strong/mid/weak spread).
 *
 * PAIRED, SAME AS EVERY GATE SINCE 2.4. Both arms keep the IDENTICAL
 * player in the IDENTICAL forfeited round, on the identical league/pool/
 * seed/opponent behavior — the ONLY difference is whether the agent's own
 * `needMult` call is `qualityAwareInsurance`-on or -off. Scored on
 * REALIZED weekly points (`realizedWeeklyPoints`), not the metric the
 * agent optimizes at pick time — the same anti-circularity every gate
 * since 2.4 insists on.
 *
 * FIT/HELD SPLIT, mean/SE > 2 ON THE HELD-OUT SPLIT TO SHIP — identical bar
 * to 3.10's round-gate test, for the identical reason: an in-sample win
 * alone is not evidence.
 *
 *   node frontend/src/engine/keeper-quality-test.mjs \
 *     --data data-pipeline/results/draft_seasons.json --qbRanks 3,12,22
 */
import { readFileSync } from "node:fs";
import { projectAll, finalizeBoard, marketAnchor, defaultScoring, MARKET_ANCHOR_W }
  from "./engine-core.js";
import { simulateDraft, realizedWeeklyPoints } from "./draft-sim.mjs";
import { DEFAULT_SNAKE_PARAMS } from "./snake-engine.js";

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const DATA = argOf("data", "results/draft_seasons.json");
// Which QB, by rank among that season's real QBs (1 = the best), becomes the
// kept player in each scenario. A spread from near-elite (should see little
// to no effect — few if any real upgrades exist above him) to clearly
// replacement-tier (the case this whole step exists for).
const QB_RANKS = argOf("qbRanks", "3,8,14,20,28").split(",").map(Number);
// The forfeited round the keeper occupies. Deliberately early and fixed
// across scenarios: a keeper's ROUND is a function of his historical
// keeper cost, not of how good he is in absolute terms this season — that
// gap (a cheap round, a mediocre player) is exactly what makes this a real
// scenario at all. What varies between scenarios is only the player.
const FORFEIT_ROUND = Number(argOf("forfeitRound", 1));
const TEAMS = Number(argOf("teams", 10));
const ROUNDS = Number(argOf("rounds", 15));
const SEEDS = Number(argOf("seeds", 12));
const WEEKS = Number(argOf("weeks", 17));
const SLOTS = argOf("slots", "1,4,7,10").split(",").map(Number);
const FIT_UPTO = Number(argOf("fitUpto", 2021));

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

/** The real shipped config — SLOTS stripped, matching production. Neither
 *  arm here changes QB_MIN/QB2_MIN/teMinRound at all (discount-only scope). */
const SHIPPED = JSON.parse(JSON.stringify(DEFAULT_SNAKE_PARAMS));
SHIPPED.SLOTS = {};

function stats(diffs) {
  const n = diffs.length;
  if (!n) return null;
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, se, t: se > 0 ? mean / se : 0, wins: diffs.filter((d) => d > 0).length };
}

/** PAIRED draft: same league, same seed, same kept player/round — only
 *  qualityAwareInsurance differs. */
function runPair(board, slot, seed, keptPlayer, projById, weekly, byes) {
  const team = slot - 1;
  const keeper = { player: keptPlayer, forfeitRound: FORFEIT_ROUND };
  const mk = (qualityAwareInsurance) => simulateDraft({
    board, teams: TEAMS, rounds: ROUNDS, roster: ROSTER, seed,
    byeByTeam: byes,
    agents: { [team]: { slot, params: SHIPPED, keeper, qualityAwareInsurance } },
  }).rosters[team];
  const a = mk(true);
  const b = mk(false);
  const score = (r) => realizedWeeklyPoints(r, projById, weekly, byes, ROSTER, WEEKS);
  return +(score(a) - score(b)).toFixed(1);
}

console.log(`keeper-quality-test — QB ranks=[${QB_RANKS.join(",")}], `
  + `forfeitRound=${FORFEIT_ROUND}, fit<=${FIT_UPTO}<held, `
  + `${SEEDS} seeds x slots [${SLOTS.join(",")}], ${ROUNDS} rounds, ${WEEKS} weeks\n`);

const results = {};
for (const rank of QB_RANKS) {
  const fit = [], held = [];
  let missingSeasons = 0;
  for (const season of Object.keys(raw).map(Number).sort()) {
    const s = raw[season];
    if (!s.weekly || !s.byes || !Object.keys(s.weekly).length) continue;
    const board = boardFor(season);
    const qbsByValue = board.filter((p) => p.pos === "QB")
      .sort((a, b) => (b.valuePoints ?? b.vbd ?? 0) - (a.valuePoints ?? a.vbd ?? 0));
    const keptPlayer = qbsByValue[rank - 1];
    if (!keptPlayer) { missingSeasons++; continue; }   // season too thin at QB for this rank
    const projById = Object.fromEntries(board.map((p) => [p.id, p.valuePoints ?? p.vbd ?? 0]));
    const bucket = season <= FIT_UPTO ? fit : held;
    for (const slot of SLOTS) {
      for (const seed of seeds) {
        bucket.push(runPair(board, slot, seed, keptPlayer, projById, s.weekly, s.byes));
      }
    }
  }
  const fitStats = stats(fit), heldStats = stats(held);
  results[rank] = { fitStats, heldStats, missingSeasons };
  const fmt = (r) => r ? `${r.mean >= 0 ? "+" : ""}${r.mean.toFixed(1)} ± ${r.se.toFixed(1)} (t=${r.t.toFixed(2)}, n=${r.n})` : "n/a";
  console.log(`kept QB rank=${rank}  fit ${fmt(fitStats)}   held ${fmt(heldStats)}`
    + (missingSeasons ? `   (${missingSeasons} season(s) too thin at QB, skipped)` : ""));
}

console.log("\n=== VERDICT ===");
console.log("Discount-only per docs/ROADMAP.md 3.11 — this never touches "
  + "QB_MIN/QB2_MIN/teMinRound/te2MinRound.");
let anyClears = false;
for (const [rank, r] of Object.entries(results)) {
  if (!r.heldStats || Math.abs(r.heldStats.t) <= 2) continue;
  anyClears = true;
  const verdict = r.heldStats.mean > 0 ? "IMPROVES" : "WORSE";
  console.log(`rank=${rank}: clears the held-out bar (mean/SE > 2) — ${verdict} `
    + `(${r.heldStats.mean >= 0 ? "+" : ""}${r.heldStats.mean.toFixed(1)} pts, t=${r.heldStats.t.toFixed(2)})`);
}
if (!anyClears) {
  console.log("No scenario cleared |t| > 2 on the held-out split — "
    + "qualityAwareInsurance is not shown to help; the flat 0.60 discount stands.");
}

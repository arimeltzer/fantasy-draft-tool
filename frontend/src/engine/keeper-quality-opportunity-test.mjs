/**
 * keeper-quality-opportunity-test.mjs — roadmap 3.11b: does the
 * OPPORTUNITY-COST-AWARE quality discount beat the flat 0.60 baseline,
 * where the plain (ungated-boost) version already failed?
 * =====================================================================
 * THE QUESTION. 3.11's plain `qualityAwareInsurance` was gated and
 * REJECTED (docs/ROADMAP.md 3.11: -1.1 to -2.2 realized pts on the
 * held-out split, worsening as the discount fired more aggressively) —
 * diagnosed as spending a bench slot on a backup QB who mostly never
 * plays, displacing a bench RB/WR that would have contributed real
 * points more often. `qualityAwareOpportunityMult` dampens the SAME
 * boost by how comparable the best available bench RB/WR is (the exact
 * fix that rescued 3.6h from 3.6f-snake's identical failure mode). This
 * gate asks whether THAT fix actually works.
 *
 * COMPARED AGAINST THE FLAT BASELINE, NOT THE REJECTED PLAIN VERSION.
 * The question that matters is whether this mechanism beats what's
 * actually shipped today (the flat 0.60), not whether it beats an idea
 * already known to be worse — so `qualityOpportunityAware`-on is paired
 * against `qualityOpportunityAware`-off (`qualityAware` also left off in
 * both arms, so the "off" arm is the real shipped baseline).
 *
 * Otherwise identical machinery to `keeper-quality-test.mjs` — same
 * keeper pre-seeding, same paired common-random-numbers design, same
 * fit/held split, same `mean/SE > 2` bar, same kept-QB-rank scenarios
 * (so the two gates are directly comparable).
 *
 *   node frontend/src/engine/keeper-quality-opportunity-test.mjs \
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
const QB_RANKS = argOf("qbRanks", "3,8,14,20,28").split(",").map(Number);
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
 *  qualityOpportunityAware differs. The "off" arm is the real shipped
 *  baseline (flat 0.60), not the rejected plain qualityAware version. */
function runPair(board, slot, seed, keptPlayer, projById, weekly, byes) {
  const team = slot - 1;
  const keeper = { player: keptPlayer, forfeitRound: FORFEIT_ROUND };
  const mk = (qualityOpportunityAware) => simulateDraft({
    board, teams: TEAMS, rounds: ROUNDS, roster: ROSTER, seed,
    byeByTeam: byes,
    agents: { [team]: { slot, params: SHIPPED, keeper, qualityOpportunityAware } },
  }).rosters[team];
  const a = mk(true);
  const b = mk(false);
  const score = (r) => realizedWeeklyPoints(r, projById, weekly, byes, ROSTER, WEEKS);
  return +(score(a) - score(b)).toFixed(1);
}

console.log(`keeper-quality-opportunity-test — QB ranks=[${QB_RANKS.join(",")}], `
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
console.log("Opportunity-cost-aware follow-up to 3.11's rejected plain version "
  + "(docs/ROADMAP.md 3.11b) — compared against the FLAT baseline, not the "
  + "already-rejected plain qualityAware. Discount-only: never touches "
  + "QB_MIN/QB2_MIN/teMinRound/te2MinRound.");
let anyHelps = false, anyHurts = false;
for (const [rank, r] of Object.entries(results)) {
  if (!r.heldStats || Math.abs(r.heldStats.t) <= 2) continue;
  const verdict = r.heldStats.mean > 0 ? "IMPROVES" : "WORSE";
  if (r.heldStats.mean > 0) anyHelps = true; else anyHurts = true;
  console.log(`rank=${rank}: clears the held-out bar (mean/SE > 2) — ${verdict} `
    + `(${r.heldStats.mean >= 0 ? "+" : ""}${r.heldStats.mean.toFixed(1)} pts, t=${r.heldStats.t.toFixed(2)})`);
}
if (!anyHelps && !anyHurts) {
  console.log("No scenario cleared |t| > 2 on the held-out split — "
    + "qualityOpportunityAware is not shown to help; the flat 0.60 discount stands.");
} else if (anyHelps && !anyHurts) {
  console.log("At least one scenario clears the bar in the HELPFUL direction, "
    + "none in the harmful direction — a candidate to ship (off by default until wired).");
} else {
  console.log("Mixed or harmful result — does NOT clear the bar as a clean win; "
    + "the flat 0.60 discount stands.");
}

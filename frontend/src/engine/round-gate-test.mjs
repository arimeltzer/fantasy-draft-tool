/**
 * round-gate-test.mjs — roadmap 3.10: is QB_MIN/teMinRound the right round,
 * or just an inherited one?
 * ====================================================================
 * THE QUESTION. `QB_MIN`/`QB2_MIN`/`teMinRound`/`te2MinRound` (snake-engine.js
 * DEFAULT_SNAKE_PARAMS) are ported wholesale from the pre-repo offline research
 * model — confirmed via git history: SLOT_DEFAULT's QB_MIN:8/QB2_MIN:9 is
 * literally slot 2/3's config from the original ten-slot grid search roadmap
 * 0.2 collapsed. 0.2 only ever tested "ten values beat one shared value" — it
 * never asked whether the shared value ITSELF is good. This does.
 *
 * THE CIRCULARITY THIS AVOIDS, same as 2.4/3.9: scoring on the metric the
 * agent optimizes (raw VBD at pick time) proves nothing. Both arms draft with
 * PROJECTIONS, both are scored on REALIZED weekly points against the real
 * schedule (`realizedWeeklyPoints`) — the agent optimizes projections, the
 * scoreboard is reality.
 *
 * THE OVERFITTING GUARD, same reason this step exists at all: if WE fit a
 * value on all available seasons, we reproduce the exact sin roadmap 0.2 was
 * built to catch. Seasons <= --fitUpto are the FIT split (used to spot a
 * candidate worth reporting); seasons after it are the HELD-OUT split (the
 * only one a candidate is allowed to win on to actually be recommended).
 * Default fitUpto=2021 fits on the OLDER seasons and validates on the more
 * RECENT ones — the direction that matters for a tool used to draft in 2026,
 * not the arbitrary split 0.2 was stuck with (that one was fixed by when the
 * original, unreproducible grid search happened, not chosen for validation
 * quality).
 *
 * PRE-REGISTERED BAR (docs/ROADMAP.md 3.10): a candidate value only replaces
 * the shipped default if it beats it by mean/SE > 2 on the HELD-OUT split.
 * In-sample wins are not evidence — an overfit sweep always looks good on its
 * own fit data.
 *
 *   node frontend/src/engine/round-gate-test.mjs --mode QB \
 *     --data results/draft_seasons.json --values 5,6,7,8,9,10,11
 *   node frontend/src/engine/round-gate-test.mjs --mode TE \
 *     --data results/draft_seasons.json --values 1,2,3,4,5,6,7
 */
import { readFileSync } from "node:fs";
import { projectAll, finalizeBoard, marketAnchor, defaultScoring, MARKET_ANCHOR_W }
  from "./engine-core.js";
import { simulateDraft, realizedWeeklyPoints } from "./draft-sim.mjs";
import { DEFAULT_SNAKE_PARAMS } from "./snake-engine.js";

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const DATA = argOf("data", "results/draft_seasons.json");
const MODE = argOf("mode", "QB");   // QB (QB_MIN/QB2_MIN) | TE (teMinRound/te2MinRound)
if (MODE !== "QB" && MODE !== "TE") throw new Error(`--mode must be QB or TE, got "${MODE}"`);
const VALUES = argOf("values", MODE === "QB" ? "5,6,7,8,9,10,11" : "1,2,3,4,5,6,7")
  .split(",").map(Number);
// QB2_MIN = QB_MIN + gap, te2MinRound = teMinRound + gap — the shipped gap
// (8->9, 4->7) is reproduced exactly by these defaults; see the SHIPPED
// baseline below, built from the real DEFAULT_SNAKE_PARAMS rather than
// re-derived from --gap, so a mismatched --gap can only affect the
// CANDIDATES, never silently change what "shipped" means.
const GAP = Number(argOf("gap", MODE === "QB" ? 1 : 3));
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

/** The real shipped config, SLOTS stripped so the shared default always
 * applies (matches how the app runs today — SLOTS is {} in production). */
const SHIPPED = JSON.parse(JSON.stringify(DEFAULT_SNAKE_PARAMS));
SHIPPED.SLOTS = {};

/** One candidate: shipped config with only this mode's round(s) swapped —
 * everything else (including the OTHER position's gate) stays at shipped. */
function configFor(value) {
  const cfg = JSON.parse(JSON.stringify(SHIPPED));
  if (MODE === "QB") {
    cfg.SLOT_DEFAULT.QB_MIN = value;
    cfg.SLOT_DEFAULT.QB2_MIN = value + GAP;
  } else {
    cfg.teMinRound = value;
    cfg.te2MinRound = value + GAP;
  }
  return cfg;
}

function stats(diffs) {
  const n = diffs.length;
  if (!n) return null;
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, se, t: se > 0 ? mean / se : 0, wins: diffs.filter((d) => d > 0).length };
}

/** PAIRED draft: same league, same seed, only the config differs. */
function runPair(board, slot, seed, candCfg, projById, weekly, byes) {
  const team = slot - 1;
  const mk = (params) => simulateDraft({
    board, teams: TEAMS, rounds: ROUNDS, roster: ROSTER, seed,
    byeByTeam: byes,
    agents: { [team]: { slot, params } },
  }).rosters[team];
  const a = mk(candCfg);
  const b = mk(SHIPPED);
  const score = (r) => realizedWeeklyPoints(r, projById, weekly, byes, ROSTER, WEEKS);
  return +(score(a) - score(b)).toFixed(1);
}

const shippedValue = MODE === "QB" ? SHIPPED.SLOT_DEFAULT.QB_MIN : SHIPPED.teMinRound;
console.log(`round-gate-test — mode=${MODE} (shipped=${shippedValue}), `
  + `candidates=[${VALUES.join(",")}], gap=${GAP}, fit<=${FIT_UPTO}<held, `
  + `${SEEDS} seeds x slots [${SLOTS.join(",")}], ${ROUNDS} rounds, ${WEEKS} weeks\n`);

const results = {};
for (const value of VALUES) {
  const candCfg = configFor(value);
  const fit = [], held = [];
  for (const season of Object.keys(raw).map(Number).sort()) {
    const s = raw[season];
    if (!s.weekly || !s.byes || !Object.keys(s.weekly).length) continue;
    const board = boardFor(season);
    const projById = Object.fromEntries(board.map((p) => [p.id, p.valuePoints ?? p.vbd ?? 0]));
    const bucket = season <= FIT_UPTO ? fit : held;
    for (const slot of SLOTS) {
      for (const seed of seeds) {
        bucket.push(runPair(board, slot, seed, candCfg, projById, s.weekly, s.byes));
      }
    }
  }
  const fitStats = stats(fit), heldStats = stats(held);
  results[value] = { fitStats, heldStats };
  const fmt = (r) => r ? `${r.mean >= 0 ? "+" : ""}${r.mean.toFixed(1)} ± ${r.se.toFixed(1)} (t=${r.t.toFixed(2)}, n=${r.n})` : "n/a";
  console.log(`round=${value}  fit ${fmt(fitStats)}   held ${fmt(heldStats)}`);
}

console.log("\n=== VERDICT ===");
console.log(`shipped default: ${MODE}_MIN/round = ${shippedValue}`);
let best = null;
for (const [value, r] of Object.entries(results)) {
  if (!r.heldStats || Math.abs(r.heldStats.t) <= 2) continue;   // must clear the bar HELD OUT
  if (!best || r.heldStats.mean > best.r.heldStats.mean) best = { value, r };
}
if (best) {
  console.log(`Candidate clearing the held-out bar (mean/SE > 2): round=${best.value} `
    + `(${best.r.heldStats.mean >= 0 ? "+" : ""}${best.r.heldStats.mean.toFixed(1)} pts, `
    + `t=${best.r.heldStats.t.toFixed(2)})`);
  console.log("Fit-split confirmation (context only, NOT the bar): "
    + (best.r.fitStats
      ? `${best.r.fitStats.mean >= 0 ? "+" : ""}${best.r.fitStats.mean.toFixed(1)} pts, t=${best.r.fitStats.t.toFixed(2)}`
      : "n/a"));
} else {
  console.log("No candidate cleared |t| > 2 on the held-out split — the shipped default stands.");
}

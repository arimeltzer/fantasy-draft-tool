/**
 * draft-sim.mjs — simulate whole snake drafts against the SHIPPED engine
 * ======================================================================
 * Built for roadmap step 0.2, which asks whether the ten per-slot snake
 * configs survive out-of-sample validation. That could not be answered,
 * because the grid search that produced them is not in this repository —
 * `DEFAULT_SNAKE_PARAMS.SLOTS` carries 100 fitted numbers whose provenance is
 * a comment reading "ported from the offline research model". Unreproducible
 * parameters cannot be audited, only trusted, and 100 of them from five
 * seasons is a lot to take on trust.
 *
 * This runs in Node against `snake-engine.js` ITSELF rather than a port. The
 * project already keeps two Python ports honest with parity tests precisely
 * because ports drift; the cheaper fix is not to have one.
 *
 * DESIGN NOTES THAT AFFECT WHETHER THE OUTPUT MEANS ANYTHING
 *
 * Paired runs (common random numbers). Comparing two configs on independent
 * simulations buries a small real difference under draft-to-draft noise. Every
 * comparison here replays the SAME league — same pool, same seed, same
 * opponent behaviour — changing only our own config, so the difference between
 * two arms is attributable to the config and nothing else.
 *
 * Hindsight lineups. A roster is scored on its best legal starting lineup by
 * ACTUAL points. Real managers cannot do that, so these totals are an upper
 * bound and they flatter depth. It is applied identically to every arm, so it
 * is fair for RANKING configs; it is not a forecast of what you would score.
 * Phase 2's weekly simulator is what replaces it.
 *
 * Opponents are ADP bots with noise and roster limits. That is a floor, not a
 * model of good managers — a config that only beats ADP bots has proved little.
 * It is enough for 0.2, which asks whether ten configs beat one.
 */
import { pickScore, maxUseful, DEFAULT_SNAKE_PARAMS } from "./snake-engine.js";
import { rankByAdp } from "./engine-core.js";
import { byeLineupMult } from "./bye-lineup-value.js";
import { nextPickNumber } from "./survival.js";
import { runHotness } from "./positional-run.js";

/** Deterministic RNG so a comparison can be replayed exactly. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Serpentine pick order: overall pick number -> team index (0-based). */
export function snakeOrder(teams, rounds) {
  const order = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < teams; i++) {
      order.push(r % 2 === 0 ? i : teams - 1 - i);
    }
  }
  return order;
}

function emptyCounts() {
  return { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
}

function needsFrom(counts, roster) {
  const surplus = Math.max(0, counts.RB - (roster.RB || 0))
    + Math.max(0, counts.WR - (roster.WR || 0))
    + Math.max(0, counts.TE - (roster.TE || 0));
  return {
    QB: Math.max(0, (roster.QB || 0) - counts.QB),
    RB: Math.max(0, (roster.RB || 0) - counts.RB),
    WR: Math.max(0, (roster.WR || 0) - counts.WR),
    TE: Math.max(0, (roster.TE || 0) - counts.TE),
    FLEX: Math.max(0, (roster.FLEX || 0) - surplus),
  };
}

/**
 * An opponent's pick: near the top of the board by ADP, with noise, and
 * refusing positions they have no room for.
 *
 * The noise is exponentially weighted over the best available rather than
 * uniform over a window, because real rooms mostly take near-consensus players
 * and occasionally reach a long way. A uniform window produces neither.
 */
export function botPick(avail, ranks, counts, roster, rng, temperature = 4) {
  const eligible = avail.filter((p) => counts[p.pos] < maxUseful(p.pos, roster, false));
  const pool = (eligible.length ? eligible : avail)
    .slice()
    .sort((a, b) => (ranks[a.id] ?? 1e9) - (ranks[b.id] ?? 1e9))
    .slice(0, 25);
  if (!pool.length) return null;
  const weights = pool.map((_, i) => Math.exp(-i / temperature));
  const total = weights.reduce((s, w) => s + w, 0);
  let x = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    x -= weights[i];
    if (x <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/**
 * Run one draft. `agents` maps a team index to a config; every other team is
 * an ADP bot. Returns each team's roster.
 */
export function simulateDraft({
  board, teams = 10, rounds = 15, roster, agents = {},
  seed = 1, P = DEFAULT_SNAKE_PARAMS, temperature = 4,
  // Bye schedule for the season being replayed. Optional, but WITHOUT it
  // `pickScore`'s step-8 `byeClash` penalty cannot fire at all — it guards on
  // `s.byeByTeam` — so the simulated "shipped" agent was quietly a version of
  // the app with bye handling switched off. Found while building 2.4's gate,
  // where it made the bye-aware and bye-blind control arms identical.
  byeByTeam = null,
}) {
  const rng = mulberry32(seed);
  const ranks = rankByAdp(board);
  const order = snakeOrder(teams, rounds);

  const taken = new Set();
  const rosters = Array.from({ length: teams }, () => []);
  const counts = Array.from({ length: teams }, emptyCounts);
  // Positional-run detection (roadmap 3.2) reads recent draft-wide pace, not
  // one team's — every pick, agent or bot, is logged.
  const pickLog = [];

  for (let overall = 0; overall < order.length; overall++) {
    const team = order[overall];
    const avail = board.filter((p) => !taken.has(p.id));
    if (!avail.length) break;

    let choice = null;
    const cfg = agents[team];
    if (cfg) {
      const myRound = rosters[team].length + 1;
      const posRemaining = {};
      for (const p of avail) posRemaining[p.pos] = (posRemaining[p.pos] || 0) + 1;
      // roadmap 3.6h — best available VBD per position, the "is there a
      // real alternative on the board" input opportunityBenchMult needs.
      const bestVbdByPos = {};
      for (const p of avail) {
        if (!(p.pos in bestVbdByPos) || p.vbd > bestVbdByPos[p.pos]) bestVbdByPos[p.pos] = p.vbd;
      }
      const live = {
        round: myRound,
        teams,
        slot: cfg.slot,
        counts: counts[team],
        superflex: false,
        roster,
        needs: needsFrom(counts[team], roster),
        bestVbd: Math.max(...avail.map((p) => p.vbd)),
        posRemaining,
        bestVbdByPos,
        adpRankById: ranks,
        cliffById: cfg.cliffById || {},
        poolSize: avail.length,
      };

      // Byes, as the shipped room supplies them (SnakeRoom builds exactly
      // these two). Only when a schedule was given — otherwise byeClash stays
      // inert, which is the pre-2.4 behaviour every existing caller expects.
      if (byeByTeam) {
        live.byeByTeam = byeByTeam;
        const rb = {};
        for (const q of rosters[team]) {
          if (!q.pos) continue;
          (rb[q.pos] ||= []).push(q.team ? byeByTeam[q.team] ?? null : null);
        }
        live.rosterByesByPos = rb;
      }

      // Survival margin (roadmap 3.1 — SIMPLIFIED), opt-in per agent so the
      // paired comparison can run identical leagues with this as the ONLY
      // difference. Just the next pick number; pickScore does the rest with
      // adpRankById it already has.
      if (cfg.survival) {
        live.nextPick = nextPickNumber(myRound, teams, cfg.slot, rounds);
      }
      // Positional run (roadmap 3.2), opt-in independently of survival for
      // isolation in paired comparisons — though it is inert unless survival
      // is ALSO on, since it only ever modifies that margin. Only the recent
      // window matters; runHotness itself slices to `teams`.
      if (cfg.positionalRun) {
        live.runHotByPos = runHotness(pickLog, teams);
      }
      // Roadmap 2.4, opt-in per agent so the paired comparison can run
      // identical leagues with the bye valuation as the ONLY difference.
      // Closes over the roster AS IT STANDS AT THIS PICK — the marginal value
      // of a bye-covering body depends entirely on who is already on it.
      if (cfg.byeLineup) {
        const mine = rosters[team];
        live.byeLineupMultFor = (p) => byeLineupMult(p, mine, {
          pointsOf: (q) => q.valuePoints ?? q.vbd ?? 0,
          byeOf: (q) => (q.team ? cfg.byeLineup.byeByTeam[q.team] ?? null : null),
          rosterCfg: roster,
          weeks: cfg.byeLineup.weeks || 17,
        }, cfg.byeLineup.clamp || {});
      }
      // Roadmap 3.6f-snake, opt-in per agent for the same isolated-comparison
      // reason every other flag here is opt-in: needMult()'s benchDepthMult
      // step (diminishing RB/WR bench depth) only fires when this is set,
      // so the paired comparison can run identical leagues with this as the
      // ONLY difference.
      if (cfg.benchDepth) {
        live.benchDepthAware = true;
      }
      // Roadmap 3.6h, same opt-in-per-agent isolation reason: needMult()'s
      // opportunityBenchMult step only fires when this is set. bestVbdByPos
      // (built above) is already on `live` unconditionally — cheap to
      // compute, and harmless when this flag is off since opportunityBenchMult
      // is never called without opportunityBenchAware also being true.
      if (cfg.opportunityBench) {
        live.opportunityBenchAware = true;
      }
      let best = -Infinity;
      for (const p of avail) {
        const { score, blocked } = pickScore(p, live, cfg.params || P);
        if (blocked || !Number.isFinite(score)) continue;
        if (score > best) { best = score; choice = p; }
      }
      // Every candidate gated (deep roster, everything blocked): fall back to
      // best available by value rather than forfeiting the pick.
      if (!choice) {
        choice = avail.slice().sort((a, b) => b.vbd - a.vbd)[0];
      }
    } else {
      choice = botPick(avail, ranks, counts[team], roster, rng, temperature);
    }

    if (!choice) break;
    taken.add(choice.id);
    rosters[team].push(choice);
    counts[team][choice.pos] = (counts[team][choice.pos] || 0) + 1;
    pickLog.push(choice.pos);
  }

  return { rosters, counts };
}

/**
 * Best legal starting lineup, scored on whatever `pointsById` holds.
 *
 * FLEX takes the best remaining RB/WR/TE. Called with ACTUAL season points
 * this is a hindsight-optimal lineup — see the header for why that is
 * acceptable for comparing configs and not a forecast.
 */
export function bestLineupPoints(rosterPlayers, pointsById, roster) {
  const pts = (p) => pointsById[p.id] ?? 0;
  const byPos = {};
  for (const p of rosterPlayers) (byPos[p.pos] ||= []).push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => pts(b) - pts(a));

  let total = 0;
  const used = new Set();
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    const n = roster[pos] || 0;
    for (const p of (byPos[pos] || []).slice(0, n)) { total += pts(p); used.add(p.id); }
  }
  const flexPool = ["RB", "WR", "TE"]
    .flatMap((pos) => byPos[pos] || [])
    .filter((p) => !used.has(p.id))
    .sort((a, b) => pts(b) - pts(a));
  for (const p of flexPool.slice(0, roster.FLEX || 0)) total += pts(p);
  return +total.toFixed(1);
}

// Deterministic per-(seed, id) draw stream, one uniform[0,1) value per week.
// A weekly-injury draw needs to depend ONLY on the player and the seed, not
// on which roster he's being evaluated in or where he sits in that array —
// otherwise the same real player could roll a DIFFERENT "out" pattern in the
// treatment arm than in the control arm of a paired comparison, which would
// inject noise unrelated to whatever the two arms actually differ on. That
// breaks the common-random-numbers design this whole file is built around
// (see the file header). Folding the id into the seed via a cheap string
// hash, then running mulberry32 from the combined seed, gives exactly that:
// the same (seed, id) always produces the same week-by-week stream, however
// many different rosters that id happens to appear on across a run.
function injuryDraws(seed, id, weeks) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  const rng = mulberry32(h >>> 0);
  const draws = [];
  for (let w = 0; w < weeks; w++) draws.push(rng());
  return draws;
}

// Real weekly OUT rate among STARTABLE players (top 20 QB/TE, top 40 RB, top
// 50 WR by season PPR points — roughly the startable depth of a 10-team
// league), 2019-2024 nflverse `load_player_stats`: a player counted as
// "missed" a week his team did NOT have a bye and he recorded zero stat
// lines that week (can't separate injury from a healthy scratch from this
// data alone — both are "the bench had to cover him", which is the only
// thing that matters here). n = 1,983 QB / 3,967 RB / 4,980 WR / 1,984 TE
// player-weeks. K/DST were not in this pull (no clean "startable" pool
// concept for either) and default to 0 — untested, not asserted safe.
export const INJURY_MISS_RATE = { QB: 0.052, RB: 0.101, WR: 0.077, TE: 0.085, K: 0, DST: 0 };

/**
 * Builds a reusable, deterministic (seed, missRateByPos) -> per-(player,
 * week) OUT oracle. Build ONE of these per gate run and hand it to every
 * `realizedWeeklyPoints` call in that run (both arms, every roster) — that
 * is what guarantees a shared real player draws the identical weekly
 * pattern everywhere he appears. Memoizes per player id since the same
 * player is typically scored many times (multiple seeds/slots reuse ids
 * across a full gate sweep).
 */
export function makeInjuryOracle(seed = 1, missRateByPos = INJURY_MISS_RATE, weeks = 17) {
  const cache = new Map();
  return (id, pos, week) => {
    let draws = cache.get(id);
    if (!draws) { draws = injuryDraws(seed, id, weeks); cache.set(id, draws); }
    const rate = missRateByPos[pos] || 0;
    return draws[week - 1] < rate;
  };
}

/**
 * REALIZED weekly-lineup points — roadmap 2.4's scorer.
 *
 * `bestLineupPoints` above scores one hindsight-optimal lineup on SEASON
 * totals, which cannot see byes at all and so cannot measure a bye-aware
 * agent. This walks the season week by week instead.
 *
 * THE LINEUP IS SET BY PROJECTION AND SCORED ON REALITY, and that split is
 * the whole point. Setting it by hindsight would reward roster depth
 * mechanically — with perfect foresight another body can only ever help —
 * and would flatter any agent that drafts more players, which is exactly the
 * behaviour under test. Setting by projection is also what a manager
 * actually does on Sunday morning.
 *
 * INJURY-AWARE, OPT-IN (`injuryOracle`, see `makeInjuryOracle` above).
 * ABSENT — the default, and every caller before this — the ONLY
 * unavailability modelled is a BYE, and a player who was actually injured
 * or inactive that week is still started and simply scores his real 0.
 * That was flagged here as understating bench depth's value "but applying
 * identically to both arms, so not biasing the comparison" — true as far
 * as it goes, but incomplete for a comparison that is SPECIFICALLY about
 * whether extra bench depth is worth drafting: with unavailability limited
 * to byes, a bench player can NEVER be needed for anything byes don't
 * already cover, so any such comparison is close to a foregone conclusion
 * by construction, not genuine evidence the real-world effect is absent.
 * Raised directly (with the correct diagnosis) after 3.6f's gate came back
 * null — see docs/ROADMAP.md 3.6f-injury-check. Passing an oracle built
 * from real per-position weekly OUT rates (`INJURY_MISS_RATE`) gives bench
 * depth an actual, calibrated chance to be needed.
 *
 * @param rosterPlayers drafted roster, each {id, pos, team}
 * @param projById      projected SEASON points, for setting the lineup
 * @param weeklyActual  {id: {week: realized points}} — absent week = real 0
 * @param byeByTeam     {TEAM: bye week | null}
 * @param roster        slot config
 * @param weeks         weeks to score (default 17)
 * @param injuryOracle  optional (id, pos, week) => out?, from makeInjuryOracle()
 */
export function realizedWeeklyPoints(
  rosterPlayers, projById, weeklyActual, byeByTeam, roster, weeks = 17,
  injuryOracle = null,
) {
  const byeOf = (p) => (p.team && byeByTeam ? byeByTeam[p.team] ?? null : null);
  // Per-week PROJECTION drives the start/sit decision. Divide by weeks
  // actually played so a bye doesn't quietly shrink the player himself.
  const projWk = new Map();
  for (const p of rosterPlayers) {
    const played = Math.max(1, weeks - (byeOf(p) ? 1 : 0));
    projWk.set(p.id, (projById[p.id] ?? 0) / played);
  }
  const realWk = (p, week) => (weeklyActual[p.id]?.[week] ?? 0);

  let total = 0;
  for (let week = 1; week <= weeks; week++) {
    const avail = rosterPlayers.filter((p) =>
      byeOf(p) !== week && !(injuryOracle && injuryOracle(p.id, p.pos, week)));
    const byPos = {};
    for (const p of avail) (byPos[p.pos] ||= []).push(p);
    // Sorted by PROJECTION — never by what actually happened.
    for (const k of Object.keys(byPos)) {
      byPos[k].sort((a, b) => (projWk.get(b.id) || 0) - (projWk.get(a.id) || 0));
    }
    const used = new Set();
    for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
      for (const p of (byPos[pos] || []).slice(0, roster[pos] || 0)) {
        total += realWk(p, week); used.add(p.id);
      }
    }
    const flex = ["RB", "WR", "TE"]
      .flatMap((pos) => byPos[pos] || [])
      .filter((p) => !used.has(p.id))
      .sort((a, b) => (projWk.get(b.id) || 0) - (projWk.get(a.id) || 0));
    for (const p of flex.slice(0, roster.FLEX || 0)) total += realWk(p, week);
  }
  return +total.toFixed(1);
}

/**
 * PAIRED comparison of two configs at one slot, on one season's board.
 *
 * Both arms see an identical league — same pool, same seed, therefore the same
 * opponent picks up to the point our own choice diverges. The returned diff is
 * per-seed, so the caller can report a mean AND how often each arm wins, which
 * matters: a config that wins narrowly nine times in ten is a different
 * proposition from one that wins hugely once.
 */
export function pairedCompare({
  board, pointsById, roster, teams = 10, rounds = 15,
  slot, configA, configB, seeds = [1, 2, 3, 4, 5],
  temperature = 4, agentA = {}, agentB = {},
}) {
  const rows = [];
  for (const seed of seeds) {
    const team = slot - 1;
    const a = simulateDraft({
      board, teams, rounds, roster, seed, temperature,
      agents: { [team]: { slot, params: configA, ...agentA } },
    });
    const b = simulateDraft({
      board, teams, rounds, roster, seed, temperature,
      agents: { [team]: { slot, params: configB, ...agentB } },
    });
    const aPts = bestLineupPoints(a.rosters[team], pointsById, roster);
    const bPts = bestLineupPoints(b.rosters[team], pointsById, roster);
    rows.push({ seed, slot, a: aPts, b: bPts, diff: +(aPts - bPts).toFixed(1) });
  }
  const diffs = rows.map((r) => r.diff);
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, diffs.length - 1));
  return {
    rows,
    meanDiff: +mean.toFixed(2),
    sdDiff: +sd.toFixed(2),
    // Standard error of the paired mean — the number that says whether a
    // difference is distinguishable from draft noise at all.
    seDiff: +(sd / Math.sqrt(diffs.length)).toFixed(2),
    aWins: diffs.filter((d) => d > 0).length,
    n: diffs.length,
  };
}

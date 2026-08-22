/* bye-lineup-value.js — roadmap 2.4. Deterministic bye-aware season value.
 *
 * THE IDEA, in one line: a roster is worth the sum, over every week, of the
 * best lineup it can actually field that week. Players on bye cannot be
 * fielded, so a bench body that covers a bye week is worth something and a
 * bench body stacked behind an already-covered week is not.
 *
 * WHY THIS IS NOT 2.2, WHICH IS CLOSED. 2.2 needed weekly DISTRIBUTIONS,
 * because its thesis was that bench value is paid out of week-to-week
 * volatility ("sometimes your WR3 outscores your WR1"). Those distributions
 * failed calibration — weekly draws understated season variance 3-4x. This
 * module draws nothing. Every number here is deterministic, and the only
 * source of week-to-week difference is the bye schedule, which 2.2a's own
 * pre-registration already classified as "deterministic and known ex ante ...
 * handled structurally in the simulator (no lineup slot, no draw)". So this
 * keeps the half of bench value that never needed a distribution and drops
 * the half that failed.
 *
 * WHAT IT THEREFORE CANNOT PRICE, and must not be described as pricing:
 *   - injury replacement (nobody is ever unavailable except on a bye)
 *   - volatility option value (that was 2.2's thesis; still closed)
 *   - streaming K/DST
 *
 * NOT built on `lineup-optimizer.js` (the 2.2b artifact) even though that also
 * optimises a weekly lineup: its interface is keyed on `season~name~pos~team`
 * strings and takes drawn `weeklyOutcomes`, both shaped for the Monte-Carlo
 * path that 2.2 closed. This is id-keyed and deterministic. Its FLEX also
 * omits TE, which is wrong for a standard league — see that file.
 */

/** FLEX takes the best remaining of these — matches `bestLineupPoints` in
 *  draft-sim.mjs and `bye-weeks.js`, and the user's own stated league rule
 *  ("flex and bench are interchangeable for WR, RB, TE"). */
const FLEX_ELIGIBLE = ["RB", "WR", "TE"];
const FILL_ORDER = ["QB", "RB", "WR", "TE", "K", "DST"];

/** Weeks in the scored season. 18-week NFL regular season since 2021; every
 *  team has exactly one bye inside it. */
export const DEFAULT_WEEKS = 17;

/**
 * Per-week points for a player who earns `seasonPts` across the weeks he
 * actually plays.
 *
 * Dividing by GAMES PLAYED rather than by the week count is the honest
 * conversion: a season projection is what he scores over his playable weeks,
 * so spreading it across a week he is on bye would quietly shrink every
 * player with a bye and make the bye look costly for the wrong reason.
 */
export function perWeekPoints(seasonPts, hasBye, weeks = DEFAULT_WEEKS) {
  const played = Math.max(1, weeks - (hasBye ? 1 : 0));
  return (seasonPts || 0) / played;
}

/**
 * Best legal lineup from `available`, scored on `wk(player)`.
 *
 * Greedy is exact here, not an approximation: dedicated slots take disjoint
 * position pools, and FLEX takes the best of what those leave behind, so
 * there is no exchange that improves the total. (Same structure and same
 * reasoning as `draft-sim.mjs bestLineupPoints`.)
 */
export function bestWeekLineup(available, wk, rosterCfg) {
  const byPos = {};
  for (const p of available) (byPos[p.pos] ||= []).push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => wk(b) - wk(a));

  let total = 0;
  const used = new Set();
  for (const pos of FILL_ORDER) {
    const n = rosterCfg[pos] || 0;
    for (const p of (byPos[pos] || []).slice(0, n)) { total += wk(p); used.add(p); }
  }
  const flex = FLEX_ELIGIBLE
    .flatMap((pos) => byPos[pos] || [])
    .filter((p) => !used.has(p))
    .sort((a, b) => wk(b) - wk(a));
  for (const p of flex.slice(0, rosterCfg.FLEX || 0)) total += wk(p);
  return total;
}

/**
 * Season value of a roster: sum over weeks of the best fieldable lineup.
 *
 * `honorByes: false` is the control arm — the identical calculation with
 * every player available every week. The DIFFERENCE between the two arms is
 * the entire signal this step is testing, so both live here rather than the
 * control being a separate, subtly-different code path.
 *
 * @param {Array}  players    roster, each {id, pos, team}
 * @param {Object} opts
 *   - pointsOf(player) -> season points (projected when valuing, realized when scoring)
 *   - byeOf(player)    -> bye week number, or null/0 for none
 *   - rosterCfg        -> {QB, RB, WR, TE, FLEX, K, DST}
 *   - weeks            -> scored weeks (default 17)
 *   - honorByes        -> when false, nobody is ever on bye
 */
export function seasonLineupValue(players, {
  pointsOf, byeOf, rosterCfg, weeks = DEFAULT_WEEKS, honorByes = true,
} = {}) {
  if (!players || !players.length) return 0;

  // Per-week points are fixed across weeks (deterministic model), so compute
  // once per player rather than per week.
  const byeCache = new Map();
  const wkCache = new Map();
  for (const p of players) {
    const bye = byeOf ? byeOf(p) : null;
    byeCache.set(p, bye || null);
    wkCache.set(p, perWeekPoints(pointsOf(p), !!bye, weeks));
  }
  const wk = (p) => wkCache.get(p) || 0;

  let total = 0;
  for (let week = 1; week <= weeks; week++) {
    const available = honorByes
      ? players.filter((p) => byeCache.get(p) !== week)
      : players;
    total += bestWeekLineup(available, wk, rosterCfg);
  }
  return total;
}

/**
 * What adding `candidate` to `roster` is worth, in season lineup points.
 *
 * This is the number a drafting agent should maximise under 2.4, and it
 * subsumes several things the shipped recommender handles with separate
 * heuristics: a third quarterback adds almost nothing because he almost never
 * enters a lineup, and a bench back whose bye week is already covered adds
 * less than one whose is not. No `needMult`, no `maxUseful` gate, no
 * `byeClash` penalty — the lineup calculation produces all of it.
 */
export function marginalLineupValue(candidate, roster, opts = {}) {
  const before = seasonLineupValue(roster, opts);
  const after = seasonLineupValue([...roster, candidate], opts);
  return after - before;
}

/**
 * Bye multiplier for a candidate — the drop-in replacement for `byeClash`'s
 * `mult` in `snake-engine.js pickScore`, expressed the same way so it can be
 * swapped in for an isolated comparison.
 *
 * `marginalByeAware / marginalByeBlind`: how much of this player's marginal
 * lineup value survives the real bye schedule. Above 1 is possible and is the
 * point — a bench body worth little in a bye-blind world can be worth real
 * points as cover, which `byeClash` (a penalty, never a credit) can never
 * express.
 *
 * Clamped, because the ratio is unstable exactly where it is least
 * meaningful: a candidate who would never start in a bye-blind world has a
 * marginal denominator near zero, and an unclamped ratio there would hand a
 * deep bench player an unbounded bonus off a rounding difference.
 */
export function byeLineupMult(candidate, roster, opts = {}, { max = 0.15, eps = 0.5 } = {}) {
  const aware = marginalLineupValue(candidate, roster, { ...opts, honorByes: true });
  const blind = marginalLineupValue(candidate, roster, { ...opts, honorByes: false });
  if (blind <= eps) {
    // No meaningful bye-blind value to scale. Credit real bye cover, but only
    // up to the same cap the penalty side uses.
    return aware > eps ? 1 + max : 1;
  }
  const ratio = aware / blind;
  return Math.min(1 + max, Math.max(1 - max, ratio));
}

/**
 * Lineup Optimizer — select the best starting lineup for a given week
 * Roadmap 2.2b: weekly-lineup season simulator
 *
 * Given a roster with weekly outcome draws (weekly points), position limits,
 * and availability (byes, injuries), greedily optimize lineups by marginal
 * contribution: for each position slot, pick the available player at that
 * position who maximizes that week's expected score minus the bench best.
 */

/**
 * optimizeLineup(roster, week, leagueSettings, weeklyOutcomes, schedule)
 *
 * @param {Array} roster - [{name, pos, team, proj_week}, ...] for this season
 * @param {number} week - week number (1–17 in NFL)
 * @param {Object} leagueSettings - {roster: {QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, DST: 1}, bench: 5}
 * @param {Object} weeklyOutcomes - {(season,name,pos,team): weekPoints} drawn for this week
 * @param {Object} schedule - {(season,team): {week: opp}} to detect byes
 *
 * @returns {Object} {starters: [...], bench: [...], score: number}
 *
 * Starters are sorted into position order. Bench is unsorted.
 * Score is the sum of starters' weekly points.
 */
export function optimizeLineup(roster, week, leagueSettings, weeklyOutcomes, schedule, season) {
  if (!roster || roster.length === 0) {
    return { starters: [], bench: [], score: 0 };
  }

  // Derive available players (exclude byes)
  const available = roster.filter((p) => {
    if (schedule && schedule[`${season}~${p.team}`]) {
      const teamSchedule = schedule[`${season}~${p.team}`];
      if (!teamSchedule[week]) {
        // Missing week = bye, unavailable
        return false;
      }
    }
    return true;
  });

  // Sort available players into position buckets
  const byPos = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DST']) {
    byPos[pos] = available.filter((p) => p.pos === pos);
  }

  // Greedy slot-filling: for each position slot (including FLEX),
  // pick the best available player at that position.
  const starters = [];
  const used = new Set();

  // Helper: get player's weekly points
  const getPoints = (p) => weeklyOutcomes[`${season}~${p.name}~${p.pos}~${p.team}`] || 0;

  // Fill non-FLEX positions first
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DST']) {
    const slots = leagueSettings.roster[pos] || 0;
    for (let i = 0; i < slots; i++) {
      const candidates = byPos[pos].filter((p) => !used.has(`${p.name}~${p.pos}~${p.team}`));
      if (candidates.length === 0) continue;

      // Pick the candidate with highest weekly points
      const best = candidates.reduce((acc, p) => {
        const pts = getPoints(p);
        return pts > (acc.pts || -Infinity) ? { p, pts } : acc;
      }, {});

      if (best.p) {
        starters.push(best.p);
        used.add(`${best.p.name}~${best.p.pos}~${best.p.team}`);
      }
    }
  }

  // Fill FLEX slots with best available RB or WR
  const flexSlots = leagueSettings.roster.FLEX || 0;
  for (let i = 0; i < flexSlots; i++) {
    const candidates = [...byPos.RB, ...byPos.WR].filter(
      (p) => !used.has(`${p.name}~${p.pos}~${p.team}`),
    );
    if (candidates.length === 0) break;

    const best = candidates.reduce((acc, p) => {
      const pts = getPoints(p);
      return pts > (acc.pts || -Infinity) ? { p, pts } : acc;
    }, {});

    if (best.p) {
      starters.push(best.p);
      used.add(`${best.p.name}~${best.p.pos}~${best.p.team}`);
    }
  }

  // Bench: everyone not starting
  const bench = available.filter((p) => !used.has(`${p.name}~${p.pos}~${p.team}`));

  // Calculate starter score
  const score = starters.reduce((sum, p) => sum + getPoints(p), 0);

  return { starters, bench, score };
}

/**
 * simulateSeason(roster, leagueSettings, weeklyDistributions, schedule, season, rng, nDraws)
 *
 * Monte Carlo simulation of one season: for each week, draw from weekly
 * outcome distributions, optimize lineup, score, accumulate season total.
 * Returns sorted array of season totals from nDraws independent runs.
 *
 * @param {Array} roster - player roster
 * @param {Object} leagueSettings - roster config
 * @param {Object} weeklyDistributions - {(season,name,pos,team): [sorted ratios]} per position
 * @param {Object} schedule - bye schedule
 * @param {number} season - season year
 * @param {function} rng - random() returning [0, 1), for testing
 * @param {number} nDraws - number of independent season simulations (default 1000)
 *
 * @returns {Array} sorted season totals
 */
export function simulateSeason(
  roster,
  leagueSettings,
  weeklyDistributions,
  schedule,
  season,
  rng = Math.random,
  nDraws = 1000,
) {
  const seasonTotals = [];

  for (let draw = 0; draw < nDraws; draw++) {
    let seasonScore = 0;

    // Iterate through weeks 1–17 (or however many the league plays)
    const nWeeks = leagueSettings.weeks || 17;
    for (let week = 1; week <= nWeeks; week++) {
      // Draw weekly outcomes for each player this week:
      // form once per player-season, residual per week.
      // (This assumes the input `weeklyDistributions` already reflects the
      // form-factor composition; we just draw from the per-week post-form pools
      // as if they were already calibrated.)
      const weeklyOutcomes = {};

      for (const p of roster) {
        const key = `${season}~${p.name}~${p.pos}~${p.team}`;
        // Draw from weekly distribution if it exists
        // (in real use, this would be per-week form + residual from the backtest)
        if (weeklyDistributions[key]) {
          const pool = weeklyDistributions[key];
          const idx = Math.floor(rng() * pool.length);
          const ratio = pool[idx];
          // Apply to this week's live-board projection
          weeklyOutcomes[key] = (p.proj_week || 0) * ratio;
        } else {
          weeklyOutcomes[key] = 0;
        }
      }

      // Optimize lineup for this week
      const lineup = optimizeLineup(roster, week, leagueSettings, weeklyOutcomes, schedule, season);
      seasonScore += lineup.score;
    }

    seasonTotals.push(seasonScore);
  }

  // Sort for quantile access
  return seasonTotals.sort((a, b) => a - b);
}

/**
 * Utility: compute season totals' quantile-based statistics for calibration checks.
 * @param {Array} sorted - sorted array of simulated season totals
 * @returns {Object} {mean, sd, q5, q25, q50, q75, q95}
 */
export function seasonStats(sorted) {
  if (!sorted || sorted.length === 0) return {};

  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const variance =
    sorted.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, sorted.length - 1);
  const sd = Math.sqrt(variance);

  const quantile = (p) => {
    const idx = p * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    const weight = idx - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  };

  return {
    mean,
    sd,
    q5: quantile(0.05),
    q25: quantile(0.25),
    q50: quantile(0.5),
    q75: quantile(0.75),
    q95: quantile(0.95),
  };
}

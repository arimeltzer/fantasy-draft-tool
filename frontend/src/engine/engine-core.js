/* =====================================================================
   ENGINE CORE — shared VBD machinery for both auction and snake.

   Import from auction-engine.js or snake-engine.js for format-specific
   functions and params. Import directly from here if you only need the
   shared pipeline (scoring, projection blending, VBD).
   ===================================================================== */

export const DEFAULT_PARAMS = {
  // How much last season's actual production should pull the projection.
  priorWeight: 0.35,

  // Mean reversion: dampens the last-season correction.
  regressionStrength: 0.25,

  // Last season normalized to per-game pace, scaled to a full season.
  projectedGames: 17,

  // Age multipliers per position.
  age: {
    QB:  { declineStart: 35, declinePerYear: 0.03, youthPeak: 0,  youthBonus: 0.00 },
    RB:  { declineStart: 27, declinePerYear: 0.05, youthPeak: 23, youthBonus: 0.03 },
    WR:  { declineStart: 30, declinePerYear: 0.03, youthPeak: 24, youthBonus: 0.02 },
    TE:  { declineStart: 31, declinePerYear: 0.03, youthPeak: 25, youthBonus: 0.02 },
    K:   { declineStart: 99, declinePerYear: 0.00, youthPeak: 0,  youthBonus: 0.00 },
    DST: { declineStart: 99, declinePerYear: 0.00, youthPeak: 0,  youthBonus: 0.00 },
  },
  ageClamp: [0.85, 1.06],

  // FLEX spots split across RB/WR/TE when computing replacement level.
  flexShare: { RB: 0.50, WR: 0.42, TE: 0.08 },

  // Projection methodology (ported from the offline research model). Player
  // value is projected client-side from two prior seasons + age + ADP, rather
  // than trusting an external `proj` field. Tune here to change every board.
  projection: {
    primaryWeight:     0.70,  // weight on the most recent season in the 2-year blend
    primaryWeightUp:   0.80,  // if trending up  > trendThreshold pts/season, trust recent more
    primaryWeightDown: 0.65,  // if trending down > trendThreshold, discount the down year (rebound)
    trendThreshold:    50,    // pts/season pace delta that flips the weight
    // Durability discount by games played last season: gp < threshold → mult.
    durability: [[6, 0.60], [10, 0.74], [14, 0.88]],   // else 1.0
    // Rookies / players with no recent stats: ADP-tier estimate (no NFL draft
    // round available in the pipeline — coarse approximation, market `proj`
    // used first when present).
    rookieCeil:   { QB: 330, RB: 285, WR: 275, TE: 205, K: 130, DST: 130 },
    rookieEraBonus: 1.12,
    rookieAdpFloor: 0.15,     // min fraction of ceiling at deep ADP
    rookieAdpSpan:  200,      // ADP at which the estimate reaches the floor
    // WRs on teams with a fragile QB situation take a talent discount.
    fragileQbTeams:  [],      // e.g. ["CLE", "NYG"] — manual upkeep
    fragileQbWrMult: 0.85,
  },

  // Kept here so valuation-engine.js shim stays backward-compatible with
  // callers that pass DEFAULT_PARAMS directly to auctionValues().
  auction: { minBid: 1 },
};

export const SCORING_PRESETS = {
  Standard:   { ppr: 0 },
  "Half-PPR": { ppr: 0.5 },
  PPR:        { ppr: 1 },
};

export function defaultScoring(ppr = 0.5) {
  return {
    ptsPerPassYd: 0.04, ptsPerPassTD: 4, ptsPerInt: -2,
    ptsPerRushYd: 0.1,  ptsPerRushTD: 6,
    ptsPerRec: ppr,     ptsPerRecYd: 0.1, ptsPerRecTD: 6,
    ptsPerFumble: -2,
  };
}

export function points(line = {}, sc) {
  const g = (k) => line[k] || 0;
  const hasStats = g("passYd") || g("passTD") || g("rushYd") ||
                   g("rushTD") || g("rec") || g("recYd") || g("recTD");
  if (!hasStats && line.pts != null) return line.pts;
  return (
    g("passYd") * sc.ptsPerPassYd + g("passTD") * sc.ptsPerPassTD + g("int") * sc.ptsPerInt +
    g("rushYd") * sc.ptsPerRushYd + g("rushTD") * sc.ptsPerRushTD +
    g("rec") * sc.ptsPerRec + g("recYd") * sc.ptsPerRecYd + g("recTD") * sc.ptsPerRecTD +
    g("fumbles") * sc.ptsPerFumble
  );
}

export function ageMultiplier(pos, age, P = DEFAULT_PARAMS) {
  const c = P.age[pos];
  if (!c || !age) return 1;
  let m = 1;
  if (age > c.declineStart) m -= (age - c.declineStart) * c.declinePerYear;
  if (c.youthPeak && age <= c.youthPeak) m += c.youthBonus;
  return Math.min(P.ageClamp[1], Math.max(P.ageClamp[0], m));
}

/** Games-played durability discount: first threshold gp falls under wins. */
function durabilityMult(gp, table) {
  for (const [thresh, mult] of table) if (gp < thresh) return mult;
  return 1.0;
}

/** Rookie / no-recent-stats projection: market `proj` if present, else ADP tier. */
function rookieProjection(player, sc, PP) {
  const marketPts = points(player.proj || {}, sc);
  if (marketPts > 0) return marketPts;
  const ceil = PP.rookieCeil[player.pos] ?? 150;
  const adp = player.adp;
  if (adp == null || adp <= 0) return ceil * PP.rookieAdpFloor * PP.rookieEraBonus;
  const frac = Math.max(PP.rookieAdpFloor, 1 - Math.log(adp) / Math.log(PP.rookieAdpSpan));
  return ceil * frac * PP.rookieEraBonus;
}

/**
 * Project a player's full-season fantasy points from two prior seasons.
 * Returns the breakdown so projectValue() can derive risk without recomputing.
 *
 *   pace(season) = points(season)/gp × projectedGames   (full-season equivalent)
 *   blend        = w1·pace(last) + (1-w1)·pace(last2)    (w1 shifts on trend)
 *   proj         = blend × durability × age × situation
 */
export function projectPoints(player, sc, P = DEFAULT_PARAMS) {
  const PP = P.projection || DEFAULT_PARAMS.projection;
  const G = P.projectedGames;

  const pace = (season) =>
    season && (season.gp || 0) > 0 ? (points(season, sc) / season.gp) * G : null;
  const pace1 = pace(player.last);
  const pace2 = pace(player.last2);
  const ageMult = ageMultiplier(player.pos, player.age, P);

  if (pace1 == null && pace2 == null) {
    const proj = +(rookieProjection(player, sc, PP) * ageMult).toFixed(1);
    return { proj, pace1: null, pace2: null, trend: null, durMult: 1, ageMult, rookie: true };
  }

  let blended, trend = null;
  if (pace1 != null && pace2 != null) {
    trend = pace1 - pace2;
    let w1 = PP.primaryWeight;
    if (trend > PP.trendThreshold) w1 = PP.primaryWeightUp;
    else if (trend < -PP.trendThreshold) w1 = PP.primaryWeightDown;
    blended = w1 * pace1 + (1 - w1) * pace2;
  } else {
    blended = pace1 != null ? pace1 : pace2;
  }

  const gp = (player.last && player.last.gp) || (player.last2 && player.last2.gp) || G;
  const durMult = durabilityMult(gp, PP.durability);

  const situ = (player.pos === "WR" && Array.isArray(PP.fragileQbTeams) &&
                PP.fragileQbTeams.includes(player.team)) ? PP.fragileQbWrMult : 1;

  const proj = +(blended * durMult * ageMult * situ).toFixed(1);
  return { proj, pace1, pace2, trend, durMult, ageMult, rookie: false };
}

export function projectValue(player, sc, P = DEFAULT_PARAMS) {
  const pp = projectPoints(player, sc, P);
  const valuePoints = pp.proj;

  const injuryRisk = Math.min(1, Math.max(0, (1 - pp.durMult) / 0.40));
  const volatility = pp.pace1 != null && pp.pace2 != null && pp.pace1 !== 0
    ? Math.min(1, Math.abs(pp.pace1 - pp.pace2) / pp.pace1)
    : (pp.rookie ? 0.5 : 0.2);
  const ageRisk = Math.max(0, 1 - pp.ageMult);
  const risk = +Math.min(1, 0.45 * volatility + 0.35 * injuryRisk + 1.8 * ageRisk).toFixed(2);

  return {
    projPts: valuePoints,
    priorEquiv: pp.pace1 == null ? null : +pp.pace1.toFixed(1),
    valuePoints,
    ageMult: +pp.ageMult.toFixed(3),
    trend: pp.trend == null ? null : +pp.trend.toFixed(1),
    rookie: pp.rookie,
    risk,
  };
}

export function replacementRanks(league, P = DEFAULT_PARAMS) {
  const { teams, roster, superflex } = league;
  const flex = teams * (roster.FLEX || 0);
  const r = {
    QB:  teams * (roster.QB  || 0),
    RB:  teams * (roster.RB  || 0) + flex * P.flexShare.RB,
    WR:  teams * (roster.WR  || 0) + flex * P.flexShare.WR,
    TE:  teams * (roster.TE  || 0) + flex * P.flexShare.TE,
    K:   teams * (roster.K   || 0),
    DST: teams * (roster.DST || 0),
  };
  if (superflex) r.QB += teams * (roster.SF || 1);
  return r;
}

export function valueBoard(players, league, sc, P = DEFAULT_PARAMS) {
  const scored = players.map((pl) => ({ ...pl, ...projectValue(pl, sc, P) }));
  const rep = replacementRanks(league, P);
  const repPts = {};
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    const list = scored.filter((p) => p.pos === pos).sort((a, b) => b.valuePoints - a.valuePoints);
    const idx = Math.max(0, Math.floor(rep[pos]) - 1);
    repPts[pos] = list.length ? (list[Math.min(idx, list.length - 1)]?.valuePoints ?? 0) : 0;
  }
  const board = scored.map((p) => ({
    ...p,
    vbd: +(p.valuePoints - (repPts[p.pos] ?? 0)).toFixed(1),
  }));

  const tier = {};
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const list = board.filter((p) => p.pos === pos).sort((a, b) => b.vbd - a.vbd);
    let t = 1;
    list.forEach((p, i) => {
      if (i > 0 && (list[i - 1].vbd - p.vbd) > 18) t++;
      tier[p.id] = t;
    });
  }
  return board.map((p) => ({ ...p, tier: tier[p.id] || null })).sort((a, b) => b.vbd - a.vbd);
}

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

export function projectValue(player, sc, P = DEFAULT_PARAMS) {
  const projPts = points(player.proj || {}, sc);

  let priorEquiv = null;
  if (player.last && (player.last.gp || 0) > 0) {
    const ppg = points(player.last, sc) / player.last.gp;
    priorEquiv = ppg * P.projectedGames;
  }

  const correction = priorEquiv == null
    ? 0
    : P.priorWeight * (1 - P.regressionStrength) * (priorEquiv - projPts);

  const blended = projPts + correction;
  const ageMult = ageMultiplier(player.pos, player.age, P);
  const valuePoints = +(blended * ageMult).toFixed(1);

  const divergence = priorEquiv == null || projPts === 0
    ? 0 : Math.min(1, Math.abs(priorEquiv - projPts) / projPts);
  const injury = player.last
    ? Math.min(1, Math.max(0, (P.projectedGames - (player.last.gp || P.projectedGames)) / P.projectedGames))
    : 0;
  const ageRisk = 1 - ageMult;
  const risk = +Math.min(1, 0.5 * divergence + 0.3 * injury + 2 * Math.max(0, ageRisk)).toFixed(2);

  return {
    projPts: +projPts.toFixed(1),
    priorEquiv: priorEquiv == null ? null : +priorEquiv.toFixed(1),
    valuePoints,
    ageMult: +ageMult.toFixed(3),
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

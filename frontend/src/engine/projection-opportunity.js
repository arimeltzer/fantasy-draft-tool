/* =====================================================================
   PROJECTION OPPORTUNITY — two-stage projection: volume x shrunk efficiency
   ---------------------------------------------------------------------
   Roadmap Phase 1 (1.1/1.2). SHIPPED FOR TE ONLY.

   Mirrors data-pipeline/projection_opportunity.py exactly for the ONE
   number that matters, `proj` — parity-tested against it
   (opportunity_parity.py). Points are volume x efficiency, and only one of
   those two repeats year to year: v2 already established touchdown RATE is
   close to random while touchdown VOLUME is not. This generalizes that one
   step further, splitting the projection into two independent stages
   instead of patching shrunk touchdowns onto the points-pace blend, and
   shrinking the WHOLE per-opportunity rate (yards and touchdowns together),
   not just the touchdown component — v2 left yardage alone on the
   assumption it's stable "over hundreds of events", which isn't true for a
   40-target committee receiver.

     1. VOLUME (projectVolume) — next season's expected opportunities
        (targets for TE — the only position shipped; see OPPORTUNITY_FIELDS
        for the full table swept), using the SAME trend-weighted,
        durability-discounted blend shape projectPoints() already uses for
        points pace.
     2. EFFICIENCY (computeLeagueEfficiency + the shrinkage in
        projectPointsOpportunity) — points per opportunity, shrunk toward
        the league rate via the same empirical-Bayes construction
        projection_v2.py uses for touchdown rate.

   RESULT (docs/ROADMAP.md Phase 1). Swept 2017-2025 two ways: against the
   pre-Phase-0 pure model, and against what is actually live (injury
   discount + expert blend + anchor, at their shipped weights) — the
   question that decides what ships. QB and WR passed the first and failed
   the second: their gain was mostly signal the expert blend (weighted
   0.3/0.4 there, the two highest) already extracted. RB failed both,
   landing within 0.0003 of v2's already-rejected RB result each time. TE
   passed both — lowest expert-blend trust (0.2), no injury discount at all,
   genuine room left. Shipped as OPPORTUNITY_K = { TE: 2.0 }, everyone else
   0 (inert — always falls back to the shipped points-pace model).

   FALLBACK. K/DST have no clean "opportunity" concept, and a true rookie has
   no prior-season volume to project from either — both keep the shipped
   points-pace projection untouched.

   NO PARITY REQUIRED on `computeLeagueEfficiency`'s INPUT DATA: the Python
   backtest pools opportunity across every prior NFL season it can load; this
   pools across whatever's on the current board (each player's last + last2)
   — a client-side engine has no multi-season historical dataset to reach
   for. That's a real, necessary difference in what data feeds the formula,
   not a formula difference — the shrinkage math itself, and what it produces
   from a given rates table, is exactly what's parity-tested.
   ===================================================================== */
import { DEFAULT_PARAMS, ageMultiplier, durabilityMult, points } from "./engine-core.js";

/** Which season-line fields sum to "opportunities" for a position.
 *  Positions absent here (K, DST) have no clean volume concept. */
export const OPPORTUNITY_FIELDS = {
  QB: ["attempts", "carries"],
  RB: ["carries", "targets"],
  WR: ["targets"],
  TE: ["targets"],
};

/** Shipped efficiency-shrinkage strength, per position (roadmap Phase 1).
 *  Only TE cleared the kill gate against the live board; everyone else is 0. */
export const OPPORTUNITY_K = { QB: 0, RB: 0, WR: 0, TE: 2.0, K: 0, DST: 0 };

/** Total opportunities on one season line, for this position's fields. */
export function opportunity(line, pos) {
  const fields = OPPORTUNITY_FIELDS[pos];
  if (!line || !fields) return 0;
  return fields.reduce((s, f) => s + (line[f] || 0), 0);
}

function trendWeight(pace1, pace2, PP) {
  const trend = pace1 - pace2;
  if (trend > PP.trendThreshold) return PP.primaryWeightUp;
  if (trend < -PP.trendThreshold) return PP.primaryWeightDown;
  return PP.primaryWeight;
}

/**
 * Stage 1: next season's expected opportunities, plus the pace/durability
 * breakdown (needed for the opportunity model's own risk score, same shape
 * projectPoints() already returns for the points-pace blend).
 * Returns null for a position with no opportunity concept, or a player with
 * no prior-season volume at all (true rookies stay on rookieProjection()).
 */
function volumePace(player, P) {
  const pos = player.pos;
  if (!OPPORTUNITY_FIELDS[pos]) return null;
  const PP = P.projection;
  const G = P.projectedGames;
  const last = player.last, last2 = player.last2;
  const gp1 = (last && last.gp) || 0;
  const gp2 = (last2 && last2.gp) || 0;
  const pace1 = gp1 ? (opportunity(last, pos) / gp1) * G : null;
  const pace2 = gp2 ? (opportunity(last2, pos) / gp2) * G : null;
  if (pace1 == null && pace2 == null) return null;

  let blended;
  if (pace1 != null && pace2 != null) {
    const w1 = trendWeight(pace1, pace2, PP);
    blended = w1 * pace1 + (1 - w1) * pace2;
  } else {
    blended = pace1 != null ? pace1 : pace2;
  }
  const gp = gp1 || gp2 || G;
  const durMult = durabilityMult(gp, PP.durability);
  return { volume: blended * durMult, pace1, pace2, durMult };
}

/** (points, opportunities) pooled across whichever prior seasons the player
 *  has — the player's own empirical evidence, before shrinkage. */
function playerOwnRate(player, sc, pos) {
  let pts = 0, opp = 0;
  for (const line of [player.last, player.last2]) {
    if (!line) continue;
    const o = opportunity(line, pos);
    if (o > 0) { pts += points(line, sc); opp += o; }
  }
  return { pts, opp };
}

/**
 * Per position: pooled points-per-opportunity rate and typical workload,
 * from whatever the board carries (each player's last + last2) — see the
 * module doc for why this differs from the backtest's multi-season pool.
 */
export function computeLeagueEfficiency(players, sc) {
  const acc = {};
  for (const p of players) {
    if (!OPPORTUNITY_FIELDS[p.pos]) continue;
    for (const line of [p.last, p.last2]) {
      if (!line) continue;
      const opp = opportunity(line, p.pos);
      if (opp <= 0) continue;
      const a = (acc[p.pos] ||= { pts: 0, opp: 0, n: 0 });
      a.pts += points(line, sc);
      a.opp += opp;
      a.n += 1;
    }
  }
  const out = {};
  for (const [pos, a] of Object.entries(acc)) {
    if (a.opp > 0 && a.n > 0) out[pos] = { rate: a.pts / a.opp, meanOpp: a.opp / a.n };
  }
  return out;
}

/**
 * The two-stage projection: volume x shrunk efficiency x age.
 * Returns null when there's no usable volume signal (K/DST, a true rookie,
 * or no league rate for the position) — the caller's job to fall back to
 * the shipped model in that case, not this function's.
 */
export function projectPointsOpportunity(player, sc, rates, k, P = DEFAULT_PARAMS) {
  const pos = player.pos;
  const vp = volumePace(player, P);
  const { pts: ownPts, opp: ownOpp } = playerOwnRate(player, sc, pos);
  const r = rates[pos];
  if (!vp || vp.volume <= 0 || ownOpp <= 0 || !r) return null;

  const n0 = k * r.meanOpp;
  const shrunkRate = (ownPts + n0 * r.rate) / (ownOpp + n0);
  const ageMult = ageMultiplier(pos, player.age, P);
  const proj = +(vp.volume * shrunkRate * ageMult).toFixed(1);
  return {
    proj, pace1: vp.pace1, pace2: vp.pace2, durMult: vp.durMult, ageMult,
    volume: +vp.volume.toFixed(1), efficiency: +shrunkRate.toFixed(4),
    ownEfficiency: +(ownPts / ownOpp).toFixed(4), rookie: false,
  };
}

/** projectValue()-shaped output from the opportunity model. Same risk
 *  formula projectValue() uses, fed from the volume blend's own pace1/pace2/
 *  durMult instead of the points blend's — "volatility" here is real
 *  usage-swing risk (how much a player's ROLE moved year to year), not a
 *  fabricated default, and arguably a more honest signal than the points
 *  model's version, which conflated it with touchdown luck. */
function projectValueOpportunity(player, sc, rates, k, P = DEFAULT_PARAMS) {
  const pp = projectPointsOpportunity(player, sc, rates, k, P);
  if (!pp) return null;

  const valuePoints = pp.proj;
  const injuryRisk = Math.min(1, Math.max(0, (1 - pp.durMult) / 0.40));
  const volatility = pp.pace1 != null && pp.pace2 != null && pp.pace1 !== 0
    ? Math.min(1, Math.abs(pp.pace1 - pp.pace2) / pp.pace1)
    : 0.2;
  const ageRisk = Math.max(0, 1 - pp.ageMult);
  const risk = +Math.min(1, 0.45 * volatility + 0.35 * injuryRisk + 1.8 * ageRisk).toFixed(2);

  return {
    projPts: valuePoints, priorEquiv: pp.pace1 == null ? null : +pp.pace1.toFixed(1),
    valuePoints, ageMult: +pp.ageMult.toFixed(3), trend: null, rookie: false, risk,
    opportunityBased: true, volume: pp.volume, efficiency: pp.efficiency,
  };
}

/**
 * Apply the opportunity model across a projected board, keyed by
 * OPPORTUNITY_K[pos]. Runs right after projectAll(), before the injury
 * discount / expert blend / anchor — the backtest that validated
 * OPPORTUNITY_K measured exactly that order (opportunity model -> injury
 * discount -> expert blend -> anchor).
 *
 * A player the opportunity model has nothing to say about (no usable volume,
 * K/DST, a rookie) is returned untouched — whatever projectAll() already
 * gave them stands, same coverage rule the expert blend and injury discount
 * use.
 */
export function applyOpportunityModel(players, sc, K = OPPORTUNITY_K, P = DEFAULT_PARAMS) {
  if (!Object.values(K).some((k) => k > 0)) return players;
  const rates = computeLeagueEfficiency(players, sc);
  return players.map((p) => {
    const k = K[p.pos];
    if (!k) return p;
    const ov = projectValueOpportunity(p, sc, rates, k, P);
    return ov ? { ...p, ...ov } : p;
  });
}

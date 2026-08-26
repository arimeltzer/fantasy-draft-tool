/* =====================================================================
   ENGINE CORE — shared VBD machinery for both auction and snake.

   Import from auction-engine.js or snake-engine.js for format-specific
   functions and params. Import directly from here if you only need the
   shared pipeline (scoring, projection blending, VBD).
   ===================================================================== */

export const DEFAULT_PARAMS = {
  // ⚠ UNUSED. Nothing reads these two — `projectPoints()` blends seasons with
  // `projection.primaryWeight` / `trendThreshold` instead. They are the only
  // parameters `data-pipeline/backtest_parameters.py` tunes, which means that
  // backtest has never been measuring the shipped model.
  //
  // Kept (rather than deleted) because the backtest still references them, but
  // do NOT treat these values as tuned: run against 2015-2025, the grid's best
  // setting for both was 0.0 — i.e. "apply no correction". See
  // docs/PROJECTION_BACKTEST.md before wiring them into anything.
  priorWeight: 0.35,
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

// Standard scoring, everything except receptions (which is the league's PPR
// setting). This is the single source of truth for "what we score a stat
// category at when the league hasn't told us otherwise" — both
// defaultScoring() and resolveScoring() build off it, so there's exactly one
// place to change if the baseline ever needs adjusting.
export const DEFAULT_SCORING = {
  ptsPerPassYd: 0.04, ptsPerPassTD: 4, ptsPerInt: -2,
  ptsPerRushYd: 0.1,  ptsPerRushTD: 6,
  ptsPerRecYd: 0.1,   ptsPerRecTD: 6,
  ptsPerFumble: -2,
};

export function defaultScoring(ppr = 0.5) {
  return { ...DEFAULT_SCORING, ptsPerRec: ppr };
}

/**
 * Resolve a league's FULL scoring rules from its settings, not just PPR.
 *
 * `settings.ppr` remains the single source of truth for reception points
 * (unchanged from before — it's what every league form already edits).
 * `settings.scoring` is an optional partial override for every OTHER stat
 * category (pass/rush/rec yards+TDs, INTs, fumbles); any field left unset
 * falls back to DEFAULT_SCORING, so a league that never touches `scoring`
 * gets byte-identical behavior to the old defaultScoring(ppr) call — this is
 * a pure additive capability, not a behavior change for existing leagues.
 */
export function resolveScoring(settings = {}) {
  return { ...DEFAULT_SCORING, ...(settings.scoring || {}), ptsPerRec: settings.ppr ?? 0.5 };
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

/** Games-played durability discount: first threshold gp falls under wins.
 *  Exported for projection-opportunity.js — its volume blend uses the same
 *  discount shape, applied to opportunities instead of points. */
export function durabilityMult(gp, table) {
  for (const [thresh, mult] of table) if (gp < thresh) return mult;
  return 1.0;
}

/**
 * Rookie / no-recent-stats projection.
 *
 * Order of evidence: a real market projection if we have one, else the
 * player's market RANK on a decaying curve from the positional ceiling, else
 * the floor.
 *
 * Rank falls back from ADP to ECR — the same fallback `rankByAdp()` makes, and
 * for the same reason: a FantasyPros pull often carries rankings but no ADP.
 * Without it every rookie collapses to the identical floor value, so the #3
 * pick and the 878th-ranked player look equally worthless. That is worse than
 * being absent: a player shown at replacement level reads as a considered
 * judgement rather than missing data.
 */
function rookieProjection(player, sc, PP) {
  const marketPts = points(player.proj || {}, sc);
  if (marketPts > 0) return marketPts;
  const ceil = PP.rookieCeil[player.pos] ?? 150;
  const rank = player.adp != null && player.adp > 0 ? player.adp
             : player.ecr != null && player.ecr > 0 ? player.ecr
             : null;
  if (rank == null) return ceil * PP.rookieAdpFloor * PP.rookieEraBonus;
  const frac = Math.max(PP.rookieAdpFloor, 1 - Math.log(rank) / Math.log(PP.rookieAdpSpan));
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

/**
 * Is this row worth surfacing in the "rookies only" board filter?
 *
 * `player.rookie` (set above) means "no prior-season stats to project from" —
 * that's the right signal for valuation (it drives risk and gates the expert
 * blend), but it is broader than "rookie" in the sense a drafter means when
 * they click this filter. K and DST hit the same no-stats fallback for
 * reasons that have nothing to do with being a rookie: a DST is a standing
 * team-level entity that fields one every year (there is no such thing as a
 * rookie defense), and a statless K is almost always a journeyman cycling
 * rosters, not the rare true rookie kicker. Nobody drafting late for "an
 * unproven rookie's upside" (the filter's own stated purpose) means a
 * kicker or a defense. Reported live: the filter was "over broad — pulling
 * in defenses and kickers." Valuation (risk, blendExpertAll's skip) is left
 * alone — this is a display-only distinction, same as the rookies filter
 * itself.
 */
export function isRookieFilterMatch(player) {
  return !!player.rookie && player.pos !== "K" && player.pos !== "DST";
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

/**
 * Per-position weight on OUR model when blending with the FantasyPros expert
 * projection, in POINTS space (roadmap 0.1). w=1 is our model untouched, w=0
 * is the experts' number.
 *
 * Backtested 2019-2025 (`data-pipeline/projection_backtest.py`): at these
 * weights, BOTH halves of the pre-committed kill gate in docs/ROADMAP.md
 * clear — matched-population Spearman beats plain ADP, and the full-board
 * merged-with-market-anchor number beats the shipped model, at every
 * position (QB +0.030, RB +0.037, TE +0.044, WR +0.020 over the pre-0.1
 * merged board).
 *
 * Unlike MARKET_ANCHOR_W, this is deliberately four separate numbers, not
 * one shared constant: the per-position optimum here (0.2-0.4) is narrower
 * and more position-dependent than the market anchor's flat 0.2-0.5 range —
 * QB and WR are more than one full weight-step apart at the top of their
 * curves — so a single constant would give up real, measured signal for no
 * parsimony benefit. K/DST were never in the backtest population (no
 * FantasyPros expert projection was tested for them), so they stay at w=1
 * (pure model) rather than guess a weight nothing validated.
 */
export const EXPERT_BLEND_W = { QB: 0.3, RB: 0.2, TE: 0.2, WR: 0.4, K: 1.0, DST: 1.0 };

/**
 * Blend our model's points with the experts' (FantasyPros) projection, in
 * POINTS space — preserves magnitude, unlike marketAnchor's rank transfer.
 * `w` is the weight on OUR model.
 *
 * A player the experts do not cover — no `proj` at all, or a projection of
 * exactly 0, which reads as "no opinion filed" rather than "projected for
 * zero points" — keeps our model's number untouched. Blending toward an
 * absent or zero opinion would quietly rewrite the ~45-50% of the board
 * FantasyPros doesn't project down toward zero.
 */
export function blendExpert(modelPts, expertPts, w) {
  if (expertPts == null || !(expertPts > 0)) return modelPts;
  return +(w * modelPts + (1 - w) * expertPts).toFixed(1);
}

/**
 * Apply the expert blend to an already-projected board.
 *
 * Rookies are skipped: `rookieProjection()` inside `projectPoints()` already
 * uses the expert projection FIRST, with higher priority than our own
 * pace-based estimate — blending it in again here would double-count the
 * same number instead of correcting the veteran path the roadmap audit
 * found broken ("every veteran is projected from their own box scores while
 * an expert forecast sits unused in the same row").
 *
 * Runs right after `projectAll()`, before SOS/marketAnchor — the backtest
 * that validated `EXPERT_BLEND_W` measured plain-model -> expert-blend ->
 * market-anchor, in that order, and this keeps the shipped pipeline in the
 * same order the measurement describes.
 */
export function blendExpertAll(players, sc, W = EXPERT_BLEND_W) {
  return players.map((p) => {
    if (p.rookie) return p;
    const w = W[p.pos];
    if (w == null || w >= 1) return p;
    const expertPts = points(p.proj || {}, sc);
    const valuePoints = blendExpert(p.valuePoints, expertPts, w);
    return valuePoints === p.valuePoints ? p : { ...p, valuePoints };
  });
}

/**
 * Expected games missed by injury severity, out of a full season — same
 * shape/units as `durabilityMult` inside `projectPoints()`, but driven by
 * the CURRENT reported status (`player.injury`) rather than last season's
 * games played (roadmap 0.3).
 */
export const INJURY_GAMES_MISSED = { out: 6, doubtful: 2, questionable: 0.5 };

/**
 * Per-position weight (K, scales INJURY_GAMES_MISSED) on the injury
 * discount. Backtested 2017-2025: at k=0.5, QB and RB both clear the kill
 * gate in docs/ROADMAP.md 0.3 — `spearman_total` improves by more than the
 * noise floor without `spearman_pace` degrading past it. TE and WR do not:
 * at every k>0 tested, their pace correlation degraded past the gate before
 * total improved past it, meaning the discount there was re-discovering
 * `durabilityMult` rather than adding new information. K/DST were never in
 * the backtest population (score() only covers QB/RB/TE/WR). Ships PER
 * POSITION: TE/WR/K/DST stay at k=0 (durabilityMult alone) rather than a
 * discount that didn't earn its place there.
 */
export const INJURY_K = { QB: 0.5, RB: 0.5, WR: 0, TE: 0, K: 0, DST: 0 };

/** Multiplier for one player's injury status. 1 (no-op) if the position's K
 *  is 0, the player has no reported status, or the status isn't in the
 *  games-missed table (e.g. severity "note"). */
export function injuryMultiplier(pos, severity, K = INJURY_K, G = DEFAULT_PARAMS.projectedGames) {
  const k = K[pos];
  if (!severity || !k) return 1;
  const missed = (INJURY_GAMES_MISSED[severity] || 0) * k;
  return Math.max(0, (G - missed) / G);
}

/**
 * Apply the injury discount across a projected board.
 *
 * Runs right after `projectAll()`, before the expert blend/SOS/marketAnchor:
 * this corrects the model's OWN estimate of the player's production, the
 * same category `durabilityMult` already occupies, so it belongs upstream of
 * signals blended in from elsewhere. Not tested in combination with the
 * expert blend (0.1) — the backtest scored it against the pure model alone
 * — so keeping it first, untangled from that blend, matches what was
 * measured.
 */
export function applyInjuryDiscount(players, K = INJURY_K, G = DEFAULT_PARAMS.projectedGames) {
  return players.map((p) => {
    const mult = injuryMultiplier(p.pos, p.injury?.severity, K, G);
    if (mult === 1) return p;
    return { ...p, valuePoints: +(p.valuePoints * mult).toFixed(1) };
  });
}

/**
 * Rank players by market position: ADP when present, ECR as the fallback
 * (FantasyPros pulls sometimes carry rankings but no ADP — ECR order is a
 * close proxy, and without a fallback every market-rank signal goes dead).
 * Returns {id: rank}, rank 1 = most valued by the market.
 */
export function rankByAdp(players) {
  const key = (p) => (p.adp != null && p.adp > 0 ? p.adp : (p.ecr != null && p.ecr > 0 ? p.ecr : null));
  const ranked = players
    .filter((p) => key(p) != null)
    .sort((a, b) => key(a) - key(b));
  const out = {};
  ranked.forEach((p, i) => { out[p.id] = i + 1; });
  return out;
}

/** Default weight on OUR model when anchoring to the market. See marketAnchor. */
export const MARKET_ANCHOR_W = 0.3;

/**
 * Pull our projection toward the market's ordering, where the market has one.
 *
 * WHY. Backtested 2017-2025 on rank correlation against actual season points,
 * the market beats this model at every position on the players it ranks —
 * ADP 0.648/0.652/0.535/0.650 (QB/RB/TE/WR) against the model's
 * 0.497/0.551/0.472/0.594. But ADP only ranks about 55% of the board, and the
 * model has to price the rest. Anchoring the covered half and leaving the
 * uncovered half to the model beat the shipped model on the FULL board by
 * +0.052 QB, +0.047 RB, +0.016 TE, +0.022 WR, with top-24 hit rate up 3-5
 * points everywhere. That merge is what this implements.
 *
 * HOW. Per position, the market's rank is converted back into points by RANK
 * TRANSFER: if ADP says a player is the 7th-best RB, he receives the points
 * this model assigns to ITS OWN 7th-best RB. Points, not ranks, because
 * valuePoints feeds replacement level, VBD, tiers and auction dollars — a
 * rank-only blend would score well and break everything downstream. The
 * transfer uses no information from the season being predicted and keeps the
 * output on our own scale.
 *
 * COVERAGE. The ladder is built from the RANKED players only, so the transfer
 * is a permutation WITHIN that subset: ranked players are reshuffled among the
 * point values ranked players already held, and everyone the market ignores
 * keeps their projection and their place in the distribution. Reading the k-th
 * market rank off a ladder that included unranked players would hand out slots
 * those players already occupy, inflating the covered group and demoting the
 * rest of the board.
 *
 * WEIGHT. w is the weight on OUR model; w=1 is the pure model, w=0 is the
 * model's point distribution reordered by ADP. 0.3 is not a per-position fit:
 * the sweep's optimum sits at 0.2-0.5 depending on position, the curves are
 * flat across that range, and a single 0.3 lands within 0.001 Spearman of the
 * best weight at all four positions. One constant chosen off a flat optimum
 * generalizes; four constants read off their own evaluation data do not.
 */
export function marketAnchor(players, w = MARKET_ANCHOR_W, rankById = null) {
  if (w >= 1) return players;
  const ranks = rankById || rankByAdp(players);
  const byPos = {};
  players.forEach((p, i) => {
    (byPos[p.pos] ||= []).push(i);
  });

  const out = players.slice();
  for (const idxs of Object.values(byPos)) {
    const ranked = idxs.filter((i) => ranks[players[i].id] != null);
    if (!ranked.length) continue;
    // Our own points for the ranked players, best first: the ladder the
    // market's ordering is read against.
    const ladder = ranked.map((i) => players[i].valuePoints).sort((a, b) => b - a);
    const marketOrder = ranked.slice().sort((a, b) => ranks[players[a].id] - ranks[players[b].id]);
    marketOrder.forEach((i, slot) => {
      const implied = ladder[Math.min(slot, ladder.length - 1)];
      out[i] = { ...players[i], valuePoints: +(w * players[i].valuePoints + (1 - w) * implied).toFixed(1) };
    });
  }
  return out;
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

/** Projection only — no replacement level, no VBD. Split out so callers can
 *  adjust valuePoints (schedule strength, market anchoring) BEFORE replacement
 *  and VBD are derived from them, rather than deriving twice. */
export function projectAll(players, sc, P = DEFAULT_PARAMS) {
  return players.map((pl) => ({ ...pl, ...projectValue(pl, sc, P) }));
}

/** VBD-gap tier threshold: a new tier begins whenever two consecutive
 *  players (sorted descending by the same value) differ by more than this
 *  many points. Exported so any OTHER value on the same points scale can be
 *  tiered by the identical "drop-off" definition finalizeBoard uses for its
 *  own vbd — gaps in raw points and gaps in VBD are the same number for two
 *  players at the same position (VBD only subtracts one shared per-position
 *  replacement constant, which cancels out of the difference), so the
 *  threshold transfers without adjustment. See `tierize()`. */
export const TIER_GAP = 18;

/** Assign gap tiers to one position's list (already sorted descending by
 *  `valueKey`) — tier 1 is the top group, incrementing every time the drop
 *  to the next player exceeds TIER_GAP. Returns {id: tier}, not a mutated
 *  list, so a caller can merge it into whatever shape it's already
 *  building (finalizeBoard's own board map, or a second-opinion source's
 *  own points list in useBoard). Pulled out so there is exactly ONE
 *  definition of "a tier" in this codebase — two independent copies of a
 *  replacement/tier calculation drifting apart is a mistake this file has
 *  made once already (see finalizeBoard's own docstring history). */
export function tierize(sortedList, valueKey) {
  const tier = {};
  let t = 1;
  sortedList.forEach((p, i) => {
    if (i > 0 && (sortedList[i - 1][valueKey] - p[valueKey]) > TIER_GAP) t++;
    tier[p.id] = t;
  });
  return tier;
}

/**
 * Replacement level, VBD and tiers from finished valuePoints.
 *
 * Everything downstream — auction dollars, scarcity, the snake recommender —
 * reads vbd, so this must run LAST, after every adjustment to valuePoints.
 * It used to be duplicated in useBoard for the schedule-strength path, with
 * its own copy of the FLEX share constants; a change to one and not the other
 * would have silently moved replacement level for SOS leagues only.
 */
export function finalizeBoard(scored, league, P = DEFAULT_PARAMS) {
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
    Object.assign(tier, tierize(list, "vbd"));
  }
  return board.map((p) => ({ ...p, tier: tier[p.id] || null })).sort((a, b) => b.vbd - a.vbd);
}

/**
 * Projection -> VBD in one call.
 *
 * The injury discount, expert blend and market anchor are OFF here and
 * opted into by the app (see useBoard), not because they are optional in
 * spirit but because order matters: schedule strength has to land on
 * valuePoints before the anchor reads them, so the app composes
 * projectAll -> applyInjuryDiscount -> blendExpertAll -> SOS -> marketAnchor
 * -> finalizeBoard itself.
 */
export function valueBoard(players, league, sc, P = DEFAULT_PARAMS, opts = {}) {
  let scored = projectAll(players, sc, P);
  if (opts.injuryDiscount) scored = applyInjuryDiscount(scored, opts.injuryK ?? INJURY_K);
  if (opts.expertBlend) scored = blendExpertAll(scored, sc, opts.expertBlendW ?? EXPERT_BLEND_W);
  if (opts.anchor) scored = marketAnchor(scored, opts.anchorW ?? MARKET_ANCHOR_W);
  return finalizeBoard(scored, league, P);
}

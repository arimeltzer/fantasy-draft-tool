/* =====================================================================
   FANTASY VALUATION ENGINE
   ---------------------------------------------------------------------
   One source of truth for both the snake tool and the auction tool.
   Framework-agnostic, zero dependencies. Drop into a Claude Code repo
   and import the pieces you need.

   THE PIPELINE (each step is a pure, swappable function):

     stats ──► points()                fantasy points under YOUR scoring
        │
        ├─ projection points  ┐
        └─ last-season points ┴─► projectValue()   blend + age + regression
                                       │            → valuePoints, risk
                                       ▼
                                  valueBoard()       → VBD vs replacement, tiers
                                   │        │
                          (snake)  ▼        ▼ (auction)
                        rank+tiers      auctionValues() → $ par values
                                              │
                                              ▼
                                        applyInflation() → live $ as draft runs

   EVERY modeling decision lives in PARAMS below — change a knob, the
   whole board recomputes. This is the part to make your own.
   ===================================================================== */

/* ------------------------------------------------------------------ *
 * 1. TUNABLE KNOBS — this is "your algorithm." Edit freely.
 * ------------------------------------------------------------------ */
export const DEFAULT_PARAMS = {
  // How much last season's actual production should pull the projection.
  // 0 = trust the projection completely; 1 = pull all the way to last
  // year's pace. The pull is applied as a correction to the projection.
  priorWeight: 0.35,

  // Mean reversion. Dampens the last-season correction, because outlier
  // seasons (good or bad) are partly luck and regress. 0 = no damping,
  // 1 = ignore last season entirely.
  regressionStrength: 0.25,

  // Last season is normalized to a per-game pace, then scaled to a full
  // season so injured/partial years aren't unfairly punished.
  projectedGames: 17,

  // Age multipliers. Production is scaled by an age curve per position:
  // value holds until `declineStart`, then drops `declinePerYear`/yr.
  // Young players at/under `youthPeak` get a small ascending bonus.
  age: {
    QB:  { declineStart: 35, declinePerYear: 0.03, youthPeak: 0, youthBonus: 0.00 },
    RB:  { declineStart: 27, declinePerYear: 0.05, youthPeak: 23, youthBonus: 0.03 },
    WR:  { declineStart: 30, declinePerYear: 0.03, youthPeak: 24, youthBonus: 0.02 },
    TE:  { declineStart: 31, declinePerYear: 0.03, youthPeak: 25, youthBonus: 0.02 },
    K:   { declineStart: 99, declinePerYear: 0.00, youthPeak: 0, youthBonus: 0.00 },
    DST: { declineStart: 99, declinePerYear: 0.00, youthPeak: 0, youthBonus: 0.00 },
  },
  ageClamp: [0.85, 1.06], // never let the age factor run away

  // FLEX is split across RB/WR/TE when computing replacement level.
  flexShare: { RB: 0.50, WR: 0.42, TE: 0.08 },

  // Auction: discretionary dollars (above the $1 minimum bids) are shared
  // only among players with positive value over replacement.
  auction: { minBid: 1 },
};

/* ------------------------------------------------------------------ *
 * 2. SCORING — stat line → fantasy points
 * ------------------------------------------------------------------ */
export const SCORING_PRESETS = {
  Standard:  { ppr: 0 },
  "Half-PPR":{ ppr: 0.5 },
  PPR:       { ppr: 1 },
};

export function defaultScoring(ppr = 0.5) {
  return {
    ptsPerPassYd: 0.04, ptsPerPassTD: 4, ptsPerInt: -2,
    ptsPerRushYd: 0.1,  ptsPerRushTD: 6,
    ptsPerRec: ppr,     ptsPerRecYd: 0.1, ptsPerRecTD: 6,
    ptsPerFumble: -2,
  };
}

/** Fantasy points for a stat line. K/DST may pass a pre-scored `pts`. */
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

/* ------------------------------------------------------------------ *
 * 3. THE BLEND — projection + last season → one value
 * ------------------------------------------------------------------ *
 * player = {
 *   name, pos, team, age,
 *   proj:  { ...stat line projected for THIS season },   // required
 *   last:  { ...actual stat line LAST season, gp: gamesPlayed }, // optional
 * }
 *
 * Formula (read it as a sentence):
 *   start from the projection, nudge toward last year's full-season pace
 *   by `priorWeight`, damp that nudge by `regressionStrength`, then scale
 *   by an age factor.
 *
 *   valuePoints = ( projPts + priorWeight*(1-reg)*(priorEquiv - projPts) ) * ageMult
 * ------------------------------------------------------------------ */
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

  // Last season → full-season-equivalent pace (handles partial seasons).
  let priorEquiv = null;
  if (player.last && (player.last.gp || 0) > 0) {
    const ppg = points(player.last, sc) / player.last.gp;
    priorEquiv = ppg * P.projectedGames;
  }

  // The correction. Rookies / no prior → projection stands alone.
  const correction = priorEquiv == null
    ? 0
    : P.priorWeight * (1 - P.regressionStrength) * (priorEquiv - projPts);

  const blended = projPts + correction;
  const ageMult = ageMultiplier(player.pos, player.age, P);
  const valuePoints = +(blended * ageMult).toFixed(1);

  // Risk 0..1: divergence from projection, partial season, age decline.
  const divergence = priorEquiv == null || projPts === 0
    ? 0 : Math.min(1, Math.abs(priorEquiv - projPts) / projPts);
  const injury = player.last ? Math.min(1, Math.max(0, (P.projectedGames - (player.last.gp || P.projectedGames)) / P.projectedGames)) : 0;
  const ageRisk = 1 - ageMult; // >0 once past decline
  const risk = +Math.min(1, 0.5 * divergence + 0.3 * injury + 2 * Math.max(0, ageRisk)).toFixed(2);

  return { projPts: +projPts.toFixed(1), priorEquiv: priorEquiv == null ? null : +priorEquiv.toFixed(1), valuePoints, ageMult: +ageMult.toFixed(3), risk };
}

/* ------------------------------------------------------------------ *
 * 4. REPLACEMENT LEVEL + VBD  (shared by both formats)
 * ------------------------------------------------------------------ *
 * league = { teams, roster: {QB,RB,WR,TE,FLEX,K,DST,BENCH,SF?}, superflex }
 * ------------------------------------------------------------------ */
export function replacementRanks(league, P = DEFAULT_PARAMS) {
  const { teams, roster, superflex } = league;
  const flex = teams * (roster.FLEX || 0);
  const r = {
    QB: teams * (roster.QB || 0),
    RB: teams * (roster.RB || 0) + flex * P.flexShare.RB,
    WR: teams * (roster.WR || 0) + flex * P.flexShare.WR,
    TE: teams * (roster.TE || 0) + flex * P.flexShare.TE,
    K:  teams * (roster.K || 0),
    DST:teams * (roster.DST || 0),
  };
  if (superflex) r.QB += teams * (roster.SF || 1);
  return r;
}

/** Returns players with {valuePoints, vbd, tier, risk, ...} sorted by VBD. */
export function valueBoard(players, league, sc, P = DEFAULT_PARAMS) {
  const scored = players.map((pl) => ({ ...pl, ...projectValue(pl, sc, P) }));
  const rep = replacementRanks(league, P);
  const repPts = {};
  for (const pos of ["QB","RB","WR","TE","K","DST"]) {
    const list = scored.filter((p) => p.pos === pos).sort((a,b) => b.valuePoints - a.valuePoints);
    const idx = Math.max(0, Math.floor(rep[pos]) - 1);
    repPts[pos] = list.length ? (list[Math.min(idx, list.length - 1)]?.valuePoints ?? 0) : 0;
  }
  const board = scored.map((p) => ({ ...p, vbd: +(p.valuePoints - (repPts[p.pos] ?? 0)).toFixed(1) }));

  // Tiers by VBD gap within a position.
  const tier = {};
  for (const pos of ["QB","RB","WR","TE"]) {
    const list = board.filter((p) => p.pos === pos).sort((a,b) => b.vbd - a.vbd);
    let t = 1;
    list.forEach((p, i) => { if (i > 0 && (list[i-1].vbd - p.vbd) > 18) t++; tier[p.id] = t; });
  }
  return board.map((p) => ({ ...p, tier: tier[p.id] || null })).sort((a,b) => b.vbd - a.vbd);
}

/* ------------------------------------------------------------------ *
 * 5. SNAKE helper — when does pick `slot` come back around?
 * ------------------------------------------------------------------ */
export function snakePicks(slot, teams, rounds = 18) {
  const out = [];
  for (let r = 1; r <= rounds; r++)
    out.push(r % 2 === 1 ? (r - 1) * teams + slot : r * teams - slot + 1);
  return out;
}

/* ------------------------------------------------------------------ *
 * 6. AUCTION — VBD → dollar values, then live inflation
 * ------------------------------------------------------------------ *
 * auctionLeague = { teams, budget (per team, e.g. 200), rosterSize }
 *   rosterSize = total players each team drafts (starters + bench).
 *
 * Par value: every drafted player costs at least $minBid. The dollars
 * ABOVE that minimum are split among positive-VBD players in proportion
 * to their VBD.
 * ------------------------------------------------------------------ */
export function auctionValues(board, auctionLeague, P = DEFAULT_PARAMS) {
  const { teams, budget, rosterSize } = auctionLeague;
  const totalMoney = teams * budget;
  const totalSpots = teams * rosterSize;
  const min = P.auction.minBid;
  const discretionary = totalMoney - totalSpots * min;

  const pool = board.filter((p) => p.vbd > 0);
  const sumVBD = pool.reduce((s, p) => s + p.vbd, 0) || 1;

  return board.map((p) => {
    const par = p.vbd > 0 ? min + (p.vbd / sumVBD) * discretionary : min;
    return { ...p, parValue: Math.max(min, Math.round(par)) };
  });
}

/**
 * Live inflation. Feed the prices actually paid so far; remaining
 * undrafted players are repriced against the money still in the room.
 *
 *   draftedPrices = [{ id, price }]   actual winning bids observed
 * Returns { factor, board: [...with adjValue] }.
 */
export function applyInflation(boardWithPar, draftedPrices, auctionLeague, P = DEFAULT_PARAMS) {
  const { teams, budget, rosterSize } = auctionLeague;
  const min = P.auction.minBid;
  const totalMoney = teams * budget;
  const totalSpots = teams * rosterSize;

  const paidById = new Map(draftedPrices.map((d) => [d.id, d.price]));
  const spent = draftedPrices.reduce((s, d) => s + d.price, 0);
  const filledSpots = draftedPrices.length;

  const remainingMoney = totalMoney - spent;
  const remainingSpots = totalSpots - filledSpots;
  const remainingDiscretionary = remainingMoney - remainingSpots * min;

  const undrafted = boardWithPar.filter((p) => !paidById.has(p.id) && p.parValue > min);
  const remainingParDiscretionary = undrafted.reduce((s, p) => s + (p.parValue - min), 0) || 1;

  const factor = +(remainingDiscretionary / remainingParDiscretionary).toFixed(3);

  const board = boardWithPar.map((p) => {
    if (paidById.has(p.id)) return { ...p, paid: paidById.get(p.id), adjValue: null };
    const adj = p.parValue > min ? Math.max(min, Math.round(min + (p.parValue - min) * factor)) : min;
    return { ...p, paid: null, adjValue: adj };
  });

  return { factor, board, spent, remainingMoney, remainingSpots };
}

/** Most you can bid and still fill your roster at $1 each. */
export function maxBid(myBudgetLeft, myOpenSpots, minBid = 1) {
  return Math.max(minBid, myBudgetLeft - (myOpenSpots - 1) * minBid);
}

/* ------------------------------------------------------------------ *
 * USAGE
 * ------------------------------------------------------------------ *
 *   import { defaultScoring, valueBoard, auctionValues, applyInflation,
 *            maxBid, snakePicks } from "./valuation-engine.js";
 *
 *   const sc = defaultScoring(0.5);                 // half-PPR
 *   const board = valueBoard(players, league, sc);  // snake: rank by .vbd
 *
 *   const auc = auctionValues(board, { teams:12, budget:200, rosterSize:16 });
 *   const { board: live, factor } = applyInflation(auc, pricesPaid,
 *                                     { teams:12, budget:200, rosterSize:16 });
 *   const myMax = maxBid(143, 9);                   // = 135
 * ------------------------------------------------------------------ */

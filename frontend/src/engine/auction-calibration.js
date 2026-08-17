/* =====================================================================
   AUCTION CALIBRATION — what YOUR room pays, not what the nation pays.

   `marketPrice()` predicts what a player will cost. With FantasyPros auction
   values unavailable (the public v2 API has no auction endpoint — see
   data-pipeline/fantasypros.py:fetch_aav), that prediction is a generic
   logarithmic curve over ADP rank, identical for every league on earth.

   Real rooms are not generic and they are not random. A league that has spent
   45% of its money on running backs three years running will do it again; it
   is a property of the people in it. Against a curve that assumes 36%, every
   running back is underpriced for you and every receiver is a bargain you
   cannot see. That gap is the largest edge available in an auction and it is
   invisible in national data by construction.

   WHAT THIS USES. Prior-season draft prices, which the app already has: the
   keeper importers pull last season's draft results with the price paid, and
   cache them in `settings.keeperImport.candidates`. Read for keeper costs;
   otherwise thrown away.

   WHAT IT DOES NOT DO. It does not reprice individual players. Last year's
   price for a specific player says almost nothing about this year's — he got
   older, changed teams, or broke out. What carries across seasons is the
   SHAPE of the room's spending: how the pot splits across positions. So this
   estimates positional shares only, and applies them to the market forecast,
   never to our own valuation. Contaminating `dollarValue` with market
   behaviour would destroy the very signal the tool exists to surface — the
   gap between what a player is worth and what he will cost.
   ===================================================================== */
import { DEFAULT_AUCTION_PARAMS } from "./auction-engine.js";

export const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];

/**
 * Prior strength for shrinking a league's observed share toward the model's.
 *
 * In units of priced picks at that position. One season of a 10-team league
 * gives roughly 20-30 running backs but under a dozen quarterbacks, so a raw
 * ratio would be far noisier at QB than at RB while looking equally
 * authoritative. At K0 = 40 a 20-pick sample keeps a third of its deviation
 * and a 120-pick sample (four seasons) keeps three quarters — deliberately
 * conservative, because the cost of over-trusting one noisy season is
 * systematically mispricing an entire position for a whole draft.
 */
export const SHRINK_K0 = 40;

/** Below this many priced picks the sample says nothing; stay uncalibrated. */
export const MIN_PICKS = 40;

/** Hard bounds on any one multiplier, whatever the data says. */
export const MULT_CLAMP = [0.60, 1.60];

const clamp = (x, [lo, hi]) => Math.min(hi, Math.max(lo, x));

/** The identity calibration — used whenever there is no usable history. */
export function noCalibration(note = "no prior-season auction prices") {
  const posMult = {};
  for (const pos of POSITIONS) posMult[pos] = 1;
  return { usable: false, posMult, sample: {}, observedShare: {}, modelShare: {},
           totalSpend: 0, pricedPicks: 0, coverage: null, topHeaviness: null,
           notes: [note] };
}

/**
 * Estimate how this league's spending differs from the model's assumption.
 *
 * `picks` — [{ pos, price }] from a prior season's draft. Anything without a
 * positive price is ignored rather than counted as zero: undrafted and
 * keeper-retained players are not evidence about what the room pays.
 *
 * Returns multipliers that are SPEND-NEUTRAL by construction: their
 * model-share-weighted average is 1, so scaling every market price by them
 * leaves the total money on the board unchanged. Without that, calibration
 * would quietly inflate or deflate the whole market and break the inflation
 * tracker, which reasons about money remaining against the pot.
 */
export function calibrateAuction(picks, league = {}, P = DEFAULT_AUCTION_PARAMS) {
  const notes = [];
  const priced = (picks || []).filter(
    (p) => p && POSITIONS.includes(p.pos) && Number.isFinite(p.price) && p.price > 0,
  );
  if (priced.length < MIN_PICKS) {
    return noCalibration(
      `only ${priced.length} priced picks; need ${MIN_PICKS} before trusting a positional split`);
  }

  const spend = {};
  const count = {};
  let totalSpend = 0;
  for (const p of priced) {
    spend[p.pos] = (spend[p.pos] || 0) + p.price;
    count[p.pos] = (count[p.pos] || 0) + 1;
    totalSpend += p.price;
  }
  if (totalSpend <= 0) return noCalibration("prior draft has no positive prices");

  // The model's assumed split, renormalized over the positions this league
  // actually drafts. A league with no kicker should not have the kicker's
  // share of the reference distribution counted against it.
  const teams = league.teams || 10;
  const baseAlloc = teams >= 14 ? P.POS_ALLOC_14 : P.POS_ALLOC;
  const present = POSITIONS.filter((pos) => (count[pos] || 0) > 0);
  const baseSum = present.reduce((s, pos) => s + (baseAlloc[pos] || 0), 0);
  if (baseSum <= 0) return noCalibration("no reference allocation for these positions");

  const modelShare = {};
  const observedShare = {};
  const posMult = {};
  for (const pos of POSITIONS) {
    modelShare[pos] = present.includes(pos) ? (baseAlloc[pos] || 0) / baseSum : 0;
    observedShare[pos] = totalSpend ? (spend[pos] || 0) / totalSpend : 0;
    if (!present.includes(pos) || modelShare[pos] <= 0) { posMult[pos] = 1; continue; }
    const raw = observedShare[pos] / modelShare[pos];
    const n = count[pos] || 0;
    // Empirical-Bayes shrink toward 1 (= "behaves like the reference").
    posMult[pos] = 1 + (raw - 1) * (n / (n + SHRINK_K0));
  }

  // Spend-neutral: rescale so the model-share-weighted mean multiplier is 1.
  const weighted = POSITIONS.reduce((s, pos) => s + modelShare[pos] * posMult[pos], 0);
  if (weighted > 0) {
    for (const pos of POSITIONS) posMult[pos] = posMult[pos] / weighted;
  }
  for (const pos of POSITIONS) posMult[pos] = +clamp(posMult[pos], MULT_CLAMP).toFixed(3);

  // Descriptive only, deliberately NOT applied to prices: how concentrated the
  // room's money is. Acting on it would need a second, separately validated
  // model of the price curve's shape; reporting it lets a human act on it now.
  const sorted = priced.map((p) => p.price).sort((a, b) => b - a);
  const topN = Math.max(1, Math.round(sorted.length * 0.1));
  const topHeaviness = +(sorted.slice(0, topN).reduce((s, v) => s + v, 0) / totalSpend).toFixed(3);

  for (const pos of present) {
    if ((count[pos] || 0) < 8) {
      notes.push(`${pos}: only ${count[pos]} priced picks — heavily shrunk toward neutral`);
    }
  }

  // SURVIVORSHIP. Every importer builds its candidate list from END-OF-SEASON
  // ROSTERS joined to draft prices, not from the draft itself — a player who
  // was drafted and later cut is absent, and a waiver pickup arrives with no
  // price. So the sample is the drafted players who survived the year, which
  // skews toward the ones that worked: expensive picks are held, cheap busts
  // are dropped, and kickers and defenses are churned almost entirely.
  //
  // There is no way to recover the missing rows from this data, so the honest
  // move is to measure how much is missing and say so. A full auction is
  // teams x rosterSize picks; well below that means the shares below describe
  // the survivors rather than the room's actual spending.
  const expected = (league.teams || 0) * (league.rosterSize || 0);
  const coverage = expected > 0 ? +(priced.length / expected).toFixed(2) : null;
  if (coverage != null && coverage < 0.75) {
    notes.push(
      `only ${priced.length} of about ${expected} draft picks carry a price ` +
      `(${Math.round(coverage * 100)}%) — the import lists end-of-season rosters, so ` +
      `dropped players are missing and these shares lean toward picks that worked out`);
  }

  return {
    usable: true,
    posMult,
    sample: count,
    observedShare,
    modelShare,
    totalSpend,
    pricedPicks: priced.length,
    /** priced picks / a full draft. Below ~0.75 the sample is survivors. */
    coverage,
    topHeaviness,
    notes,
  };
}

/**
 * Pull [{pos, price}] out of a cached keeper import.
 *
 * The importers record last season's draft price as `bid`. `waiver` is a FAAB
 * claim, not an auction price, and is excluded: it reflects in-season roster
 * churn rather than what the room pays at the draft table.
 */
export function picksFromKeeperImport(cache) {
  if (!cache) return [];

  // PREFER the full draft when the importer supplied one. `candidates` is
  // built from END-OF-SEASON ROSTERS, so a player who was drafted and later
  // cut is missing from it entirely — a sample of the picks that worked, which
  // is exactly the wrong thing to learn prices from. `draftPicks` is the draft
  // itself, dropped players included.
  //
  // Picks whose position could not be resolved are skipped rather than
  // bucketed somewhere: a price with no position cannot inform a positional
  // share, and guessing would be worse than the smaller sample.
  if (Array.isArray(cache.draftPicks) && cache.draftPicks.length) {
    const full = cache.draftPicks
      .filter((p) => p && Number.isFinite(p.bid) && p.bid > 0 && POSITIONS.includes(p.pos))
      .map((p) => ({ pos: p.pos, price: p.bid }));
    if (full.length) return full;
  }

  if (!Array.isArray(cache.candidates)) return [];
  return cache.candidates
    .filter((c) => c && Number.isFinite(c.bid) && c.bid > 0 && POSITIONS.includes(c.pos))
    .map((c) => ({ pos: c.pos, price: c.bid }));
}

/** One-line summary of what the calibration decided, for the UI. */
export function describeCalibration(cal) {
  if (!cal || !cal.usable) return cal?.notes?.[0] || "not calibrated";
  const moved = POSITIONS
    .filter((pos) => cal.sample[pos] && Math.abs(cal.posMult[pos] - 1) >= 0.03)
    .sort((a, b) => Math.abs(cal.posMult[b] - 1) - Math.abs(cal.posMult[a] - 1))
    .map((pos) => `${pos} ${cal.posMult[pos] > 1 ? "+" : ""}${Math.round((cal.posMult[pos] - 1) * 100)}%`);
  return moved.length
    ? `From ${cal.pricedPicks} prior picks: ${moved.join(", ")}`
    : `From ${cal.pricedPicks} prior picks: spending matches the model`;
}

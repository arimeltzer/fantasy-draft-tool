/* ================================================================== *
 * keeper.js — keeper-cost engine (pure, framework-free)
 * ------------------------------------------------------------------ *
 * A "keeper" is a player a team retains from last season instead of
 * putting into the draft. The league's rule turns last year's cost
 * into THIS year's keeper cost:
 *
 *   • price basis (auction, ESPN-style): thisPrice = lastPrice + surcharge
 *   • round basis (snake,   Yahoo-style): thisRound = lastRound  (R{undrafted} if a free agent)
 *
 * The app seeds each keeper onto the board as a pre-filled draft pick
 * (player removed from the pool; auction price feeds budget + inflation;
 * snake round is the pick it costs that team). All math is client-side,
 * same as the valuation engine.
 *
 * This module is pure and node-runnable — see keeper.selftest.mjs.
 * ================================================================== */

/** Generic keeper rule. `basis` picks which fields matter. */
export const KEEPER_PRESETS = {
  // Yahoo default: keep 1, costs the round you drafted them (R13 if a FA),
  // can't keep the same player two years running.
  yahoo: {
    preset: "yahoo", label: "Yahoo", enabled: true,
    maxKeepers: 1, basis: "round",
    priceSurcharge: 0, undraftedRound: 13, roundInflation: 0,
    noConsecutive: true,
  },
  // ESPN default: keep up to 3, each costs last year's price + $7.
  espn: {
    preset: "espn", label: "ESPN", enabled: true,
    maxKeepers: 3, basis: "price",
    priceSurcharge: 7, undraftedRound: 0, roundInflation: 0,
    noConsecutive: false,
  },
  // Neutral starting point for hand-tuned leagues.
  custom: {
    preset: "custom", label: "Custom", enabled: true,
    maxKeepers: 2, basis: "price",
    priceSurcharge: 5, undraftedRound: 13, roundInflation: 0,
    noConsecutive: false,
  },
};

/** A sensible default rule for a freshly-created league of this format. */
export function defaultKeeperRule(format) {
  const base = format === "snake" ? KEEPER_PRESETS.yahoo : KEEPER_PRESETS.espn;
  return { ...base };
}

/** Merge a partial rule onto its preset baseline (so old leagues stay valid). */
export function normalizeKeeperRule(rule, format) {
  const preset = rule?.preset && KEEPER_PRESETS[rule.preset]
    ? KEEPER_PRESETS[rule.preset]
    : defaultKeeperRule(format);
  return { ...preset, ...(rule || {}) };
}

/**
 * Compute this year's keeper cost for one entry.
 *
 * entry = {
 *   base:   number | null,  // last year's DRAFT price (price basis) or round (round basis)
 *   waiver: number | null,  // last year's WAIVER/FAAB claim value, same unit as base
 *   fa:     boolean,        // true if the player was undrafted (no draft base)
 *   kept:   number,         // consecutive years already kept (advisories / escalation)
 * }
 *
 * Many leagues set a keeper's cost to the HIGHER of what he was drafted for and
 * what it cost to claim him off waivers — so a waiver pickup isn't a cheap
 * keeper. We resolve the more-expensive of the two (bigger $ for price, earlier
 * round for round), then apply the surcharge / escalation on top. When neither
 * is present the player is a true free agent → the undrafted default.
 *
 * Returns { basis, price|null, round|null, advisory: string[] }.
 */
export function keeperCost(entry, rule) {
  const kept = Math.max(0, Math.round(entry?.kept ?? 0));
  const draftBase = entry?.fa || entry?.base == null ? null : Number(entry.base);
  const waiverBase = entry?.waiver == null ? null : Number(entry.waiver);
  const advisory = [];

  if (rule.noConsecutive && kept >= 1) {
    advisory.push("League rule: this player was kept last year and can't be kept again.");
  }

  if (rule.basis === "round") {
    // "Higher value" in a round league = an EARLIER round (smaller number).
    const rounds = [draftBase, waiverBase].filter((v) => v != null);
    let round;
    if (rounds.length === 0) {
      round = rule.undraftedRound || 13;
    } else {
      round = Math.round(Math.min(...rounds)) - (rule.roundInflation || 0) * kept;
    }
    round = Math.max(1, round);
    return { basis: "round", price: null, round, advisory };
  }

  // price basis — higher value = more dollars.
  const prices = [draftBase, waiverBase].filter((v) => v != null);
  let price;
  if (prices.length === 0) {
    // No prior price at all — a FA keeper just costs the surcharge (min $1).
    price = Math.max(1, rule.priceSurcharge || 1);
  } else {
    price = Math.round(Math.max(...prices)) + (rule.priceSurcharge || 0);
  }
  price = Math.max(1, price);
  return { basis: "price", price, round: null, advisory };
}

/**
 * Validate a set of keeper entries against the rule, per owner.
 * entries = [{ owner, ... }]. Returns { ok, errors: string[], perOwner }.
 */
export function validateKeepers(entries, rule) {
  const perOwner = {};
  for (const e of entries) {
    const owner = e.owner || "Me";
    (perOwner[owner] ||= []).push(e);
  }
  const errors = [];
  for (const [owner, list] of Object.entries(perOwner)) {
    if (list.length > rule.maxKeepers) {
      errors.push(`${owner}: ${list.length} keepers exceeds the league max of ${rule.maxKeepers}.`);
    }
  }
  return { ok: errors.length === 0, errors, perOwner };
}

/** Total keeper dollars an owner commits (price basis) — 0 for round basis. */
export function ownerKeeperSpend(entries, rule, owner = "Me") {
  if (rule.basis !== "price") return 0;
  return entries
    .filter((e) => (e.owner || "Me") === owner)
    .reduce((s, e) => s + (keeperCost(e, rule).price || 0), 0);
}

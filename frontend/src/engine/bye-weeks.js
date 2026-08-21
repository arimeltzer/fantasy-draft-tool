/* bye-weeks.js — bye derivation + the roster cost of stacking byes.
 *
 * DERIVATION, not new data. `fantasy_schedule` holds one row per
 * (season, team, week) and the ingest only ever writes weeks a team ACTUALLY
 * plays (`build_schedule()` skips NaN/placeholder rows), so a bye is simply a
 * week missing from a team's list. Nothing needed to be loaded or migrated to
 * support this — the gap in the schedule IS the bye.
 *
 * WHY A BYE IS NOT A "RISK". Every other adjustment in this engine prices
 * something unknowable (will he get hurt, will he regress). A bye is the
 * opposite: it is deterministic and visible in August. It costs you nothing in
 * expectation across a season — the player scores his points in the other
 * weeks — and costs you something only when it COLLIDES, i.e. when enough
 * starters at one position sit in the same week that you cannot field a
 * lineup. So this is scored as a collision penalty on the roster you are
 * building, never as a knock on the player himself.
 */

/** Regular-season week count. 2021+ is 18 weeks; earlier seasons were 17.
 *  Only used as the universe to subtract played weeks from, so an
 *  over-estimate would invent a phantom bye — hence it is derived from the
 *  schedule itself where possible (see `byeByTeam`). */
export const DEFAULT_REG_WEEKS = 18;

/**
 * {TEAM: [{week, opp}]} -> {TEAM: byeWeek}.
 *
 * `regWeeks` defaults to the largest week actually present anywhere in the
 * schedule rather than a hardcoded 18: if a caller passes a partial schedule
 * (or a pre-2021 season), assuming 18 would report every team as having a bye
 * in the missing tail. Deriving the horizon from the data cannot do that.
 *
 * A team with no gap returns null (not 0) — "no bye on record" is different
 * from "bye in week 0", and callers branch on it.
 */
export function byeByTeam(schedule, regWeeks = null) {
  const out = {};
  if (!schedule) return out;

  let horizon = regWeeks;
  if (!horizon) {
    horizon = 0;
    for (const games of Object.values(schedule)) {
      for (const g of games || []) {
        if (g && g.week > horizon) horizon = g.week;
      }
    }
    if (!horizon) return out;
  }

  for (const [team, games] of Object.entries(schedule)) {
    const played = new Set((games || []).map((g) => g && g.week));
    let bye = null;
    for (let w = 1; w <= horizon; w++) {
      if (!played.has(w)) { bye = w; break; }
    }
    out[team] = bye;
  }
  return out;
}

/**
 * The marginal cost of adding `bye` at `pos`, given the byes already on the
 * roster at that position.
 *
 * The arithmetic is the honest version rather than a vibe: in the clashing
 * week you can field `available` players at this position. If that already
 * covers your starter slots, one more player sharing that bye costs you
 * nothing — you were never going to start him that week anyway. It costs you
 * exactly when `available < starters`, and it gets worse the more bodies are
 * already stacked on that week.
 *
 * Returns { mult, sharing, available, unfilled }. `mult` is 1 when there is
 * no collision, so callers can multiply unconditionally.
 */
export function byeClash(bye, rosterByes = [], starters = 0, opts = {}) {
  const step = opts.step ?? 0.04;
  const max = opts.max ?? 0.12;
  const none = { mult: 1, sharing: 0, available: 0, unfilled: 0 };

  if (!bye || !starters) return none;

  const others = rosterByes.filter((b) => b != null);
  const sharing = others.filter((b) => b === bye).length;
  if (sharing === 0) return none;          // first body on this bye: no clash

  // Players at this position who ARE available in the clashing week. The
  // candidate himself is not among them — he is the one being added to the bye.
  const available = others.filter((b) => b !== bye).length;
  if (available >= starters) return { ...none, sharing, available };

  // Starter slots you cannot fill in the clashing week. The candidate is on
  // the bye himself, so adding him does not raise `available` — that is
  // precisely why he is being charged.
  const unfilled = starters - available;
  const mult = 1 - Math.min(max, step * sharing);
  return { mult, sharing, available, unfilled };
}

/**
 * Roster-wide bye report: for each week, which positions are short of
 * starters. Drives the UI surface (and is what makes the penalty auditable
 * rather than a number that appears from nowhere).
 *
 * `roster`: [{pos, bye}]. `starters`: {pos: count}.
 * Returns [{week, pos, available, starters, short}] sorted by severity.
 */
export function byeReport(roster = [], starters = {}) {
  const byPos = {};
  for (const p of roster) {
    if (!p || !p.pos) continue;
    (byPos[p.pos] ||= []).push(p.bye ?? null);
  }

  const out = [];
  for (const [pos, byes] of Object.entries(byPos)) {
    const need = starters[pos] || 0;
    if (!need) continue;
    // Shortfall you already have for a reason that has nothing to do with
    // byes: the roster simply isn't full at this position yet. Mid-draft that
    // is almost every position, so charging it here would bury the real
    // signal under noise. Only the shortfall the BYE adds is reported.
    const baseline = Math.max(0, need - byes.length);
    const weeks = new Set(byes.filter((b) => b != null));
    for (const week of weeks) {
      const available = byes.filter((b) => b !== week).length;
      const short = Math.max(0, need - available) - baseline;
      if (short > 0) {
        out.push({ week, pos, available, starters: need, short });
      }
    }
  }
  return out.sort((a, b) => b.short - a.short || a.week - b.week);
}

/**
 * Real-time board flag, not a valuation input — deliberately separate from
 * `byeClash`. `byeClash` (used inside the snake recommender's `pickScore`)
 * already folds a clash into a small, capped SCORE penalty, but only once it
 * actually costs a starter slot; the auction room has no bye-aware valuation
 * at all. A user explicitly asked for the model NOT to go further than that
 * — "it's only one week" — and instead wanted every same-position/same-week
 * pairing surfaced so THEY can decide in the moment, including a pairing
 * (say a 3rd RB) that isn't costing a start yet and never will show up in
 * `byeClash`/`byeReport`.
 *
 * Given a candidate's position/bye and the roster you already own, returns
 * every one of YOUR players at the SAME position on the SAME bye week.
 * `roster`: [{pos, bye, name}]. Unpriced — purely for display.
 */
export function byeCollisions(pos, bye, roster = []) {
  if (bye == null || !pos) return [];
  return roster.filter((p) => p && p.pos === pos && p.bye === bye && p.name);
}

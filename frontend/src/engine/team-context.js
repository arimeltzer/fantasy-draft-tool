/**
 * team-context.js — roadmap 1.3: team-change discount (RB/WR only).
 * ============================================================================
 * Team, quarterback change, coaching change and pace were all backtested as
 * candidate context signals (2017-2025), each swept and judged INDEPENDENTLY
 * per the roadmap's own instruction. Only team change cleared BOTH halves of
 * the kill gate — a material partial-correlation gain over baseline AND a
 * merged-board improvement beating v2's own +0.003 bar — and only for RB/WR,
 * measured TWO ways like roadmap 1.1/1.2 taught to: against the pure model
 * (QB/RB/WR passed) and re-baselined against what is ACTUALLY shipping
 * (injury discount + expert blend + anchor at their live weights) — where
 * QB's gain nearly vanished (QB already gets both the injury discount AND a
 * 0.3-weighted expert blend, which were already extracting most of this
 * signal) but RB (+0.0038) and WR (+0.0062) held up. qb_change, coach_change
 * and pace never beat the merge bar even against the easier pure-model
 * comparison, so none of them ship.
 *
 * `data-pipeline/team_context.py` + `team_context_selftest.py` hold the
 * feature-construction logic (attempts-leader QB, modal coach, plays/game);
 * `projection_backtest.py`'s ROADMAP 1.3 sections are the actual measurement.
 * Backtest runs: `projection-backtest.yml` #32073576167 (pure model,
 * corrected after #32072847568 surfaced a qb_change/team_change collision
 * bug) and #32074247724 (re-baselined against the live board — the one that
 * decided what ships).
 *
 * Shipped as `TEAM_CHANGE_K = { RB: 0.25, WR: 0.25 }`, everyone else 0. A
 * player with no prior-season team on record (a rookie, or a row missing
 * `last.team`) passes through untouched — same coverage rule every other
 * stage in this pipeline uses.
 */

/** Per-position discount fraction when `last.team` differs from the
 *  player's current `team`. Only RB/WR are backtested and nonzero; K/DST
 *  were never in the backtest population, QB/TE didn't clear the gate. */
export const TEAM_CHANGE_K = { QB: 0, RB: 0.25, WR: 0.25, TE: 0, K: 0, DST: 0 };

/**
 * Apply the team-change discount across a projected board.
 *
 * Runs right after `applyOpportunityModel()`, before the injury discount —
 * the backtest that validated TEAM_CHANGE_K measured it applied to the pure
 * model's own point estimate (`project_points`/`projectAll` output), before
 * any of `applyInjuryDiscount`/`blendExpertAll`/`marketAnchor` touch it.
 * Disjoint from the opportunity model in practice (TE only there, RB/WR
 * only here), so their relative order doesn't change either one's result.
 */
export function applyTeamChangeDiscount(players, K = TEAM_CHANGE_K) {
  if (!Object.values(K).some((k) => k > 0)) return players;
  return players.map((p) => {
    const k = K[p.pos];
    if (!k) return p;
    const prevTeam = p.last?.team;
    if (!prevTeam || !p.team || prevTeam === p.team) return p;
    return { ...p, valuePoints: +(p.valuePoints * (1 - k)).toFixed(1) };
  });
}

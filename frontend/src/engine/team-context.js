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
 * signal) but RB (+0.0038 at k=0.25) and WR (+0.0062 at k=0.25) held up.
 * qb_change, coach_change and pace never beat the merge bar even against the
 * easier pure-model comparison, so none of them ship.
 *
 * The FIRST shipped k=0.25 for both positions was the best OF A GRID THAT
 * HAD NOT YET TURNED OVER — it was still climbing at the grid's own top when
 * it shipped, not a found peak. Re-swept wider (up to 0.5) against the live
 * board: RB's true optimum is k=0.4 (+0.0051, and the numbers genuinely roll
 * over past it — a real peak, not another moving edge); WR's kept climbing
 * all the way to k=0.5 (+0.0108) with still no sign of turning over, so WR
 * stays at its earlier, more conservative k=0.25 until a further-out sweep
 * actually finds where it stops (updating WR to another still-climbing edge
 * would repeat the exact mistake this re-sweep exists to catch).
 *
 * A destination-quality nuance (multiplier = 1 - k*(1 - z), z the new
 * team's offensive EPA/play vs league average) was also tried, on the
 * theory that WHERE a player landed should matter, not just THAT he moved.
 * It did not help — it actively underperformed the flat discount at every
 * position, including on the pure model where the flat version was
 * strongest (RB/WR). Not shipped in any form.
 *
 * `data-pipeline/team_context.py` + `team_context_selftest.py` hold the
 * feature-construction logic (attempts-leader QB, modal coach, plays/game,
 * offensive quality); `projection_backtest.py`'s ROADMAP 1.3 sections are
 * the actual measurement. Backtest runs: `projection-backtest.yml`
 * #32073576167 (pure model, corrected after #32072847568 surfaced a
 * qb_change/team_change collision bug), #32074247724 (re-baselined against
 * the live board — the one that decided what first shipped), and
 * #32079414046 (extended k grid + the quality nuance — the one that decided
 * RB's k=0.4 and killed the quality idea).
 *
 * Shipped as `TEAM_CHANGE_K = { RB: 0.4, WR: 0.25 }`, everyone else 0. A
 * player with no prior-season team on record (a rookie, or a row missing
 * `last.team`) passes through untouched — same coverage rule every other
 * stage in this pipeline uses.
 */

/** Per-position discount fraction when `last.team` differs from the
 *  player's current `team`. Only RB/WR are backtested and nonzero; K/DST
 *  were never in the backtest population, QB/TE didn't clear the gate.
 *  RB is k=0.4 (a found peak); WR is still k=0.25 — its own sweep hadn't
 *  turned over by k=0.5, so raising it to another unconfirmed edge would
 *  repeat the mistake that prompted re-checking RB in the first place. */
export const TEAM_CHANGE_K = { QB: 0, RB: 0.4, WR: 0.25, TE: 0, K: 0, DST: 0 };

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

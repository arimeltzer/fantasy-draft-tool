#!/usr/bin/env node
/* Selftest: bye-lineup-value.js — roadmap 2.4.
 *
 * SCOPE. This pins the module's ARITHMETIC and its structural properties. It
 * does NOT establish that bye-aware valuation helps a drafting agent — that is
 * 2.4's pre-registered gate (realized weekly lineups scored from
 * fantasy_player_logs), which has not been run. Nothing imports this module
 * yet, deliberately.
 */
import {
  perWeekPoints, bestWeekLineup, seasonLineupValue, marginalLineupValue, byeLineupMult,
} from "./bye-lineup-value.js";

let pass = 0, fail = 0;
const check = (cond, msg) => { cond ? pass++ : (fail++, console.error(`✗ ${msg}`)); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const CFG = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 };
const P = (id, pos, team, pts) => ({ id, pos, team, pts });
const BYES = { ATL: 9, CAR: 9, LAR: 8, KC: 5, SF: 7, BUF: 6, NO: 11, DEN: 10, NONE: null };
const opts = (extra = {}) => ({
  pointsOf: (p) => p.pts, byeOf: (p) => BYES[p.team] ?? null, rosterCfg: CFG, ...extra,
});

/* ── perWeekPoints: divide by weeks PLAYED, not weeks in the season ───── */
check(near(perWeekPoints(170, false, 17), 10), "no bye: 170 over 17 weeks is 10/wk");
check(near(perWeekPoints(160, true, 17), 10), "with a bye: 160 over the 16 played weeks is 10/wk");
check(perWeekPoints(0, true, 17) === 0, "no points is no points");
check(perWeekPoints(100, true, 1) === 100, "never divides by zero at the degenerate horizon");

/* ── bestWeekLineup: slot limits, and FLEX takes RB/WR/TE ─────────────── */
{
  const wk = (p) => p.pts;
  // Three RBs for two RB slots + one FLEX: all three start, nothing more.
  const three = [P(1, "RB", "KC", 20), P(2, "RB", "SF", 15), P(3, "RB", "BUF", 10)];
  check(bestWeekLineup(three, wk, { RB: 2, FLEX: 1 }) === 45, "FLEX absorbs the third RB");
  check(bestWeekLineup(three, wk, { RB: 2 }) === 35, "without a FLEX slot the third RB sits");
  // A TE is FLEX-eligible — the 2.2b optimizer got this wrong; this one must not.
  const te = [P(1, "TE", "KC", 20), P(2, "TE", "SF", 18)];
  check(bestWeekLineup(te, wk, { TE: 1, FLEX: 1 }) === 38, "TE is FLEX-eligible");
  // A QB is not.
  const qb = [P(1, "QB", "KC", 30), P(2, "QB", "SF", 28)];
  check(bestWeekLineup(qb, wk, { QB: 1, FLEX: 1 }) === 30, "a second QB cannot take FLEX");
  // Best-first within a slot.
  check(bestWeekLineup(three, wk, { RB: 1 }) === 20, "the best player takes the slot");
  check(bestWeekLineup([], wk, CFG) === 0, "no players is no points");
}

/* ── seasonLineupValue: byes can only ever cost ───────────────────────── */
{
  const roster = [
    P(1, "QB", "KC", 300), P(2, "WR", "SF", 250), P(3, "WR", "BUF", 240),
    P(4, "TE", "NO", 180), P(5, "RB", "ATL", 260), P(6, "RB", "CAR", 250),
    P(7, "WR", "DEN", 200),
  ];
  const aware = seasonLineupValue(roster, opts());
  const blind = seasonLineupValue(roster, opts({ honorByes: false }));
  check(blind >= aware, "honoring byes can never RAISE a roster's value");
  check(blind > aware, "and on a roster with no cover it strictly lowers it");
  check(seasonLineupValue([], opts()) === 0, "an empty roster is worth nothing");

  // With honorByes:false the bye schedule is irrelevant — same roster, byes
  // moved, identical answer. Guards the control arm actually being a control.
  const moved = { ...opts({ honorByes: false }), byeOf: () => 3 };
  check(near(seasonLineupValue(roster, opts({ honorByes: false })),
             seasonLineupValue(roster, moved)),
        "the bye-blind arm ignores the schedule entirely");
}

/* ── the structural claim: lineup value subsumes positional need ──────── */
{
  const full = [
    P(1, "QB", "KC", 300), P(2, "WR", "SF", 250), P(3, "WR", "BUF", 240),
    P(4, "TE", "NO", 180), P(5, "RB", "ATL", 260), P(6, "RB", "CAR", 250),
    P(7, "WR", "DEN", 200),
  ];
  // A second QB in a one-QB league only ever plays the week QB1 is on bye.
  const qb2 = marginalLineupValue(P(8, "QB", "SF", 280), full, opts());
  // A third RB covers a real RB bye hole AND competes for FLEX.
  const rb3 = marginalLineupValue(P(9, "RB", "LAR", 200), full, opts());
  check(qb2 > 0, "a backup QB is worth something — he starts on the QB1 bye");
  check(qb2 < rb3, "but far less than a flex-capable back, with no need heuristic involved");
  check(qb2 < 30, "a backup QB's whole season value is about one week of him");

  // A player who fills a genuinely EMPTY slot is worth roughly his full
  // season, since he starts every week he is available.
  const noFlex = full.filter((p) => p.id !== 7);          // FLEX now empty
  const filler = marginalLineupValue(P(10, "WR", "LAR", 160), noFlex, opts());
  check(filler > 140, "filling an empty slot is worth nearly the player's whole season");
}

/* ── byeLineupMult: shaped like byeClash's mult, but can credit ───────── */
{
  const full = [
    P(1, "QB", "KC", 300), P(2, "WR", "SF", 250), P(3, "WR", "BUF", 240),
    P(4, "TE", "NO", 180), P(5, "RB", "ATL", 260), P(6, "RB", "CAR", 250),
    P(7, "WR", "DEN", 200),
  ];
  const m = byeLineupMult(P(9, "RB", "LAR", 200), full, opts());
  check(m >= 0.85 && m <= 1.15, "the multiplier stays inside its clamp");
  const noBye = byeLineupMult(P(9, "RB", "NONE", 200), full, opts());
  check(noBye >= 0.85 && noBye <= 1.15, "a player with no bye on record is still bounded");
  // Unlike byeClash, a credit above 1 is representable — that is the point.
  check(byeLineupMult(P(11, "RB", "LAR", 1), full, opts(), { max: 0.2 }) <= 1.2,
        "a marginal-value-free candidate cannot exceed the cap either");
}

console.log(`\nbye-lineup-value.selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

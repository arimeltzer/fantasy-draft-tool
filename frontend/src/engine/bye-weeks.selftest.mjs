/* Node-runnable fixture tests for bye-weeks.js — `node bye-weeks.selftest.mjs`.
 * Mirrors keeper.selftest.mjs convention: pure, deterministic. */
import { byeByTeam, byeClash, byeReport } from "./bye-weeks.js";

let pass = 0, fail = 0;
function eq(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`✗ ${msg}\n    got  ${g}\n    want ${w}`); }
}
function ok(cond, msg) { cond ? pass++ : (fail++, console.error(`✗ ${msg}`)); }

/* ── byeByTeam: the gap in the schedule IS the bye ─────────────────── */
// A 4-week universe where BUF is missing week 3.
const sched4 = {
  BUF: [{ week: 1, opp: "NYJ" }, { week: 2, opp: "MIA" }, { week: 4, opp: "NE" }],
  NYJ: [{ week: 1, opp: "BUF" }, { week: 2, opp: "NE" }, { week: 3, opp: "MIA" }, { week: 4, opp: "MIA" }],
};
eq(byeByTeam(sched4).BUF, 3, "a missing week is the bye");
eq(byeByTeam(sched4).NYJ, null, "a team that plays every week has no bye");

// The horizon is derived from the data, not assumed to be 18. If it were
// assumed, NYJ (which plays all 4 weeks of a 4-week fixture) would be reported
// as having a phantom bye in week 5.
ok(byeByTeam(sched4).NYJ === null,
   "a partial/short schedule does not invent a phantom bye past its own horizon");
eq(byeByTeam(sched4, 6).NYJ, 5, "an explicit horizon is honoured when given");

eq(byeByTeam({}), {}, "empty schedule yields no byes");
eq(byeByTeam(null), {}, "null schedule is handled");
// Only the FIRST gap is reported — a real team has exactly one bye, and
// reporting a later gap would mean the schedule itself is malformed.
eq(byeByTeam({ X: [{ week: 2, opp: "Y" }] }).X, 1, "the earliest gap is the bye");

/* ── byeClash: costs only when it actually collides ────────────────── */
// No bye on record, or a position you do not start: never a penalty.
eq(byeClash(null, [9, 9], 2).mult, 1, "a player with no bye is never penalised");
eq(byeClash(9, [9, 9], 0).mult, 1, "a position with no starter slots is never penalised");

// First body on a bye week: no collision yet.
eq(byeClash(9, [5, 7], 2).mult, 1, "the first player on a given bye is free");
eq(byeClash(9, [], 2).mult, 1, "an empty roster cannot collide");

// Two RBs both out in week 9 with 2 starter slots -> zero RBs that week.
const two = byeClash(9, [9], 2);
ok(two.mult < 1, "a second starter sharing a bye is penalised");
eq(two.sharing, 1, "sharing counts the existing roster players on that bye");
eq(two.available, 0, "nobody at the position is available that week");
eq(two.unfilled, 2, "both starter slots go unfilled");

// A third stacked body is worse than a second.
ok(byeClash(9, [9, 9], 2).mult < two.mult,
   "stacking a third body on the same bye is worse than the second");

// ...but the penalty is capped, so a bye clash can never dominate player value.
const deep = byeClash(9, [9, 9, 9, 9, 9, 9, 9, 9], 2);
ok(deep.mult >= 1 - 0.12 - 1e-9, "the penalty is capped");
ok(deep.mult > 0.85, "even a pathological stack stays a minor adjustment");

// The key correctness case: if you already have enough OTHER bodies at the
// position to cover the starters that week, a shared bye costs nothing.
const covered = byeClash(9, [9, 3, 5], 2);
eq(covered.mult, 1, "a bye you can already cover from the rest of the roster is free");
eq(covered.available, 2, "two non-bye players cover two starter slots");

// One short of covering still bites.
ok(byeClash(9, [9, 3], 2).mult < 1, "being one body short of covering is penalised");

/* ── byeReport: the auditable roster-wide view ─────────────────────── */
const roster = [
  { pos: "RB", bye: 9 }, { pos: "RB", bye: 9 }, { pos: "RB", bye: 4 },
  { pos: "WR", bye: 7 }, { pos: "WR", bye: 11 },
  { pos: "QB", bye: 9 },
];
const rep = byeReport(roster, { RB: 2, WR: 2, QB: 1 });
ok(rep.some((r) => r.week === 9 && r.pos === "RB"),
   "two RBs on the same bye with 2 starter slots is reported");
eq(rep.find((r) => r.week === 9 && r.pos === "RB").short, 1,
   "one RB starter slot is short in week 9 (one non-bye RB covers the other)");
ok(rep.some((r) => r.week === 9 && r.pos === "QB"),
   "a lone QB on bye leaves the QB slot short");
// Exactly two WRs for two starter slots: even on DIFFERENT byes, each bye
// week leaves you one short. That is real — it is what a bench WR is for.
ok(rep.some((r) => r.week === 7 && r.pos === "WR" && r.short === 1),
   "two WRs for two slots are one short in each of their bye weeks");
ok(!rep.some((r) => r.week === 4),
   "a single RB on a bye the others cover is not reported");

// Shortfall from an INCOMPLETE roster is not charged to the bye. One WR with
// two starter slots is short a body every week; only the extra week-5 gap is
// attributable to the bye.
eq(byeReport([{ pos: "WR", bye: 5 }], { WR: 2 }),
   [{ week: 5, pos: "WR", available: 0, starters: 2, short: 1 }],
   "an incomplete roster is not double-charged; only the bye's own gap counts");

// Sorted by severity so the UI can show the worst first.
const severe = byeReport(
  [{ pos: "RB", bye: 9 }, { pos: "RB", bye: 9 }, { pos: "WR", bye: 5 }, { pos: "WR", bye: 8 }],
  { RB: 2, WR: 2 },
);
eq(severe[0].pos, "RB", "the most severe shortfall sorts first");
eq(severe[0].short, 2, "two RBs stacked on one bye leave both slots short");
ok(severe.filter((r) => r.pos === "WR").every((r) => r.short === 1),
   "WRs on separate byes are only one short each");

eq(byeReport([], { RB: 2 }), [], "an empty roster reports nothing");
eq(byeReport(roster, {}), [], "no starter requirements means nothing to report");

console.log(`\nbye-weeks.selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

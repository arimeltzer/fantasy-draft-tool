/* Node-runnable fixture tests for team-context.js —
 * `node team-context.selftest.mjs`.
 * Mirrors data-pipeline/team_context.py's own selftest coverage
 * (team_context_selftest.py); `team_change_parity.py` asserts the two stay
 * numerically identical on the one field that matters, valuePoints.
 */
import { TEAM_CHANGE_K, applyTeamChangeDiscount } from "./team-context.js";

let pass = 0, fail = 0;
function eq(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error(`✗ ${msg}\n    got  ${g}\n    want ${w}`); }
}
function ok(cond, msg, detail = "") {
  if (cond) { pass++; } else { fail++; console.error(`✗ ${msg}${detail ? "  " + detail : ""}`); }
}

const mk = (id, pos, team, vp, lastTeam) => ({
  id, pos, team, valuePoints: vp, last: lastTeam != null ? { gp: 17, team: lastTeam } : null,
});

// ── shipped weights: RB/WR only, different weights per position ─────────
// Both are found peaks — k=0.25 first shipped for both was still climbing
// at its own grid's top; a two-pass re-sweep (to 0.5, then to 0.9) found
// RB's peak at 0.4 and WR's much larger peak at 0.7, each decaying
// smoothly and monotonically on both sides in the real backtest.
eq(TEAM_CHANGE_K, { QB: 0, RB: 0.4, WR: 0.7, TE: 0, K: 0, DST: 0 },
   "shipped weights match the roadmap 1.3 RESULT — RB 0.4, WR 0.7 (both found peaks), everyone else 0");

{
  const pool = [
    mk("rb_moved", "RB", "MIA", 200, "NYJ"),      // team changed -> discounted
    mk("rb_stayed", "RB", "MIA", 200, "MIA"),     // same team -> untouched
    mk("wr_moved", "WR", "SF", 150, "DAL"),       // team changed -> discounted
    mk("qb_moved", "QB", "NYG", 300, "SEA"),      // QB: K=0 -> untouched regardless
    mk("te_moved", "TE", "KC", 180, "LAC"),       // TE: K=0 -> untouched regardless
    mk("rb_rookie", "RB", "DEN", 90, null),       // no last.team (rookie) -> untouched
  ];
  const out = applyTeamChangeDiscount(pool, TEAM_CHANGE_K);
  const by = Object.fromEntries(out.map((p) => [p.id, p]));

  eq(by.rb_moved.valuePoints, +(200 * 0.6).toFixed(1), "RB who changed teams is discounted 40%");
  eq(by.rb_stayed.valuePoints, 200, "RB on the same team is untouched");
  eq(by.wr_moved.valuePoints, +(150 * 0.3).toFixed(1), "WR who changed teams is discounted 70%");
  eq(by.qb_moved.valuePoints, 300, "QB is untouched — K=0, never cleared the gate");
  eq(by.te_moved.valuePoints, 180, "TE is untouched — K=0, never cleared the gate");
  eq(by.rb_rookie.valuePoints, 90, "no last.team on record (rookie) -> untouched, not a false discount");

  const allZero = applyTeamChangeDiscount(pool, { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 });
  ok(allZero === pool, "every K at 0 short-circuits to the identical array (no-op, not just no-change)");

  // Non-team fields (name, ecr, etc.) must survive untouched on a discounted row.
  const rich = { id: "rb_moved2", pos: "RB", team: "MIA", valuePoints: 200,
                 last: { gp: 17, team: "NYJ" }, name: "Test Player", ecr: 12 };
  const [richOut] = applyTeamChangeDiscount([rich], TEAM_CHANGE_K);
  eq(richOut.name, "Test Player", "other fields on the player object survive a discount untouched");
  eq(richOut.ecr, 12, "ecr survives a discount untouched");
}

console.log(`\nteam-context.selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

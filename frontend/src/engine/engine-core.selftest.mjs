/* Node-runnable fixture tests for engine-core.js — `node engine-core.selftest.mjs`.
 * Focused on resolveScoring(): the merge behavior that lets a league override
 * per-stat-category scoring beyond PPR, without disturbing existing leagues
 * that never set `settings.scoring`. */
import {
  DEFAULT_SCORING, defaultScoring, resolveScoring, points, projectValue, valueBoard,
} from "./engine-core.js";

let pass = 0, fail = 0;
function eq(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`✗ ${msg}\n    got  ${g}\n    want ${w}`); }
}
function ok(cond, msg) { cond ? pass++ : (fail++, console.error(`✗ ${msg}`)); }

// ── No behavior change for existing leagues: omitting `scoring` reproduces
//    defaultScoring(ppr) exactly, field for field. ─────────────────────────
eq(resolveScoring({ ppr: 0.5 }), defaultScoring(0.5), "no scoring override == old defaultScoring(0.5)");
eq(resolveScoring({ ppr: 1 }), defaultScoring(1), "no scoring override == old defaultScoring(1) (full PPR)");
eq(resolveScoring({}), defaultScoring(0.5), "missing ppr falls back to 0.5, same as defaultScoring's default");

// ── Partial override: only the touched fields change; everything else
//    (including ptsPerRec, which is NOT part of `scoring`) stays standard. ──
const sixPtPassTD = resolveScoring({ ppr: 0.5, scoring: { ptsPerPassTD: 6 } });
eq(sixPtPassTD.ptsPerPassTD, 6, "override changes only the touched field");
eq(sixPtPassTD.ptsPerRushTD, DEFAULT_SCORING.ptsPerRushTD, "untouched fields stay standard");
eq(sixPtPassTD.ptsPerRec, 0.5, "ptsPerRec still comes from ppr, not scoring");

// ── ppr always wins for ptsPerRec, even if `scoring` tries to set it too
//    (defensive: the UI never does this, but the merge order must be safe). ──
eq(resolveScoring({ ppr: 1, scoring: { ptsPerRec: 99 } }).ptsPerRec, 1,
   "settings.ppr overrides any ptsPerRec smuggled into settings.scoring");

// ── points(): a real scoring swap changes fantasy points as expected ───────
const line = { passYd: 4000, passTD: 30, int: 10, rushYd: 200, rushTD: 2,
               rec: 0, recYd: 0, recTD: 0, fumbles: 1 };
const standard = resolveScoring({ ppr: 0.5 });
const sixPtQB = resolveScoring({ ppr: 0.5, scoring: { ptsPerPassTD: 6 } });
const stdPts = points(line, standard);
const sixPts = points(line, sixPtQB);
eq(+(sixPts - stdPts).toFixed(1), 30 * 2, "30 pass TDs at +2pts each (4->6) adds exactly 60pts");

// ── Superflex-style QB-premium league (6pt pass TD, -1 INT) changes VBD ─────
// A pass-heavy QB should score relatively better under 6pt/-1 than a
// rush-heavy RB with the same total line, proving the override actually
// reaches valueBoard() (the full pipeline), not just points() in isolation.
const qb = { id: 1, pos: "QB", team: "KC", age: 28,
             proj: { passYd: 4500, passTD: 35, int: 8, rushYd: 200, rushTD: 2 },
             last: null, last2: null, adp: 5 };
const rb = { id: 2, pos: "RB", team: "SF", age: 25,
             proj: { rushYd: 1400, rushTD: 12, rec: 40, recYd: 300, recTD: 1 },
             last: null, last2: null, adp: 6 };
const league = { teams: 12, roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 } };

const boardStd = valueBoard([qb, rb], league, standard);
const board6pt = valueBoard([qb, rb], league,
  resolveScoring({ ppr: 0.5, scoring: { ptsPerPassTD: 6, ptsPerInt: -1 } }));
const qbGainStd = boardStd.find((p) => p.id === 1).valuePoints;
const qbGain6pt = board6pt.find((p) => p.id === 1).valuePoints;
const rbGainStd = boardStd.find((p) => p.id === 2).valuePoints;
const rbGain6pt = board6pt.find((p) => p.id === 2).valuePoints;
ok(qbGain6pt > qbGainStd, "QB value rises under 6pt-pass-TD/-1-INT scoring");
eq(rbGain6pt, rbGainStd, "RB value (no passing stats) is unaffected by the passing-scoring override");

/* ── rookies: valued off market rank, not pinned to a floor ────────── */
// A player with no NFL history has no `last`/`last2` to project from, so the
// market's opinion of them IS the signal. FantasyPros pulls often carry ECR
// but no ADP; if only ADP counted, every rookie collapsed to the same floor
// value and a top-15 rookie looked identical to an unrankable one.
const rookie = (pos, over) => ({ id: 9, pos, team: "ARI", age: 22,
                                 proj: null, last: null, last2: null, ...over });
const val = (p) => valueBoard([p], { teams: 12, roster: { QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1,BENCH:6 } },
                              standard)[0].valuePoints;

const eliteEcr = val(rookie("RB", { ecr: 15 }));
const midEcr   = val(rookie("RB", { ecr: 45 }));
const deepEcr  = val(rookie("RB", { ecr: 300 }));
const noRank   = val(rookie("RB", {}));
ok(eliteEcr > midEcr, "a top-15 rookie projects above a mid-round one");
ok(midEcr > deepEcr, "a mid-round rookie projects above a deep one");
ok(eliteEcr > noRank * 2, "ECR-ranked rookie is far above the unranked floor");
eq(deepEcr, noRank, "past the ADP span, rank decays to the same floor");

// ADP still wins when both are present — it is the more direct signal.
const byAdp = val(rookie("RB", { adp: 15, ecr: 300 }));
eq(byAdp, eliteEcr, "ADP takes precedence over ECR when both exist");

// A real market projection beats any rank-derived estimate.
const projected = val(rookie("RB", { ecr: 300, proj: { rushYd: 1200, rushTD: 10 } }));
ok(projected > deepEcr, "a real projection overrides the rank curve");

// Rookies carry elevated risk — no history means a wider range of outcomes.
const rookieRow = valueBoard([rookie("WR", { ecr: 20 })],
  { teams: 12, roster: { QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1,BENCH:6 } }, standard)[0];
ok(rookieRow.risk >= 0.2, "rookie risk is flagged, not treated as a known quantity");

console.log(`\nengine-core.selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

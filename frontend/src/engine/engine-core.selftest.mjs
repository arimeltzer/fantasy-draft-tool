/* Node-runnable fixture tests for engine-core.js — `node engine-core.selftest.mjs`.
 * Focused on resolveScoring(): the merge behavior that lets a league override
 * per-stat-category scoring beyond PPR, without disturbing existing leagues
 * that never set `settings.scoring`. */
import {
  DEFAULT_SCORING, defaultScoring, resolveScoring, points, projectValue, valueBoard,
  marketAnchor, finalizeBoard, blendExpert, blendExpertAll, EXPERT_BLEND_W,
  injuryMultiplier, applyInjuryDiscount, INJURY_K, INJURY_GAMES_MISSED,
  isRookieFilterMatch,
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

// ── completions: 0 by default (no behavior change for a league that never
//    sets it), real signal for one that does — reported live, a real Yahoo
//    league scores 0.5/completion. ──────────────────────────────────────────
eq(DEFAULT_SCORING.ptsPerCompletion, 0, "completions score 0 by default");
const completionsLine = { ...line, completions: 28 };
eq(points(completionsLine, standard), stdPts,
   "a league that never sets ptsPerCompletion is unaffected by a completions count in the line");
const halfPtPerComp = resolveScoring({ ppr: 0.5, scoring: { ptsPerCompletion: 0.5 } });
eq(+(points(completionsLine, halfPtPerComp) - stdPts).toFixed(1), 14,
   "0.5 pts/completion x 28 completions adds exactly 14pts");

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

/* ── isRookieFilterMatch: the board's "rookies only" filter is narrower
 *    than the `rookie` flag itself. Reported live: the filter was "over
 *    broad — pulling in defenses and kickers." A statless K/DST hits the
 *    same rookie:true fallback as a real rookie (no last-season data to
 *    project from), but neither is actually a rookie in the sense the
 *    filter means — a DST is a standing team unit, and a statless K is
 *    almost always a journeyman, not the rare true rookie kicker. ────── */
ok(isRookieFilterMatch({ pos: "RB", rookie: true }), "a statless RB matches the rookies filter");
ok(isRookieFilterMatch({ pos: "QB", rookie: true }), "a statless QB matches the rookies filter");
ok(isRookieFilterMatch({ pos: "WR", rookie: true }), "a statless WR matches the rookies filter");
ok(isRookieFilterMatch({ pos: "TE", rookie: true }), "a statless TE matches the rookies filter");
ok(!isRookieFilterMatch({ pos: "K", rookie: true }), "a statless K does NOT match — journeyman, not a rookie");
ok(!isRookieFilterMatch({ pos: "DST", rookie: true }), "a statless DST does NOT match — no such thing as a rookie defense");
ok(!isRookieFilterMatch({ pos: "RB", rookie: false }), "a veteran never matches regardless of position");
ok(!isRookieFilterMatch({ pos: "RB" }), "a missing rookie flag is treated as false, not a match");

/* ── A SECOND over-broad case: a returning veteran who missed all of last
 *    season (injury, suspension, ...) hits the identical rookie:true
 *    fallback as a genuine rookie (no last/last2 to project from).
 *    `yearsExp` (nflverse rosters, 0 for the current draft class) is the
 *    ground-truth signal that tells them apart. ────────────────────────── */
ok(isRookieFilterMatch({ pos: "RB", rookie: true, yearsExp: 0 }),
   "yearsExp 0 (the current draft class) still matches — a real rookie");
ok(isRookieFilterMatch({ pos: "RB", rookie: true, yearsExp: null }),
   "yearsExp unknown (roster fetch didn't have him) still matches — don't guess a veteran off the list");
ok(isRookieFilterMatch({ pos: "RB", rookie: true }),
   "yearsExp absent entirely (same as null) still matches");
ok(!isRookieFilterMatch({ pos: "RB", rookie: true, yearsExp: 3 }),
   "yearsExp > 0 does NOT match — a returning veteran with no stats, not a rookie");
ok(!isRookieFilterMatch({ pos: "QB", rookie: true, yearsExp: 1 }),
   "same for QB — a real case: a 2nd-year QB who missed his rookie season to injury");

/* ── market anchor ────────────────────────────────────────────────────────
   Ported from projection_backtest.blend_with_market; `anchor_parity.py`
   asserts the two stay numerically identical. These cover the STRUCTURAL
   properties that parity alone would not catch if both sides were wrong
   together. */
{
  const mk = (id, pos, vp) => ({ id, pos, valuePoints: vp });
  // 6 RBs, only 3 ranked — the coverage case the merge exists for.
  const pool = [mk("a","RB",100), mk("b","RB",90), mk("c","RB",80),
                mk("d","RB",70), mk("e","RB",60), mk("f","RB",50)];
  const ranks = { c: 1, a: 2, f: 3 };
  const vp = (rows) => Object.fromEntries(rows.map((p) => [p.id, p.valuePoints]));

  eq(vp(marketAnchor(pool, 1.0, ranks)), vp(pool), "anchor w=1 is the pure model");

  const at0 = vp(marketAnchor(pool, 0.0, ranks));
  eq([at0.a, at0.c, at0.f].sort((x, y) => x - y), [50, 80, 100],
     "anchor reshuffles ranked players among their OWN point values");
  ok(at0.c > at0.a && at0.a > at0.f, "anchor respects market order");
  eq([at0.b, at0.d, at0.e], [90, 70, 60], "anchor leaves unranked players untouched");

  const half = vp(marketAnchor(pool, 0.5, ranks));
  ok(half.c > 80 && half.c < 100, "anchor at w=0.5 sits between the endpoints");

  // Position isolation: a WR's rank must not pull on the RB ladder.
  const mixed = [mk("r1","RB",100), mk("r2","RB",50), mk("w1","WR",10), mk("w2","WR",5)];
  const mixedOut = vp(marketAnchor(mixed, 0.0, { r1: 2, r2: 1, w1: 1, w2: 2 }));
  eq(mixedOut.r1, 50, "anchor is per-position (RB takes RB points)");
  eq(mixedOut.w1, 10, "anchor is per-position (WR keeps WR points)");

  eq(vp(marketAnchor(pool, 0.0, {})), vp(pool), "no ranks at all -> pass through");

  // The whole point: VBD must be derived AFTER anchoring, not before.
  const league = { teams: 10, roster: { QB:1,RB:2,WR:2,TE:1,FLEX:1,K:0,DST:0,BENCH:5 } };
  const anchored = finalizeBoard(marketAnchor(pool, 0.0, ranks), league);
  const top = anchored[0];
  eq(top.id, "c", "board order follows the anchored points, not the raw model");
  ok(anchored.every((p) => typeof p.vbd === "number"), "anchored board still carries vbd");
}

/* ── expert blend (roadmap 0.1) ───────────────────────────────────────────
   `blendExpert` mirrors data-pipeline/projection_backtest.py:blend_expert;
   `expert_blend_parity.py` asserts the shipped weights stay numerically
   identical to what was backtested. These cover the structural properties. */
{
  eq(blendExpert(100, 200, 1.0), 100, "expert blend w=1 is the pure model");
  eq(blendExpert(100, 200, 0.0), 200, "expert blend w=0 is the pure expert number");
  eq(blendExpert(100, 300, 0.5), 200, "expert blend w=0.5 is the midpoint");
  eq(blendExpert(100, null, 0.5), 100, "no expert opinion -> model passes through");
  eq(blendExpert(100, 0, 0.5), 100, "a zero expert projection reads as no opinion, not zero points");
  eq(blendExpert(100, -5, 0.5), 100, "a negative expert projection also reads as no opinion");

  const mk = (id, pos, vp, projPts, rookie = false) =>
    ({ id, pos, valuePoints: vp, rookie, proj: { pts: projPts } });
  const sc = defaultScoring(0.5);
  const pool = [
    mk("v1", "QB", 300, 400),       // veteran, expert disagrees -> blended
    mk("v2", "RB", 200, null),      // veteran, no expert coverage -> untouched
    mk("r1", "WR", 100, 900, true), // rookie -> skipped even though covered
  ];
  const out = blendExpertAll(pool, sc, EXPERT_BLEND_W);
  const by = Object.fromEntries(out.map((p) => [p.id, p.valuePoints]));
  eq(by.v1, EXPERT_BLEND_W.QB * 300 + (1 - EXPERT_BLEND_W.QB) * 400,
     "veteran with expert coverage is blended at the position weight");
  eq(by.v2, 200, "veteran with no expert coverage passes through untouched");
  eq(by.r1, 100, "rookies are skipped — rookieProjection() already used proj first");

  const noOp = blendExpertAll([mk("k1", "K", 50, 999)], sc, EXPERT_BLEND_W);
  eq(noOp[0].valuePoints, 50, "a position at weight 1.0 (K/DST) is never touched");

  // The whole point: VBD must be derived AFTER the expert blend, not before.
  const league = { teams: 10, roster: { QB:1,RB:2,WR:2,TE:1,FLEX:1,K:0,DST:0,BENCH:5 } };
  const blended = finalizeBoard(blendExpertAll(
    [mk("lowproj", "QB", 100, 500), mk("highproj", "QB", 90, 100)], sc, EXPERT_BLEND_W
  ), league);
  ok(blended.every((p) => typeof p.vbd === "number"), "blended board still carries vbd");
}

/* ── injury-aware expected games (roadmap 0.3) ────────────────────────────
   `injuryMultiplier`/`applyInjuryDiscount` mirror
   data-pipeline/projection_backtest.py:injury_multiplier;
   `injury_discount_parity.py` asserts the shipped weights stay numerically
   identical to what was backtested. */
{
  eq(injuryMultiplier("QB", null, INJURY_K), 1, "no reported status -> no-op");
  eq(injuryMultiplier("QB", "note", INJURY_K), 1, "an unrecognized severity -> no-op");
  ok(injuryMultiplier("QB", "out", INJURY_K) < 1, "a QB reported OUT is discounted");
  ok(injuryMultiplier("RB", "out", INJURY_K) < 1, "an RB reported OUT is discounted");
  eq(injuryMultiplier("WR", "out", INJURY_K), 1,
     "WR stays at k=0 — didn't clear the roadmap 0.3 gate");
  eq(injuryMultiplier("TE", "out", INJURY_K), 1,
     "TE stays at k=0 — didn't clear the roadmap 0.3 gate");
  eq(injuryMultiplier("QB", "out", INJURY_K),
     (17 - INJURY_GAMES_MISSED.out * INJURY_K.QB) / 17,
     "exact games-missed arithmetic at the shipped k");
  ok(injuryMultiplier("QB", "out", INJURY_K) < injuryMultiplier("QB", "doubtful", INJURY_K) &&
     injuryMultiplier("QB", "doubtful", INJURY_K) < injuryMultiplier("QB", "questionable", INJURY_K),
     "severities order the same way the games-missed table does");

  const mk = (id, pos, vp, injury) => ({ id, pos, valuePoints: vp, injury });
  const out = applyInjuryDiscount([
    mk("q1", "QB", 300, { severity: "out" }),
    mk("q2", "QB", 200, null),
    mk("w1", "WR", 100, { severity: "out" }),
  ], INJURY_K);
  const by = Object.fromEntries(out.map((p) => [p.id, p.valuePoints]));
  ok(by.q1 < 300, "a flagged QB's valuePoints drops");
  eq(by.q2, 200, "an unflagged QB is untouched");
  eq(by.w1, 100, "a flagged WR is untouched (k=0 for WR)");

  // The whole point: VBD must be derived AFTER the discount, not before.
  const league = { teams: 10, roster: { QB:1,RB:2,WR:2,TE:1,FLEX:1,K:0,DST:0,BENCH:5 } };
  const board = finalizeBoard(applyInjuryDiscount(
    [mk("healthy", "QB", 100, null), mk("hurt", "QB", 100, { severity: "out" })], INJURY_K
  ), league);
  ok(board.find((p) => p.id === "healthy").vbd > board.find((p) => p.id === "hurt").vbd,
     "an equally-projected but injured QB ranks below the healthy one");
}

console.log(`\nengine-core.selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * snake-engine.selftest.mjs — roster discipline in the pick recommender
 * =====================================================================
 * Written after a mock draft in which the recommender would have taken three
 * quarterbacks and three tight ends ahead of startable skill players.
 *
 * The cause was one line. `needMult` gave EVERY position a two-deep bench
 * allowance (`have < starter + 2`), so in a one-QB league the third
 * quarterback scored 0.88 — the same "worth drafting for depth" credit as a
 * third running back — and no gate ever blocked a fourth. A backup at a
 * one-starter position only plays when the starter is hurt; a third never
 * plays at all.
 *
 * These assertions pin the rule that replaced it, in both directions: the
 * stacking must stop, and the depth that IS worth having must survive.
 *
 *   node frontend/src/engine/snake-engine.selftest.mjs
 */
import {
  pickScore, maxUseful, snakePicks, myPickNumbers,
  resolveSlotConfig, DEFAULT_SNAKE_PARAMS,
} from "./snake-engine.js";

let pass = 0;
const fails = [];

function check(label, ok, detail = "") {
  if (ok) { pass++; return; }
  fails.push(label);
  console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
}

const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, BENCH: 6 };
const player = (pos, vbd, over = {}) => ({ id: `${pos}-${vbd}`, pos, vbd, age: 26, risk: 0.1, trend: 0, ...over });

function state(over = {}) {
  return {
    round: 10, teams: 10, slot: 5,
    counts: { QB: 0, RB: 0, WR: 0, TE: 0 },
    superflex: false, roster: ROSTER,
    needs: { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0 },
    bestVbd: 100, posRemaining: { QB: 20, RB: 40, WR: 50, TE: 20 },
    adpRankById: {}, cliffById: {}, poolSize: 200,
    ...over,
  };
}

// ── maxUseful: how many of a position are worth rostering ─────────────────
check("1-QB league tops out at two quarterbacks", maxUseful("QB", ROSTER, false) === 2,
      String(maxUseful("QB", ROSTER, false)));
check("superflex raises the QB ceiling", maxUseful("QB", ROSTER, true) === 3,
      String(maxUseful("QB", ROSTER, true)));
check("1-TE league tops out at two tight ends", maxUseful("TE", ROSTER, false) === 2,
      String(maxUseful("TE", ROSTER, false)));
check("RB/WR are bounded by the bench, not a fixed allowance",
      maxUseful("RB", ROSTER) === 2 + 1 + 6 && maxUseful("WR", ROSTER) === 2 + 1 + 6,
      `${maxUseful("RB", ROSTER)} / ${maxUseful("WR", ROSTER)}`);
check("a deeper bench allows more RB/WR", maxUseful("RB", { ...ROSTER, BENCH: 10 }) > maxUseful("RB", ROSTER));
check("kickers and defenses are never benched",
      maxUseful("K", { K: 1 }) === 1 && maxUseful("DST", { DST: 1 }) === 1);

// ── the reported bug: stacking a one-starter position ─────────────────────
const qb3 = pickScore(player("QB", 60), state({ counts: { QB: 2, RB: 2, WR: 2, TE: 1 } }));
check("a THIRD quarterback is blocked outright", qb3.score === -Infinity, JSON.stringify(qb3));
check("...and says why", /enough QB/.test(qb3.blocked || ""), qb3.blocked);

const te3 = pickScore(player("TE", 55), state({ counts: { QB: 1, RB: 2, WR: 2, TE: 2 } }));
check("a THIRD tight end is blocked outright", te3.score === -Infinity, JSON.stringify(te3));

const qb3sf = pickScore(player("QB", 60), state({
  superflex: true, counts: { QB: 2, RB: 2, WR: 2, TE: 1 },
}));
check("but a third QB is allowed in superflex", Number.isFinite(qb3sf.score), JSON.stringify(qb3sf));

// ── a backup at a one-starter position must not outrank real depth ────────
// Equal VBD, starters already filled: the RB is startable via FLEX or a bye,
// the second QB only plays if the starter is hurt.
const filled = state({ counts: { QB: 1, RB: 2, WR: 2, TE: 1 } });
const qb2 = pickScore(player("QB", 50), filled);
const rb3 = pickScore(player("RB", 50), filled);
check("QB2 scores below an equally-valued RB3", qb2.score < rb3.score,
      `qb2=${qb2.score.toFixed(1)} rb3=${rb3.score.toFixed(1)}`);
const te2 = pickScore(player("TE", 50), filled);
check("TE2 scores below an equally-valued WR3", te2.score < pickScore(player("WR", 50), filled).score);

// ── the depth that IS worth having must survive ───────────────────────────
const rb5 = pickScore(player("RB", 40), state({ counts: { QB: 1, RB: 4, WR: 3, TE: 1 } }));
check("a fifth running back is still draftable", Number.isFinite(rb5.score), JSON.stringify(rb5));
const wr6 = pickScore(player("WR", 40), state({ counts: { QB: 1, RB: 3, WR: 5, TE: 1 } }));
check("a sixth receiver is still draftable", Number.isFinite(wr6.score), JSON.stringify(wr6));

// ── existing behaviour that must not regress ──────────────────────────────
const early = pickScore(player("QB", 90), state({ round: 2 }));
check("the early-round QB gate still holds", early.score === -Infinity, early.blocked);
const firstQb = pickScore(player("QB", 90), state({ round: 10 }));
check("the first quarterback is still recommended once the gate opens",
      Number.isFinite(firstQb.score) && firstQb.reasons.includes("no QB yet"),
      JSON.stringify(firstQb));
const risky = pickScore(player("RB", 90, { risk: 0.8 }), state({ round: 2 }));
check("the early-round risk gate still holds", risky.score === -Infinity, risky.blocked);

// ── pick scheduling, unchanged but load-bearing ───────────────────────────
check("serpentine picks alternate correctly",
      JSON.stringify(snakePicks(3, 10, 4)) === JSON.stringify([3, 18, 23, 38]),
      JSON.stringify(snakePicks(3, 10, 4)));
check("traded picks override the serpentine formula",
      JSON.stringify(myPickNumbers({ teams: 10, draftSlot: 3, myPicks: [5, 9] }, 4)) === "[5,9]");

// ── roadmap 0.2: the per-slot configs are collapsed ───────────────────────
// Ten configs (~100 fitted numbers, provenance outside this repo) beat one
// shared config by +10.67 pts where they were tuned and +2.53 (mean/SE 1.16)
// out of sample. Indistinguishable from noise, so they were removed on
// parsimony. These assertions stop them coming back without evidence, and
// stop the MECHANISM being deleted along with the values.
check("no per-slot configs ship", Object.keys(DEFAULT_SNAKE_PARAMS.SLOTS).length === 0,
      JSON.stringify(Object.keys(DEFAULT_SNAKE_PARAMS.SLOTS)));
check("every slot resolves to the one shared config",
      [1, 5, 10, 12].every((s) =>
        resolveSlotConfig(DEFAULT_SNAKE_PARAMS, 10, s) === DEFAULT_SNAKE_PARAMS.SLOT_DEFAULT));
check("a non-10-team league also uses it",
      resolveSlotConfig(DEFAULT_SNAKE_PARAMS, 12, 3) === DEFAULT_SNAKE_PARAMS.SLOT_DEFAULT);
{
  // The lookup still works, so a config that EARNS its place can return.
  const withSlot = { ...DEFAULT_SNAKE_PARAMS, SLOTS: { 4: { ...DEFAULT_SNAKE_PARAMS.SLOT_DEFAULT, QB_MIN: 3 } } };
  check("a reinstated per-slot config is still honoured",
        resolveSlotConfig(withSlot, 10, 4).QB_MIN === 3);
  check("...and only for its own slot",
        resolveSlotConfig(withSlot, 10, 5) === DEFAULT_SNAKE_PARAMS.SLOT_DEFAULT);
}

// ── bye-week collision penalty ────────────────────────────────────────────
// The player is identical in every case; only the roster around him changes,
// so any score difference is the bye logic and nothing else.
{
  const rb = player("RB", 100, { team: "BUF" });
  const byeByTeam = { BUF: 9, KC: 9, MIA: 4, NE: 6 };
  const clean = state({ byeByTeam, rosterByesByPos: { RB: [4, 6] } });
  const stacked = state({ byeByTeam, rosterByesByPos: { RB: [9] } });

  check("no bye data leaves the score untouched",
        pickScore(rb, state()).score === pickScore(rb, state({ byeByTeam: {} })).score);
  check("a bye nobody else shares is free",
        pickScore(rb, clean).score === pickScore(rb, state()).score);
  check("stacking a second RB on the same bye is penalised",
        pickScore(rb, stacked).score < pickScore(rb, clean).score);
  check("the penalty is explained in the reasons",
        pickScore(rb, stacked).reasons.some((r) => r.includes("bye wk 9")));

  // The correctness case: enough other bodies to cover means no charge.
  const covered = state({ byeByTeam, rosterByesByPos: { RB: [9, 4, 6] } });
  check("a shared bye the rest of the roster covers is free",
        pickScore(rb, covered).score === pickScore(rb, state()).score);

  // Deeper stacks hurt more, but stay bounded.
  const deep = state({ byeByTeam, rosterByesByPos: { RB: [9, 9] } });
  check("a third body on the same bye is worse than the second",
        pickScore(rb, deep).score < pickScore(rb, stacked).score);
  check("the penalty is capped so it cannot flip a much better player",
        pickScore(rb, deep).score >= pickScore(rb, state()).score * (1 - DEFAULT_SNAKE_PARAMS.byeClashMax) - 1e-9);

  // A clearly better player must still win despite a bye clash — this is the
  // whole reason the cap exists.
  const better = player("RB", 130, { team: "BUF" });
  check("a materially better player still outranks a bye-clean lesser one",
        pickScore(better, stacked).score > pickScore(player("RB", 100, { team: "MIA" }), stacked).score);

  // The penalty must survive the step-6 ADP blend rather than being diluted
  // by it — that is why it is applied last.
  const adpRound = { round: 8, adpRankById: { "RB-100": 5 }, byeByTeam };
  check("the penalty still applies in the ADP-blend rounds",
        pickScore(rb, state({ ...adpRound, rosterByesByPos: { RB: [9] } })).score
          < pickScore(rb, state({ ...adpRound, rosterByesByPos: { RB: [4] } })).score);
}

// ── survival margin (roadmap 3.1 — SIMPLIFIED) ────────────────────────────
// margin_rounds = (adpRank - nextPick) / teams. adpRank approximates the
// overall pick the market expects him gone at, so a LARGE adpRank relative
// to nextPick means he'll last (safe); small/negative means he's expected
// gone before I pick again (urgent). The probabilistic model (survival.js:
// pSurvive/survivalCosts) is tested but not wired in — see its header for
// why. All tests here use round: 1 (outside the step-6 ADP-blend window of
// 6-12) unless the test is specifically about composing with that blend, so
// the margin's effect can be isolated from it.
{
  const rb = player("RB", 100);
  const r1 = { round: 1 };   // outside the 6-12 ADP-blend window

  // Absent nextPick, or absent an ADP entry for this player, the engine is
  // byte-identical to before — opt-in, and every existing caller passes
  // neither.
  check("no nextPick leaves the score untouched",
        pickScore(rb, state({ ...r1, nextPick: undefined })).score
          === pickScore(rb, state(r1)).score);
  check("nextPick with no ADP entry for this player leaves the score untouched",
        pickScore(rb, state({ ...r1, nextPick: 20 })).score
          === pickScore(rb, state(r1)).score);

  // adpRank 180, nextPick 20, teams 10 -> margin = (180-20)/10 = 16 rounds:
  // deep into safe territory, no urgency.
  const comfortable = state({ ...r1, nextPick: 20, adpRankById: { "RB-100": 180 } });
  check("a large margin applies no urgency",
        pickScore(rb, comfortable).score === pickScore(rb, state(r1)).score);

  // adpRank 22, nextPick 20 -> margin = 0.2 rounds: inside a round, PARTIAL
  // urgency, strictly less than the cap. `capped` is derived from the actual
  // baseline rather than assumed, because needMult already scales it
  // ("no RB yet" = x1.30) before the margin ever multiplies it.
  const tight = state({ ...r1, nextPick: 20, adpRankById: { "RB-100": 22 } });
  const capped = pickScore(rb, state(r1)).score * (1 + DEFAULT_SNAKE_PARAMS.survivalUrgencyMax);
  check("less than a round of margin raises the score",
        pickScore(rb, tight).score > pickScore(rb, state(r1)).score);
  check("partial margin does not hit the cap",
        pickScore(rb, tight).score < capped - 1e-9);

  // adpRank 5, nextPick 20 -> margin = -1.5: the market's implied slot for
  // him is well before my next pick — expected gone. Saturates at the cap,
  // same as margin = 0 exactly (the clamp treats "already gone" and
  // "gone right at zero margin" identically — this is a capped multiplier,
  // not an unbounded one).
  const gone = state({ ...r1, nextPick: 20, adpRankById: { "RB-100": 5 } });
  check("negative margin saturates at the cap",
        Math.abs(pickScore(rb, gone).score - capped) < 1e-9);
  check("negative margin is a bigger boost than partial margin",
        pickScore(rb, gone).score > pickScore(rb, tight).score);

  // The point of the whole mechanism: between two equally valuable players,
  // the one who will not last outranks the one who comfortably will.
  check("a player who won't last outranks an equal one who would have survived",
        pickScore(rb, gone).score > pickScore(rb, comfortable).score);

  // Surfaced to the user only when actually urgent (margin < 0).
  check("a player expected gone before my next pick is flagged",
        pickScore(rb, gone).reasons.includes("won't last"));
  check("a player with positive margin is not flagged",
        !pickScore(rb, tight).reasons.includes("won't last"));
  check("a player with a large margin is not flagged",
        !pickScore(rb, comfortable).reasons.includes("won't last"));

  // Same discipline as the bye clash: it must land AFTER the step-6 ADP
  // blend, or the blend's weighted average would dilute it.
  const adpRound = { round: 8, adpRankById: { "RB-100": 5 }, nextPick: 20 };
  const withMargin = pickScore(rb, state(adpRound)).score;
  const withoutMargin = pickScore(rb, state({ round: 8, adpRankById: { "RB-100": 5 } })).score;
  check("the margin survives the ADP blend rounds (round 8 is in 6-12)",
        withMargin > withoutMargin);

  // Composes with the bye clash rather than being swallowed by it — both are
  // multiplicative on `base`, applied in sequence.
  const byeByTeam = { MIA: 9 };
  const rbMia = player("RB", 100, { team: "MIA" });
  const byeState = (extra) => state({
    ...r1, byeByTeam, rosterByesByPos: { RB: [9, 9] }, roster: { ...ROSTER, RB: 2 }, ...extra,
  });
  const byeOnly = pickScore(rbMia, byeState({})).score;
  const byeAndMargin = pickScore(
    rbMia,
    byeState({ nextPick: 20, adpRankById: { "RB-100": 5 } }),
  ).score;
  check("survival urgency still raises the score on top of a bye discount",
        byeAndMargin > byeOnly);
}

// ── positional run discount (roadmap 3.2) ─────────────────────────────────
// A run shrinks the margin BEFORE the step-9 urgency check, so it can turn a
// previously-safe read into an urgent one — that composition is the point.
{
  const rb = player("RB", 100);
  const wr = player("WR", 100, { id: "WR-100" });
  const r1 = { round: 1 };

  // adpRank 31, nextPick 20, teams 10 -> margin = 1.1 rounds: just OUTSIDE
  // the urgency window on its own.
  const justSafe = { ...r1, nextPick: 20, adpRankById: { "RB-100": 31 } };
  check("without a run, 1.1 rounds of margin is safe (no urgency)",
        pickScore(rb, state(justSafe)).score === pickScore(rb, state(r1)).score);

  // The same player, same margin, but RB is running hot (hot=1, the max).
  // 1.1 x (1 - 0.30) = 0.77 rounds -> crosses under 1 -> urgency now applies.
  const withRun = { ...justSafe, runHotByPos: { RB: 1 } };
  check("a hot run flips a previously-safe margin into urgent",
        pickScore(rb, state(withRun)).score > pickScore(rb, state(justSafe)).score);
  check("the flipped case is flagged as a run",
        pickScore(rb, state(withRun)).reasons.includes("RB run"));

  // A genuinely comfortable margin survives even the maximum discount — the
  // cap exists so a run cannot manufacture urgency out of real safety.
  const veryComfortable = { ...r1, nextPick: 20, adpRankById: { "RB-100": 70 }, runHotByPos: { RB: 1 } };
  check("a large margin stays safe even at maximum run discount",
        pickScore(rb, state(veryComfortable)).score === pickScore(rb, state(r1)).score);

  // Per-position: an RB run does not touch a WR's margin.
  const wrUnaffected = { ...r1, nextPick: 20, adpRankById: { "WR-100": 31 }, runHotByPos: { RB: 1 } };
  check("a run at one position does not discount another position's margin",
        pickScore(wr, state(wrUnaffected)).score === pickScore(wr, state({ ...r1, nextPick: 20, adpRankById: { "WR-100": 31 } })).score);

  // No runHotByPos at all is identical to hot=0 — opt-in, absent by default.
  check("absent runHotByPos matches explicit hot=0",
        pickScore(rb, state(justSafe)).score
          === pickScore(rb, state({ ...justSafe, runHotByPos: { RB: 0 } })).score);

  // Below the reason-flag threshold (hot=0.5 exactly, not >0.5): the numeric
  // effect still applies but isn't surfaced as a headline "run" flag — mild
  // heat shouldn't shout as loud as a real one.
  const mildHeat = { ...justSafe, runHotByPos: { RB: 0.5 } };
  check("mild heat is not flagged as a run even if it nudges the score",
        !pickScore(rb, state(mildHeat)).reasons.includes("RB run"));
}

console.log();
if (fails.length) {
  console.error(`snake-engine.selftest: ${pass} passed, ${fails.length} FAILED — ${fails.join(", ")}`);
  process.exit(1);
}
console.log(`snake-engine.selftest: ${pass} passed, 0 failed`);

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
import { pickScore, maxUseful, snakePicks, myPickNumbers } from "./snake-engine.js";

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

console.log();
if (fails.length) {
  console.error(`snake-engine.selftest: ${pass} passed, ${fails.length} FAILED — ${fails.join(", ")}`);
  process.exit(1);
}
console.log(`snake-engine.selftest: ${pass} passed, 0 failed`);

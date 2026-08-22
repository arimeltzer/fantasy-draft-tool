/**
 * auction-sim.selftest.mjs — the harness must be right before its number means anything
 * ========================================================================================
 * This decides whether 3.3 (budget-path), 3.4 (room ceiling) and 3.4a
 * (opponent demand) earned their place. Per the roadmap 3.5 pre-registration,
 * four things are checked BEFORE this harness is allowed to produce a
 * verdict:
 *   1. budget/roster invariants hold
 *   2. second-price mechanics are exact, including one-bidder and ties
 *   3. identical arms produce EXACTLY zero difference, every seed
 *   4. a deliberately crippled agent loses
 *
 *   node frontend/src/engine/auction-sim.selftest.mjs
 */
import {
  totalRosterSize, resolveSale, simulateAuction, pairedCompareAuction, botWTPMultiplier,
} from "./auction-sim.mjs";
import { bestLineupPoints } from "./draft-sim.mjs";

let pass = 0;
const fails = [];
const check = (label, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push(label);
  console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
};

const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 };

function makeBoard(n = 150) {
  const POS = ["RB", "WR", "QB", "TE", "K", "DST"];
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `P${i + 1}`,
    pos: POS[i % POS.length],
    team: "XX",
    age: 26,
    risk: 0.1,
    trend: 0,
    vbd: +(200 - i * 1.1).toFixed(1),
    valuePoints: +(220 - i * 1.0).toFixed(1),
    adp: i + 1,
  }));
}

// ── roster size accounting ────────────────────────────────────────────────
check("totalRosterSize sums every field",
      totalRosterSize(ROSTER) === (1 + 2 + 2 + 1 + 1 + 1 + 1 + 6));
check("missing fields default to 0, not NaN",
      Number.isFinite(totalRosterSize({ QB: 1 })));

// ── second-price mechanics (requirement 2) ────────────────────────────────
{
  check("one bidder sells at the minimum",
        resolveSale([{ team: 0, bid: 40 }], 1).price === 1);
  check("one bidder — winner is that team",
        resolveSale([{ team: 0, bid: 40 }], 1).winners[0] === 0);

  const two = resolveSale([{ team: 0, bid: 80 }, { team: 1, bid: 50 }], 1);
  check("two bidders: price is one increment above the second-highest",
        two.price === 51, String(two.price));
  check("two bidders: the high bidder wins", two.winners[0] === 0);

  const tie = resolveSale([{ team: 0, bid: 60 }, { team: 1, bid: 60 }], 1);
  check("a tie sells at the tied amount, not one above it",
        tie.price === 60, String(tie.price));
  check("a tie reports both winners", tie.winners.length === 2
        && tie.winners.includes(0) && tie.winners.includes(1));

  check("nobody bidding is unsold", resolveSale([{ team: 0, bid: 0 }], 1) === null);

  const three = resolveSale(
    [{ team: 0, bid: 10 }, { team: 1, bid: 0 }, { team: 2, bid: 25 }], 1,
  );
  check("non-bidders (0) are excluded from the price calc",
        three.price === 11, String(three.price));

  check("minBid floors the price even with a $0 second bidder",
        resolveSale([{ team: 0, bid: 5 }], 5).price === 5);
}

// ── budget/roster invariants (requirement 1) ──────────────────────────────
{
  const board = makeBoard();
  for (const agentMode of ["control", "treatment"]) {
    for (const seed of [1, 2, 3]) {
      const { rosters, spend } = simulateAuction({
        board, teams: 10, roster: ROSTER, budget: 200, agentTeam: 3, agentMode, seed,
      });
      check(`${agentMode} seed ${seed}: nobody overspends`,
            spend.every((s) => s <= 200), JSON.stringify(spend));
      check(`${agentMode} seed ${seed}: nobody exceeds roster size`,
            rosters.every((r) => r.length <= totalRosterSize(ROSTER)),
            JSON.stringify(rosters.map((r) => r.length)));
      check(`${agentMode} seed ${seed}: no player drafted twice`,
            (() => {
              const seen = new Set();
              for (const r of rosters) for (const p of r) {
                if (seen.has(p.id)) return false;
                seen.add(p.id);
              }
              return true;
            })());
      check(`${agentMode} seed ${seed}: nobody rosters a 2nd K or DST`,
            rosters.every((r) => ["K", "DST"].every(
              (pos) => r.filter((p) => p.pos === pos).length <= 1,
            )));
    }
  }
}

check("botWTPMultiplier: an unmet starter pays above market",
      botWTPMultiplier("RB", ROSTER, {}, false) > 1);
check("botWTPMultiplier: a filled K is out of the market",
      botWTPMultiplier("K", ROSTER, { K: 1 }, false) === 0);
check("botWTPMultiplier is not opponentDemand's shape",
      // opponentDemand returns a COUNT (0,1,2,...); this returns a PRICE
      // MULTIPLIER (0 or roughly 1-1.15) — different codomain by construction.
      botWTPMultiplier("RB", ROSTER, {}, false) <= 1.2);

// ── identical arms produce exactly zero difference (requirement 3) ───────
{
  const board = makeBoard();
  const pointsById = Object.fromEntries(board.map((p) => [p.id, p.vbd]));
  const same = pairedCompareAuction({
    board, pointsById, roster: ROSTER, teams: 10, agentTeam: 4,
    modeA: "control", modeB: "control", seeds: [1, 2, 3, 4, 5],
  });
  check("identical arms (control vs control): zero diff, every seed",
        same.meanDiff === 0 && same.rows.every((r) => r.diff === 0),
        JSON.stringify(same.rows.map((r) => r.diff)));
  check("...and therefore zero spread", same.sdDiff === 0);
  check("identical arms: identical empty-slot rates too",
        same.controlEmptySlotRate === same.treatmentEmptySlotRate);
  check("identical arms: the clean-split mean is 0 when there is a clean row",
        same.cleanN === 0 || same.cleanMeanDiff === 0);

  const sameT = pairedCompareAuction({
    board, pointsById, roster: ROSTER, teams: 10, agentTeam: 4,
    modeA: "treatment", modeB: "treatment", seeds: [1, 2, 3],
  });
  check("identical arms (treatment vs treatment): zero diff, every seed",
        sameT.meanDiff === 0 && sameT.rows.every((r) => r.diff === 0),
        JSON.stringify(sameT.rows.map((r) => r.diff)));
}

// ── a deliberately crippled agent loses (requirement 4) ────────────────────
{
  const board = makeBoard();
  const pointsById = Object.fromEntries(board.map((p) => [p.id, p.vbd]));
  const cmp = pairedCompareAuction({
    board, pointsById, roster: ROSTER, teams: 10, agentTeam: 2,
    modeA: "control", modeB: "passive", seeds: [1, 2, 3, 4, 5],
  });
  check("a bidder who never buys anything loses to one who does",
        cmp.meanDiff < 0, `meanDiff ${cmp.meanDiff} (treatment=passive)`);
  check("...at every seed, not just on average",
        cmp.rows.every((r) => r.diff <= 0), JSON.stringify(cmp.rows.map((r) => r.diff)));

  // Empty-starting-slot diagnostic: a passive bidder buys nothing, so it
  // must ALWAYS report unfilled starters — the diagnostic's own positive
  // control.
  check("a passive bidder always shows unfilled starting slots",
        cmp.treatmentEmptySlotRate === 1
        && cmp.rows.every((r) => r.treatmentUnfilled > 0),
        JSON.stringify(cmp.rows.map((r) => r.treatmentUnfilled)));

  // Sanity on bestLineupPoints itself: a passive bidder ends the draft with
  // an empty roster, which must score 0, not NaN or a crash.
  const passiveRun = simulateAuction({
    board, teams: 10, roster: ROSTER, agentTeam: 2, agentMode: "passive", seed: 1,
  });
  check("a passive bidder's roster is empty", passiveRun.rosters[2].length === 0);
  check("an empty roster scores 0, not NaN",
        bestLineupPoints(passiveRun.rosters[2], pointsById, ROSTER) === 0);
}

// ── nomination order is fixed and identical across arms ───────────────────
{
  const board = makeBoard();
  const a = simulateAuction({ board, teams: 10, roster: ROSTER, agentTeam: 0, agentMode: "control", seed: 9 });
  const b = simulateAuction({ board, teams: 10, roster: ROSTER, agentTeam: 0, agentMode: "treatment", seed: 9 });
  const orderA = a.log.map((l) => l.id);
  const orderB = b.log.map((l) => l.id);
  // Not necessarily identical past the point the agent's own choice diverges
  // the room (a sold player is removed from the fixed sequence for BOTH arms
  // alike), but the sequence of IDs offered — sold or not — comes from one
  // sort computed before either arm acts, so the first several sales (before
  // any plausible divergence) should line up.
  check("nomination order agrees before any plausible divergence",
        orderA.slice(0, 3).join() === orderB.slice(0, 3).join(),
        `${orderA.slice(0, 5)} vs ${orderB.slice(0, 5)}`);
}

// ── roadmap 3.7: treatment-hist mode + realizedWeeklyPoints presence-gate ──
{
  const board = makeBoard();
  const pointsById = Object.fromEntries(board.map((p) => [p.id, p.vbd]));

  const noHist = pairedCompareAuction({
    board, pointsById, roster: ROSTER, teams: 10, agentTeam: 4,
    modeA: "treatment", modeB: "treatment-hist", benchReserve: {}, seeds: [1, 2, 3],
  });
  check("treatment-hist with no historical signal behaves exactly like treatment",
        noHist.meanDiff === 0 && noHist.rows.every((r) => r.diff === 0),
        JSON.stringify(noHist.rows.map((r) => r.diff)));

  // A strong historical QB/RB/WR reserve changes what treatment-hist can
  // spend on starters while a backup is still missing — must produce SOME
  // divergence from plain treatment somewhere across these seeds (not
  // asserting direction/size, just that the knob does something).
  const withHist = pairedCompareAuction({
    board, pointsById, roster: ROSTER, teams: 10, agentTeam: 4,
    modeA: "treatment", modeB: "treatment-hist",
    benchReserve: { QB: 40, RB: 40, WR: 40 }, seeds: [1, 2, 3, 4, 5],
  });
  check("a large historical reserve actually moves treatment-hist off plain treatment",
        withHist.rows.some((r) => r.diff !== 0),
        JSON.stringify(withHist.rows.map((r) => r.diff)));
}

{
  // Presence-gate: supplying weeklyActual+byeByTeam must change what
  // pairedCompareAuction reports vs the season-total default — sanity that
  // the gate actually switches scorers, not proof of realizedWeeklyPoints'
  // own correctness (draft-sim.selftest.mjs already owns that).
  const POS = ["RB", "WR", "QB", "TE", "K", "DST"];
  const teamsList = ["AAA", "BBB", "CCC", "DDD"];
  const board = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1, name: `P${i + 1}`, pos: POS[i % POS.length],
    team: teamsList[i % teamsList.length], age: 26, risk: 0.1, trend: 0,
    vbd: +(150 - i).toFixed(1), valuePoints: +(160 - i).toFixed(1), adp: i + 1,
  }));
  const pointsById = Object.fromEntries(board.map((p) => [p.id, p.valuePoints]));
  const weeklyActual = Object.fromEntries(
    board.map((p) => [p.id, Object.fromEntries(
      Array.from({ length: 17 }, (_, w) => [w + 1, (p.valuePoints / 17) * 0.5]),
    )]),
  );
  const byeByTeam = { AAA: 6, BBB: 7, CCC: 8, DDD: 9 };

  const withoutWeekly = pairedCompareAuction({
    board, pointsById, roster: ROSTER, teams: 10, agentTeam: 1,
    modeA: "control", modeB: "treatment", seeds: [1, 2, 3],
  });
  const withWeekly = pairedCompareAuction({
    board, pointsById, roster: ROSTER, teams: 10, agentTeam: 1,
    modeA: "control", modeB: "treatment", seeds: [1, 2, 3],
    weeklyActual, byeByTeam,
  });
  check("supplying weeklyActual+byeByTeam changes the reported diffs vs the season-total default",
        JSON.stringify(withoutWeekly.rows.map((r) => r.diff))
          !== JSON.stringify(withWeekly.rows.map((r) => r.diff)));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

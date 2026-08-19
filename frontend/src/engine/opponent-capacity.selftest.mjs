#!/usr/bin/env node
/**
 * Selftest — opponent-capacity.js (roadmap 3.4)
 *
 * The load-bearing checks are the three pre-registered in ROADMAP.md 3.4:
 * capacity must agree with the shipped `maxBid` (or two places in the
 * codebase disagree about what a budget can buy), the ceiling must fall
 * monotonically as money drains, and a full roster must contribute nothing.
 */
import {
  opponentCapacities, priceCeiling, cappedPrice, bindingCeiling,
} from "./opponent-capacity.js";
import { maxBid } from "./auction-engine.js";

let pass = 0;
const fails = [];
function check(label, ok, detail = "") {
  if (ok) { pass++; return; }
  fails.push(label);
  console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
}

/* ------------------------------ gate 1: agrees with the shipped maxBid -- */
{
  let diverged = 0, compared = 0;
  for (let budget = 1; budget <= 200; budget += 7) {
    for (let spots = 1; spots <= 16; spots++) {
      const mine = maxBid(budget, spots, 1);
      const theirs = opponentCapacities([budget], [spots], 1)[0];
      compared++;
      if (mine !== theirs) { diverged++; if (diverged <= 3) console.log(`  b=${budget} s=${spots}: mine=${mine} theirs=${theirs}`); }
    }
  }
  check(`opponent capacity equals maxBid across ${compared} budget/spot combos`,
        diverged === 0, `${diverged} divergent`);
}

/* --------------------------------- gate 3: a full roster cannot bid ----- */
check("a team with no open spots has zero capacity, however rich",
      opponentCapacities([200], [0], 1)[0] === 0);
check("a team with negative spots has zero capacity",
      opponentCapacities([200], [-3], 1)[0] === 0);
check("a full rich team does not prop up the ceiling",
      priceCeiling(opponentCapacities([200, 5], [0, 3], 1), 1)
        === priceCeiling(opponentCapacities([5], [3], 1), 1));

/* -------------------------------------- gate 2: monotone as money drains */
{
  let monotone = true;
  let prev = Infinity;
  for (let budget = 200; budget >= 1; budget -= 5) {
    const c = priceCeiling(opponentCapacities([budget, budget], [5, 5], 1), 1);
    if (c > prev) monotone = false;
    prev = c;
  }
  check("ceiling never rises as budgets fall", monotone);

  let monotoneSpots = true;
  prev = Infinity;
  for (let spots = 1; spots <= 15; spots++) {
    // More spots left = more must be reserved = less biddable on one player.
    const c = priceCeiling(opponentCapacities([100], [spots], 1), 1);
    if (c > prev) monotoneSpots = false;
    prev = c;
  }
  check("ceiling never rises as opponents' remaining spots grow", monotoneSpots);

  check("a broke room bottoms out at the minimum bid",
        priceCeiling(opponentCapacities([1, 1, 1], [4, 4, 4], 1), 1) === 2,
        String(priceCeiling(opponentCapacities([1, 1, 1], [4, 4, 4], 1), 1)));
  check("an empty room still floors at the minimum bid",
        priceCeiling([], 1) === 1);
}

/* ------------------------------------------------------------- ceiling -- */
{
  // $50 free with 1 spot => can bid 50; I win at 51.
  const caps = opponentCapacities([50, 20], [1, 1], 1);
  check("ceiling is one increment above the richest opponent",
        priceCeiling(caps, 1) === 51, String(priceCeiling(caps, 1)));
  check("the RICHEST opponent sets it, not the sum",
        priceCeiling(opponentCapacities([50, 50, 50], [1, 1, 1], 1), 1) === 51);
}

/* ---------------------------------------------------------- cappedPrice */
{
  // Room can go to $51; a $30 player is unaffected.
  const rich = opponentCapacities([50], [1], 1);
  const a = cappedPrice(30, rich, 1);
  check("a price the room can afford is left alone", a.price === 30 && a.capped === false);

  // Room can only reach $6; a $40 player cannot actually fetch $40.
  const broke = opponentCapacities([5, 3], [1, 1], 1);
  const b = cappedPrice(40, broke, 1);
  check("a price beyond the room's money is capped", b.price === 6 && b.capped === true,
        `${b.price} / ${b.capped}`);
  check("the capped flag marks money, not value, as the binding force", b.ceiling === 6);

  check("a non-numeric market degrades to the minimum rather than NaN",
        Number.isFinite(cappedPrice(undefined, rich, 1).price));
  check("price never falls below the minimum bid",
        cappedPrice(0, broke, 1).price === 1);
}

/* -------------------------------------------------------- bindingCeiling */
{
  const roomRich = opponentCapacities([80], [1], 1);   // ceiling 81
  const roomBroke = opponentCapacities([4], [1], 1);   // ceiling 5

  check("allocation binds when it is the tighter constraint",
        JSON.stringify(bindingCeiling({ allocationCeiling: 30, capacities: roomRich, minBid: 1 }))
          === JSON.stringify({ bid: 30, binding: "allocation" }));

  check("opponents bind when the room cannot pay what I could afford",
        JSON.stringify(bindingCeiling({ allocationCeiling: 60, capacities: roomBroke, minBid: 1 }))
          === JSON.stringify({ bid: 5, binding: "opponents" }));

  // A 3.3 verdict of 0 is a real answer ("worth nothing to my roster"), not a
  // missing value — it must win rather than being treated as unconstrained.
  //
  // Note this case does NOT exercise the explicit `alloc <= 0` guard: since
  // priceCeiling floors at minBid, 0 <= roomCeiling always holds and the
  // general branch already returns the same thing. Verified by mutation —
  // deleting the guard leaves this assertion green. It is kept below anyway
  // for the case that DOES depend on it.
  check("an allocation ceiling of zero wins and is reported as allocation",
        JSON.stringify(bindingCeiling({ allocationCeiling: 0, capacities: roomRich, minBid: 1 }))
          === JSON.stringify({ bid: 0, binding: "allocation" }));

  // THIS is what the guard actually defends: without it a negative input
  // would flow through the general branch and be returned as a negative bid.
  // Not reachable from bidCeiling() today (it floors at 0), so this pins the
  // contract rather than a live path — defensive code that nothing tests is
  // indistinguishable from dead code.
  check("a negative allocation ceiling clamps to zero rather than a negative bid",
        bindingCeiling({ allocationCeiling: -5, capacities: roomRich, minBid: 1 }).bid === 0);

  // With no allocation ceiling supplied at all, the room still bounds it.
  const noAlloc = bindingCeiling({ capacities: roomBroke, minBid: 1 });
  check("with no allocation ceiling the room still caps the bid",
        noAlloc.bid === 5 && noAlloc.binding === "opponents");

  check("the composed bid never exceeds either input",
        (() => {
          for (const alloc of [1, 7, 30, 200]) {
            for (const caps of [roomRich, roomBroke]) {
              const r = bindingCeiling({ allocationCeiling: alloc, capacities: caps, minBid: 1 });
              if (r.bid > alloc) return false;
              if (r.bid > priceCeiling(caps, 1)) return false;
            }
          }
          return true;
        })());
}

/* --------------------------------------------------- realistic draft arc */
{
  // Ten opponents, 16-man rosters, $200 each. As the draft runs the ceiling
  // must fall from "anything is possible" toward the minimum.
  const arc = [];
  for (const done of [0, 0.25, 0.5, 0.75, 0.95]) {
    const spent = Math.round(200 * done * 0.9);
    const filled = Math.round(16 * done);
    const budgets = Array.from({ length: 10 }, () => 200 - spent);
    const spots = Array.from({ length: 10 }, () => 16 - filled);
    arc.push(priceCeiling(opponentCapacities(budgets, spots, 1), 1));
  }
  check("the ceiling tightens monotonically over a realistic draft",
        arc.every((v, i) => i === 0 || v <= arc[i - 1]), arc.join(" -> "));
  check("the ceiling is genuinely informative late (well under a full budget)",
        arc[arc.length - 1] < 40, `ended at ${arc[arc.length - 1]}`);
}

console.log();
if (fails.length) {
  console.error(`opponent-capacity.selftest: ${pass} passed, ${fails.length} FAILED — ${fails.join(", ")}`);
  process.exit(1);
}
console.log(`opponent-capacity.selftest: ${pass} passed, 0 failed`);

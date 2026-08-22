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
  opponentDemand, priceCeilingFor, opponentCountsFromPicks,
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

  /* --- MY OWN CASH (the overspend fix) ------------------------------------
   * Reported by a user mid-draft: "$Max should never exceed my remaining
   * budget... otherwise it is causing me to overspend." It could, and did:
   * once starters are full AuctionRoom passes allocationCeiling = market,
   * which is a property of the PLAYER, and the only other cap here was the
   * ROOM's money. Nothing knew what the bidder could actually afford. */
  const rich = bindingCeiling({ allocationCeiling: 35, budgetCeiling: 4, capacities: roomRich, minBid: 1 });
  check("my own cash caps the bid when it is the tightest constraint",
        rich.bid === 4 && rich.binding === "budget");

  check("a $35 market player with $4 of room to bid never reads above $4",
        bindingCeiling({ allocationCeiling: 35, budgetCeiling: 4, capacities: roomRich, minBid: 1 }).bid <= 4);

  check("no money left is a real verdict, and outranks a positive allocation",
        (() => {
          const r = bindingCeiling({ allocationCeiling: 30, budgetCeiling: 0, capacities: roomRich, minBid: 1 });
          return r.bid === 0 && r.binding === "budget";
        })());

  check("plenty of cash leaves the previous binding constraint reported",
        (() => {
          const a = bindingCeiling({ allocationCeiling: 30, budgetCeiling: 500, capacities: roomRich, minBid: 1 });
          const o = bindingCeiling({ allocationCeiling: 60, budgetCeiling: 500, capacities: roomBroke, minBid: 1 });
          return a.binding === "allocation" && o.binding === "opponents";
        })());

  check("omitting budgetCeiling preserves the old behaviour exactly",
        (() => {
          for (const alloc of [1, 7, 30, 200]) {
            for (const caps of [roomRich, roomBroke]) {
              const was = bindingCeiling({ allocationCeiling: alloc, capacities: caps, minBid: 1 });
              const now = bindingCeiling({ allocationCeiling: alloc, budgetCeiling: undefined, capacities: caps, minBid: 1 });
              if (JSON.stringify(was) !== JSON.stringify(now)) return false;
            }
          }
          return true;
        })());

  /* Roster DEPTH drives the cap, and deeper is tighter — flagged by the user
   * ("some rosters are deeper than 13"). The cap is maxBid(left, open) =
   * left - (open - 1), so the same money spread over more unfilled slots
   * leaves less for any one player. Nothing here hardcodes a roster size;
   * this pins that the relationship holds and stays >= $1. */
  check("a deeper roster tightens the wallet cap on the same money",
        (() => {
          const left = 20;
          const capFor = (open) => Math.max(1, left - (open - 1));
          const bids = [3, 8, 15, 30].map((open) => bindingCeiling({
            allocationCeiling: 60, budgetCeiling: capFor(open),
            capacities: roomRich, minBid: 1,
          }).bid);
          // 18, 13, 6, then floored at 1 — strictly decreasing until the floor.
          return bids[0] === 18 && bids[1] === 13 && bids[2] === 6 && bids[3] === 1
            && bids.every((b) => b >= 1);
        })());

  check("the composed bid never exceeds ANY of the three inputs",
        (() => {
          for (const alloc of [1, 7, 30, 200]) {
            for (const mine of [0, 1, 4, 25, 300]) {
              for (const caps of [roomRich, roomBroke]) {
                const r = bindingCeiling({
                  allocationCeiling: alloc, budgetCeiling: mine, capacities: caps, minBid: 1,
                });
                if (r.bid > alloc || r.bid > mine || r.bid > priceCeiling(caps, 1)) return false;
              }
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

/* ================= roadmap 3.4a: positional demand ====================== */
const LR = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 };

/* -------------------------------- gate 2: K/DST capped at one apiece ---- */
{
  check("an opponent needs exactly one kicker", opponentDemand("K", LR, {}) === 1);
  check("a team that has its kicker is out of the kicker market",
        opponentDemand("K", LR, { K: 1 }) === 0);
  check("same for defense", opponentDemand("DST", LR, { DST: 1 }) === 0);
  // The cap must hold even if the league config claims more, which is the
  // failure mode that would keep a filled team alive as a phantom bidder.
  check("K stays capped at one even if the roster settings say three",
        opponentDemand("K", { ...LR, K: 3 }, { K: 1 }) === 0);
  check("DST stays capped at one even if the roster settings say two",
        opponentDemand("DST", { ...LR, DST: 2 }, { DST: 1 }) === 0);
}

/* --------------------------- gate 1: demand monotonicity ---------------- */
{
  let monotone = true;
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    let prev = Infinity;
    for (let have = 0; have <= 12; have++) {
      const d = opponentDemand(pos, LR, { [pos]: have });
      if (d > prev) monotone = false;
      if (d < 0) monotone = false;
      prev = d;
    }
    // Everyone must bottom out at zero — no position is infinitely hungry.
    if (opponentDemand(pos, LR, { [pos]: 99 }) !== 0) monotone = false;
  }
  check("demand never rises as a position fills, and always reaches zero", monotone);

  check("FLEX-eligible positions carry the flex slot as extra demand",
        opponentDemand("RB", LR, {}) > opponentDemand("RB", { ...LR, FLEX: 0 }, {}));
  check("a non-flex position ignores the flex slot",
        opponentDemand("QB", LR, {}) === opponentDemand("QB", { ...LR, FLEX: 0 }, {}));
  check("superflex raises QB demand",
        opponentDemand("QB", LR, {}, true) > opponentDemand("QB", LR, {}, false));
}

/* ------------- gates 3 + 4: gating only ever tightens, and gates ------- */
{
  const budgets = [200, 50];
  const openSpots = [10, 10];
  // Opponent 0 is rich but completely done at TE; opponent 1 is poorer and needy.
  const counts = [{ TE: 5 }, {}];

  const te = priceCeilingFor("TE", { budgets, openSpots, counts, leagueRoster: LR });
  check("a rich opponent with no demand cannot set the position's ceiling",
        te.ceiling < te.arithmetic, `${te.ceiling} vs ${te.arithmetic}`);
  check("the tighter number reflects the needy opponent, not the rich one",
        te.ceiling === maxBid(50, 10, 1) + 1, String(te.ceiling));
  check("gating is reported when it bit", te.gated === true);
  check("bidder count excludes the sated opponent", te.bidders === 1);

  // Same room, a position where BOTH still need bodies: no tightening.
  const rb = priceCeilingFor("RB", { budgets, openSpots, counts, leagueRoster: LR });
  check("with demand everywhere the gated ceiling equals the arithmetic one",
        rb.ceiling === rb.arithmetic);
  check("gating is reported as inactive when it did not bite", rb.gated === false);

  // Gate 3 as a sweep: gating must NEVER exceed the arithmetic bound.
  let everLoosened = false;
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    for (const c of [[{}, {}], [{ [pos]: 9 }, {}], [{}, { [pos]: 9 }], [{ [pos]: 9 }, { [pos]: 9 }]]) {
      const r = priceCeilingFor(pos, { budgets, openSpots, counts: c, leagueRoster: LR });
      if (r.ceiling > r.arithmetic) everLoosened = true;
    }
  }
  check("gating can only tighten, never loosen, across every position", !everLoosened);

  // Everyone sated: nobody can bid, so it floors rather than going negative.
  const dead = priceCeilingFor("TE", {
    budgets, openSpots, counts: [{ TE: 9 }, { TE: 9 }], leagueRoster: LR,
  });
  check("a room with no demand anywhere floors at the minimum bid",
        dead.ceiling === 1 && dead.bidders === 0, `${dead.ceiling}/${dead.bidders}`);
}

/* ---------------------------------------- opponentCountsFromPicks ------- */
{
  const posById = new Map([[1, "RB"], [2, "RB"], [3, "WR"], [4, "TE"], [5, "QB"]]);
  const picks = [
    { mine: false, teamId: 0, playerId: 1 },
    { mine: false, teamId: 0, playerId: 2 },
    { mine: false, teamId: 1, playerId: 3 },
    { mine: true,  teamId: null, playerId: 4 },   // mine — must not count
    { mine: false, teamId: 0, playerId: null },   // no player — must not count
    { mine: false, teamId: 9, playerId: 5 },      // out of range — must not count
    { mine: false, teamId: null, playerId: 5 },   // no team — must not count
  ];
  const counts = opponentCountsFromPicks(picks, posById, 2);

  check("counts one entry per opponent", counts.length === 2);
  check("tallies an opponent's picks by position",
        counts[0].RB === 2 && counts[1].WR === 1, JSON.stringify(counts));
  check("my own picks are not counted as an opponent's",
        !counts.some((c) => c.TE));
  check("a pick with no player is skipped rather than counted as undefined",
        !Object.keys(counts[0]).includes("undefined"));
  check("an out-of-range teamId cannot corrupt another team's counts",
        counts[0].QB === undefined && counts[1].QB === undefined);
  check("an empty log gives empty counts, not undefined entries",
        opponentCountsFromPicks([], posById, 2).every((c) => Object.keys(c).length === 0));
  check("accepts a plain object lookup as well as a Map",
        opponentCountsFromPicks([{ mine: false, teamId: 0, playerId: 1 }],
                                { 1: "RB" }, 1)[0].RB === 1);

  // The whole reason this is extracted: it feeds priceCeilingFor, so a wiring
  // mistake here would silently disable demand gating in the product.
  const rich = { budgets: [200, 200], openSpots: [10, 10], leagueRoster: LR };
  const hungry = priceCeilingFor("RB", { ...rich, counts: opponentCountsFromPicks([], posById, 2) });
  const sated = priceCeilingFor("RB", {
    ...rich,
    counts: [{ RB: 9 }, { RB: 9 }],
  });
  check("counts from the pick log actually drive the gated ceiling",
        sated.ceiling < hungry.ceiling, `${sated.ceiling} vs ${hungry.ceiling}`);
}

/* ------------------------------------- the point of the whole exercise -- */
{
  // One rich team, already stacked at RB. Before 3.4a it would hold the RB
  // ceiling up single-handed; after, it cannot.
  const budgets = [180, 6, 6];
  const openSpots = [8, 8, 8];
  const counts = [{ RB: 9 }, {}, {}];
  const r = priceCeilingFor("RB", { budgets, openSpots, counts, leagueRoster: LR });
  check("a stacked rich team no longer inflates its filled position's ceiling",
        r.ceiling < 20 && r.arithmetic > 100, `ceiling ${r.ceiling}, arithmetic ${r.arithmetic}`);
}

console.log();
if (fails.length) {
  console.error(`opponent-capacity.selftest: ${pass} passed, ${fails.length} FAILED — ${fails.join(", ")}`);
  process.exit(1);
}
console.log(`opponent-capacity.selftest: ${pass} passed, 0 failed`);

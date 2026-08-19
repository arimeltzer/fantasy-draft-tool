#!/usr/bin/env node
/**
 * Selftest — budget-path.js (roadmap 3.3)
 *
 * THE LOAD-BEARING TEST is `reachableRoster` against exhaustive brute force
 * on randomized small cases. An optimizer that is subtly not optimal is worse
 * than no optimizer, because every number downstream inherits the error
 * silently and nothing ever looks broken — the same reason survival.js's
 * prefix-sum shortcut was pinned against its own O(n^2) definition.
 *
 * The DP has two places it could plausibly be wrong and look fine:
 *   - reusing one player across two slots (the count-dimension knapsack's
 *     loop order is what prevents it), and
 *   - FLEX, which makes position pools overlap (handled by enumerating the
 *     flex assignment so pools are disjoint inside each branch).
 * Both are specifically exercised below rather than hoped for.
 */
import {
  reachableRoster, bidCeiling, flexDistributions, remainingStartingSlots,
  FLEX_ELIGIBLE, TOP_K_PER_POS,
} from "./budget-path.js";

let pass = 0;
const fails = [];
function check(label, ok, detail = "") {
  if (ok) { pass++; return; }
  fails.push(label);
  console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
}

const valueOf = (p) => p.value;
const priceOf = (p) => p.price;

/* ------------------------------------------------------------ brute force */
/** Exhaustive: every assignment of distinct players to slots, within budget. */
function bruteForce(slots, budget, pool) {
  let best = -Infinity;
  const used = new Set();
  const walk = (i, spent, val) => {
    if (spent > budget) return;
    if (i === slots.length) { if (val > best) best = val; return; }
    const slot = slots[i];
    for (const p of pool) {
      if (used.has(p.id)) continue;
      const fits = slot === "FLEX" ? FLEX_ELIGIBLE.includes(p.pos) : p.pos === slot;
      if (!fits) continue;
      used.add(p.id);
      walk(i + 1, spent + p.price, val + p.value);
      used.delete(p.id);
    }
  };
  walk(0, 0, 0);
  return best;
}

/* ------------------------------------------------------- flexDistributions */
check("flexDistributions(0) is the single empty assignment",
      flexDistributions(0).length === 1);
check("flexDistributions(1) is one per eligible position",
      flexDistributions(1).length === FLEX_ELIGIBLE.length);
{
  // 2 identical flex slots over 3 positions = multiset count = C(2+2,2) = 6.
  check("flexDistributions(2) enumerates combinations-with-repetition",
        flexDistributions(2).length === 6);
  const all = flexDistributions(2);
  check("every 2-flex distribution totals 2",
        all.every((d) => d.RB + d.WR + d.TE === 2));
}

/* -------------------------------------------------- DP vs brute force ---- */
{
  // Deterministic RNG so a failure is reproducible.
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const POSNS = ["QB", "RB", "WR", "TE"];
  const SLOT_SETS = [
    ["RB", "WR"],
    ["RB", "RB", "WR"],
    ["QB", "RB", "WR", "TE"],
    ["RB", "WR", "FLEX"],              // FLEX overlapping RB/WR pools
    ["RB", "RB", "WR", "WR", "FLEX"],  // FLEX with real competition
    ["QB", "RB", "FLEX", "FLEX"],      // two FLEX slots
  ];

  let mismatches = 0, cases = 0, infeasibleSeen = 0, leftoverSeen = 0;
  for (let trial = 0; trial < 240; trial++) {
    const slots = SLOT_SETS[trial % SLOT_SETS.length];
    const pool = [];
    const n = 6 + Math.floor(rnd() * 5);
    for (let i = 0; i < n; i++) {
      pool.push({
        id: i + 1,
        pos: POSNS[Math.floor(rnd() * POSNS.length)],
        price: 1 + Math.floor(rnd() * 12),
        value: Math.round(rnd() * 100),
      });
    }
    const budget = 8 + Math.floor(rnd() * 26);

    const dp = reachableRoster({ slots, budget, pool, valueOf, priceOf });
    const bf = bruteForce(slots, budget, pool);
    cases++;

    if (bf === -Infinity) {
      infeasibleSeen++;
      if (dp.feasible) { mismatches++; console.log(`  brute=infeasible dp=feasible trial ${trial}`); }
      continue;
    }
    if (!dp.feasible || Math.abs(dp.value - bf) > 1e-9) {
      mismatches++;
      if (mismatches <= 3) {
        console.log(`  trial ${trial}: dp=${dp.feasible ? dp.value : "infeasible"} brute=${bf} `
          + `slots=${slots.join("/")} budget=${budget}`);
      }
      continue;
    }
    if (dp.spend < budget) leftoverSeen++;

    // The reconstructed picks must be real: right count, distinct, affordable,
    // and actually summing to the reported value. A DP can report the correct
    // optimum and still reconstruct nonsense.
    if (dp.picks.length !== slots.length) {
      mismatches++; console.log(`  trial ${trial}: picks ${dp.picks.length} != slots ${slots.length}`);
      continue;
    }
    const ids = new Set(dp.picks.map((p) => p.id));
    if (ids.size !== dp.picks.length) { mismatches++; console.log(`  trial ${trial}: duplicate pick`); continue; }
    const cost = dp.picks.reduce((s, p) => s + p.price, 0);
    const val = dp.picks.reduce((s, p) => s + p.value, 0);
    if (cost > budget) { mismatches++; console.log(`  trial ${trial}: picks cost ${cost} > ${budget}`); continue; }
    if (Math.abs(val - dp.value) > 1e-9) { mismatches++; console.log(`  trial ${trial}: picks sum ${val} != ${dp.value}`); }
  }

  check(`DP equals brute-force optimum on ${cases} randomized cases`, mismatches === 0,
        `${mismatches} mismatches`);
  // Guard the guard: a suite where nothing was ever infeasible, or the budget
  // never bound, would be passing trivially.
  check("the randomized suite actually produced infeasible cases", infeasibleSeen > 0,
        `saw ${infeasibleSeen}`);
  check("the randomized suite actually produced budget-limited cases", leftoverSeen < cases,
        `leftover in ${leftoverSeen}/${cases}`);
}

/* ------------------------------------------------------- no player reuse */
{
  // One outstanding RB, two RB slots. Reusing him would score 200; the honest
  // answer uses the second-best RB.
  const pool = [
    { id: 1, pos: "RB", price: 5, value: 100 },
    { id: 2, pos: "RB", price: 5, value: 10 },
  ];
  const r = reachableRoster({ slots: ["RB", "RB"], budget: 50, pool, valueOf, priceOf });
  check("a player cannot fill two slots at once", r.value === 110, `got ${r.value}`);
}

/* ------------------------------------------------- greedy would get this wrong */
{
  // The whole point of exact DP. Budget 10, two slots. Greedy takes the $9
  // star first (value 100), then can only afford a $1 RB (value 1) => 101.
  // Optimal takes two $5s => 60+60 = 120.
  const pool = [
    { id: 1, pos: "RB", price: 9, value: 100 },
    { id: 2, pos: "RB", price: 5, value: 60 },
    { id: 3, pos: "WR", price: 5, value: 60 },
    { id: 4, pos: "WR", price: 1, value: 1 },
  ];
  const r = reachableRoster({ slots: ["RB", "WR"], budget: 10, pool, valueOf, priceOf });
  check("beats the greedy trap (spend-down-first)", r.value === 120, `got ${r.value}`);
}

/* --------------------------------------------------------- infeasibility */
{
  const pool = [{ id: 1, pos: "RB", price: 5, value: 10 }];
  check("not enough bodies at a position is infeasible",
        reachableRoster({ slots: ["RB", "RB"], budget: 99, pool, valueOf, priceOf }).feasible === false);
  check("cannot afford the cheapest legal roster is infeasible",
        reachableRoster({ slots: ["RB"], budget: 2, pool, valueOf, priceOf }).feasible === false);
  check("no slots is trivially feasible at zero value",
        reachableRoster({ slots: [], budget: 10, pool, valueOf, priceOf }).value === 0);
}

/* ----------------------------------------------------------- FLEX routing */
{
  // Only TEs left for the FLEX; the DP must route a TE into it rather than
  // declaring the roster unfillable.
  const pool = [
    { id: 1, pos: "RB", price: 5, value: 50 },
    { id: 2, pos: "TE", price: 5, value: 40 },
  ];
  const r = reachableRoster({ slots: ["RB", "FLEX"], budget: 20, pool, valueOf, priceOf });
  check("FLEX accepts a TE when that is the only option", r.feasible && r.value === 90,
        `${r.feasible} / ${r.value}`);

  // A QB is not FLEX-eligible, so this one IS unfillable.
  const qbOnly = [
    { id: 1, pos: "RB", price: 5, value: 50 },
    { id: 2, pos: "QB", price: 5, value: 99 },
  ];
  check("FLEX refuses a QB",
        reachableRoster({ slots: ["RB", "FLEX"], budget: 20, pool: qbOnly, valueOf, priceOf }).feasible === false);
}

/* ------------------------------------------------------------- pruning */
{
  // More candidates than TOP_K_PER_POS: the best must still be found (pruning
  // sorts by value, so the top is never the part discarded).
  const pool = Array.from({ length: TOP_K_PER_POS + 30 }, (_, i) => ({
    id: i + 1, pos: "RB", price: 1, value: i,       // best is LAST in id order
  }));
  const r = reachableRoster({ slots: ["RB"], budget: 50, pool, valueOf, priceOf });
  check("pruning keeps the best candidate, not the first-seen",
        r.value === TOP_K_PER_POS + 29, `got ${r.value}`);
}

/* ---------------------------------------------------------- bidCeiling */
{
  const pool = [
    { id: 1, pos: "RB", price: 10, value: 100 },
    { id: 2, pos: "RB", price: 10, value: 90 },
    { id: 3, pos: "WR", price: 10, value: 80 },
    { id: 4, pos: "WR", price: 10, value: 70 },
  ];
  const slots = ["RB", "WR"];
  const budget = 40;
  const star = pool[0];

  const ceil = bidCeiling({ player: star, slots, budget, pool, valueOf, priceOf });
  check("bidCeiling is positive for a player who belongs on the roster", ceil > 0, `got ${ceil}`);
  check("bidCeiling never exceeds the cash on hand", ceil <= budget, `got ${ceil}`);

  // Paying the ceiling must genuinely leave you no worse off; one dollar more
  // must genuinely leave you worse off. That is the definition, checked
  // directly against reachableRoster rather than trusting the search.
  const base = reachableRoster({ slots, budget, pool, valueOf, priceOf }).value;
  const restPool = pool.filter((p) => p.id !== star.id);
  const at = (p) => {
    const r = reachableRoster({ slots: ["WR"], budget: budget - p, pool: restPool, valueOf, priceOf });
    return r.feasible ? star.value + r.value : -Infinity;
  };
  check("paying exactly the ceiling is no worse than skipping", at(ceil) >= base);
  check("paying one more than the ceiling IS worse than skipping", at(ceil + 1) < base);

  // More valuable player, same market => higher ceiling.
  const lesser = { id: 9, pos: "RB", price: 10, value: 12 };
  const poolL = [lesser, ...pool.slice(1)];
  const ceilL = bidCeiling({ player: lesser, slots, budget, pool: poolL, valueOf, priceOf });
  check("a more valuable player earns a higher ceiling", ceil > ceilL, `${ceil} vs ${ceilL}`);

  // A player with no slot he can fill is worth nothing at any price.
  const kicker = { id: 99, pos: "K", price: 1, value: 500 };
  check("a player with no fillable slot has ceiling 0",
        bidCeiling({ player: kicker, slots, budget, pool: [...pool, kicker], valueOf, priceOf }) === 0);
}

/* -------------------------------------------- remainingStartingSlots ---- */
{
  const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 5 };
  const P = (pos) => ({ pos });

  {
    const { slots, reserveSpots } = remainingStartingSlots(ROSTER, []);
    check("empty roster needs every starting slot",
          slots.filter((s) => s === "QB").length === 1
          && slots.filter((s) => s === "RB").length === 2
          && slots.filter((s) => s === "WR").length === 2
          && slots.filter((s) => s === "TE").length === 1
          && slots.filter((s) => s === "FLEX").length === 1,
          slots.join("/"));
    check("empty roster reserves for K + DST + bench", reserveSpots === 7, `got ${reserveSpots}`);
  }

  {
    // A third WR in a 2-WR league fills FLEX, it is not an unmet WR need.
    const { slots } = remainingStartingSlots(ROSTER, [P("WR"), P("WR"), P("WR")]);
    check("surplus at a position consumes FLEX rather than reporting a need",
          !slots.includes("WR") && !slots.includes("FLEX"), slots.join("/"));
  }

  {
    // Owning MORE than a position requires must not produce negative slots.
    const { slots } = remainingStartingSlots(ROSTER, [P("QB"), P("QB"), P("QB")]);
    check("over-filling a position never yields negative slots",
          !slots.includes("QB") && slots.length > 0, slots.join("/"));
  }

  {
    // Extra bodies beyond the starters eat into the bench reserve.
    const many = [P("RB"), P("RB"), P("RB"), P("RB")];   // 2 starters + 2 (flex + bench)
    const { reserveSpots } = remainingStartingSlots(ROSTER, many);
    check("bodies past the starting lineup reduce the bench reserve",
          reserveSpots < 7, `got ${reserveSpots}`);
    check("reserve never goes negative", reserveSpots >= 0, `got ${reserveSpots}`);
  }

  {
    const { slots, reserveSpots } = remainingStartingSlots({}, []);
    check("an empty roster config asks for nothing",
          slots.length === 0 && reserveSpots === 0);
  }
}

console.log();
if (fails.length) {
  console.error(`budget-path.selftest: ${pass} passed, ${fails.length} FAILED — ${fails.join(", ")}`);
  process.exit(1);
}
console.log(`budget-path.selftest: ${pass} passed, 0 failed`);

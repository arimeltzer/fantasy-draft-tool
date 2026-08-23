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
  firstBackupBoost, BACKUP_BOOST_MULT,
  FLEX_ELIGIBLE, TOP_K_PER_POS,
  historicalBenchReserve, benchReserveDollars,
  BENCH_WINDOW, BENCH_RESERVE_MIN_PICKS,
  bonusBackupPositions, withBonusBackupSlots,
  benchDepthMult, BENCH_DEPTH_DECAY, BENCH_DEPTH_IMBALANCE_MULT,
  benchStackWarning,
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

/* ------------------------------------------------ firstBackupBoost ------ */
{
  const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 5 };

  check("boosts the FIRST bench body at QB/RB/WR",
        firstBackupBoost("QB", 1, ROSTER) === BACKUP_BOOST_MULT
        && firstBackupBoost("RB", 2, ROSTER) === BACKUP_BOOST_MULT
        && firstBackupBoost("WR", 2, ROSTER) === BACKUP_BOOST_MULT);

  check("no boost once a backup already exists",
        firstBackupBoost("RB", 3, ROSTER) === 1
        && firstBackupBoost("QB", 2, ROSTER) === 1);

  check("no boost before starters are even filled — this is a BENCH nudge",
        firstBackupBoost("RB", 1, ROSTER) === 1
        && firstBackupBoost("RB", 0, ROSTER) === 1);

  check("TE/K/DST are excluded — they already have maxUseful's own policy",
        firstBackupBoost("TE", 1, ROSTER) === 1
        && firstBackupBoost("K", 1, ROSTER) === 1
        && firstBackupBoost("DST", 1, ROSTER) === 1);

  check("never negative-backups from an under-filled roster; never below 1",
        firstBackupBoost("RB", 0, ROSTER) === 1
        && firstBackupBoost("QB", 0, {}) === 1);
}

/* ---------------------------------------------------- benchDepthMult ---- */
{
  // 2 dedicated + 1 FLEX = capacity 3; depth slot (full value) is the 4th.
  const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 };

  check("full value through the depth slot (up to and including the 4th)",
        benchDepthMult("RB", 1, ROSTER, 2) === 1
        && benchDepthMult("RB", 3, ROSTER, 2) === 1
        && benchDepthMult("RB", 4, ROSTER, 2) === 1);

  check("decays starting at the 5th, geometrically",
        Math.abs(benchDepthMult("RB", 5, ROSTER, 3) - BENCH_DEPTH_DECAY) < 1e-9
        && Math.abs(benchDepthMult("RB", 6, ROSTER, 3) - BENCH_DEPTH_DECAY ** 2) < 1e-9);

  // The exact scenario reported live: 5 RBs, zero WR (sibling capacity 3 not
  // reached) — the imbalance penalty stacks on top of the plain decay.
  check("extra discount when the FLEX sibling hasn't reached its own capacity",
        Math.abs(benchDepthMult("RB", 5, ROSTER, 0) - BENCH_DEPTH_DECAY * BENCH_DEPTH_IMBALANCE_MULT) < 1e-9);

  check("no imbalance penalty once the sibling has reached ITS capacity",
        Math.abs(benchDepthMult("RB", 5, ROSTER, 3) - BENCH_DEPTH_DECAY) < 1e-9
        && Math.abs(benchDepthMult("RB", 5, ROSTER, 5) - BENCH_DEPTH_DECAY) < 1e-9);

  check("symmetric for WR, keyed off WR's own roster requirement",
        benchDepthMult("WR", 4, ROSTER, 2) === 1
        && Math.abs(benchDepthMult("WR", 5, ROSTER, 0) - BENCH_DEPTH_DECAY * BENCH_DEPTH_IMBALANCE_MULT) < 1e-9);

  check("every other position is untouched — this is RB/WR's shared FLEX relationship only",
        benchDepthMult("QB", 10, ROSTER, 0) === 1
        && benchDepthMult("TE", 10, ROSTER, 0) === 1
        && benchDepthMult("K", 10, ROSTER, 0) === 1
        && benchDepthMult("DST", 10, ROSTER, 0) === 1);

  check("never exceeds 1 (a discount only, never a bonus) and never negative",
        benchDepthMult("RB", 20, ROSTER, 0) > 0 && benchDepthMult("RB", 20, ROSTER, 0) <= 1);
}

/* ------------------------------------------------- benchStackWarning ---- */
// Roadmap 3.6g — the display-only flag that replaced benchDepthMult as a
// SCORE/PRICE effect after both 3.6f gates rejected it. Shares
// benchDepthMult's exact threshold (capacity + 1) on purpose, since it's
// answering the identical question, just as information instead of a
// valuation change.
{
  const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 };

  check("no warning up to and including the depth slot (the 4th)",
        benchStackWarning("RB", 1, ROSTER, 0) === null
        && benchStackWarning("RB", 3, ROSTER, 0) === null
        && benchStackWarning("RB", 4, ROSTER, 0) === null);

  // The exact scenario reported live: 5 RBs, zero WR (sibling capacity 3
  // not reached) — this is precisely what should fire.
  check("fires once past the depth slot AND the sibling hasn't caught up",
        (() => {
          const w = benchStackWarning("RB", 5, ROSTER, 0);
          return w && w.sibling === "WR" && w.siblingHave === 0 && w.siblingCapacity === 3;
        })());

  check("no warning once the sibling has reached ITS OWN capacity",
        benchStackWarning("RB", 5, ROSTER, 3) === null
        && benchStackWarning("RB", 5, ROSTER, 5) === null);

  check("symmetric for WR, keyed off WR's own roster requirement",
        benchStackWarning("WR", 4, ROSTER, 0) === null
        && benchStackWarning("WR", 5, ROSTER, 0)?.sibling === "RB");

  check("every other position is untouched — this is RB/WR's shared FLEX relationship only",
        benchStackWarning("QB", 10, ROSTER, 0) === null
        && benchStackWarning("TE", 10, ROSTER, 0) === null
        && benchStackWarning("K", 10, ROSTER, 0) === null
        && benchStackWarning("DST", 10, ROSTER, 0) === null);

  check("stays flagged arbitrarily deep, as long as the sibling stays thin",
        benchStackWarning("RB", 20, ROSTER, 0) !== null);
}

/* ------------------------------------------ historicalBenchReserve (3.7) */
{
  const TEAMS = 10;
  const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 5 };
  // threshold = teams * roster[pos] = 10 for QB. Ranks 1-10 are "starters",
  // the window (BENCH_WINDOW=3) picked up starts at rank 11.
  const qbSeason = (season, windowPrices) => {
    const picks = [];
    for (let i = 0; i < TEAMS; i++) picks.push({ pos: "QB", bid: 50, overall: i + 1, season });
    windowPrices.forEach((price, i) => picks.push({ pos: "QB", bid: price, overall: TEAMS + i + 1, season }));
    return picks;
  };

  const threeSeasons = [
    ...qbSeason(2023, [6, 5, 4]),
    ...qbSeason(2024, [6, 5, 4]),
    ...qbSeason(2025, [6, 5, 4]),
  ];
  const rich = historicalBenchReserve(threeSeasons, { teams: TEAMS, roster: ROSTER });
  check("enough pooled window picks (9 >= MIN_PICKS) makes the signal usable",
        rich.usable && rich.sample.QB === 9);
  check("shrinks the observed $5 average toward the $1 fallback, doesn't just pass it through",
        rich.reserve.QB > 1 && rich.reserve.QB < 5,
        `got ${rich.reserve.QB}`);
  check("a position never drafted (no threshold) stays the $1 fallback",
        rich.reserve.RB === 1 && rich.reserve.WR === 1);

  const oneSeasonOnly = historicalBenchReserve(qbSeason(2025, [6, 5, 4]), { teams: TEAMS, roster: ROSTER });
  check(`below BENCH_RESERVE_MIN_PICKS (${BENCH_RESERVE_MIN_PICKS}) stays $1 — most leagues' 1-2 imported seasons`,
        !oneSeasonOnly.usable && oneSeasonOnly.reserve.QB === 1 && oneSeasonOnly.sample.QB === BENCH_WINDOW);

  check("no history at all is a clean $1 fallback, not a crash",
        historicalBenchReserve(null, { teams: TEAMS, roster: ROSTER }).usable === false
        && historicalBenchReserve([], { teams: TEAMS, roster: ROSTER }).reserve.QB === 1);

  check("picks with no overall (Yahoo/paste import) are excluded from this signal, not treated as rank 0",
        historicalBenchReserve(
          [{ pos: "QB", bid: 5, season: 2025 }, { pos: "QB", bid: 4, season: 2025 }],
          { teams: TEAMS, roster: ROSTER },
        ).reserve.QB === 1);
}

/* ------------------------------------------------ benchReserveDollars --- */
{
  const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 5 };
  const historical = { QB: 3, RB: 1, WR: 1 };   // only QB carries a differentiated signal

  check("upgrades exactly the missing QB backup slot from $1 to its historical anchor",
        benchReserveDollars(ROSTER, [{ pos: "QB" }], 5, historical) === 5 + (3 - 1));

  check("no upgrade once the QB backup already exists",
        benchReserveDollars(ROSTER, [{ pos: "QB" }, { pos: "QB" }], 5, historical) === 5);

  check("RB/WR with no differentiated signal (anchor=1) stay flat, even with zero backups",
        benchReserveDollars(ROSTER, [{ pos: "RB" }, { pos: "RB" }], 5, historical) === 5);

  check("zero reserve slots is a no-op regardless of missing backups",
        benchReserveDollars(ROSTER, [{ pos: "QB" }], 0, historical) === 0);

  check("never reserves more than the slots actually available",
        benchReserveDollars(ROSTER, [], 0, { QB: 50, RB: 50, WR: 50 }) === 0);
}

/* ------------------------------------------------- roadmap 3.8 --------- */
{
  const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 };

  check("bonusBackupPositions is exactly the 2+-starter positions",
        JSON.stringify(bonusBackupPositions(ROSTER).sort()) === JSON.stringify(["RB", "WR"]));
  check("a roster with no 2+-starter position has no bonus positions at all",
        bonusBackupPositions({ QB: 1, RB: 1, WR: 1, TE: 1 }).length === 0);
  check("superflex-style QB:2 makes QB eligible too — derived from roster, not hardcoded",
        bonusBackupPositions({ QB: 2, RB: 1 }).includes("QB"));

  const openSlots = ["RB", "WR"];   // e.g. last RB starter + last WR starter still open

  check("have[pos]===0 (drafting the FIRST player): untouched, no bonus slot",
        JSON.stringify(withBonusBackupSlots(openSlots, ROSTER, [])) === JSON.stringify(openSlots));

  check("have[RB]===1 (about to buy the LAST RB starter): one bonus RB slot added",
        withBonusBackupSlots(openSlots, ROSTER, [{ pos: "RB" }])
          .filter((s) => s === "RB").length === 2);

  check("have[RB]===1 does not add a bonus slot for WR (a position it didn't trigger)",
        withBonusBackupSlots(openSlots, ROSTER, [{ pos: "RB" }])
          .filter((s) => s === "WR").length === 1);

  check("have[RB]>=roster[RB] (starters already full): no bonus — real bench phase governs",
        withBonusBackupSlots(openSlots, ROSTER, [{ pos: "RB" }, { pos: "RB" }])
          .filter((s) => s === "RB").length === 1);

  check("both RB and WR at have===1 simultaneously: a bonus slot for each",
        JSON.stringify(withBonusBackupSlots(openSlots, ROSTER, [{ pos: "RB" }, { pos: "WR" }]).sort())
        === JSON.stringify(["RB", "RB", "WR", "WR"].sort()));

  check("a 1-starter position (QB) never gets a bonus slot regardless of have",
        withBonusBackupSlots(["QB"], ROSTER, [{ pos: "QB" }]).filter((s) => s === "QB").length === 1);

  check("the input slots array is never mutated in place",
        (() => { const s = ["RB"]; withBonusBackupSlots(s, ROSTER, [{ pos: "RB" }]); return s.length === 1; })());

  // The point of the mechanism: with a bonus RB slot in play, the DP should
  // be able to prefer a cheaper RB2 that ALSO affords a strong bench RB
  // over a pricier RB2 alone, when the combined value wins.
  {
    const pool = [
      { id: 1, pos: "RB", value: 20, price: 34 },   // pricier RB2 candidate, alone
      { id: 2, pos: "RB", value: 18, price: 32 },   // slightly cheaper RB2 candidate
      { id: 3, pos: "RB", value: 12, price: 8 },    // a strong, affordable bench RB
      { id: 4, pos: "WR", value: 5, price: 3 },
    ];
    const valueOf = (p) => p.value;
    const priceOf = (p) => p.price;

    const withoutBonus = reachableRoster({ slots: ["RB"], budget: 40, pool, valueOf, priceOf });
    const withBonus = reachableRoster({
      slots: withBonusBackupSlots(["RB"], { RB: 2 }, [{ pos: "RB" }]),
      budget: 40, pool, valueOf, priceOf,
    });
    check("without the bonus slot, the DP takes the single best RB alone (id 1, $34)",
          withoutBonus.picks.length === 1 && withoutBonus.picks[0].id === 1);
    check("with the bonus slot, the DP finds the cheaper RB2 + bench RB combo beats RB2 alone",
          withBonus.picks.map((p) => p.id).sort().join() === "2,3",
          JSON.stringify(withBonus.picks.map((p) => p.id)));
    check("...and that combo's total value (18+12=30) beats the single pricier RB alone (20)",
          withBonus.value === 30 && withBonus.value > withoutBonus.value);
  }
}

console.log();
if (fails.length) {
  console.error(`budget-path.selftest: ${pass} passed, ${fails.length} FAILED — ${fails.join(", ")}`);
  process.exit(1);
}
console.log(`budget-path.selftest: ${pass} passed, 0 failed`);

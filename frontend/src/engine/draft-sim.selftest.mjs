/**
 * draft-sim.selftest.mjs — the simulator must be right before its output means anything
 * =====================================================================================
 * A draft simulator fails silently and expensively. If the serpentine order is
 * wrong, or a player can be drafted twice, or the paired comparison does not
 * actually pair, it still produces smooth plausible numbers and those numbers
 * decide whether 100 tuned parameters stay in the engine. So the mechanics are
 * pinned first, against cases whose answers are known without simulating.
 *
 *   node frontend/src/engine/draft-sim.selftest.mjs
 */
import {
  mulberry32, snakeOrder, botPick, simulateDraft, bestLineupPoints, pairedCompare,
  realizedWeeklyPoints, makeInjuryOracle, INJURY_MISS_RATE,
} from "./draft-sim.mjs";
import { snakePicks } from "./snake-engine.js";

let pass = 0;
const fails = [];
const check = (label, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push(label);
  console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
};

const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0, BENCH: 8 };

/** A board with a clean, known value ordering. */
function makeBoard(n = 200) {
  const POS = ["RB", "WR", "QB", "TE"];
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `P${i + 1}`,
    pos: POS[i % POS.length],
    team: "XX",
    age: 26,
    risk: 0.1,
    trend: 0,
    vbd: +(300 - i * 1.4).toFixed(1),
    valuePoints: +(320 - i * 1.3).toFixed(1),
    adp: i + 1,
  }));
}

// ── RNG ───────────────────────────────────────────────────────────────────
const r1 = mulberry32(42);
const r2 = mulberry32(42);
check("same seed gives the same stream",
      [r1(), r1(), r1()].join() === [r2(), r2(), r2()].join());
check("different seeds differ", mulberry32(1)() !== mulberry32(2)());
const draws = Array.from({ length: 2000 }, mulberry32(7));
check("rng stays in [0,1)", draws.every((d) => d >= 0 && d < 1));

// ── serpentine order ──────────────────────────────────────────────────────
// Checked against the SHIPPED snakePicks rather than a second hand-rolled
// formula: if the simulator drafted in a different order from the app's own
// pick maths, every result would be about a draft nobody plays.
for (const teams of [8, 10, 12]) {
  const rounds = 15;
  const order = snakeOrder(teams, rounds);
  check(`order has every pick (${teams} teams)`, order.length === teams * rounds);
  let ok = true;
  for (let slot = 1; slot <= teams; slot++) {
    const mine = [];
    order.forEach((t, i) => { if (t === slot - 1) mine.push(i + 1); });
    if (JSON.stringify(mine) !== JSON.stringify(snakePicks(slot, teams, rounds))) ok = false;
  }
  check(`order matches shipped snakePicks at every slot (${teams} teams)`, ok);
}

// ── a full draft ──────────────────────────────────────────────────────────
{
  const board = makeBoard();
  const { rosters } = simulateDraft({
    board, teams: 10, rounds: 15, roster: ROSTER, seed: 3,
    agents: { 4: { slot: 5 } },
  });
  const all = rosters.flat();
  check("every team fills its roster", rosters.every((r) => r.length === 15));
  check("no player is drafted twice", new Set(all.map((p) => p.id)).size === all.length);
  check("nobody drafts a player who isn't on the board",
        all.every((p) => board.some((b) => b.id === p.id)));
  check("the draft is deterministic for a seed",
        JSON.stringify(simulateDraft({ board, teams: 10, rounds: 15, roster: ROSTER, seed: 3,
                                       agents: { 4: { slot: 5 } } }).rosters.map((r) => r.map((p) => p.id)))
        === JSON.stringify(rosters.map((r) => r.map((p) => p.id))));
}

// ── bots respect roster capacity ──────────────────────────────────────────
{
  const board = makeBoard(300);
  const { counts } = simulateDraft({ board, teams: 10, rounds: 15, roster: ROSTER, seed: 11 });
  check("no bot hoards quarterbacks", counts.every((c) => c.QB <= 2),
        JSON.stringify(counts.map((c) => c.QB)));
  check("no bot hoards tight ends", counts.every((c) => c.TE <= 2),
        JSON.stringify(counts.map((c) => c.TE)));
}

// ── lineup scoring ────────────────────────────────────────────────────────
{
  const roster = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 };
  const players = [
    { id: 1, pos: "QB" }, { id: 2, pos: "QB" },
    { id: 3, pos: "RB" }, { id: 4, pos: "RB" }, { id: 5, pos: "RB" },
    { id: 6, pos: "WR" }, { id: 7, pos: "WR" },
    { id: 8, pos: "TE" },
  ];
  const pts = { 1: 300, 2: 290, 3: 200, 4: 190, 5: 180, 6: 150, 7: 140, 8: 100 };
  // QB 300 + RB 200,190 + WR 150,140 + TE 100 + FLEX(best left = RB 180)
  check("starts the best legal lineup and uses FLEX",
        bestLineupPoints(players, pts, roster) === 1260,
        String(bestLineupPoints(players, pts, roster)));
  check("a benched second QB contributes nothing",
        bestLineupPoints(players.filter((p) => p.id !== 2), pts, roster) === 1260);
  check("missing players score 0 rather than NaN",
        Number.isFinite(bestLineupPoints(players, {}, roster)));
}

// ── the paired comparison must actually pair ──────────────────────────────
{
  const board = makeBoard();
  const pointsById = Object.fromEntries(board.map((p) => [p.id, p.vbd]));
  const params = JSON.parse(JSON.stringify(
    (await import("./snake-engine.js")).DEFAULT_SNAKE_PARAMS));

  const same = pairedCompare({
    board, pointsById, roster: ROSTER, slot: 5,
    configA: params, configB: params, seeds: [1, 2, 3, 4, 5],
  });
  check("identical configs produce a zero difference, every seed",
        same.meanDiff === 0 && same.rows.every((r) => r.diff === 0),
        JSON.stringify(same.rows.map((r) => r.diff)));
  check("...and therefore zero spread", same.sdDiff === 0);

  // A config that refuses to draft a quarterback until round 14 should do
  // worse than one that may take the best available. Known sign, so it tests
  // that the comparison is wired the right way round.
  const lateQb = JSON.parse(JSON.stringify(params));
  lateQb.SLOT_DEFAULT = { ...params.SLOT_DEFAULT, QB_MIN: 14, QB2_MIN: 15 };
  lateQb.SLOTS = {};
  const normal = JSON.parse(JSON.stringify(params));
  normal.SLOTS = {};
  const cmp = pairedCompare({
    board, pointsById, roster: ROSTER, slot: 5,
    configA: normal, configB: lateQb, seeds: [1, 2, 3, 4, 5, 6, 7, 8],
  });
  check("a deliberately crippled config loses", cmp.meanDiff > 0,
        `meanDiff ${cmp.meanDiff}, A won ${cmp.aWins}/${cmp.n}`);
  check("the standard error is reported", Number.isFinite(cmp.seDiff));
}

// ── survival wiring (roadmap 3.1) ─────────────────────────────────────────
{
  // A board built to exercise the mechanism rather than to look realistic.
  // `makeBoard` makes vbd monotone in adp, which is the one shape where
  // survival can NEVER change a pick — the best available is also the most
  // certain to be gone, so the lookahead only confirms the plain-value order.
  //
  // Here the two best backs are a point apart in value and opposite in
  // urgency: RB1 is a player the room is 60 picks late on (certain to last to
  // our next pick, so taking him now wastes it) and RB2 goes immediately.
  // Everyone else is far enough back that no positional multiplier can lift
  // them over the backs — the WR premium tops out at x1.35, and 200 x 1.35 is
  // still below 300.
  const board = [
    { id: 1, pos: "RB", vbd: 300, adp: 60 },   // best, and will still be here
    { id: 2, pos: "RB", vbd: 299, adp: 2 },    // a point worse, gone immediately
    ...Array.from({ length: 120 }, (_, i) => ({
      id: i + 3,
      pos: ["WR", "QB", "TE", "RB"][i % 4],
      vbd: +(200 - i * 1.4).toFixed(1),
      adp: i + 3,
    })),
  ].map((p) => ({
    name: `P${p.id}`, team: "XX", age: 26, risk: 0.1, trend: 0,
    valuePoints: p.vbd + 20, ...p,
  }));
  const roster = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, BENCH: 8 };
  // Slot 1, so our agent is on the clock first and both backs are genuinely
  // available to it. At slot 5 the ADP bots take RB2 before our turn and the
  // comparison silently becomes a different question.
  const run = (agent) => simulateDraft({
    board, teams: 10, rounds: 15, roster, seed: 7,
    agents: { 0: { slot: 1, ...agent } },
  }).rosters[0].map((p) => p.id).join(",");

  const first = (agent) => Number(run(agent).split(",")[0]);
  check("plain value takes the best back", first({}) === 1);
  check("survival takes the back who will not last instead",
        first({ survival: true }) === 2,
        `took ${first({ survival: true })}`);

  // Same agent, same seed, twice — the mechanism must be deterministic or a
  // paired comparison measures noise instead of the change.
  check("the survival agent is deterministic",
        run({ survival: true }) === run({ survival: true }));

  // roadmap 3.1 was SIMPLIFIED from a modeled probability (sigma parameter,
  // swept in survival-test.mjs) to a deterministic margin — see survival.js's
  // header for why: the sigma sweep itself found the gate's verdict
  // insensitive to cv, which was evidence the modeling wasn't earning its
  // complexity. No sigma exists to test here any more.

  // Bot faithfulness is still a live concern for the simplified margin too —
  // it reads adpRankById, which the bots' own draft order produces.
  const atTemp = (t) => simulateDraft({
    board, teams: 10, rounds: 15, roster, seed: 7, temperature: t,
    agents: { 4: { slot: 5, survival: true } },
  }).rosters[3].map((p) => p.id).join(",");
  check("bot temperature changes opponent behaviour", atTemp(1) !== atTemp(20));
}

// ── positional run wiring (roadmap 3.2) ───────────────────────────────────
// Slot 10 (last pick of round 1): 9 bot picks happen first. The top 60 ranks
// are ALL running backs, so bots — who only ever draw from the top-25-by-
// rank of what's left — are structurally unable to pick anything else for
// all 9 of those picks (60 - 8 already-taken >= 25 at every one of the 9
// decisions, so the pool can never be diluted by a non-RB). This is a
// guarantee from the board's construction, not a probabilistic hope, so the
// test can assert on it directly rather than trusting a seed.
//
// The alternative candidate has to be a WR: TE and QB are both hard-gated in
// round 1 (teMinRound/QB_MIN), so WR is the only other legal first pick. That
// collides with step 5's WR era premium (a rank-based multiplier for WRs in
// rounds 1-3) unless the WR's rank is pushed past 72, where every premium
// tier stops applying — hence 60 RB fillers rather than a smaller number:
// enough other low-priority filler players exist below the focal WR that its
// rank clears 72 and the premium never enters the comparison at all.
{
  // vbd deliberately LOW and uniform for every filler — bots pick by RANK
  // only (adp), never by vbd, so this has no effect on which 9 they take.
  // But OUR agent scores by vbd, and every filler being available at once
  // means all the survivors compete for our pick too — they must not
  // outscore the two focal candidates just by having been given a bigger
  // number for no reason.
  const rbFillers = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1, name: `RB${i + 1}`, pos: "RB", team: "XX",
    age: 26, risk: 0.1, trend: 0, vbd: 50, valuePoints: 70, adp: i + 1,
  }));
  const RB_FOCAL_ID = 22;   // adp 22 -> rank 22
  rbFillers[RB_FOCAL_ID - 1].vbd = 100;   // the value that makes the math work out below

  const otherFillers = [
    ...Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i, name: `WRf${i}`, pos: "WR", team: "XX",
      age: 26, risk: 0.1, trend: 0, vbd: 50, valuePoints: 70, adp: 61 + i,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      id: 120 + i, name: `QBf${i}`, pos: "QB", team: "XX",
      age: 26, risk: 0.1, trend: 0, vbd: 50, valuePoints: 70, adp: 71 + i,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      id: 130 + i, name: `TEf${i}`, pos: "TE", team: "XX",
      age: 26, risk: 0.1, trend: 0, vbd: 50, valuePoints: 70, adp: 76 + i,
    })),
  ];
  const WR_FOCAL_ID = 999;
  // adp far out; what matters is its RANK clears 72 (see header note above),
  // which the 80 lower-adp fillers above guarantee regardless of this value.
  const wrFocal = {
    id: WR_FOCAL_ID, name: "WRfocal", pos: "WR", team: "XX",
    age: 26, risk: 0.1, trend: 0, vbd: 102, valuePoints: 120, adp: 200,
  };

  const runBoard = [...rbFillers, ...otherFillers, wrFocal];
  const runRoster = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, BENCH: 10 };

  const runOne = (positionalRun) => simulateDraft({
    board: runBoard, teams: 10, rounds: 2, roster: runRoster, seed: 3, temperature: 1,
    agents: { 9: { slot: 10, survival: true, positionalRun } },
  });

  const withoutRun = runOne(false);
  const withRun = runOne(true);

  // Confirm the setup: all 9 pre-picks really were RBs, in both runs (the
  // board guarantees this; verifying it is what makes the rest of this test
  // trustworthy rather than assumed).
  for (const [label, result] of [["without", withoutRun], ["with", withRun]]) {
    const prePicks = result.rosters.slice(0, 9).map((r) => r[0]?.pos);
    check(`setup check (${label} positionalRun): all 9 pre-picks are RB`,
          prePicks.every((p) => p === "RB"), prePicks.join(","));
  }

  // The actual claim: identical board, identical bot behaviour up to this
  // point (same seed/temperature) — the ONLY difference is whether our
  // agent's own scoring sees the run it just watched happen. Without it,
  // margin (22-11)/10=1.1 rounds reads as comfortably safe and the slightly
  // more valuable WR wins (102 x 1.30 = 133.6 > 100 x 1.30 = 130). With it,
  // the real 9-of-9 RB run (hot=1.0) shrinks that margin to 0.77 rounds,
  // crossing into urgency (130 x 1.0345 = 134.485), and the RB flips ahead.
  const myPickWithout = withoutRun.rosters[9][0];
  const myPickWith = withRun.rosters[9][0];
  check("without run-awareness, the slightly-better-value WR is taken",
        myPickWithout?.id === WR_FOCAL_ID, `took id ${myPickWithout?.id}`);
  check("with run-awareness, the live RB run flips the pick to the RB",
        myPickWith?.id === RB_FOCAL_ID, `took id ${myPickWith?.id}`);
}

// ── realizedWeeklyPoints: opt-in injury oracle ─────────────────────────────
// Raised directly: the shipped scorer only ever benches a player for a BYE,
// so a bench player can never be "needed" for anything a bye doesn't already
// cover — which makes any bench-depth comparison close to a foregone null by
// construction, independent of whether the real-world effect exists. This
// pins the fix: an opt-in, deterministic (id, week) -> out? oracle.
{
  const roster = { QB: 1, RB: 0, WR: 0, TE: 0, FLEX: 0, K: 0, DST: 0, BENCH: 1 };
  const starter = { id: "QB-starter", pos: "QB", team: "AAA" };
  const backup = { id: "QB-backup", pos: "QB", team: "AAA" };
  const projById = { "QB-starter": 340, "QB-backup": 170 }; // starter projects way ahead
  const weekly = {
    "QB-starter": Object.fromEntries(Array.from({ length: 17 }, (_, i) => [i + 1, 20])),
    "QB-backup": Object.fromEntries(Array.from({ length: 17 }, (_, i) => [i + 1, 10])),
  };

  // Absent oracle: byte-identical to calling with no 7th argument at all —
  // every pre-existing call site never passes one, so this is the exact
  // regression check that matters.
  const withoutArg = realizedWeeklyPoints([starter, backup], projById, weekly, {}, roster, 17);
  const withNullOracle = realizedWeeklyPoints([starter, backup], projById, weekly, {}, roster, 17, null);
  check("no 7th argument matches an explicit null oracle",
        withoutArg === withNullOracle, `${withoutArg} vs ${withNullOracle}`);
  // Starter always wins on projection alone (340 > 170), so absent any
  // unavailability model the backup never plays a single week.
  check("without an oracle, the higher-projected starter plays every week",
        withoutArg === 20 * 17, String(withoutArg));

  // A rate-0 oracle for every position must be a complete no-op.
  const zeroOracle = makeInjuryOracle(1, { QB: 0 }, 17);
  const withZeroRate = realizedWeeklyPoints([starter, backup], projById, weekly, {}, roster, 17, zeroOracle);
  check("a 0% miss-rate oracle changes nothing",
        withZeroRate === withoutArg, `${withZeroRate} vs ${withoutArg}`);

  // A hand-rolled oracle marking ONLY the starter out, every week, proves
  // realizedWeeklyPoints actually CONSUMES the oracle to bench a specific
  // player and start whoever's left — the backup must be the one who plays,
  // scoring accordingly. (A rate-based oracle can't isolate one player this
  // way since makeInjuryOracle's rate is keyed by POSITION, not identity —
  // a QB:1 rate would correctly bench BOTH QBs, not just the starter, which
  // is exactly the realistic behavior the next check exercises.)
  const starterOnlyOutOracle = (id) => id === "QB-starter";
  const withStarterOut = realizedWeeklyPoints([starter, backup], projById, weekly, {}, roster, 17, starterOnlyOutOracle);
  check("an oracle marking only the starter out benches him every week — the backup scores instead",
        withStarterOut === 10 * 17, String(withStarterOut));

  // The whole reason this exists: a real per-position rate, applied
  // independently to EVERY player at that position (starter included), must
  // over many weeks let the backup start SOME weeks without the harness
  // forcing an all-or-nothing outcome — neither the old bye-only behavior
  // (backup never plays) nor a pathological rate (backup always plays).
  // Seed fixed to one (of many checked) where the starter is actually
  // marked out at least once and the backup covers that week — the case
  // this whole mechanism exists to enable.
  const realisticOracle = makeInjuryOracle(2, INJURY_MISS_RATE, 17);
  const withRealistic = realizedWeeklyPoints([starter, backup], projById, weekly, {}, roster, 17, realisticOracle);
  check("a realistic miss-rate leaves the total strictly between all-starter and all-backup",
        withRealistic < withoutArg && withRealistic > withStarterOut,
        `${withRealistic} (all-starter ${withoutArg}, all-backup ${withStarterOut})`);

  // The pairing property makeInjuryOracle exists for: the SAME player id
  // draws the SAME weekly pattern under the SAME seed no matter which
  // roster (arm) he is evaluated on — required for a valid paired
  // comparison (this file's whole common-random-numbers design).
  const oracleA = makeInjuryOracle(7, INJURY_MISS_RATE, 17);
  const oracleB = makeInjuryOracle(7, INJURY_MISS_RATE, 17);
  const pattern = (oracle) => Array.from({ length: 17 }, (_, i) => oracle("QB-starter", "QB", i + 1));
  check("the same seed reproduces the identical weekly pattern for a given player id",
        JSON.stringify(pattern(oracleA)) === JSON.stringify(pattern(oracleB)));
  const oracleDiffSeed = makeInjuryOracle(8, INJURY_MISS_RATE, 17);
  check("a different seed can (and did, for this fixture) produce a different pattern",
        JSON.stringify(pattern(oracleA)) !== JSON.stringify(pattern(oracleDiffSeed)));
}

console.log();
if (fails.length) {
  console.error(`draft-sim.selftest: ${pass} passed, ${fails.length} FAILED — ${fails.join(", ")}`);
  process.exit(1);
}
console.log(`draft-sim.selftest: ${pass} passed, 0 failed`);

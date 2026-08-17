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

console.log();
if (fails.length) {
  console.error(`draft-sim.selftest: ${pass} passed, ${fails.length} FAILED — ${fails.join(", ")}`);
  process.exit(1);
}
console.log(`draft-sim.selftest: ${pass} passed, 0 failed`);

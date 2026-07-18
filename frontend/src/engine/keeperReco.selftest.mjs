/* Node fixture tests for keeperReco.js — `node keeperReco.selftest.mjs`. */
import { snakePicks } from "./valuation-engine.js";
import {
  marketOrder, expectedAtPick, wheelFactor, scarcityBonus,
  snakeCandidateValue, auctionCandidateValue, recommendKeepers,
} from "./keeperReco.js";

let pass = 0, fail = 0;
const eq = (g, w, m) => (JSON.stringify(g) === JSON.stringify(w)
  ? pass++ : (fail++, console.error(`✗ ${m}\n    got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)));
const ok = (c, m) => (c ? pass++ : (fail++, console.error(`✗ ${m}`)));

// Synthetic board: 60 players, VBD strictly decreasing, ADP == rank, so the
// market draft order equals the VBD order and expectedAtPick(P) is the rank-P vbd.
const POS = ["RB", "WR", "QB", "TE"];
const board = Array.from({ length: 60 }, (_, i) => {
  const rank = i + 1;
  return {
    id: rank, name: `P${rank}`, pos: POS[i % 4],
    vbd: 120 - 2 * rank, valuePoints: 200 - rank,
    adp: rank, ecr: rank,
    parValue: Math.max(1, 70 - rank), adjValue: Math.max(1, 70 - rank),
  };
});
const mkt = marketOrder(board);

// ── market order + expected-at-pick ─────────────────────────────────
eq(mkt[0].marketIdx, 1, "marketOrder is 1-based");
eq(expectedAtPick(mkt, 25, new Set()).id, 25, "best available at pick 25 is rank 25");
eq(expectedAtPick(mkt, 36, new Set()).vbd, 120 - 2 * 36, "expected vbd at pick 36");

// ── DRAFT POSITION: same keeper + round, different slot => different cost ──
// Keeper = rank-2 stud (vbd 116), kept at round 3.
const stud = board[1];
const cand = { id: stud.id, player: stud, cost: { basis: "round", price: null, round: 3 } };
const teams = 12;
const picksSlot1 = snakePicks(1, teams, 30);   // round3 -> pick 25
const picksSlot12 = snakePicks(12, teams, 30); // round3 -> pick 36
eq(picksSlot1[2], 25, "slot 1 round 3 -> overall pick 25");
eq(picksSlot12[2], 36, "slot 12 round 3 -> overall pick 36");

const s1 = snakeCandidateValue(cand, board, mkt, new Set(), picksSlot1, 3, 1);
const s12 = snakeCandidateValue(cand, board, mkt, new Set(), picksSlot12, 3, 1);
eq(s1.forfeitPick, 25, "slot1 forfeits pick 25");
eq(s12.forfeitPick, 36, "slot12 forfeits pick 36");
eq(s1.surplus, +(116 - (120 - 2 * 25)).toFixed(1), "slot1 surplus vs rank-25");
eq(s12.surplus, +(116 - (120 - 2 * 36)).toFixed(1), "slot12 surplus vs rank-36");
ok(s12.surplus > s1.surplus, "later slot forfeits a worse pick => bigger keeper surplus");

// ── wheel factor: ends amplify, center neutral ──────────────────────
ok(wheelFactor(1, 12) > wheelFactor(6, 12), "slot 1 more wheel-heavy than slot 6");
eq(wheelFactor(6, 12) <= 1.05, true, "center slot ~ neutral");

// ── scarcity: VBD cliff to next available at position ───────────────
const cliffBoard = [
  { id: 1, pos: "TE", vbd: 90 }, { id: 2, pos: "TE", vbd: 30 }, { id: 3, pos: "TE", vbd: 25 },
];
eq(scarcityBonus(cliffBoard[0], cliffBoard, new Set(), 1), 60, "elite TE cliff = 90-30");

// ── auction surplus ─────────────────────────────────────────────────
const aCand = { id: 5, player: board[4], cost: { basis: "price", price: 20, round: null } };
const av = auctionCandidateValue(aCand, board, new Set(), 1);
eq(av.surplus, +((70 - 5) - 20).toFixed(1), "auction surplus = adjValue - price");

// ── SET OPTIMIZER: recommend fewer than max when marginal is weak ───
// A: rank-2 stud kept cheap (round 8 => forfeits a weak pick, huge surplus)
// B: rank-6 kept at round 6 (solid surplus)
// C: rank-10 kept at ROUND 1 (its forfeited early pick is better than the
//    player himself -> negative surplus -> KV below the flexibility floor).
const cands = [
  { id: board[1].id, player: board[1], cost: { basis: "round", price: null, round: 8 } },
  { id: board[5].id, player: board[5], cost: { basis: "round", price: null, round: 6 } },
  { id: board[9].id, player: board[9], cost: { basis: "round", price: null, round: 1 } },
];
const rec = recommendKeepers(cands, {
  format: "snake", board, marketBoard: mkt,
  settings: { teams, draftSlot: 6, roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 } },
  allKeptIds: new Set(), maxKeepers: 3, flexFloor: 3,
});
ok(rec.best.ids.includes(board[1].id), "keeps the cheap stud");
ok(rec.best.ids.length < 3, "recommends fewer than the max of 3");
ok(!rec.best.ids.includes(board[9].id), "drops the marginal keeper (KV below floor)");
ok(rec.ranked[0].kv >= rec.ranked[rec.ranked.length - 1].kv, "ranked by KV desc");

// none-worth-keeping => empty recommendation
// A rank-40 scrub kept at round 1: you'd get a far better player at that pick.
const weak = [{ id: board[39].id, player: board[39], cost: { basis: "round", price: null, round: 1 } }];
const recNone = recommendKeepers(weak, {
  format: "snake", board, marketBoard: mkt,
  settings: { teams, draftSlot: 6, roster: { RB: 2, WR: 2 } },
  allKeptIds: new Set(), maxKeepers: 1, flexFloor: 3,
});
eq(recNone.best.ids.length, 0, "keeping nobody when no candidate clears the floor");

console.log(`\nkeeperReco.selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

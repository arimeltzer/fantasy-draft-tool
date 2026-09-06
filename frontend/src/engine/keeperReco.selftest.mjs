/* Node fixture tests for keeperReco.js — `node keeperReco.selftest.mjs`. */
import { snakePicks } from "./valuation-engine.js";
import {
  marketOrder, expectedAtPick, wheelFactor, scarcityBonus,
  snakeCandidateValue, auctionCandidateValue, recommendKeepers,
  predictOpponentKeepers, pickForRound, positionalFallback,
} from "./keeperReco.js";
import { myPickNumbers, INSURANCE_MULT } from "./snake-engine.js";

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

// ── AUCTION: scarcity (VBD points) must NOT override a bad price ─────
// A scarce player (huge VBD cliff) but priced ABOVE market -> negative $
// surplus -> must be HOLD, not keep. (Regression: scarcity in points was
// being added to a dollar surplus and swamping it.)
const scarceTE = { id: 900, name: "Scarce TE", pos: "TE", vbd: 130, valuePoints: 260, adp: 3, ecr: 3, parValue: 78, adjValue: 78 };
const auctionBoard = [scarceTE, ...board.map((p) => ({ ...p, pos: "RB" }))]; // make TE scarce (only one)
const auctionMkt = marketOrder(auctionBoard);
const overPriced = { id: 900, player: scarceTE, cost: { basis: "price", price: 81, round: null } };
const aRec = recommendKeepers([overPriced], {
  format: "auction", board: auctionBoard, marketBoard: auctionMkt,
  settings: { teams: 12, budget: 200, roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, BENCH: 6 } },
  allKeptIds: new Set(), maxKeepers: 3, flexFloor: 3,
});
eq(aRec.ranked[0].kv <= 0, true, "auction KV excludes points-scarcity ($78 mkt - $81 cost => ~-$3)");
eq(aRec.best.ids.length, 0, "overpriced scarce player is NOT recommended");

// A well-priced version of the same scarce player IS recommended.
const wellPriced = { id: 900, player: scarceTE, cost: { basis: "price", price: 40, round: null } };
const aRec2 = recommendKeepers([wellPriced], {
  format: "auction", board: auctionBoard, marketBoard: auctionMkt,
  settings: { teams: 12, budget: 200, roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, BENCH: 6 } },
  allKeptIds: new Set(), maxKeepers: 3, flexFloor: 3,
});
ok(aRec2.best.ids.includes(900), "same player at $40 (>$38 surplus) IS recommended");

// ── PREDICT OPPONENT KEEPERS: studs kept, scrubs not, respects max ──
// Team 2 rosters a rank-2 stud kept at round 10 (huge surplus) + a rank-50
// scrub kept at round 1 (negative). Team 3 has a rank-4 stud at round 9.
const predCands = [
  { player_id: board[1].id, is_mine: false, owner: "Team 2", bid: null, round: 10 },
  { player_id: board[49].id, is_mine: false, owner: "Team 2", bid: null, round: 1 },
  { player_id: board[3].id, is_mine: false, owner: "Team 3", bid: null, round: 9 },
  { player_id: board[0].id, is_mine: true, owner: "Me", bid: null, round: 12 }, // ignored (mine)
];
const pred = predictOpponentKeepers(predCands, {
  format: "snake", board, marketBoard: mkt,
  settings: { teams: 12 }, rule: { maxKeepers: 1, basis: "round" }, floor: 0,
});
ok(pred.keptIds.has(board[1].id), "predicts Team 2 keeps its stud");
ok(!pred.keptIds.has(board[49].id), "does not predict the scrub as kept");
ok(pred.keptIds.has(board[3].id), "predicts Team 3 keeps its stud");
ok(!pred.keptIds.has(board[0].id), "ignores my own players");
eq(pred.byTeam["Team 2"].length, 1, "max 1 keeper per team respected");

// If you've already confirmed a keeper for Team 2 (max 1), predict 0 more for
// them — and never re-predict a player you've committed.
const pred2 = predictOpponentKeepers(predCands, {
  format: "snake", board, marketBoard: mkt,
  settings: { teams: 12 }, rule: { maxKeepers: 1, basis: "round" }, floor: 0,
  committedIds: new Set([board[1].id]), committedByOwner: { "Team 2": 1 },
});
eq(pred2.byTeam["Team 2"].length, 0, "no extra prediction once a team's slot is filled");
ok(!pred2.keptIds.has(board[49].id), "does not fill a filled team with its next-best");
ok(pred2.keptIds.has(board[3].id), "still predicts for a team with open slots (Team 3)");

// ── TRADED PICKS: myPicks overrides serpentine end to end ───────────
// Serpentine default is untouched when no override is present.
eq(myPickNumbers({ teams: 12, draftSlot: 1 }, 3), [1, 24, 25], "no override => serpentine");
eq(myPickNumbers({ teams: 12, draftSlot: 1, myPicks: [] }, 3), [1, 24, 25], "empty override ignored");
// An explicit list wins, is de-duped and sorted.
eq(myPickNumbers({ teams: 12, draftSlot: 1, myPicks: [25, 1, 25, 40] }), [1, 25, 40], "override sorted+deduped");

// pickForRound looks the round up rather than indexing positionally.
eq(pickForRound([1, 24, 25, 48], 1, 12), 1, "round 1 -> pick 1");
eq(pickForRound([1, 24, 25, 48], 2, 12), 24, "round 2 -> pick 24");
// Two picks in one round (acquired): the earlier/more valuable one is the cost.
eq(pickForRound([1, 20, 24, 25], 2, 12), 20, "two picks in a round -> the earlier one");
// No pick in that round (traded away): you forfeit the next one you own.
eq(pickForRound([1, 48], 2, 12), 48, "traded-away round -> next owned pick");

// Trading away an early pick must change the keeper math: with the round-3
// pick gone, a round-3 keeper costs a much later pick, so surplus rises.
const tradeBoard = board, tradeMkt = mkt;
const tCand = { id: board[1].id, player: board[1], cost: { basis: "round", price: null, round: 3 } };
const normalPicks = myPickNumbers({ teams: 12, draftSlot: 1 }, 30);
const tradedPicks = normalPicks.filter((p) => Math.ceil(p / 12) !== 3); // R3 dealt away
const vNormal = snakeCandidateValue(tCand, tradeBoard, tradeMkt, new Set(), normalPicks, 3, 1, 12);
const vTraded = snakeCandidateValue(tCand, tradeBoard, tradeMkt, new Set(), tradedPicks, 3, 1, 12);
ok(vTraded.forfeitPick > vNormal.forfeitPick, "trading the R3 pick pushes the forfeited pick later");
ok(vTraded.surplus > vNormal.surplus, "a later forfeited pick means the keeper is worth more");

// recommendKeepers honours settings.myPicks (same override, full pipeline).
const recNormal = recommendKeepers([tCand], {
  format: "snake", board: tradeBoard, marketBoard: tradeMkt,
  settings: { teams: 12, draftSlot: 1, roster: { RB: 2, WR: 2 } },
  allKeptIds: new Set(), maxKeepers: 1, flexFloor: 0,
});
const recTraded = recommendKeepers([tCand], {
  format: "snake", board: tradeBoard, marketBoard: tradeMkt,
  settings: { teams: 12, draftSlot: 1, roster: { RB: 2, WR: 2 }, myPicks: tradedPicks },
  allKeptIds: new Set(), maxKeepers: 1, flexFloor: 0,
});
ok(recTraded.ranked[0].forfeitPick > recNormal.ranked[0].forfeitPick,
   "recommendKeepers uses settings.myPicks for the forfeited pick");

// ── PER-TEAM PICKS drive opponent predictions ───────────────────────
// Same player, same keeper round, two teams at opposite ends of the draft.
// The team picking LAST in that round forfeits a worse pick, so the keeper is
// worth more to them — an effect the old mid-round guess couldn't see.
const oppCands = [
  { player_id: board[3].id, is_mine: false, owner: "Early", bid: null, round: 5 },
  { player_id: board[3].id, is_mine: false, owner: "Late", bid: null, round: 5 },
];
const predSlots = predictOpponentKeepers(
  [oppCands[0]],
  { format: "snake", board, marketBoard: mkt,
    settings: { teams: 12, teamSlots: { Early: 1 } },
    rule: { maxKeepers: 1, basis: "round" }, floor: -999 },
);
const predSlotsLate = predictOpponentKeepers(
  [{ ...oppCands[1] }],
  { format: "snake", board, marketBoard: mkt,
    settings: { teams: 12, teamSlots: { Late: 12 } },
    rule: { maxKeepers: 1, basis: "round" }, floor: -999 },
);
ok(predSlotsLate.byTeam["Late"][0].surplus > predSlots.byTeam["Early"][0].surplus,
   "a late-drafting team values the same round-5 keeper more than an early one");

// An explicit per-team traded-pick list beats the slot-derived default.
const predTraded = predictOpponentKeepers(
  [{ player_id: board[3].id, is_mine: false, owner: "Early", bid: null, round: 5 }],
  { format: "snake", board, marketBoard: mkt,
    settings: { teams: 12, teamSlots: { Early: 1 },
                // traded away everything early; their next pick is deep
                teamPicks: { Early: [110, 120] } },
    rule: { maxKeepers: 1, basis: "round" }, floor: -999 },
);
ok(predTraded.byTeam["Early"][0].surplus > predSlots.byTeam["Early"][0].surplus,
   "teamPicks override beats teamSlots and raises surplus when picks were traded away");

// Unknown team => mid-round fallback, still produces a prediction (no crash).
const predUnknown = predictOpponentKeepers(
  [{ player_id: board[3].id, is_mine: false, owner: "Mystery", bid: null, round: 5 }],
  { format: "snake", board, marketBoard: mkt,
    settings: { teams: 12 }, rule: { maxKeepers: 1, basis: "round" }, floor: -999 },
);
eq(predUnknown.byTeam["Mystery"].length, 1, "unknown team still predicted via mid-round fallback");

// ── recommendKeepers stays fast on a REALISTIC candidate count ──────
// Reported live: the snake keeper page went unresponsive after a real Yahoo
// pull, dropdown included, and took a long time to produce recommendations.
// Root cause: recommendKeepers used to walk the FULL power set of your own
// candidates (2^n) and discard anything over maxKeepers afterward -- fine
// for a short bench list, but a real keeper-eligible roster (bench/IR
// included) can comfortably clear 24-28 players, and 2^n at that size is
// 16.7M-268M masks. Measured before the fix: n=24 -> 2.0s, n=26 -> 7.9s,
// n=28 -> 32.0s of blocked main-thread time (doubling every ~2 candidates,
// exactly like 2^n) -- enough to freeze the whole page, an unrelated
// dropdown included, since this runs synchronously inside a render.
// maxKeepers is always small in real leagues, so walking only combinations
// of size 0..maxKeepers (identical output -- those were the only subsets
// ever KEPT, just not the only ones generated) turns that into
// sum(C(n,0..maxKeepers)), a few thousand at this size instead of hundreds
// of millions. This pins a generous wall-clock ceiling so the exponential
// version can never silently come back.
{
  const bigBoard = Array.from({ length: 60 }, (_, i) => ({
    id: i, pos: POS[i % 4], vbd: 120 - i, parValue: Math.max(1, 60 - i), adjValue: Math.max(1, 60 - i),
  }));
  const bigCandidates = Array.from({ length: 30 }, (_, i) => ({
    id: i, player: bigBoard[i], cost: { round: (i % 15) + 1, price: (i % 40) + 1 },
  }));
  const t0 = performance.now();
  recommendKeepers(bigCandidates, {
    format: "snake", board: bigBoard, marketBoard: marketOrder(bigBoard),
    settings: { teams: 10, draftSlot: 3, roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 } },
    allKeptIds: new Set(), maxKeepers: 3, flexFloor: 3,
  });
  const ms = performance.now() - t0;
  ok(ms < 2000, `recommendKeepers stays fast (${ms.toFixed(0)}ms) at a realistic 30-candidate roster`);
}

// ── roadmap 3.12: opportunity-cost-aware QB/TE keeper valuation ─────────
// Proposed directly, after roadmap 3.11/3.11b both tried and failed to fix
// this at DRAFT TIME (scaling the live pick-scoring discount): "maybe the
// solution is to update the keeper recommendation process to consider the
// opportunity costs in light of the gates we've established." A redundant
// QB/TE keeper (insurance, not depth, once you already have a starter's
// worth among your OTHER chosen keepers) has his VBD discounted by the
// SAME shipped `INSURANCE_MULT` pickScore's own needMult already applies
// to a live QB2/TE2 pick — reused, not a new number.
{
  const roster1QB = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 };
  const qbA = board[2];   // QB, rank3, vbd 114
  const qbCandA = { id: qbA.id, player: qbA, cost: { basis: "round", price: null, round: 5 } };

  // A LONE QB keeper (rank 0 among this subset's same-position keepers,
  // i.e. the presumptive starter) keeps his full VBD — no discount.
  const vSolo = snakeCandidateValue(qbCandA, board, mkt, new Set(), picksSlot1, 5, 1, teams, 0, roster1QB, false);
  eq(vSolo.insuranceDiscounted, false, "a lone QB keeper is not insurance-discounted");
  eq(vSolo.keptValue, qbA.vbd, "a lone QB keeper's kept value equals his full VBD");

  // A SECOND QB keeper (rank 1 — one other, presumably-better QB keeper
  // already accounted for) is redundant with an existing starter and gets
  // discounted.
  const vSecond = snakeCandidateValue(qbCandA, board, mkt, new Set(), picksSlot1, 5, 1, teams, 1, roster1QB, false);
  eq(vSecond.insuranceDiscounted, true, "a 2nd QB keeper is insurance-discounted");
  eq(vSecond.keptValue, +(qbA.vbd * INSURANCE_MULT).toFixed(1), "discounted by the shipped INSURANCE_MULT, reused not reinvented");
  ok(vSecond.surplus < vSolo.surplus,
    "the same player values lower as a redundant 2nd QB keeper than as the lone starter");

  // Superflex: a 2nd QB is real depth, not insurance — never discounted,
  // mirroring pickScore's own needMult exactly.
  const vSuperflex = snakeCandidateValue(qbCandA, board, mkt, new Set(), picksSlot1, 5, 1, teams, 1, roster1QB, true);
  eq(vSuperflex.insuranceDiscounted, false, "superflex leagues never discount a 2nd QB keeper");

  // TE follows the identical rule as non-superflex QB.
  const teA = board[3];   // TE, rank4
  const teCandA = { id: teA.id, player: teA, cost: { basis: "round", price: null, round: 5 } };
  const vTeSecond = snakeCandidateValue(teCandA, board, mkt, new Set(), picksSlot1, 5, 1, teams, 1, roster1QB, false);
  eq(vTeSecond.insuranceDiscounted, true, "a 2nd TE keeper is insurance-discounted the same as QB");

  // RB/WR are never insurance-discounted, however many are already kept —
  // depth is real value there, not insurance (needMult's own distinction).
  const rbA = board[0];
  const rbCandA = { id: rbA.id, player: rbA, cost: { basis: "round", price: null, round: 5 } };
  const vRbStacked = snakeCandidateValue(rbCandA, board, mkt, new Set(), picksSlot1, 5, 1, teams, 3, roster1QB, false);
  eq(vRbStacked.insuranceDiscounted, false, "RB/WR are never insurance-discounted, however deep the stack");

  // Integration, via recommendKeepers: when keeping TWO QBs together, the
  // discount follows VBD rank (the higher-VBD one is treated as the real
  // starter), NOT round-processing order. qbLow is given the EARLIER
  // (round-processed-first) round specifically to prove this.
  const qbHigh = board[2];   // vbd 114
  const qbLow = board[6];    // vbd 106
  const twoQbCands = [
    { id: qbHigh.id, player: qbHigh, cost: { basis: "round", price: null, round: 9 } },
    { id: qbLow.id, player: qbLow, cost: { basis: "round", price: null, round: 4 } },
  ];
  const twoQbRec = recommendKeepers(twoQbCands, {
    format: "snake", board, marketBoard: mkt,
    settings: { teams, draftSlot: 1, roster: roster1QB },
    allKeptIds: new Set(), maxKeepers: 2, flexFloor: -1000,
  });
  const keptIds = new Set(twoQbRec.best.items.map((it) => it.cand.id));
  ok(keptIds.has(qbHigh.id) && keptIds.has(qbLow.id),
    "setup check: both QBs are worth keeping together in this fixture");
  const itemHigh = twoQbRec.best.items.find((it) => it.cand.id === qbHigh.id);
  const itemLow = twoQbRec.best.items.find((it) => it.cand.id === qbLow.id);
  eq(itemHigh.insuranceDiscounted, false, "the higher-VBD QB is treated as the starter (full value)");
  eq(itemLow.insuranceDiscounted, true, "the lower-VBD QB is the redundant one and gets discounted");

  // A SOLE keeper is never discounted regardless of processing mechanics —
  // recommendKeepers' own `ranked` view (each candidate scored alone).
  const soloRanked = twoQbRec.ranked.find((r) => r.cand.id === qbLow.id);
  eq(soloRanked.insuranceDiscounted, false,
    "evaluated alone (the 'ranked' solo view), the same QB is not discounted");
}

// ── roadmap 3.13: positional fallback ("will a comparable one still be
// there when I get to pick again?") — asked directly after 3.12 shipped:
// does keeping a QB foreclose drafting a stronger one live? Deliberately
// NOT QB/TE-scoped — the mechanics apply to any position; interpretation
// is left to the caller/UI.
{
  const qbKeeper = board[2];   // QB, rank3, vbd 114
  const forfeitRound = 3;
  const forfeitPick = pickForRound(picksSlot1, forfeitRound, teams);
  const fb = positionalFallback(qbKeeper, mkt, new Set(), picksSlot1, forfeitPick, teams);
  const expectedNextPick = picksSlot1.filter((p) => p > forfeitPick).sort((a, b) => a - b)[0];

  ok(fb !== null, "a fallback exists when a later pick + same-position player remain");
  eq(fb.pick, expectedNextPick,
    "checks the pick where I next actually act, not just 'next in market order'");
  eq(fb.round, Math.ceil(expectedNextPick / teams), "round derived from that real pick");
  eq(fb.player.pos, "QB", "fallback is scoped to the SAME position as the kept player");
  eq(fb.gap, +(qbKeeper.vbd - fb.player.vbd).toFixed(1), "gap = kept VBD - fallback VBD");

  // No later pick owned (this keeper's pick is your last) -> null, not a guess.
  eq(positionalFallback(qbKeeper, mkt, new Set(), [forfeitPick], forfeitPick, teams), null,
    "no later pick owned -> no fallback to report");

  // Nothing left at the position by the time you'd act again (every QB
  // already kept, league-wide) -> null.
  const allQbIds = new Set(board.filter((p) => p.pos === "QB").map((p) => p.id));
  eq(positionalFallback(qbKeeper, mkt, allQbIds, picksSlot1, forfeitPick, teams), null,
    "every same-position player already kept -> no fallback");

  // Works identically for a non-insurance-only position (RB) — this
  // function makes no QB/TE-specific judgment call at all.
  const rbKeeper = board[0];
  const fbRb = positionalFallback(rbKeeper, mkt, new Set(), picksSlot1, forfeitPick, teams);
  ok(fbRb !== null && fbRb.player.pos === "RB", "works the same way for RB (or any position)");

  // Wired into snakeCandidateValue's own return, display-only — never
  // touches surplus/kv, still computed exactly as before against the best
  // ANY-position player at the forfeited pick (not position-scoped).
  const qbCand = { id: qbKeeper.id, player: qbKeeper, cost: { basis: "round", price: null, round: forfeitRound } };
  const withFallback = snakeCandidateValue(qbCand, board, mkt, new Set(), picksSlot1, forfeitRound, 1, teams);
  ok(withFallback.positionalFallback !== null && withFallback.positionalFallback.player.pos === "QB",
    "snakeCandidateValue surfaces the fallback alongside surplus/kv");
  const anyBest = expectedAtPick(mkt, forfeitPick, new Set());
  eq(withFallback.surplus, +(qbKeeper.vbd - (anyBest ? anyBest.vbd : 0)).toFixed(1),
    "surplus is unaffected by the new field — still vs the best ANY-position player at the forfeited pick");
}

console.log(`\nkeeperReco.selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

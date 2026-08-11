/**
 * draft-order.js — node self-test.
 *
 *   node frontend/src/engine/draft-order.selftest.mjs
 *
 * The board is the authoring surface for traded picks, and `myPicks` /
 * `teamPicks` are derived from it, so the properties that matter are: the
 * untouched board is exactly serpentine (agrees with snakePicks, which the
 * pick clock and keeper costs already use), every pick has exactly one owner,
 * and a trade moves a pick without inventing or destroying one.
 */
import {
  MY_TEAM, teamLabels, roundsFor, slotByTeam, baseOwners, currentOwners,
  picksByTeam, pickLabel, derivePickSettings, orderWarnings,
  renameTeam, applyOpponentNames,
} from "./draft-order.js";
import { snakePicks } from "./snake-engine.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("  ✗", msg); } };
// Key insertion order is not part of the contract — compare objects by content.
const canon = (v) => JSON.stringify(v, (_, x) =>
  x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
    : x);
const eq = (a, b, msg) =>
  ok(canon(a) === canon(b), `${msg}\n     got ${canon(a)}\n     want ${canon(b)}`);

const L = (settings) => teamLabels(settings);

/* ── team labels ──────────────────────────────────────────────────── */
eq(L({ teams: 3, opponents: ["A", "B"] }), [MY_TEAM, "A", "B"], "labels: me first");
eq(L({ teams: 4, opponents: ["A"] }), [MY_TEAM, "A", "Team 3", "Team 4"], "labels: padded to teams");
eq(L({ teams: 2, opponents: ["A", "B", "C"] }), [MY_TEAM, "A"], "labels: truncated to teams");

/* ── rounds ───────────────────────────────────────────────────────── */
eq(roundsFor({ roster: { QB: 1, RB: 2, WR: 3, BENCH: 6 } }), 12, "rounds: one per roster spot");
eq(roundsFor({ roster: { QB: 1 }, rounds: 20 }), 20, "rounds: explicit override wins");
eq(roundsFor({}), 16, "rounds: fallback when no roster");

/* ── slot assignment ──────────────────────────────────────────────── */
const three = { teams: 3, opponents: ["A", "B"] };
eq(slotByTeam({ ...three, draftSlot: 2, teamSlots: { A: 1, B: 3 } }),
   { [MY_TEAM]: 2, A: 1, B: 3 }, "slots: taken as given");
eq(slotByTeam({ ...three, draftSlot: 1, teamSlots: { A: 1, B: 3 } }),
   { [MY_TEAM]: 1, A: 2, B: 3 }, "slots: your slot wins a conflict, loser gets the leftover");
eq(slotByTeam(three), { [MY_TEAM]: 1, A: 2, B: 3 }, "slots: nothing set -> league order");
eq(slotByTeam({ ...three, draftSlot: 9, teamSlots: { A: 0, B: 3 } }),
   { [MY_TEAM]: 1, A: 2, B: 3 }, "slots: out-of-range values ignored, not trusted");
// A bijection is the whole point: no two teams may share a slot.
const many = slotByTeam({ teams: 10, opponents: ["a","b","c","d","e","f","g","h","i"],
                          teamSlots: { a: 5, b: 5, c: 5 }, draftSlot: 5 });
eq(new Set(Object.values(many)).size, 10, "slots: always a bijection even with duplicates");

/* ── the untouched board IS serpentine ────────────────────────────── */
for (const teams of [8, 10, 12]) {
  const settings = {
    teams,
    opponents: Array.from({ length: teams - 1 }, (_, i) => `T${i + 2}`),
    draftSlot: 3,
    roster: { BENCH: 15 },
  };
  const rounds = roundsFor(settings);
  const owners = baseOwners(settings, rounds);
  eq(Object.keys(owners).length, teams * rounds, `board ${teams}: every pick owned`);
  const held = picksByTeam(owners);
  eq(held[MY_TEAM], snakePicks(3, teams, rounds), `board ${teams}: my picks match snakePicks()`);
  // and each opponent matches their own slot's serpentine run
  const slots = slotByTeam(settings);
  for (const [team, slot] of Object.entries(slots)) {
    if (team === MY_TEAM) continue;
    eq(held[team], snakePicks(slot, teams, rounds), `board ${teams}: ${team} matches slot ${slot}`);
  }
}

/* ── pick labels ──────────────────────────────────────────────────── */
eq(pickLabel(1, 10), "1.01", "label: first pick");
eq(pickLabel(10, 10), "1.10", "label: end of round 1");
eq(pickLabel(11, 10), "2.01", "label: round 2 starts at 11");
eq(pickLabel(31, 10), "4.01", "label: round 4");

/* ── trades ───────────────────────────────────────────────────────── */
const league = { teams: 3, opponents: ["A", "B"], draftSlot: 2, roster: { BENCH: 4 } };
const R = roundsFor(league);                          // 4 rounds, 12 picks
eq(R, 4, "fixture: 4 rounds");
eq(picksByTeam(baseOwners(league, R))[MY_TEAM], [2, 5, 8, 11], "fixture: my serpentine picks");

// You trade for A's round-1 pick (overall 1) and give up your round-3 (pick 8).
const traded = { ...league, pickOwners: { 1: MY_TEAM, 8: "A" } };
const owners = currentOwners(traded, R);
const held = picksByTeam(owners);
eq(held[MY_TEAM], [1, 2, 5, 11], "trade: two picks in round 1, none in round 3");
// A drafts slot 1, so base [1, 6, 7, 12]; loses pick 1 to you, gains your 8.
eq(held["A"], [6, 7, 8, 12], "trade: A loses pick 1 and gains pick 8");
eq(Object.keys(owners).length, 12, "trade: no pick invented or destroyed");
ok(Object.values(held).flat().length === 12, "trade: every pick still owned exactly once");

// An override naming a team that doesn't exist, or a pick past the end, is junk.
const junk = currentOwners({ ...league, pickOwners: { 1: "Ghost", 999: "A" } }, R);
eq(junk[1], picksByTeam(baseOwners(league, R))[undefined] ?? junk[1], "junk: unknown team ignored");
eq(junk[1], baseOwners(league, R)[1], "junk: unknown owner leaves the base owner in place");
eq(junk[999], undefined, "junk: out-of-range pick not added to the board");

/* ── derived settings (what the engines actually read) ────────────── */
const clean = derivePickSettings(league, baseOwners(league, R), R);
eq(clean, { pickOwners: undefined, myPicks: undefined, teamPicks: undefined },
   "derive: an untouched board clears the overrides entirely");

const derived = derivePickSettings(league, owners, R);
eq(derived.myPicks, [1, 2, 5, 11], "derive: myPicks comes from the board");
eq(derived.pickOwners, { 1: MY_TEAM, 8: "A" }, "derive: only the trades are stored");
ok(derived.teamPicks && !(MY_TEAM in derived.teamPicks), "derive: teamPicks holds opponents only");
eq(derived.teamPicks["A"], held["A"], "derive: A's teamPicks matches the board");
// Round-tripping the derived settings must reproduce the same board.
const roundTrip = currentOwners({ ...league, ...derived }, R);
eq(roundTrip, owners, "derive: settings round-trip back to the same board");

/* ── warnings ─────────────────────────────────────────────────────── */
eq(orderWarnings(league, baseOwners(league, R)), [], "warn: clean league is quiet");
// B drafts slot 3 -> base [3, 4, 9, 10]; buy every one of them.
const stripped = currentOwners({ ...league, pickOwners: { 3: MY_TEAM, 4: MY_TEAM, 9: MY_TEAM, 10: MY_TEAM } }, R);
ok(orderWarnings(league, stripped).some((w) => w.includes("no picks")), "warn: a team left with nothing");
ok(orderWarnings({ ...league, opponents: ["A", "B", "C"] }, baseOwners(league, R))
     .some((w) => w.includes("opponent names")), "warn: more opponents than teams");

/* ── renaming a team carries every reference ──────────────────────── */
const named = {
  teams: 3, opponents: ["A", "B"], draftSlot: 2, roster: { BENCH: 4 },
  teamSlots: { A: 1, B: 3 },
  teamPicks: { A: [1, 6], B: [3, 4] },
  pickOwners: { 1: MY_TEAM, 8: "A" },
  keeperImport: { season: 2025, fetchedAt: "x", candidates: [
    { name: "Player One", owner: "A" }, { name: "Player Two", owner: "B" },
  ] },
};
const renamed = renameTeam(named, "A", "Team Chaos");
eq(renamed.opponents, ["Team Chaos", "B"], "rename: opponents keeps its position (team_id)");
eq(renamed.teamSlots, { "Team Chaos": 1, B: 3 }, "rename: teamSlots re-keyed");
eq(renamed.teamPicks, { "Team Chaos": [1, 6], B: [3, 4] }, "rename: teamPicks re-keyed");
eq(renamed.pickOwners, { 1: MY_TEAM, 8: "Team Chaos" }, "rename: pickOwners values follow");
eq(renamed.keeperImport.candidates.map((c) => c.owner), ["Team Chaos", "B"],
   "rename: keeper import owners follow");
eq(named.opponents, ["A", "B"], "rename: original settings untouched (pure)");
// The renamed team must still own exactly the picks it owned before.
eq(picksByTeam(currentOwners(renamed, R))["Team Chaos"],
   picksByTeam(currentOwners(named, R))["A"], "rename: keeps the same picks");

// Rejections leave settings alone, so a caller can detect them by identity.
ok(renameTeam(named, "A", "B") === named, "rename: refuses to collide with another team");
ok(renameTeam(named, "A", "   ") === named, "rename: refuses an empty name");
ok(renameTeam(named, "A", "A") === named, "rename: no-op returns the same object");
ok(renameTeam(named, "Nobody", "X") === named, "rename: unknown team is a no-op");
ok(renameTeam(named, MY_TEAM, "X") === named, "rename: your own team is not an opponent");
// "Me" and MY_TEAM identify YOU in keeper picks and on the board; an opponent
// taking either would be indistinguishable from your own team.
ok(renameTeam(named, "A", "Me") === named, "rename: refuses the reserved name 'Me'");
ok(renameTeam(named, "A", MY_TEAM) === named, "rename: refuses the reserved board id");

/* ── bulk edit: position is identity ──────────────────────────────── */
const bulk = applyOpponentNames(named, ["A2", "B"]);
eq(bulk.renames, [{ from: "A", to: "A2" }], "bulk: one changed line is one rename");
eq(bulk.settings.teamSlots, { A2: 1, B: 3 }, "bulk: keyed data follows the rename");
eq(applyOpponentNames(named, ["A", "B"]).renames, [], "bulk: unchanged list renames nothing");
// Growing the list adds a team; it is not a rename of anything.
const grown = applyOpponentNames(named, ["A", "B", "C"]);
eq(grown.renames, [], "bulk: an appended team is not a rename");
eq(grown.settings.opponents, ["A", "B", "C"], "bulk: appended team kept");
eq(grown.settings.teamSlots, named.teamSlots, "bulk: appending leaves existing keys alone");
// Shrinking drops the tail without disturbing the survivors' keys.
const shrunk = applyOpponentNames(named, ["A"]);
eq(shrunk.settings.opponents, ["A"], "bulk: removed team dropped");
eq(shrunk.settings.teamSlots, named.teamSlots, "bulk: survivors keep their slots");

console.log(`\ndraft-order.selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

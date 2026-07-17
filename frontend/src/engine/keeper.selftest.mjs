/* Node-runnable fixture tests for keeper.js — `node keeper.selftest.mjs`.
 * Mirrors backend/integrations/selftest.py convention: pure, deterministic. */
import {
  KEEPER_PRESETS, defaultKeeperRule, normalizeKeeperRule,
  keeperCost, validateKeepers, ownerKeeperSpend,
} from "./keeper.js";

let pass = 0, fail = 0;
function eq(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`✗ ${msg}\n    got  ${g}\n    want ${w}`); }
}
function ok(cond, msg) { cond ? pass++ : (fail++, console.error(`✗ ${msg}`)); }

// ── ESPN price basis: last price + $7 surcharge ─────────────────────
const espn = KEEPER_PRESETS.espn;
eq(keeperCost({ base: 15, kept: 0 }, espn).price, 22, "ESPN $15 keeper -> $22");
eq(keeperCost({ base: 1, kept: 1 }, espn).price, 8, "ESPN $1 keeper -> $8");
eq(keeperCost({ base: null, fa: true }, espn).price, 7, "ESPN FA keeper -> surcharge $7");
eq(keeperCost({ base: 15 }, espn).round, null, "ESPN price basis has no round");

// ── Yahoo round basis: drafted round, R13 if a FA, no consecutive ───
const yahoo = KEEPER_PRESETS.yahoo;
eq(keeperCost({ base: 5, kept: 0 }, yahoo).round, 5, "Yahoo R5 keeper -> R5");
eq(keeperCost({ base: null, fa: true }, yahoo).round, 13, "Yahoo FA keeper -> R13");
ok(keeperCost({ base: 5, kept: 1 }, yahoo).advisory.length === 1,
   "Yahoo flags a player kept last year (noConsecutive)");
ok(keeperCost({ base: 5, kept: 0 }, yahoo).advisory.length === 0,
   "Yahoo: first-year keeper has no advisory");

// ── Round escalation (custom) ───────────────────────────────────────
const escal = { ...KEEPER_PRESETS.yahoo, roundInflation: 1, noConsecutive: false };
eq(keeperCost({ base: 8, kept: 2 }, escal).round, 6, "Escalation: R8 kept 2yrs -> R6");
eq(keeperCost({ base: 1, kept: 5 }, escal).round, 1, "Escalation floors at R1");

// ── maxKeepers validation, per owner ────────────────────────────────
const entries = [
  { owner: "Me", base: 10 }, { owner: "Me", base: 5 }, { owner: "Me", base: 3 },
  { owner: "Team 2", base: 20 },
];
ok(validateKeepers(entries, espn).ok, "ESPN allows 3 keepers for Me");
ok(!validateKeepers(entries, yahoo).ok, "Yahoo (max 1) rejects 3 keepers for Me");
eq(validateKeepers(entries, yahoo).errors.length, 1, "one owner over the Yahoo limit");

// ── owner spend + rule plumbing ─────────────────────────────────────
eq(ownerKeeperSpend(entries, espn, "Me"), (10 + 7) + (5 + 7) + (3 + 7), "Me ESPN spend");
eq(ownerKeeperSpend(entries, yahoo, "Me"), 0, "round basis => $0 spend");
eq(defaultKeeperRule("snake").preset, "yahoo", "snake default -> yahoo");
eq(defaultKeeperRule("auction").preset, "espn", "auction default -> espn");
ok(normalizeKeeperRule({ preset: "espn", maxKeepers: 2 }, "auction").maxKeepers === 2,
   "normalize keeps overrides on top of the preset");
ok(normalizeKeeperRule(undefined, "snake").basis === "round",
   "normalize(undefined) falls back to the format default");

console.log(`\nkeeper.selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

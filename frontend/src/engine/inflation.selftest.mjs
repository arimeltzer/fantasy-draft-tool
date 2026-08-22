#!/usr/bin/env node
/* Selftest: applyInflation — the live auction inflation multiplier.
 *
 * Exists because of a real report: "at the end of the draft when most people
 * are paying $1-2 for good players inflation is showing as through the roof.
 * Shouldn't it be the opposite?" Two separate defects were behind that, and
 * both are pinned here.
 */
import { auctionValues, applyInflation, INFLATION_CLAMP, INFLATION_MIN_COVERAGE }
  from "./auction-engine.js";

let pass = 0, fail = 0;
const check = (c, m) => { c ? pass++ : (fail++, console.error(`✗ ${m}`)); };

const AL = { teams: 10, budget: 200, rosterSize: 15 };
const board = auctionValues(
  Array.from({ length: 150 }, (_, i) => ({ id: i + 1, vbd: Math.max(0, 100 - i) })), AL);

/* ── DIRECTION. The badge used to state this backwards. ───────────────── */
{
  const top10 = board.slice(0, 10);
  const over = top10.map((p) => ({ id: p.id, price: Math.round(p.parValue * 2) }));
  const under = top10.map((p) => ({ id: p.id, price: 1 }));

  const fOver = applyInflation(board, over, AL).factor;
  const fUnder = applyInflation(board, under, AL).factor;

  // Overpaying drains money faster than it removes board value, so the ratio
  // FALLS. The UI once described a high factor as "teams are overpaying",
  // which is the opposite of what produces one.
  check(fOver < 1, `OVERpaying pushes the factor below 1 (got ${fOver})`);
  check(fUnder > 1, `UNDERpaying pushes the factor above 1 (got ${fUnder})`);
  check(fOver < fUnder, "and the two are ordered, not merely both off 1");

  // No picks at all: par values are calibrated to the room's money, so the
  // starting factor should sit at about 1.
  const f0 = applyInflation(board, [], AL).factor;
  check(Math.abs(f0 - 1) < 0.15, `an untouched draft starts near x1 (got ${f0})`);
}

/* ── THE BLOW-UP. A 12-team draft reached x1088 before this was bounded. ─ */
{
  const AL12 = { teams: 12, budget: 200, rosterSize: 16 };
  const b = [];
  for (let i = 0; i < 180; i++) {
    const par = i < 60 ? Math.max(1, Math.round(60 * Math.exp(-i / 22))) : 1;
    b.push({ id: i + 1, parValue: par, vbd: par });
  }
  const picks = [];
  for (let i = 0; i < 40; i++) picks.push({ id: b[i].id, price: b[i].parValue });
  for (let i = 40; i < 70; i++) picks.push({ id: b[i].id, price: 2 });   // good players, $2
  const late = applyInflation(b, picks, AL12);

  check(late.raw > 100, `the raw ratio really does explode (got ${late.raw})`);
  check(late.factor <= INFLATION_CLAMP.max, "but the APPLIED factor is bounded");
  check(late.factor >= INFLATION_CLAMP.min, "and bounded below too");
  check(late.clamped === true, "the clamp reports itself rather than hiding");
  check(late.reliable === false, "and the estimate is marked unreliable");
  check(late.coverage < INFLATION_MIN_COVERAGE, "because almost no priced value is left");

  // The consequence that actually matters: no player's $Live can run away.
  const worst = Math.max(...late.board.filter((p) => p.adjValue != null).map((p) => p.adjValue));
  const worstPar = Math.max(...b.map((p) => p.parValue));
  check(worst <= 1 + (worstPar - 1) * INFLATION_CLAMP.max,
        `no $Live exceeds par x clamp (worst ${worst})`);
  check(worst < 200, `and nothing is priced above a whole budget (worst ${worst})`);
}

/* ── The reliable path is untouched by the clamp. ─────────────────────── */
{
  const mild = applyInflation(board, board.slice(0, 5).map((p) => ({
    id: p.id, price: p.parValue,
  })), AL);
  check(mild.reliable === true, "early in a draft the estimate is reliable");
  check(mild.clamped === false, "and unclamped");
  check(mild.factor === mild.raw, "so factor and raw agree exactly");
}

/* ── Structure the callers depend on. ─────────────────────────────────── */
{
  const r = applyInflation(board, [], AL);
  check(r.board.length === board.length, "every player comes back");
  check(r.board.every((p) => p.adjValue >= 1), "no $Live below the minimum bid");
  const drafted = applyInflation(board, [{ id: board[0].id, price: 50 }], AL);
  const sold = drafted.board.find((p) => p.id === board[0].id);
  check(sold.paid === 50 && sold.adjValue === null, "a sold player carries paid, not adjValue");
}

console.log(`\ninflation.selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

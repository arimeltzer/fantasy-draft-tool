#!/usr/bin/env node
/**
 * Selftest — positional-run.js (roadmap 3.2)
 */
import { runHotness, RUN_POSITIONS, MIN_RUN_COUNT } from "./positional-run.js";

let pass = 0;
const fails = [];
function check(label, ok, detail = "") {
  if (ok) { pass++; return; }
  fails.push(label);
  console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
}

/* ---------------------------------------------------------------- basics */
check("MIN_RUN_COUNT is the roadmap's literal example (3)", MIN_RUN_COUNT === 3);
check("RUN_POSITIONS is the four skill positions, K/DST excluded",
      RUN_POSITIONS.length === 4 && !RUN_POSITIONS.includes("K") && !RUN_POSITIONS.includes("DST"));

/* --------------------------------------------------------- degenerate in */
{
  const out = runHotness([], 10);
  check("empty log gives all zeros", RUN_POSITIONS.every((p) => out[p] === 0));
}
check("null log doesn't throw", (() => {
  try { runHotness(null, 10); return true; } catch { return false; }
})());
check("zero teams doesn't throw and gives zeros",
      RUN_POSITIONS.every((p) => runHotness(["RB", "RB", "RB"], 0)[p] === 0));

/* ---------------------------------------------------- the worked example */
{
  // "three running backs in five picks" — window is `teams`, so use teams=5
  // to match the roadmap's own example exactly.
  const log = ["WR", "RB", "RB", "QB", "RB"];
  const out = runHotness(log, 5);
  check("3 RBs in a 5-pick window registers as hot", out.RB > 0);
  check("other positions are not flagged by an RB run", out.QB === 0 && out.WR === 0 && out.TE === 0);
}

/* ------------------------------------------------------------- threshold */
{
  // 2 RBs in 5 (below MIN_RUN_COUNT) must NOT register, even though
  // 2/5=0.4 > baseline 0.25 — count threshold gates before share does.
  const log = ["WR", "RB", "QB", "TE", "RB"];
  const out = runHotness(log, 5);
  check("below MIN_RUN_COUNT never registers regardless of share", out.RB === 0);
}
{
  // Exactly at baseline share (fair rotation) must not register even with
  // a high count, if the window is proportionally large enough.
  // teams=12, 3 of each of 4 positions = 12 picks, RB share = 3/12 = 0.25 = baseline exactly.
  const log = ["QB", "RB", "WR", "TE", "QB", "RB", "WR", "TE", "QB", "RB", "WR", "TE"];
  const out = runHotness(log, 12);
  check("exact fair share (no run at all) registers as zero for every position",
        RUN_POSITIONS.every((p) => out[p] === 0));
}

/* ---------------------------------------------------------------- window */
{
  // Only the last `teams` picks matter — an old run outside the window must
  // not still register.
  const oldRun = ["RB", "RB", "RB", "RB", "RB"];   // ancient history
  const recentCalm = ["QB", "RB", "WR", "TE", "QB"]; // fair rotation, window=5
  const log = [...oldRun, ...recentCalm];
  const out = runHotness(log, 5);
  check("a run outside the window does not register", out.RB === 0);
}

/* ------------------------------------------------------------- magnitude */
{
  // Hotter run (more concentrated) should read as more hot, monotonically.
  const mild = runHotness(["QB", "RB", "RB", "WR", "RB"], 5).RB;     // 3/5
  const hot = runHotness(["RB", "RB", "RB", "RB", "WR"], 5).RB;      // 4/5
  const hottest = runHotness(["RB", "RB", "RB", "RB", "RB"], 5).RB;  // 5/5
  check("more concentration reads as hotter (mild < hot)", mild < hot);
  check("more concentration reads as hotter (hot < hottest)", hot < hottest);
  check("hotness stays within [0,1]", hottest <= 1 && mild >= 0);
}

/* ------------------------------------------------------- multi-position */
{
  // Two positions can run at once (e.g. an RB run AND a QB run in a
  // superflex-flavored stretch) — hotness is computed independently
  // per position, not a single global "the room is running" flag.
  const log = ["RB", "QB", "RB", "QB", "RB"];   // 3 RB, 2 QB in window=5
  const out = runHotness(log, 5);
  check("RB run registers", out.RB > 0);
  check("QB below threshold does not register even alongside a real run", out.QB === 0);
}

/* -------------------------------------------------------------- shape in */
check("accepts a longer log than the window without erroring", (() => {
  const long = Array.from({ length: 200 }, (_, i) => RUN_POSITIONS[i % 4]);
  try { runHotness(long, 10); return true; } catch { return false; }
})());

console.log();
if (fails.length) {
  console.error(`positional-run.selftest: ${pass} passed, ${fails.length} FAILED — ${fails.join(", ")}`);
  process.exit(1);
}
console.log(`positional-run.selftest: ${pass} passed, 0 failed`);

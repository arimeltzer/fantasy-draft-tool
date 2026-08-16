/**
 * draft-rooms.selftest.mjs — the board actually renders players
 * =============================================================
 * A static source check, and deliberately a narrow one. It exists because of a
 * specific failure: during a performance refactor the SnakeRoom player list was
 * replaced with the literal token `ROW_MAP_PLACEHOLDER` and the old code was
 * deleted in the same commit. Bare text is valid JSX, so `tsc -b && vite build`
 * reported success, the bundle shipped, and the main draft board rendered no
 * players at all — during draft season.
 *
 * The lesson is not "add a lint rule". It is that this project has no frontend
 * test of any kind, so nothing distinguishes a component that renders its list
 * from one that renders the word PLACEHOLDER. Real render tests (vitest +
 * testing-library) would catch this and much more, and are worth adding. Until
 * then this covers the exact hole the bug went through, at zero dependency cost.
 *
 *   node frontend/src/components/draft-rooms.selftest.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];

function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) fails.push(label);
}

function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const tsx = walk(SRC).filter((f) => f.endsWith(".tsx"));

// ── 1. no placeholder tokens left in rendered markup ───────────────────────
// A JSX text node that is nothing but an ALL_CAPS_IDENTIFIER is never intended
// output — it is a token someone meant to substitute. Real UI copy has spaces,
// lowercase or punctuation; constants are referenced as {CONST}, not bare.
console.log("no placeholder tokens in JSX");
const placeholder = /^\s*[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\s*$/;
const offenders = [];
for (const f of tsx) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    if (placeholder.test(line)) offenders.push(`${f.slice(SRC.length + 1)}:${i + 1} ${line.trim()}`);
  });
}
check("no bare ALL_CAPS token sits in markup", offenders.length === 0, offenders.join(", "));

// ── 2. every draft room renders its filtered player list ───────────────────
// The board's whole job. Each room filters the pool into `filtered` and must
// map it to rows; a room that computes `filtered` and never renders it is the
// bug above.
console.log("\ndraft rooms render their player list");
for (const room of ["snake/SnakeRoom.tsx", "auction/AuctionRoom.tsx"]) {
  const src = readFileSync(join(SRC, "components", room), "utf8");
  const name = room.split("/")[1];
  check(`${name} computes a filtered pool`, /const filtered\s*=/.test(src));
  // Match the map's OPENING only, then inspect a bounded window after it. The
  // two rooms bodies differ (one delegates to a memo'd row, one is a ~100-line
  // inline block) and a regex trying to span either body is matching the wrong
  // thing — brittleness that would make this guard itself the flaky part.
  const at = src.indexOf("{filtered.map(");
  check(`${name} maps that pool into rows`, at !== -1);
  if (at !== -1) {
    const body = src.slice(at, at + 8000);
    check(`${name}'s rows render an element, not a bare token`, /<[A-Za-z]/.test(body));
    check(`${name} keys its rows by player id`, /key=\{[^}]*\bp\.id\b/.test(body));
  }
  check(`${name} still handles the empty-pool case`,
        /filtered\.length === 0/.test(src));
}

console.log();
if (fails.length) {
  console.error(`draft-rooms selftest: ${fails.length} FAILED — ${fails.join(", ")}`);
  process.exit(1);
}
console.log("draft-rooms selftest: all checks passed");

/**
 * auction-calibration.selftest.mjs
 * ================================
 * The failure mode this guards against is not a crash — it is a plausible
 * multiplier derived from a sample too small to mean anything, applied to
 * every price for a whole draft. So the assertions are mostly about restraint:
 * refusing to calibrate on thin data, shrinking hard when a position is
 * sparse, staying spend-neutral, and never touching our own valuation.
 *
 *   node frontend/src/engine/auction-calibration.selftest.mjs
 */
import {
  calibrateAuction, picksFromKeeperImport, describeCalibration,
  noCalibration, MIN_PICKS, MULT_CLAMP, POSITIONS,
} from "./auction-calibration.js";
import { marketPrice, DEFAULT_AUCTION_PARAMS, dollarValues } from "./auction-engine.js";

let pass = 0;
const fails = [];
const check = (label, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push(label);
  console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const LEAGUE = { teams: 10, budget: 200, rosterSize: 15 };
const ALLOC = DEFAULT_AUCTION_PARAMS.POS_ALLOC;

/** A draft whose positional spend matches a given share map exactly. */
function draftMatching(shares, perPos = 25, pot = 2000) {
  const picks = [];
  for (const [pos, share] of Object.entries(shares)) {
    const posPot = pot * share;
    for (let i = 0; i < perPos; i++) picks.push({ pos, price: posPot / perPos });
  }
  return picks;
}

// ── restraint on thin data ────────────────────────────────────────────────
check("no history -> not usable", !calibrateAuction([], LEAGUE).usable);
check("a handful of picks -> not usable",
      !calibrateAuction(draftMatching({ RB: 1 }, 5), LEAGUE).usable);
check("below MIN_PICKS -> not usable",
      !calibrateAuction(draftMatching({ RB: 0.5, WR: 0.5 }, Math.floor(MIN_PICKS / 2) - 1), LEAGUE).usable);
check("noCalibration is the identity",
      POSITIONS.every((p) => noCalibration().posMult[p] === 1));
check("zero-price picks are ignored, not counted as $0",
      !calibrateAuction(Array.from({ length: 80 }, () => ({ pos: "RB", price: 0 })), LEAGUE).usable);

// ── a league that behaves exactly like the model ──────────────────────────
const neutral = calibrateAuction(draftMatching(ALLOC, 25), LEAGUE);
check("a model-shaped league calibrates", neutral.usable);
check("...to multipliers of 1",
      POSITIONS.every((p) => near(neutral.posMult[p], 1, 0.02)),
      JSON.stringify(neutral.posMult));

// ── a league that genuinely overpays for running backs ────────────────────
// RB share pushed well above the model's 0.36, WR cut to compensate.
const rbHeavy = calibrateAuction(
  draftMatching({ QB: 0.072, RB: 0.50, WR: 0.25, TE: 0.113, K: 0.015, DST: 0.015 }, 30), LEAGUE);
check("an RB-heavy room calibrates", rbHeavy.usable);
check("RB is marked up", rbHeavy.posMult.RB > 1.05, String(rbHeavy.posMult.RB));
check("WR is marked down", rbHeavy.posMult.WR < 0.95, String(rbHeavy.posMult.WR));
check("the multiplier is SHRUNK, not the raw ratio",
      rbHeavy.posMult.RB < 0.50 / 0.36,
      `shrunk ${rbHeavy.posMult.RB} vs raw ${(0.50 / 0.36).toFixed(3)}`);

// Spend neutrality: scaling every price by these must not change the pot.
const weighted = POSITIONS.reduce((s, p) => s + rbHeavy.modelShare[p] * rbHeavy.posMult[p], 0);
check("multipliers are spend-neutral (weighted mean 1)", near(weighted, 1, 0.02), String(weighted));

check("multipliers stay inside the clamp",
      POSITIONS.every((p) => rbHeavy.posMult[p] >= MULT_CLAMP[0] && rbHeavy.posMult[p] <= MULT_CLAMP[1]));

// ── sample size drives shrinkage ──────────────────────────────────────────
const skew = { QB: 0.072, RB: 0.50, WR: 0.25, TE: 0.113, K: 0.015, DST: 0.015 };
const thin = calibrateAuction(draftMatching(skew, 10), LEAGUE);
const thick = calibrateAuction(draftMatching(skew, 120), LEAGUE);
check("the same bias moves further with more evidence",
      thick.posMult.RB > thin.posMult.RB,
      `n=10 -> ${thin.posMult.RB}, n=120 -> ${thick.posMult.RB}`);
check("a sparse position is flagged in the notes",
      calibrateAuction(draftMatching({ RB: 0.5, WR: 0.45, QB: 0.05 }, 20), LEAGUE)
        .notes.length >= 0);

// ── a league with no kicker must not be penalised for the model's kicker ──
const noK = calibrateAuction(draftMatching({ QB: 0.08, RB: 0.38, WR: 0.41, TE: 0.13 }, 25), LEAGUE);
check("absent positions are dropped from the reference, not counted as a shortfall",
      POSITIONS.filter((p) => noK.sample[p]).every((p) => near(noK.posMult[p], 1, 0.06)),
      JSON.stringify(noK.posMult));

// ── it reaches marketPrice, and ONLY marketPrice ──────────────────────────
const base = marketPrice(5, LEAGUE, DEFAULT_AUCTION_PARAMS, "RB", null, null);
const cald = marketPrice(5, LEAGUE, DEFAULT_AUCTION_PARAMS, "RB", null, rbHeavy);
check("calibration raises the forecast price of an RB", cald > base, `${base} -> ${cald}`);
check("an unusable calibration changes nothing",
      marketPrice(5, LEAGUE, DEFAULT_AUCTION_PARAMS, "RB", null, noCalibration()) === base);
check("no calibration argument still works (back-compat)",
      marketPrice(5, LEAGUE, DEFAULT_AUCTION_PARAMS, "RB", null) === base);
check("AAV, when present, is calibrated too",
      marketPrice(5, LEAGUE, DEFAULT_AUCTION_PARAMS, "RB", 40, rbHeavy) >
      marketPrice(5, LEAGUE, DEFAULT_AUCTION_PARAMS, "RB", 40, null));

// dollarValues is OUR valuation — it takes no calibration and must not move.
const board = [
  { id: 1, pos: "RB", vbd: 90 }, { id: 2, pos: "RB", vbd: 40 },
  { id: 3, pos: "WR", vbd: 80 }, { id: 4, pos: "WR", vbd: 30 },
];
const dvBefore = dollarValues(board, LEAGUE).map((p) => p.dollarValue);
const dvAfter = dollarValues(board, LEAGUE).map((p) => p.dollarValue);
check("our own dollar values are untouched by calibration",
      JSON.stringify(dvBefore) === JSON.stringify(dvAfter),
      "dollarValues must not accept a calibration at all");

// ── reading prices out of a cached keeper import ──────────────────────────
const cache = { candidates: [
  { pos: "RB", bid: 45, waiver: 12 },
  { pos: "WR", bid: 30, waiver: null },
  { pos: "TE", bid: null, waiver: 20 },   // undrafted: no evidence
  { pos: "QB", bid: 0, waiver: null },    // $0 is not a price
  { pos: "XX", bid: 15, waiver: null },   // unknown position
] };
const fromCache = picksFromKeeperImport(cache);
check("keeper import yields only real drafted prices",
      JSON.stringify(fromCache) === JSON.stringify([{ pos: "RB", price: 45 }, { pos: "WR", price: 30 }]),
      JSON.stringify(fromCache));
check("a missing cache is handled", picksFromKeeperImport(null).length === 0);
check("waiver claims are excluded (FAAB is not a draft price)",
      !fromCache.some((p) => p.price === 12 || p.price === 20));

// ── top-heaviness is reported, not applied ────────────────────────────────
check("top-heaviness is reported", typeof rbHeavy.topHeaviness === "number");
check("top-heaviness does not leak into the multipliers",
      near(POSITIONS.reduce((s, p) => s + rbHeavy.modelShare[p] * rbHeavy.posMult[p], 0), 1, 0.02));

check("describeCalibration names the movers", /RB/.test(describeCalibration(rbHeavy)),
      describeCalibration(rbHeavy));
check("describeCalibration explains an unusable one",
      /need|no prior/.test(describeCalibration(calibrateAuction([], LEAGUE))));

// ── survivorship: the import lists rosters, not the draft ─────────────────
// Every importer joins END-OF-SEASON ROSTERS to draft prices, so players who
// were drafted and later cut are missing. That cannot be recovered from this
// data, so it has to be measured and surfaced rather than assumed away.
{
  const full = draftMatching(ALLOC, 25);                 // 150 picks
  const league150 = { teams: 10, budget: 200, rosterSize: 15 };
  const complete = calibrateAuction(full, league150);
  check("a full draft reports ~100% coverage", complete.coverage >= 0.95, String(complete.coverage));
  check("...and raises no survivorship warning",
        !complete.notes.some((n) => /rosters/.test(n)), JSON.stringify(complete.notes));

  const survivors = full.slice(0, 70);                   // ~47% of the draft
  const partial = calibrateAuction(survivors, league150);
  check("a survivors-only sample still calibrates", partial.usable);
  check("...but reports low coverage", partial.coverage < 0.6, String(partial.coverage));
  check("...and says the sample leans toward picks that worked",
        partial.notes.some((n) => /rosters/.test(n) && /dropped/.test(n)),
        JSON.stringify(partial.notes));

  check("coverage is null when roster size is unknown",
        calibrateAuction(full, { teams: 10 }).coverage === null);
}

// ── full draft beats the roster-derived sample ────────────────────────────
// The whole point of pulling draft results on import: `candidates` omits
// players who were drafted and later cut, so it under-samples cheap picks.
{
  const cache = {
    candidates: [                       // survivors only, expensive-skewed
      { pos: "RB", bid: 60 }, { pos: "WR", bid: 55 },
    ],
    draftPicks: [                       // the actual draft
      { pos: "RB", bid: 60, resolved: true }, { pos: "WR", bid: 55, resolved: true },
      { pos: "RB", bid: 2, resolved: true },  { pos: "WR", bid: 1, resolved: true },
      { pos: "TE", bid: 3, resolved: true },
    ],
  };
  const picks = picksFromKeeperImport(cache);
  check("the full draft is preferred over end-of-season rosters",
        picks.length === 5, `${picks.length} picks`);
  check("...including the cheap picks the rosters dropped",
        picks.some((p) => p.price <= 2));

  check("falls back to candidates when no draft was supplied",
        picksFromKeeperImport({ candidates: cache.candidates }).length === 2);
  check("falls back when the draft list is empty",
        picksFromKeeperImport({ candidates: cache.candidates, draftPicks: [] }).length === 2);

  // A pick ESPN could not name has no position, so it cannot inform a
  // positional share. Skipped, never bucketed by a guess.
  const withUnresolved = picksFromKeeperImport({
    candidates: [],
    draftPicks: [{ pos: "RB", bid: 10, resolved: true },
                 { pos: "", bid: 7, resolved: false }],
  });
  check("unresolved picks are skipped, not guessed at",
        withUnresolved.length === 1 && withUnresolved[0].pos === "RB");
}

console.log();
if (fails.length) {
  console.error(`auction-calibration.selftest: ${pass} passed, ${fails.length} FAILED — ${fails.join(", ")}`);
  process.exit(1);
}
console.log(`auction-calibration.selftest: ${pass} passed, 0 failed`);

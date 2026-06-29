/* =====================================================================
   SNAKE ENGINE — snake-specific pick scheduling and recommendations.

   Swap this file to upgrade the snake algorithm independently of auction.
   All shared VBD machinery (scoring, projectValue, valueBoard) lives in
   engine-core.js and is re-exported here for convenience.

   THE SNAKE PIPELINE:
     valueBoard() → rank by .vbd → snakePicks() for pick-clock timing
   ===================================================================== */
import { DEFAULT_PARAMS } from "./engine-core.js";

export {
  DEFAULT_PARAMS, SCORING_PRESETS, defaultScoring,
  points, ageMultiplier, projectValue, replacementRanks, valueBoard,
} from "./engine-core.js";

/* ------------------------------------------------------------------ *
 * SNAKE-SPECIFIC PARAMS — extend DEFAULT_PARAMS with snake knobs.
 * This is the object to tune when optimizing the snake algorithm.
 * ------------------------------------------------------------------ */
export const DEFAULT_SNAKE_PARAMS = {
  ...DEFAULT_PARAMS,
};

/* ------------------------------------------------------------------ *
 * PICK SCHEDULE — which overall picks belong to a given draft slot
 *
 * Returns the list of overall pick numbers for `slot` across `rounds`
 * rounds of a snake draft with `teams` teams.
 * ------------------------------------------------------------------ */
export function snakePicks(slot, teams, rounds = 18) {
  const out = [];
  for (let r = 1; r <= rounds; r++)
    out.push(r % 2 === 1 ? (r - 1) * teams + slot : r * teams - slot + 1);
  return out;
}

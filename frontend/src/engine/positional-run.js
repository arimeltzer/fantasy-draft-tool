/* =====================================================================
   POSITIONAL RUN — roadmap 3.2. "When three running backs go in five
   picks, the next five are likelier to be running backs."

   WHAT THIS IS. A position is "running" when it has taken up more than
   its fair share of the most recent picks — a signal that the room is
   deviating from its normal pace at that position RIGHT NOW, independent
   of what static preseason ADP says. It feeds 3.1's survival margin: a
   run shrinks the trust placed in a player's ADP-implied cushion, because
   that cushion was computed assuming normal pace and the room just
   demonstrated it isn't drafting at normal pace.

   WHAT THIS IS NOT. It does not distinguish a real run (the room reaching
   for backs) from a boring, ADP-consistent stretch (round 1 is naturally
   RB/WR-heavy, so three RBs in five early picks can be exactly what ADP
   predicted, not a deviation from it). A run detector that only reads
   recent pick FREQUENCY, without comparing it to what ADP expected at
   this exact point in the draft, cannot tell those apart. Building the
   ADP-expectation model that WOULD tell them apart is real work with its
   own failure modes (0.2's ten slot configs were exactly an attempt to
   model per-slot expected behavior, and did not survive contact with held-
   out data). This ships the simpler, honestly-labeled version instead —
   same call this repo already made for byeClash: small, capped, unfitted,
   not backed by a historical gate, because the effect size does not
   justify one and the roadmap's own restructure warns against building
   validation weight the mechanism has not earned.

   CONSTANTS ARE DELIBERATELY UNFITTED, same discipline as byeClashStep/Max
   and survivalUrgencyMax in snake-engine.js. MIN_RUN_COUNT=3 is the
   roadmap's own worked example, taken literally rather than derived; a
   bigger number would need held-out evidence, same as those.
   ===================================================================== */

/** Core skill positions a "run" applies to. K/DST timing is ritualized
 *  (drafted at a predictable late point almost every room converges on),
 *  not run-prone the way this mechanism means the word. */
export const RUN_POSITIONS = ["QB", "RB", "WR", "TE"];

/** Fair share of recent picks, if positions were taken evenly. */
const BASELINE_SHARE = 1 / RUN_POSITIONS.length;

/** Minimum recent picks at a position before calling it a run at all —
 *  below this, "hot" is noise wearing a signal's clothes. The roadmap's
 *  own example ("three running backs in five picks"), taken as-is. */
export const MIN_RUN_COUNT = 3;

/**
 * How hot each position's run is right now, in [0, 1] per position.
 *
 * @param recentPicks  chronological pick history (oldest first) — position
 *                      strings only; the caller maps its own pick log to
 *                      this shape. Only the most recent `teams` entries are
 *                      read (one full turn of the snake — the natural
 *                      window, not a fitted one: a run inside one round
 *                      means something different from the same count spread
 *                      across the whole draft).
 * @param teams        league size, also the window length.
 * @returns { QB, RB, WR, TE } each in [0, 1]. 0 = no run. 1 = every recent
 *          pick in the window was at that position.
 */
export function runHotness(recentPicks, teams) {
  const out = {};
  for (const pos of RUN_POSITIONS) out[pos] = 0;
  if (!Array.isArray(recentPicks) || !recentPicks.length || !teams) return out;

  const windowSize = Math.min(recentPicks.length, teams);
  const window = recentPicks.slice(-windowSize);

  const counts = {};
  for (const pos of window) counts[pos] = (counts[pos] || 0) + 1;

  for (const pos of RUN_POSITIONS) {
    const count = counts[pos] || 0;
    if (count < MIN_RUN_COUNT) continue;
    const share = count / windowSize;
    if (share <= BASELINE_SHARE) continue;
    out[pos] = Math.min(1, (share - BASELINE_SHARE) / (1 - BASELINE_SHARE));
  }
  return out;
}

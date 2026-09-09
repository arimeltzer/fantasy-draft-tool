import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderInApp, player } from "@/test/fixtures";
import type { SnakeLiveState } from "@/engine/snake-engine.js";
import Recommendations from "./Recommendations";

/**
 * Reported live: "once my starting lineup was filled the app recommended
 * six defenses with my next pick which would have been way too early and
 * wasting picks that I could have used to build my bench."
 *
 * Root cause: the panel's own MAX_PER_POS cap ("you make ONE pick, so the
 * 3rd-best QB isn't a real choice") was only enforced in the PRIMARY fill
 * loop. A separate backfill step, meant to top up a genuinely thin pool
 * rather than leave a short panel, refilled any remaining slots straight
 * from `open` with no cap at all. Once starters fill and every other
 * position hits its own roster/bench cap (an ordinary mid-draft state, not
 * the true endgame), DST can be the only position left unblocked — so the
 * capped primary loop takes its 2, and the uncapped backfill piled on 4
 * more defenses to reach 6. Fixed by removing the uncapped backfill: a
 * short panel is the honest outcome once nothing else can fit under the
 * cap, matching the "short panel beats bad advice" trade already made
 * elsewhere in this file for the vbd > 0 gate.
 */
const ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 };

// Starters filled everywhere except DST: QB/TE/K already at their maxUseful
// cap (starters+1 for QB/TE, starters for K), RB/WR pushed all the way to
// their own bench-bound cap (starters + FLEX + max(2, BENCH) = 9) so NONE
// of them can be a real alternative either — only DST (have: 0) is open.
const LIVE: SnakeLiveState = {
  round: 5,
  teams: 10,
  slot: 3,
  superflex: false,
  roster: ROSTER,
  counts: { QB: 2, RB: 9, WR: 9, TE: 2, K: 1, DST: 0 },
  needs: { DST: 1 },
  bestVbd: 100,
  posRemaining: {},
  adpRankById: {},
  poolSize: 200,
};

function makeBoard() {
  const dst = Array.from({ length: 6 }, (_, i) =>
    player({ id: 100 + i, name: `Defense ${i + 1}`, pos: "DST", team: `T${i}`, vbd: 12 - i }));
  // Genuinely maxed-out alternatives with a much HIGHER vbd than any
  // defense — if the cap ever leaked again, these would be the first
  // thing to reappear, so their absence is the real assertion.
  const blocked = [
    player({ id: 1, name: "Blocked RB", pos: "RB", team: "SF", vbd: 90 }),
    player({ id: 2, name: "Blocked WR", pos: "WR", team: "MIA", vbd: 85 }),
    player({ id: 3, name: "Blocked QB2", pos: "QB", team: "KC", vbd: 70 }),
  ];
  return [...blocked, ...dst];
}

describe("Recommendations — position cap once starters are filled", () => {
  it("never fills the panel with more than MAX_PER_POS of the one open position", () => {
    renderInApp(
      <Recommendations board={makeBoard()} draftedIds={new Set()} live={LIVE} onDraft={() => {}} />,
    );
    // Exactly the cap's 2 best defenses shown, not all 6 — the reported bug.
    const shown = ["Defense 1", "Defense 2", "Defense 3", "Defense 4", "Defense 5", "Defense 6"]
      .filter((n) => screen.queryByText(n) !== null);
    expect(shown).toEqual(["Defense 1", "Defense 2"]);
    // The maxed-out positions never leak in either — they're blocked, not
    // just deprioritized, so they must never fill a slot regardless of vbd.
    expect(screen.queryByText("Blocked RB")).toBeNull();
    expect(screen.queryByText("Blocked WR")).toBeNull();
    expect(screen.queryByText("Blocked QB2")).toBeNull();
  });

  it("still fills all 6 slots normally when more than one position is open", () => {
    const board = [
      ...Array.from({ length: 2 }, (_, i) =>
        player({ id: 200 + i, name: `RB${i + 1}`, pos: "RB", team: "SF", vbd: 60 - i })),
      ...Array.from({ length: 2 }, (_, i) =>
        player({ id: 210 + i, name: `WR${i + 1}`, pos: "WR", team: "MIA", vbd: 55 - i })),
      ...Array.from({ length: 6 }, (_, i) =>
        player({ id: 220 + i, name: `Defense ${i + 1}`, pos: "DST", team: `T${i}`, vbd: 12 - i })),
    ];
    const live: SnakeLiveState = {
      ...LIVE,
      counts: { QB: 2, RB: 0, WR: 0, TE: 2, K: 1, DST: 0 },
      needs: { RB: 1, WR: 1, DST: 1 },
    };
    renderInApp(<Recommendations board={board} draftedIds={new Set()} live={live} onDraft={() => {}} />);
    expect(screen.getByText("RB1")).toBeTruthy();
    expect(screen.getByText("RB2")).toBeTruthy();
    expect(screen.getByText("WR1")).toBeTruthy();
    expect(screen.getByText("WR2")).toBeTruthy();
    const defensesShown = ["Defense 1", "Defense 2", "Defense 3", "Defense 4", "Defense 5", "Defense 6"]
      .filter((n) => screen.queryByText(n) !== null);
    expect(defensesShown.length).toBe(2);
  });
});

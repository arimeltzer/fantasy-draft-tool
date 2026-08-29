import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderInApp } from "@/test/fixtures";
import { normalizeKeeperRule } from "@/engine/keeper.js";
import type { KeeperCandidate } from "@/lib/api";
import KeeperAutofill from "./KeeperAutofill";

/**
 * The reported bug: a player ESPN flags `keeper_ineligible` (already kept the
 * max number of times the league allows) was still checkable in the "Auto-fill
 * from ESPN" table, letting you commit an illegal keep. `selectable` checked
 * `alreadyKept` but not `keeper_ineligible` — one missing clause, silent
 * because nothing rendered wrong, it just let through a pick it shouldn't have.
 *
 * KeeperRecommendations already filtered this correctly elsewhere; this pins
 * the same rule in the ESPN commit table so the two can't drift again.
 */
const rule = normalizeKeeperRule(undefined, "snake");

const CANDIDATES: KeeperCandidate[] = [
  { player_id: 1, name: "Eligible Guy", pos: "RB", team: "SF", owner: "Me",
    is_mine: true, bid: null, round: 5, waiver: null, matched: true },
  { player_id: 2, name: "Capped Out Guy", pos: "WR", team: "KC", owner: "Me",
    is_mine: true, bid: null, round: 3, waiver: null, matched: true, keeper_ineligible: true },
];

function renderTable() {
  return renderInApp(
    <KeeperAutofill
      rule={rule}
      takenIds={new Set()}
      addPick={async () => {}}
      teamIdFor={() => undefined}
      cached={{ season: 2025, fetchedAt: new Date().toISOString(), candidates: CANDIDATES }}
    />,
  );
}

describe("KeeperAutofill — keeper_ineligible", () => {
  it("disables the checkbox for a player already kept the max number of times", () => {
    renderTable();
    const ineligibleRow = screen.getByText("Capped Out Guy").closest("label")!;
    const checkbox = ineligibleRow.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
  });

  it("shows why, instead of a price/round it can't actually be kept for", () => {
    renderTable();
    const ineligibleRow = screen.getByText("Capped Out Guy").closest("label")!;
    expect(ineligibleRow.textContent).toContain("ineligible");
  });

  it("leaves an eligible player checkable", () => {
    renderTable();
    const eligibleRow = screen.getByText("Eligible Guy").closest("label")!;
    const checkbox = eligibleRow.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
  });
});

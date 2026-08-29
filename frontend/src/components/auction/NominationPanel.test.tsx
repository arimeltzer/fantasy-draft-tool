import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderInApp } from "@/test/fixtures";
import NominationPanel from "./NominationPanel";

/**
 * Reported live: "the inflation number in the nomination panel for an
 * auction draft is not syncing with the number atop the screen. Late in the
 * draft the top went to N/A but the other one says 2x." Root cause:
 * InflationBadge (the header) checks `reliable` and prints "n/a" once too
 * little priced value is left on the board for the ratio to mean anything
 * (applyInflation's INFLATION_MIN_COVERAGE) — but NominationPanel was never
 * given `reliable` at all, so it printed the same clamped `factor` (usually
 * sitting right at the x2.0 ceiling late in a draft) unconditionally. Same
 * underlying `inflation.factor`/`inflation.reliable` feed both displays
 * (one `useMemo` in AuctionRoom.tsx) — this was a display/gating bug, not a
 * computation mismatch.
 */
function renderPanel(factor: number, reliable: boolean) {
  return renderInApp(
    <NominationPanel
      factor={factor}
      reliable={reliable}
      phase="late"
      nominations={[]}
      valueTargets={[]}
      myMax={50}
      oppBudgets={[10, 5]}
      richThreshold={40}
    />,
  );
}

describe("NominationPanel — inflation display", () => {
  it("shows n/a, not the clamped factor, once the header's own reliability gate would", () => {
    renderPanel(2, false);
    expect(screen.getByText("n/a")).toBeTruthy();
    expect(screen.queryByText("×2")).toBeFalsy();
    expect(screen.queryByText("×2.00")).toBeFalsy();
  });

  it("shows the real factor when the estimate is reliable", () => {
    renderPanel(1.3, true);
    expect(screen.getByText("×1.30")).toBeTruthy();
  });

  it("defaults to reliable when the prop is omitted (back-compat)", () => {
    renderInApp(
      <NominationPanel
        factor={1}
        phase="early"
        nominations={[]}
        valueTargets={[]}
        myMax={50}
        oppBudgets={[10, 5]}
        richThreshold={40}
      />,
    );
    expect(screen.getByText("×1.00")).toBeTruthy();
  });
});

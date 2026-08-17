import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderInApp, BOARD, SETTINGS } from "@/test/fixtures";
import type { KeeperCandidate } from "@/lib/api";
import KeeperRecommendations from "./KeeperRecommendations";

/**
 * The Yahoo-side twin of the ESPN keeper_ineligible bug: the "was kept" badge
 * is detected from whitespace copy-paste leaves behind (yahoo_paste.py), so
 * it can miss a player entirely — there is no code path that can fix that by
 * itself. What the app CAN guarantee is a way to correct it: mark a missed
 * detection ineligible, or undo a wrong one, and have the recommendation
 * respect it either way.
 */
const candidate = (over: Partial<KeeperCandidate> = {}): KeeperCandidate => ({
  player_id: 1, name: "Bijan Robinson", pos: "RB", team: "ATL", owner: "Me",
  is_mine: true, bid: null, round: 5, waiver: null, matched: true, ...over,
});

function renderReco(candidates: KeeperCandidate[]) {
  return renderInApp(
    <KeeperRecommendations
      format="snake"
      settings={SETTINGS}
      board={BOARD}
      picks={[]}
      addPick={async () => {}}
      removePick={async () => {}}
      importedCandidates={candidates}
    />,
  );
}

describe("KeeperRecommendations — eligibility overrides", () => {
  it("recommends an eligible import normally", () => {
    renderReco([candidate()]);
    expect(screen.getByText("Bijan Robinson")).toBeTruthy();
    expect(screen.queryByText("Kept last year — not eligible")).toBeNull();
  });

  it("marking 'kept last year?' removes him from the recommendation and lists him as ineligible", () => {
    renderReco([candidate()]);
    fireEvent.click(screen.getByTitle(/actually kept last year/i));
    expect(screen.getByText("Kept last year — not eligible")).toBeTruthy();
    expect(screen.getByText("you marked")).toBeTruthy();
  });

  it("an import already flagged keeper_ineligible starts excluded, not recommended", () => {
    renderReco([candidate({ keeper_ineligible: true })]);
    expect(screen.getByText("Kept last year — not eligible")).toBeTruthy();
    expect(screen.getByText("detected")).toBeTruthy();
  });

  it("'eligible after all' undoes an import's wrong ineligible flag", () => {
    renderReco([candidate({ keeper_ineligible: true })]);
    fireEvent.click(screen.getByText("eligible after all"));
    expect(screen.queryByText("Kept last year — not eligible")).toBeNull();
  });
});

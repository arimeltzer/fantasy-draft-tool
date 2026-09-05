import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderInApp } from "@/test/fixtures";
import type { KeeperCandidate } from "@/lib/api";
import YahooKeeperAutofill from "./YahooKeeperAutofill";

/**
 * The reported bug: a real Yahoo pull came back with 172 players and correct
 * keeper-ineligibility flags, but NO recommendations at all, and the panel
 * never asked for a team name. Root cause: Yahoo identifies "my roster" by
 * matching the OAuth manager guid against each team server-side (why it
 * never asks for a name, unlike ESPN) — a single point of failure with no
 * visibility when it misses. KeeperRecommendations only ever scores
 * candidates with is_mine=true, so a missed guid match silently produces
 * zero recommendations from a perfectly good pull.
 *
 * Fix: keep the raw pull, and when no candidate came back is_mine=true, let
 * the user pick their team from the real names Yahoo already returned.
 */
const NO_MATCH: KeeperCandidate[] = [
  { player_id: 1, name: "My Guy", pos: "RB", team: "SF", owner: "The Gridiron Gurus",
    is_mine: false, bid: null, round: 5, waiver: null, matched: true },
  { player_id: 2, name: "Their Guy", pos: "WR", team: "KC", owner: "Dynasty Warriors",
    is_mine: false, bid: null, round: 3, waiver: null, matched: true },
];

const AUTO_MATCHED: KeeperCandidate[] = [
  { player_id: 1, name: "My Guy", pos: "RB", team: "SF", owner: "Me",
    is_mine: true, bid: null, round: 5, waiver: null, matched: true },
  { player_id: 2, name: "Their Guy", pos: "WR", team: "KC", owner: "Dynasty Warriors",
    is_mine: false, bid: null, round: 3, waiver: null, matched: true },
];

function renderPanel(candidates: KeeperCandidate[], onCandidates = vi.fn()) {
  renderInApp(
    <YahooKeeperAutofill
      onCandidates={onCandidates}
      cached={{ source: "yahoo", season: 2025, fetchedAt: new Date().toISOString(), candidates }}
    />,
  );
  return onCandidates;
}

describe("YahooKeeperAutofill — guid match can silently miss", () => {
  it("warns and offers a team picker when no candidate came back is_mine", () => {
    renderPanel(NO_MATCH);
    expect(screen.getByText(/Couldn't tell which team is yours/i)).toBeTruthy();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const optionText = [...select.options].map((o) => o.textContent);
    expect(optionText).toContain("The Gridiron Gurus");
    expect(optionText).toContain("Dynasty Warriors");
  });

  it("does not warn when the guid match already found a team", () => {
    renderPanel(AUTO_MATCHED);
    expect(screen.queryByText(/Couldn't tell which team is yours/i)).toBeNull();
  });

  it("picking a team reclassifies its players as mine and feeds the recommender", async () => {
    const onCandidates = renderPanel(NO_MATCH);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "The Gridiron Gurus" } });
    await waitFor(() => {
      const calls = onCandidates.mock.calls;
      const last = calls[calls.length - 1][0] as KeeperCandidate[];
      const mine = last.find((c) => c.player_id === 1);
      const theirs = last.find((c) => c.player_id === 2);
      expect(mine?.is_mine).toBe(true);
      expect(mine?.owner).toBe("Me");
      expect(theirs?.is_mine).toBe(false);
    });
  });
});

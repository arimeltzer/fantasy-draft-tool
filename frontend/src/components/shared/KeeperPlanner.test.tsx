import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderInApp, BOARD, SETTINGS } from "@/test/fixtures";
import KeeperPlanner from "./KeeperPlanner";

/**
 * The reported bug: "in my auction league keepers are not carrying over to
 * the draft board" — clarified as "they show as sold, but they are not
 * allocated to the team that kept them." A manually-added OPPONENT keeper
 * called `addPick({ mine: false })` with no `teamId` at all, so the pick
 * came off the board (taken) but was never attributed to a specific
 * opponent — it couldn't show up on that team's roster or count against
 * their budget. This pins the fix: picking an opponent from the "Owner"
 * dropdown must resolve to that opponent's real index into
 * `settings.opponents[]`, the same convention AuctionRoom/SnakeRoom's own
 * winner dropdown already writes.
 */
type AddPickArg = { playerId?: number; mine: boolean; teamId?: number; price?: number; slot?: string };

function renderPlanner(addPick: (d: AddPickArg) => Promise<void>) {
  return renderInApp(
    <KeeperPlanner
      format="auction"
      leagueId={1}
      settings={SETTINGS}
      board={BOARD}
      picks={[]}
      addPick={addPick}
      removePick={async () => {}}
      onClose={() => {}}
    />,
  );
}

describe("KeeperPlanner — opponent keeper attribution", () => {
  it("resolves the chosen opponent to their real settings.opponents[] index", async () => {
    const addPick = vi.fn(async (_d: AddPickArg) => {});
    renderPlanner(addPick);

    fireEvent.change(screen.getByPlaceholderText("Search player to keep…"), {
      target: { value: "Ja'Marr Chase" },
    });
    fireEvent.click(await screen.findByText("Ja'Marr Chase"));

    // SETTINGS.opponents = ["Team Two", "Team Three"] -> "Team Three" is index 1.
    fireEvent.change(screen.getByDisplayValue("Me"), { target: { value: "Team Three" } });
    fireEvent.click(screen.getByText("Add keeper"));

    await waitFor(() => expect(addPick).toHaveBeenCalled());
    const call = addPick.mock.calls[0][0];
    expect(call.playerId).toBe(2);
    expect(call.mine).toBe(false);
    expect(call.teamId).toBe(1);
  });

  it("a keeper kept by ME still omits teamId", async () => {
    const addPick = vi.fn(async (_d: AddPickArg) => {});
    renderPlanner(addPick);

    fireEvent.change(screen.getByPlaceholderText("Search player to keep…"), {
      target: { value: "Bijan Robinson" },
    });
    fireEvent.click(await screen.findByText("Bijan Robinson"));
    fireEvent.click(screen.getByText("Add keeper"));

    await waitFor(() => expect(addPick).toHaveBeenCalled());
    const call = addPick.mock.calls[0][0];
    expect(call.mine).toBe(true);
    expect(call.teamId).toBeUndefined();
  });
});

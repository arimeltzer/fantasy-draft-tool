import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderInApp, BOARD, SETTINGS } from "@/test/fixtures";
import { encodeKeeper } from "@/lib/keeperPick";
import type { DraftEntry } from "@/store/draftStore";
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

function renderPlanner(
  addPick: (d: AddPickArg) => Promise<void>,
  picks: DraftEntry[] = [],
  removePick: (pickId: number) => Promise<void> = async () => {},
) {
  return renderInApp(
    <KeeperPlanner
      format="auction"
      leagueId={1}
      settings={SETTINGS}
      board={BOARD}
      picks={picks}
      addPick={addPick}
      removePick={removePick}
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

  it("reported a second time — a committed keeper whose owner didn't resolve can be fixed by hand", async () => {
    // Simulates exactly the reported state: an opponent keeper that DID get
    // committed (mine: false) but whose team_id never resolved (null) —
    // e.g. an owner label from a prior-season ESPN pull that no longer
    // matches this season's settings.opponents at all.
    const existing: DraftEntry = {
      pickId: 501, playerId: 2, overallPick: 1, mine: false, teamId: null,
      price: 12,
      slot: encodeKeeper({ k: 1, owner: "Some Old Team Name", basis: "price", kept: 0, base: 12 }),
    };
    const addPick = vi.fn(async (_d: AddPickArg) => {});
    const removePick = vi.fn(async (_id: number) => {});
    renderPlanner(addPick, [existing], removePick);

    // The warning icon flags the unresolved attribution.
    const row = screen.getByText("Ja'Marr Chase").closest("div") as HTMLElement;
    expect(within(row).getByTitle(/couldn't match this owner/i)).toBeTruthy();

    // Fix it by hand: reassign to a real opponent from the dropdown.
    const ownerSelect = within(row).getByDisplayValue("Some Old Team Name");
    fireEvent.change(ownerSelect, { target: { value: "Team Three" } });

    await waitFor(() => expect(addPick).toHaveBeenCalled());
    expect(removePick).toHaveBeenCalledWith(501);
    const call = addPick.mock.calls[0][0];
    expect(call.mine).toBe(false);
    expect(call.teamId).toBe(1);
  });
});

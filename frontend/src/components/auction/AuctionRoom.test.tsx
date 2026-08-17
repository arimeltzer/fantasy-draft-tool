import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderInApp, BOARD, SETTINGS, LEAGUE } from "@/test/fixtures";
import { useDraftStore } from "@/store/draftStore";
import AuctionRoom from "./AuctionRoom";

/**
 * Same contract as the snake room's test: the board must actually list the
 * players it was handed. The auction room escaped the ROW_MAP_PLACEHOLDER bug
 * only by luck — nothing was checking either room — so it gets the same cover.
 *
 * The auction-specific part is the money: a price box and a winner dropdown per
 * row, and a sale has to record the typed price against the right team.
 */
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      picks: vi.fn(async () => []),
      addPick: vi.fn(async (_lg: number, body: Record<string, unknown>) => ({
        id: 999, player_id: body.player_id ?? null, overall_pick: 1,
        mine: body.mine, team_id: body.team_id ?? null,
        price: body.price ?? null, slot: body.slot ?? null, ts: "",
      })),
      deletePick: vi.fn(async () => undefined),
      updatePick: vi.fn(async () => ({})),
      commonOpponents: vi.fn(async () => []),
    },
  };
});

const AUCTION_LEAGUE = { ...LEAGUE, format: "auction" as const };
const room = () => (
  <AuctionRoom league={AUCTION_LEAGUE} settings={SETTINGS} board={BOARD} leagueId={1} />
);

function list(): HTMLElement {
  const header = screen.getByText("Player").closest("div")!;
  return header.parentElement!.querySelector(".divide-y") as HTMLElement;
}

function row(name: string): HTMLElement {
  return within(list()).getByText(name).closest(".grid") as HTMLElement;
}

const names = () => BOARD.map((p) => p.name)
  .filter((n) => within(list()).queryByText(n) !== null);

beforeEach(() => {
  useDraftStore.setState({ leagueId: 1, picks: [], syncing: false });
});

describe("AuctionRoom player board", () => {
  it("renders a row for every player it is given", () => {
    renderInApp(room());
    expect(names()).toEqual(BOARD.map((p) => p.name));
  });

  it("renders no placeholder token where the rows belong", () => {
    const { container } = renderInApp(room());
    expect(container.textContent).not.toMatch(/PLACEHOLDER/i);
  });

  it("gives every unsold player a price box and a winner dropdown", () => {
    renderInApp(room());
    for (const p of BOARD) {
      const r = row(p.name);
      expect(within(r).getByRole("spinbutton")).toBeTruthy();
      expect(within(r).getByTitle("Who won this player?")).toBeTruthy();
    }
  });

  it("filters the list by the search box", () => {
    renderInApp(room());
    fireEvent.change(screen.getByPlaceholderText(/search player or team/i),
                     { target: { value: "mcbride" } });
    expect(names()).toEqual(["Trey McBride"]);
  });

  it("records the typed price against me when I win a player", async () => {
    const { api } = await import("@/lib/api");
    renderInApp(room());

    const r = row("Bijan Robinson");
    fireEvent.change(within(r).getByRole("spinbutton"), { target: { value: "57" } });
    fireEvent.change(within(r).getByTitle("Who won this player?"), { target: { value: "mine" } });

    await waitFor(() => expect(vi.mocked(api.addPick)).toHaveBeenCalled());
    const calls = vi.mocked(api.addPick).mock.calls;
    const [, body] = calls[calls.length - 1];
    expect(body.price).toBe(57);
    expect(body.mine).toBe(true);
  });

  it("records a sale to an opponent against that team", async () => {
    const { api } = await import("@/lib/api");
    renderInApp(room());

    const r = row("Ja'Marr Chase");
    fireEvent.change(within(r).getByRole("spinbutton"), { target: { value: "41" } });
    fireEvent.change(within(r).getByTitle("Who won this player?"), { target: { value: "1" } });

    await waitFor(() => expect(vi.mocked(api.addPick)).toHaveBeenCalled());
    const calls = vi.mocked(api.addPick).mock.calls;
    const [, body] = calls[calls.length - 1];
    expect(body.price).toBe(41);
    expect(body.mine).toBe(false);
    expect(body.team_id).toBe(1);
  });

  it("hides a sold player, since 'hide sold' starts on", async () => {
    renderInApp(room());
    const r = row("Trey McBride");
    fireEvent.change(within(r).getByTitle("Who won this player?"), { target: { value: "mine" } });

    await waitFor(() => expect(names()).not.toContain("Trey McBride"));
    expect(names()).toEqual(["Bijan Robinson", "Ja'Marr Chase", "Josh Allen"]);
  });

  it("shows the sale price on the row afterwards, and can undo it", async () => {
    renderInApp(room());
    fireEvent.click(screen.getByText("hide sold").querySelector("input")!);
    const r = row("Josh Allen");
    fireEvent.change(within(r).getByRole("spinbutton"), { target: { value: "12" } });
    fireEvent.change(within(r).getByTitle("Who won this player?"), { target: { value: "mine" } });

    await waitFor(() =>
      expect(within(row("Josh Allen")).getByText(/\$12/)).toBeTruthy());

    fireEvent.click(within(row("Josh Allen")).getByText(/\$12/));
    await waitFor(() =>
      expect(within(row("Josh Allen")).getByRole("spinbutton")).toBeTruthy());
  });
});

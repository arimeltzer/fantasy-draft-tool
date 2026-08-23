import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderInApp, BOARD, SETTINGS, LEAGUE, player, SCHEDULE_FIXTURE } from "@/test/fixtures";
import { useDraftStore } from "@/store/draftStore";
import SnakeRoom from "./SnakeRoom";

/**
 * The test that had to exist.
 *
 * A perf refactor once replaced this board's row map with the literal token
 * `ROW_MAP_PLACEHOLDER`. Bare text is valid JSX, so `tsc -b && vite build`
 * passed, the bundle shipped, and the snake room listed no players at all
 * during draft season. Nothing in the project could tell a component that
 * renders its list from one that renders the word PLACEHOLDER.
 *
 * So the first assertion here is the dumbest one imaginable — the players you
 * passed in appear on the board — and it is the most valuable.
 *
 * Every query is scoped to the player list. A name also appears in the
 * Recommendations panel above it, so unscoped queries match twice and, worse,
 * a board rendering nothing would still "find" the name in that panel and pass.
 */

// The store talks to Railway on every pick. Mocked at the module boundary so
// the room exercises its real store, real engine and real reducers, and only
// the network is fake.
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
      schedule: vi.fn(async () => SCHEDULE_FIXTURE),
    },
  };
});

const room = () => (
  <SnakeRoom league={LEAGUE} settings={SETTINGS} board={BOARD} leagueId={1} />
);

/** The scrollable player list, reached from a stable landmark — a
 *  data-testid — rather than by class name, which is styling and may change. */
function list(): HTMLElement {
  return screen.getByTestId("player-list");
}

/** One player's row within the list. */
function row(name: string): HTMLElement {
  return within(list()).getByText(name).closest(".grid") as HTMLElement;
}

const names = () => BOARD.map((p) => p.name)
  .filter((n) => within(list()).queryByText(n) !== null);

/** "hide taken" starts on and hides ANY drafted player, mine included — not
 *  just opponents'. */
const hideTaken = () => screen.getByText("hide taken").querySelector("input")!;

beforeEach(() => {
  useDraftStore.setState({ leagueId: 1, picks: [], syncing: false });
});

describe("SnakeRoom player board", () => {
  it("renders a row for every player it is given", () => {
    renderInApp(room());
    expect(names()).toEqual(BOARD.map((p) => p.name));
  });

  it("renders no placeholder token where the rows belong", () => {
    const { container } = renderInApp(room());
    expect(container.textContent).not.toMatch(/PLACEHOLDER/i);
    expect(within(list()).getAllByText(/./).length).toBeGreaterThan(0);
  });

  it("shows each player's position and team on their row", () => {
    renderInApp(room());
    const r = row("Josh Allen");
    expect(within(r).getByText("QB")).toBeTruthy();
    expect(within(r).getByText("BUF")).toBeTruthy();
  });

  it("filters the list by the search box", () => {
    renderInApp(room());
    fireEvent.change(screen.getByPlaceholderText(/search player or team/i),
                     { target: { value: "bijan" } });
    expect(names()).toEqual(["Bijan Robinson"]);
  });

  it("filters the list by position", () => {
    renderInApp(room());
    fireEvent.click(screen.getByRole("button", { name: "WR" }));
    expect(names()).toEqual(["Ja'Marr Chase"]);
  });

  it("says so when nothing matches, instead of rendering an empty box", () => {
    renderInApp(room());
    fireEvent.change(screen.getByPlaceholderText(/search player or team/i),
                     { target: { value: "zzzz" } });
    expect(names()).toEqual([]);
    expect(screen.getByText(/no players match/i)).toBeTruthy();
  });

  it("drops a drafted player off the board, since 'hide taken' starts on", async () => {
    renderInApp(room());
    expect((hideTaken() as HTMLInputElement).checked).toBe(true);

    fireEvent.click(within(row("Bijan Robinson")).getByTitle("I drafted this player"));

    await waitFor(() => expect(names()).not.toContain("Bijan Robinson"));
    // and only that player — the rest of the pool must survive
    expect(names()).toEqual(["Ja'Marr Chase", "Josh Allen", "Trey McBride"]);
  });

  it("marks the player as mine, not merely taken, once 'hide taken' is off", async () => {
    renderInApp(room());
    fireEvent.click(hideTaken());

    fireEvent.click(within(row("Bijan Robinson")).getByTitle("I drafted this player"));

    await waitFor(() =>
      expect(within(row("Bijan Robinson")).getByText(/Mine/)).toBeTruthy());
    // still listed, because nothing is being hidden now
    expect(names()).toEqual(BOARD.map((p) => p.name));
  });

  it("attributes a pick to the opponent chosen in the dropdown", async () => {
    const { api } = await import("@/lib/api");
    renderInApp(room());
    fireEvent.click(hideTaken());

    const picker = within(row("Ja'Marr Chase")).getByRole("combobox");
    // The options are built on first interaction, not per render — with ~600
    // rows on screen that is hundreds of selects. So a bare `change` finds no
    // option to select; the dropdown has to be opened first, as a user would.
    expect(within(picker).queryAllByRole("option", { hidden: true }).length).toBe(1);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: "0" } });

    await waitFor(() => expect(vi.mocked(api.addPick)).toHaveBeenCalled());
    const calls = vi.mocked(api.addPick).mock.calls;
    const [, body] = calls[calls.length - 1];
    expect(body.mine).toBe(false);
    expect(body.team_id).toBe(0);
    await waitFor(() =>
      expect(within(row("Ja'Marr Chase")).getByText(/Taken/)).toBeTruthy());
  });

  it("keeps the player draftable when the pick call fails", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.addPick).mockRejectedValueOnce(new Error("network down"));
    renderInApp(room());

    fireEvent.click(within(row("Bijan Robinson")).getByTitle("I drafted this player"));

    // The optimistic row rolls back, so the player is still draftable — a
    // phantom pick would hide someone who is genuinely still available.
    await waitFor(() =>
      expect(within(row("Bijan Robinson")).getByTitle("I drafted this player")).toBeTruthy());
    expect(names()).toEqual(BOARD.map((p) => p.name));
    // and the failure isn't silent — it used to be an unhandled rejection
    // with nothing shown on screen at all.
    await waitFor(() => expect(window.alert).toHaveBeenCalled());
  });
});

/**
 * "Make the model bye week aware so it will flag for me when I have another
 * player at the same position with the same bye week... I can then make the
 * decision in real time" — deliberately unpriced, so pickScore's own byeClash
 * penalty (already shipped) is untouched; this is a separate display-only
 * flag on the board itself.
 */
describe("SnakeRoom bye-collision flag (real-time, unpriced)", () => {
  const BYE_BOARD = [...BOARD, player({ id: 5, name: "Backup Back", pos: "RB", team: "CAR", ecr: 50, adp: 50 })];
  const byeRoom = () => (
    <SnakeRoom league={LEAGUE} settings={SETTINGS} board={BYE_BOARD} leagueId={1} />
  );

  it("flags a candidate sharing a bye week with a same-position player I already own", async () => {
    // Bijan Robinson (RB/ATL) is already mine; Backup Back (RB/CAR) shares
    // ATL's week-3 bye per SCHEDULE_FIXTURE.
    useDraftStore.setState({
      leagueId: 1, syncing: false,
      picks: [{ pickId: 1, playerId: 1, overallPick: 1, mine: true, teamId: null, price: null, slot: null }],
    });
    renderInApp(byeRoom());

    await waitFor(() => {
      const r = within(list()).getByText("Backup Back").closest(".grid") as HTMLElement;
      expect(within(r).getByLabelText(/bye clash week 3/i)).toBeTruthy();
    });
  });

  it("does not flag a different position, or the owned player himself", async () => {
    useDraftStore.setState({
      leagueId: 1, syncing: false,
      picks: [{ pickId: 1, playerId: 1, overallPick: 1, mine: true, teamId: null, price: null, slot: null }],
    });
    renderInApp(byeRoom());
    // "hide taken" starts on and hides mine too, not just opponents' — toggle
    // it off so Bijan's own row is reachable to prove he isn't self-flagged.
    fireEvent.click(hideTaken());

    const backupRow = () => within(list()).getByText("Backup Back").closest(".grid") as HTMLElement;
    await waitFor(() => expect(within(backupRow()).getByLabelText(/bye clash/i)).toBeTruthy());
    // Ja'Marr Chase is a WR, not an RB — no position match.
    const chaseRow = within(list()).getByText("Ja'Marr Chase").closest(".grid") as HTMLElement;
    expect(within(chaseRow).queryByLabelText(/bye clash/i)).toBeNull();
    // Bijan Robinson is the owned player himself, still listed (mine players
    // aren't hidden here) — not his own collision.
    const bijanRow = within(list()).getByText("Bijan Robinson").closest(".grid") as HTMLElement;
    expect(within(bijanRow).queryByLabelText(/bye clash/i)).toBeNull();
  });
});

describe("SnakeRoom rookies-only filter", () => {
  const ROOKIE_BOARD = [...BOARD, player({
    id: 6, name: "Rookie Runner", pos: "RB", team: "CAR", vbd: 20, ecr: 60, adp: 60, rookie: true,
  })];
  const rookieRoom = () => (
    <SnakeRoom league={LEAGUE} settings={SETTINGS} board={ROOKIE_BOARD} leagueId={1} />
  );

  it("narrows to rookies only, and back, on click", () => {
    renderInApp(rookieRoom());
    fireEvent.click(screen.getByRole("button", { name: /rookies/i }));

    expect(within(list()).queryByText("Rookie Runner")).toBeTruthy();
    expect(within(list()).queryByText("Bijan Robinson")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /rookies/i }));
    expect(within(list()).queryByText("Bijan Robinson")).toBeTruthy();
  });
});

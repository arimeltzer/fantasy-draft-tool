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

/**
 * Roadmap 3.3. This exists because of what 3.1 got wrong: its survival margin
 * was fully unit-tested in the engine and wired into the simulator, and was
 * still DEAD in the product for a whole step — `npm run build` passed the
 * entire time, because build proves the types agree, not that the feature is
 * reachable. So the allocation ceiling gets an assertion that it actually
 * reaches the DOM.
 */
// A board deep enough to actually fill QB/RB/RB/WR/WR/TE/FLEX — the small
// 4-player BOARD fixture has no reachable roster at all (4 players against 7
// open starting slots), so EVERY candidate ceiling on it is legitimately $0.
// That is exactly the right fixture for proving the contradiction below is
// gone (a $0/pass player must not appear in "your targets"), and exactly the
// wrong one for proving what a real "bid $" looks like — for that, tests need
// a roster that IS reachable.
const POS = ["QB", "RB", "WR", "TE"];
const DEEP_BOARD = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1, name: `P${i + 1}`, pos: POS[i % 4], team: "XX",
  vbd: 100 - i, valuePoints: 120 - i, ecr: i + 1, adp: i + 1,
  age: 26, risk: 0.1, trend: 0,
})) as unknown as typeof BOARD;
const deepRoom = () => (
  <AuctionRoom league={AUCTION_LEAGUE} settings={SETTINGS} board={DEEP_BOARD} leagueId={1} />
);

describe("AuctionRoom budget path (roadmap 3.3-3.5)", () => {
  it('never lists a "target" that says pass — the contradiction this fixed', () => {
    // A target panel arguing with itself: this exact 4-player fixture used to
    // let a player rank in "your targets" purely on surplus (our dollarValue
    // vs. market) while the SAME row's primary suggestion read "pass" —
    // because surplus says "the market undervalues him" and says nothing
    // about whether he fits YOUR roster right now. Filtered at the source
    // instead: a "pass" player is not a target, full stop. With this
    // fixture nothing clears the allocation bar, so the panel should show
    // NONE rather than four contradictory rows.
    renderInApp(room());
    expect(screen.queryByText("No value targets.")).toBeTruthy();
    // Scoped to the nomination panel — the main BOARD legitimately shows
    // "pass" per row now too (the $Max column, added below), and that is
    // NOT the contradiction this test guards against.
    const panel = screen.getByText(/nomination strategy/i).closest("div")!.parentElement!;
    expect(within(panel).queryAllByText("pass").length).toBe(0);
  });

  it("shows the allocation-aware ceiling as the PRIMARY suggested bid", () => {
    // Reachability, not magnitude — the interesting arithmetic is covered
    // exhaustively in budget-path.selftest.mjs against brute force. What can
    // ONLY be checked here is that the number leaves the engine and reaches
    // the DOM at all, which is exactly what 3.1 failed to do while every
    // other test passed. Promoted from a secondary "max $" badge to the
    // primary "bid $"/"pass" once the auction-sim gate (roadmap 3.5) cleared
    // it against suggestBid() head-to-head.
    renderInApp(deepRoom());
    expect(screen.getAllByText(/^bid \$\d+$/).length).toBeGreaterThan(0);
  });

  it("explains the primary bid as allocation-aware, not a cash limit", () => {
    renderInApp(deepRoom());
    const first = screen.getAllByText(/^bid \$\d+$/)[0];
    expect(first.getAttribute("title")).toMatch(/reserves a realistic price/i);
  });

  it("keeps suggestBid()'s own number visible for comparison, as SECONDARY", () => {
    // 3.5's gate is what promoted the ceiling to primary; it did not measure
    // suggestBid() out of existence. Its number stays on screen, labeled, so
    // the two methods disagreeing is still visible rather than hidden.
    renderInApp(deepRoom());
    expect(screen.getAllByText(/^· model (\$\d+|pass)$/).length).toBeGreaterThan(0);
  });

  it("caps the ceiling by the room's money when opponents are broke (3.4)", () => {
    // Rich room: my own allocation is the binding constraint, no asterisk.
    useDraftStore.setState({ leagueId: 1, picks: [], syncing: false });
    const rich = renderInApp(deepRoom());
    const richBid = screen.getAllByText(/^bid \$\d+$/)[0].textContent;
    rich.unmount();

    // Two opponents have each blown $197 of $200 — nobody can bid.
    useDraftStore.setState({
      leagueId: 1, syncing: false,
      picks: [0, 1].map((t) => ({
        pickId: t + 1, playerId: 300 + t, overallPick: t + 1,
        mine: false, teamId: t, price: 197, slot: null,
      })),
    });
    renderInApp(deepRoom());
    const broke = screen.getAllByText(/^bid \$\d+\*$/)[0];

    // The asterisk marks money, not value, as what sets the price.
    expect(broke.getAttribute("title")).toMatch(/capped by the room's money/i);
    const brokeAmt = Number(broke.textContent!.replace(/[^\d]/g, ""));
    const richAmt = Number(richBid!.replace(/[^\d]/g, ""));
    expect(brokeAmt).toBeLessThan(richAmt);
  });

  it("computes a real rosterSize when the league rosters no K or DST", () => {
    // Regression. rosterSize summed r.K and r.DST with no fallback, so a
    // roster config omitting either (common — plenty of leagues skip the
    // kicker) made it NaN. That NaN reached leagueAvail inside dollarValues
    // and came out the other end as a literal "bid $NaN" in this panel. The
    // fixture roster has no K/DST; NaN can surface in either the primary
    // (ceiling) or secondary (suggestBid) number, so check the whole panel
    // rather than one specific text pattern that might legitimately be
    // absent (e.g. every target showing "pass" instead of a $ amount).
    renderInApp(room());
    expect(screen.queryAllByText(/NaN/).length).toBe(0);
  });

  it("shows the allocation ceiling on the MAIN BOARD, on a compact mobile badge", () => {
    // The actual moment the number matters in a live draft: someone
    // nominates a player, you search his name, and the board narrows to him
    // — a different place from the fixed-size "your targets" panel above.
    // On mobile the sm+ dedicated $Max column (checked below) is hidden for
    // space, so the same value is folded into the name's subtext line.
    renderInApp(deepRoom());
    fireEvent.change(screen.getByPlaceholderText(/search player or team/i),
                     { target: { value: "P7" } });          // "P7" alone: not a substring of P17/P27/P37
    const r = row("P7");
    expect(within(r).getByText(/^· (max \$\d+[*~]?|pass)$/)).toBeTruthy();
  });

  it("populates the $Max column for the WHOLE board, not gated on search", () => {
    // A DP over the whole undrafted skill-position pool sounds expensive —
    // `bidCeiling`'s own header warns against mapping it over the whole
    // board — but that warning predated any actual measurement. A real
    // benchmark (300 undrafted QB/RB/WR/TE, full DP each) comes in under
    // 90ms total, and it only recomputes on draft-state changes (a pick),
    // never on search/filter keystrokes — cheap enough to show for every
    // row unconditionally, which is what a user asked for after finding the
    // ceiling missing from the one place they actually look things up.
    renderInApp(deepRoom());   // no search filter: the whole 40-player board
    const r = row("P7");
    // Identified by title, since bare "$X"/"pass" text collides with $Par
    // and $Live's own bare "$X" text in the same row. jsdom renders both the
    // sm+ dedicated column AND the mobile inline badge regardless of
    // viewport (CSS media queries don't apply), so at least one — not
    // necessarily exactly one — is expected here.
    expect(within(r).getAllByTitle(
      /allocation ceiling|capped by the room's money|doesn't improve your best reachable roster|the most you can pay/i,
    ).length).toBeGreaterThan(0);
  });

  it('shows a REAL price, not "pass", when the ceiling is real but below market', () => {
    // Flagged directly: "There must be some price that would be worth
    // paying for the top players... why not display a price?" An earlier
    // version treated "the market will likely take him higher than my own
    // ceiling" as equivalent to "no price is worth paying" and hid the
    // number behind "pass" — conflating two different things. A positive
    // ceiling is always a real number worth knowing, win or lose; "pass" is
    // reserved for ceiling <= 0 (he does not help your roster at ANY price).
    renderInApp(deepRoom());
    const r = row("P7");   // a known belowMarket case on this fixture
    // jsdom renders both the mobile inline badge and the sm+ dedicated
    // column regardless of viewport — at least one of each style is
    // expected, not necessarily exactly one.
    const cells = within(r).getAllByTitle(/your real ceiling/i);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.some((c) => /^\$\d+~$/.test(c.textContent ?? ""))).toBe(true);
    expect(within(r).queryByText("pass")).toBeNull();
  });
});

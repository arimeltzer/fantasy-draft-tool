import { describe, it, expect, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderInApp } from "@/test/fixtures";
import type { LiveSyncResult } from "@/lib/api";
import type { useLiveDraft } from "@/hooks/useLiveDraft";
import LiveDraftPanel from "./LiveDraftPanel";

/**
 * The gap this fixes: Yahoo identifies "my team" by matching the OAuth
 * manager guid against the league server-side — no fallback, and (before
 * this) no visibility if it misses. A real Yahoo keeper pull hit exactly
 * this failure mode (YahooKeeperAutofill.tsx's fix). Live draft sync uses
 * the identical match with no correction path at all: a miss would
 * silently attribute every one of your own picks to an opponent's roster
 * for the whole draft. This pins the safety net — the diagnostic +
 * picker sync_draft's `meta.yahoo_teams`/`yahoo_my_team_key` now carry.
 */
type Live = ReturnType<typeof useLiveDraft>;

function fakeLive(meta: Partial<LiveSyncResult["meta"]> | null): Live {
  const lastResult: LiveSyncResult | null = meta ? {
    provider: "yahoo", fmt: "snake", on_the_clock: 1, added: [], added_count: 0,
    already_had: 0, unmatched: [], meta: meta as LiveSyncResult["meta"],
    current_nomination: null, applied: true,
  } : null;
  return {
    running: false, lastSyncAt: null, error: null, totalAdded: 0, busy: false, lastResult,
    start: () => {}, stop: () => {}, toggle: () => {}, syncOnce: async () => {},
  } as unknown as Live;
}

const SETTINGS = { teams: 10, roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 }, ppr: 1 } as never;

function renderPanel(meta: Partial<LiveSyncResult["meta"]> | null) {
  localStorage.setItem("fantasy_yahoo", JSON.stringify({
    accessToken: "tok", guid: "MEGUID", expiresAt: Date.now() + 3_600_000,
  }));
  renderInApp(
    <LiveDraftPanel
      leagueId={1}
      settings={SETTINGS}
      onClose={() => {}}
      live={fakeLive(meta)}
      config={{ provider: "yahoo", extId: "449.l.1" }}
      onConfigChange={() => {}}
      intervalMs={10_000}
      onIntervalChange={() => {}}
    />,
  );
}

describe("LiveDraftPanel — Yahoo team-match safety net", () => {
  beforeEach(() => localStorage.clear());

  it("warns and offers a team picker when the guid match found nobody", () => {
    renderPanel({ yahoo_teams: [{ key: "449.l.1.t.1", name: "The Gridiron Gurus" },
                                 { key: "449.l.1.t.2", name: "Dynasty Warriors" }],
                  yahoo_my_team_key: null });
    expect(screen.getByText(/Couldn't tell which team is yours/i)).toBeTruthy();
    const select = screen.getByRole("combobox", { name: /which team was yours/i }) as HTMLSelectElement;
    const optionText = [...select.options].map((o) => o.textContent);
    expect(optionText).toContain("The Gridiron Gurus");
    expect(optionText).toContain("Dynasty Warriors");
  });

  it("does not warn when the guid match already found a team", () => {
    renderPanel({ yahoo_teams: [{ key: "449.l.1.t.1", name: "The Gridiron Gurus" }],
                  yahoo_my_team_key: "449.l.1.t.1" });
    expect(screen.queryByText(/Couldn't tell which team is yours/i)).toBeNull();
    const select = screen.getByRole("combobox", { name: /which team was yours/i }) as HTMLSelectElement;
    expect(select.value).toBe("449.l.1.t.1");
  });

  it("shows nothing extra before any team check has run", () => {
    renderPanel(null);
    expect(screen.queryByText(/Couldn't tell which team is yours/i)).toBeNull();
    expect(screen.queryByText(/which team was yours/i)).toBeNull();
  });

  it("lets the user pick a team from the dropdown", () => {
    renderPanel({ yahoo_teams: [{ key: "449.l.1.t.1", name: "The Gridiron Gurus" },
                                 { key: "449.l.1.t.2", name: "Dynasty Warriors" }],
                  yahoo_my_team_key: null });
    const select = screen.getByRole("combobox", { name: /which team was yours/i }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "449.l.1.t.2" } });
    expect(select.value).toBe("449.l.1.t.2");
  });
});

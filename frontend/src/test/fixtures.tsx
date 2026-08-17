import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BoardPlayer } from "@/engine/engine-core.js";
import type { ApiLeague, LeagueSettings } from "@/lib/api";

/**
 * Shared scaffolding for draft-room tests.
 *
 * The rooms are leaves of the app but not of the provider tree — they call
 * useNavigate and useQuery — so every test needs a router and a query client or
 * the component throws on mount for reasons unrelated to the assertion.
 */
export function renderInApp(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** A board player with every field the rows read, overridable per test. */
export function player(over: Partial<BoardPlayer> & { id: number; name: string }): BoardPlayer {
  return {
    pos: "RB",
    team: "SF",
    age: 25,
    ecr: 10,
    adp: 10,
    aav: 30,
    injury: null,
    projPts: 200,
    priorEquiv: 190,
    valuePoints: 200,
    ageMult: 1,
    trend: null,
    rookie: false,
    risk: 0.1,
    vbd: 50,
    tier: 1,
    parValue: 30,
    dollarValue: 30,
    paid: null,
    adjValue: 30,
    ...over,
  } as BoardPlayer;
}

/** Four players across three positions — enough to exercise pos filtering. */
export const BOARD: BoardPlayer[] = [
  player({ id: 1, name: "Bijan Robinson", pos: "RB", team: "ATL", vbd: 90, ecr: 1, adp: 1 }),
  player({ id: 2, name: "Ja'Marr Chase", pos: "WR", team: "CIN", vbd: 80, ecr: 2, adp: 2 }),
  player({ id: 3, name: "Josh Allen", pos: "QB", team: "BUF", vbd: 40, ecr: 3, adp: 3 }),
  player({ id: 4, name: "Trey McBride", pos: "TE", team: "ARI", vbd: 30, ecr: 4, adp: 4 }),
];

export const SETTINGS: LeagueSettings = {
  teams: 10,
  budget: 200,
  ppr: 0.5,
  roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, BENCH: 6 },
  draftSlot: 1,
  opponents: ["Team Two", "Team Three"],
} as unknown as LeagueSettings;

export const LEAGUE: ApiLeague = {
  id: 1,
  name: "Test League",
  format: "snake",
  settings: SETTINGS as unknown as Record<string, unknown>,
} as ApiLeague;

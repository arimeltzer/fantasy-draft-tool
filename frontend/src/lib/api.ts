const BASE = import.meta.env.VITE_API_URL || "";

export interface ApiPlayer {
  id: number;
  season: number;
  name: string;
  pos: string;
  team: string;
  age: number | null;
  proj: Record<string, number> | null;
  last: Record<string, number> | null;
  last2: Record<string, number> | null;
  ecr: number | null;
  adp: number | null;
  aav: number | null;
}

export interface ApiLeague {
  id: number;
  name: string;
  format: "auction" | "snake";
  settings: Record<string, unknown>;
  created_at: string;
}

export interface ApiPick {
  id: number;
  league_id: number;
  player_id: number | null;
  overall_pick: number;
  mine: boolean;
  team_id: number | null;
  price: number | null;
  slot: string | null;
  ts: string;
}

export interface ImportReport {
  provider: string;
  format: "auction" | "snake";
  teams: number;
  team_names?: string[];   // real opponent team names, now in settings.opponents
  players_matched: number;
  players_unmatched: number;
  unmatched_sample: string[];
  mine_found: boolean;
  seeded?: boolean;
  scoring_note?: string;   // what scoring was/wasn't auto-detected (see Scoring settings)
}

export interface KeeperCandidate {
  player_id: number | null;
  name: string;
  pos: string;
  team: string;
  owner: string;
  is_mine: boolean;
  bid: number | null;
  round: number | null;
  waiver: number | null;   // top FAAB/waiver claim last year (price basis only)
  keeper_ineligible?: boolean;  // platform says this player can't be kept again
  matched: boolean;
}

/** What the pasted-Yahoo parse found, incl. anything to eyeball rather than
 *  trust (the keeper badge is derived from whitespace the copy leaves behind). */
export interface YahooPasteReport {
  teams: number;
  team_names: string[];
  picks: number;
  rounds: number;
  draft_slots: Record<string, number>;
  kept_detected: string[];
  undrafted_on_roster: string[];
  unresolved_draft_teams: string[];
  warnings: string[];
}

export interface WaiverReport {
  players: number;          // candidates carrying a waiver claim
  count?: number;           // raw transactions ESPN returned
  waiver_players?: number;  // players with a FAAB acquisition
  max_bid?: number;
  source?: string | null;   // which fetch strategy worked
  attempts?: string[];      // per-strategy outcome (diagnostics)
}

export interface KeeperCandidatesResult {
  fmt: "auction" | "snake";
  season: number;
  candidates: KeeperCandidate[];
  matched: number;
  unmatched: number;
  waivers?: WaiverReport;
  paste?: YahooPasteReport;   // present when sourced from a Yahoo paste import
  draft?: { picks?: number; auction?: boolean };   // Yahoo OAuth keeper pull
  kept_detected?: string[];   // players the platform says were kept (confirm, don't trust)
}

export interface LiveSyncResult {
  provider: string;
  fmt: "auction" | "snake";
  /** Next overall pick, from the highest CONTIGUOUS pick the platform published. */
  on_the_clock: number;
  added: { overall: number; name: string; pos: string; owner: string | null; price: number | null }[];
  added_count: number;
  already_had: number;
  /** Drafted names the player pool doesn't contain — reported, never dropped. */
  unmatched: string[];
  meta: { drafted?: number; resolved?: number; in_progress?: boolean };
  applied: boolean;
}

/** Cached ESPN keeper import, persisted in league settings (no migration). */
export interface KeeperImportCache {
  season: number;
  fetchedAt: string;
  candidates: KeeperCandidate[];
  waivers?: WaiverReport;
  /** Which importer produced this — the planner reopens the matching panel. */
  source?: "espn" | "yahoo-paste" | "yahoo";
  /** Parse report when sourced from a Yahoo paste (kept list, warnings, slots). */
  paste?: YahooPasteReport;
}

export interface KeeperRule {
  preset: "yahoo" | "espn" | "custom";
  label?: string;
  enabled: boolean;
  maxKeepers: number;
  basis: "price" | "round";
  priceSurcharge: number;
  undraftedRound: number;
  roundInflation: number;
  noConsecutive: boolean;
}

/** Per-stat-category scoring, everything except receptions (that's `ppr`,
 *  below — unchanged single source of truth so nothing double-edits it).
 *  Any field left unset falls back to the engine's standard default
 *  (engine-core.js DEFAULT_SCORING) — this is a fully optional override. */
export interface ScoringRules {
  ptsPerPassYd?: number; ptsPerPassTD?: number; ptsPerInt?: number;
  ptsPerRushYd?: number; ptsPerRushTD?: number;
  ptsPerRecYd?: number; ptsPerRecTD?: number;
  ptsPerFumble?: number;
}

export interface LeagueSettings {
  teams: number;
  budget: number;
  ppr: number;
  roster: {
    QB: number; RB: number; WR: number; TE: number;
    FLEX: number; K: number; DST: number; BENCH: number; SF: number;
  };
  superflex: boolean;
  draftSlot?: number;
  keeper?: KeeperRule;
  opponents?: string[];   // labels for opponent teams (auction budget tracking); index = team_id
  source?: { provider: string; extId: string };  // set on league import; drives keeper auto-fill
  keeperImport?: KeeperImportCache;              // cached prior-season pull (avoids refetching)
  scoring?: ScoringRules;  // per-stat scoring beyond PPR; drives valuations via resolveScoring()
  /** Overall pick numbers you own (snake). Set only when picks were TRADED —
   *  unset means standard serpentine order from `draftSlot`. */
  myPicks?: number[];
  /** Each team's draft slot, keyed by team name — imported from a Yahoo paste
   *  (round 1) or entered by hand. Lets opponent keeper predictions price a
   *  rival's forfeited pick from their REAL draft position. */
  teamSlots?: Record<string, number>;
  /** Per-team traded-pick overrides, keyed by team name. Wins over teamSlots. */
  teamPicks?: Record<string, number[]>;
  /** Traded picks as authored on the draft-order board: overall pick number ->
   *  owning team ("__me__" for yours). Only picks that CHANGED hands are
   *  stored. `myPicks` / `teamPicks` above are derived from this, never
   *  hand-edited — see `engine/draft-order.js`. */
  pickOwners?: Record<string, string>;
  /** Rounds in the draft. Defaults to one per roster spot. */
  rounds?: number;
}

function getToken(): string | null {
  return localStorage.getItem("fantasy_token");
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(opts.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json();
}

export const api = {
  login: (email: string, password: string) => {
    const body = new URLSearchParams({ username: email, password });
    return fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      body,
    }).then(async (res) => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || res.statusText);
      }
      return res.json() as Promise<{ access_token: string; token_type: string }>;
    });
  },

  me: () => req<{ id: number; email: string; display_name: string | null; is_admin: boolean }>("/api/auth/me"),

  players: (season = 2026) => req<ApiPlayer[]>(`/api/players?season=${season}`),
  sos: (season = 2026) => req<Record<string, Record<string, number>>>(`/api/sos?season=${season}`),
  schedule: (season = 2026) => req<Record<string, { week: number; opp: string }[]>>(`/api/schedule?season=${season}`),
  commonOpponents: (playerId: number, season = 2026) =>
    req<{ count: number; avgFp: number; games: { opp: string; fp2025: number; week: number }[] }>(
      `/api/players/${playerId}/common-opponents?season=${season}`
    ),

  leagues: () => req<ApiLeague[]>("/api/leagues"),
  createLeague: (data: { name: string; format: "auction" | "snake"; settings: LeagueSettings }) =>
    req<ApiLeague>("/api/leagues", { method: "POST", body: JSON.stringify(data) }),
  getLeague: (id: number) => req<ApiLeague>(`/api/leagues/${id}`),
  patchLeague: (id: number, data: Partial<{ name: string; settings: LeagueSettings }>) =>
    req<ApiLeague>(`/api/leagues/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteLeague: (id: number) => req<void>(`/api/leagues/${id}`, { method: "DELETE" }),

  importLeague: (data: {
    provider: "espn" | "yahoo";
    ext_id: string;
    season?: number;
    name?: string;
    espn_s2?: string;
    swid?: string;
    my_team?: string;
    access_token?: string;
    my_guid?: string;
    seed_rosters?: boolean;
  }) => req<{ league: ApiLeague; report: ImportReport }>("/api/leagues/import", {
    method: "POST", body: JSON.stringify(data),
  }),
  espnKeeperCandidates: (data: {
    ext_id: string;
    season?: number;
    match_season?: number;
    espn_s2?: string;
    swid?: string;
    my_team?: string;
  }) => req<KeeperCandidatesResult>("/api/integrations/espn/keeper-candidates", {
    method: "POST", body: JSON.stringify(data),
  }),
  /** Create a league from pasted Yahoo pages (no OAuth/credential needed). */
  importYahooPaste: (data: {
    name: string;
    draft_text: string;
    rosters_text: string;
    my_team?: string;
  }) => req<{ league: ApiLeague; report: YahooPasteReport & { provider: string; seeded: boolean } }>(
    "/api/leagues/import-yahoo-paste", { method: "POST", body: JSON.stringify(data) }),

  /** Yahoo keeper candidates with no API access — from pasted league pages. */
  yahooPasteCandidates: (data: {
    draft_text: string;
    rosters_text: string;
    match_season?: number;
    my_team?: string;
  }) => req<KeeperCandidatesResult>("/api/integrations/yahoo/paste-candidates", {
    method: "POST", body: JSON.stringify(data),
  }),

  espnProbeActivity: (data: {
    ext_id: string;
    season?: number;
    espn_s2?: string;
    swid?: string;
  }) => req<{ season: number; probes: Record<string, unknown>[] }>(
    "/api/integrations/espn/probe-activity", { method: "POST", body: JSON.stringify(data) }),

  yahooAuthUrl: () => req<{ url: string }>("/api/integrations/yahoo/auth-url"),
  yahooExchange: (code: string) =>
    req<{ access_token: string; refresh_token: string; guid: string; expires_in: number }>(
      "/api/integrations/yahoo/exchange", { method: "POST", body: JSON.stringify({ code }) }
    ),
  yahooLeagues: (access_token: string) =>
    req<{ leagues: { key: string; name: string; season: number; num_teams: number }[] }>(
      "/api/integrations/yahoo/leagues", { method: "POST", body: JSON.stringify({ access_token }) }
    ),
  yahooRefresh: (refresh_token: string) =>
    req<{ access_token: string; refresh_token: string; guid: string | null; expires_in: number }>(
      "/api/integrations/yahoo/refresh", { method: "POST", body: JSON.stringify({ refresh_token }) }
    ),
  yahooKeeperCandidates: (data: {
    league_key: string; access_token: string; match_season?: number; my_guid?: string;
  }) => req<KeeperCandidatesResult>("/api/integrations/yahoo/keeper-candidates", {
    method: "POST", body: JSON.stringify(data),
  }),

  syncDraft: (leagueId: number, data: {
    provider: "espn" | "yahoo"; ext_id: string; season?: number; match_season?: number;
    access_token?: string; my_guid?: string; espn_s2?: string; swid?: string;
    my_team?: string; apply?: boolean;
  }) => req<LiveSyncResult>(`/api/leagues/${leagueId}/sync-draft`, {
    method: "POST", body: JSON.stringify(data),
  }),

  picks: (leagueId: number) => req<ApiPick[]>(`/api/leagues/${leagueId}/picks`),
  addPick: (leagueId: number, data: { player_id?: number; mine: boolean; team_id?: number; price?: number; slot?: string }) =>
    req<ApiPick>(`/api/leagues/${leagueId}/picks`, { method: "POST", body: JSON.stringify(data) }),
  updatePick: (leagueId: number, pickId: number, data: Partial<{ player_id: number | null; mine: boolean; team_id: number | null; price: number | null; slot: string | null }>) =>
    req<ApiPick>(`/api/leagues/${leagueId}/picks/${pickId}`, { method: "PATCH", body: JSON.stringify(data) }),
  deletePick: (leagueId: number, pickId: number) =>
    req<void>(`/api/leagues/${leagueId}/picks/${pickId}`, { method: "DELETE" }),
};

export { getToken };
export const setToken = (t: string) => localStorage.setItem("fantasy_token", t);
export const clearToken = () => localStorage.removeItem("fantasy_token");

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
  players_matched: number;
  players_unmatched: number;
  unmatched_sample: string[];
  mine_found: boolean;
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
  opponents?: string[];   // labels for opponent teams (auction budget tracking); index = team_id
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
  }) => req<{ league: ApiLeague; report: ImportReport }>("/api/leagues/import", {
    method: "POST", body: JSON.stringify(data),
  }),
  yahooAuthUrl: () => req<{ url: string }>("/api/integrations/yahoo/auth-url"),
  yahooExchange: (code: string) =>
    req<{ access_token: string; refresh_token: string; guid: string; expires_in: number }>(
      "/api/integrations/yahoo/exchange", { method: "POST", body: JSON.stringify({ code }) }
    ),
  yahooLeagues: (access_token: string) =>
    req<{ leagues: { key: string; name: string; season: number; num_teams: number }[] }>(
      "/api/integrations/yahoo/leagues", { method: "POST", body: JSON.stringify({ access_token }) }
    ),

  picks: (leagueId: number) => req<ApiPick[]>(`/api/leagues/${leagueId}/picks`),
  addPick: (leagueId: number, data: { player_id?: number; mine: boolean; team_id?: number; price?: number; slot?: string }) =>
    req<ApiPick>(`/api/leagues/${leagueId}/picks`, { method: "POST", body: JSON.stringify(data) }),
  deletePick: (leagueId: number, pickId: number) =>
    req<void>(`/api/leagues/${leagueId}/picks/${pickId}`, { method: "DELETE" }),
};

export { getToken };
export const setToken = (t: string) => localStorage.setItem("fantasy_token", t);
export const clearToken = () => localStorage.removeItem("fantasy_token");

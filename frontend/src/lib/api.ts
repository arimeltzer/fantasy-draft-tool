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
  price: number | null;
  slot: string | null;
  ts: string;
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

  picks: (leagueId: number) => req<ApiPick[]>(`/api/leagues/${leagueId}/picks`),
  addPick: (leagueId: number, data: { player_id?: number; mine: boolean; price?: number; slot?: string }) =>
    req<ApiPick>(`/api/leagues/${leagueId}/picks`, { method: "POST", body: JSON.stringify(data) }),
  deletePick: (leagueId: number, pickId: number) =>
    req<void>(`/api/leagues/${leagueId}/picks/${pickId}`, { method: "DELETE" }),
};

export { getToken };
export const setToken = (t: string) => localStorage.setItem("fantasy_token", t);
export const clearToken = () => localStorage.removeItem("fantasy_token");

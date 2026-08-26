import type { StatLine } from "@/engine/engine-core.js";

export const BASE = import.meta.env.VITE_API_URL || "";

export interface ApiPlayer {
  id: number;
  season: number;
  name: string;
  pos: string;
  team: string;
  age: number | null;
  proj: Record<string, number> | null;
  /** Scoring/volume components, StatLine-shaped. `last` also carries a
   *  `team` string — the team this player was on for that season's last
   *  game (roadmap 1.3), added so the team-change discount doesn't need a
   *  second lookup. */
  last: StatLine | null;
  last2: StatLine | null;
  ecr: number | null;
  adp: number | null;
  aav: number | null;
  /** FantasyPros' OWN consensus tier — distinct from the app's own computed
   *  VBD-gap tier (`BoardPlayer.tier`, never stored, recomputed client-side).
   *  Null for a player FantasyPros didn't tier. */
  fp_tier: number | null;
  injury: InjuryInfo | null;
}

/** Reported injury, from the FantasyPros injuries endpoint (see the pipeline). */
export interface InjuryInfo {
  status: string;            // "Questionable" | "IR" | "OUT" | …
  short?: string | null;     // "Q" | "IR" | "O" | …
  type?: string | null;      // "Knee", "Achilles", …
  severity: "out" | "doubtful" | "questionable" | "note";
  chance?: number | null;    // probability of playing, when reported
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

/** One pick of a prior draft, whether or not the player is still rostered.
 *  `pos` is blank when ESPN's player lookup could not name a dropped player. */
export interface PriorDraftPick {
  ext_id: string;
  name: string;
  pos: string;
  team: string;
  bid: number | null;
  round: number | null;
  /** Overall pick / nomination order, when ESPN supplies it — confirmed real
   *  nomination order on the `current` league-API path (roadmap 3.7's
   *  precondition, data-pipeline/espn_draft_order_probe.py). Absent for Yahoo
   *  and for ESPN leagueHistory-path seasons that weren't checked. */
  overall?: number | null;
  owner: string;
  resolved: boolean;
  /** Which draft this pick came from. Lets calibration weight older seasons
   *  down and test whether the league's habits actually persist. */
  season?: number;
}

export interface KeeperCandidatesResult {
  fmt: "auction" | "snake";
  season: number;
  candidates: KeeperCandidate[];
  /** The FULL prior draft. `candidates` comes from end-of-season rosters, so
   *  it silently omits players who were drafted and later cut — fine for
   *  keeper eligibility, biased for learning what the room pays. */
  draft_picks?: PriorDraftPick[];
  draft_meta?: { picks?: number; resolved_from_rosters?: number; looked_up?: number; unresolved?: number; attempts?: string[] };
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
  meta: {
    drafted?: number; resolved?: number; in_progress?: boolean;
    /** Total pick slots ESPN returned, INCLUDING ones not yet made — for a
     *  live draft this can be the whole season's board (e.g. 160 for a
     *  10-team/16-round league) even on pick 1, distinct from `drafted`. */
    raw_pick_slots?: number;
    /** kona_player_info top-up diagnostics, present once the roster view has
     *  fallen behind and a top-up was attempted. */
    lookup?: { lookup_attempted?: number; lookup_found?: number; lookup_status?: string | number };
    /** ESPN's real live-draft WebSocket path (live_ws_registry.py). When
     *  present, this is the actual sync mechanism — `drafted`/`resolved`
     *  above come from it, not from REST draftDetail.picks (a static
     *  skeleton that can't reflect a live draft). */
    started?: boolean; connected?: boolean; last_error?: string | null;
    /** Set when the watcher failed to even START (bad cookies, my_team
     *  didn't match a team, draftSecurity rejected) — the sync fell back to
     *  the REST path (which can't show live picks) for this poll. */
    ws_start_error?: string | null;
    /** Present when `backfill: true` was sent — how many picks ESPN's REST
     *  roster-join resolved on this one-shot catch-up attempt (for picks
     *  made before the live channel connected). */
    backfill_resolved?: number;
    backfill_error?: string;
    /** Set once, at ingest-watcher creation, if team names / "my team"
     *  couldn't be resolved from ESPN's league data at all — every pick
     *  from then on comes through with no owner and is_mine=false. Used to
     *  fail completely silently; now surfaced so a mismatch or an ESPN
     *  league-fetch failure (mock drafts in particular don't reliably
     *  expose team data this way) is visible instead of just showing up as
     *  "wrong team" on the board with no explanation. */
    team_resolution_error?: string | null;
    /** Diagnostic for a wrong-team-assignment report: exactly what numeric
     *  team id/name mapping this app resolved, and the last few raw SOLD
     *  events (both team-id fields the wire protocol carries), so a
     *  mismatch against what actually happened in ESPN's own room can be
     *  pinned to a specific cause instead of guessed at. */
    my_team_id?: number | null;
    teams_by_id?: Record<string, string>;
    recent_events?: { player_id: number; nominating_team_id: number; winning_team_id: number;
                      price: number; name: string | null }[];
  };
  /** The player currently up for auction, resolved to OUR internal player
   *  id — tracked off BID, not NOMINATION (see the backend's
   *  LiveDraftWatcher.current_nomination_id docstring for why). null when
   *  nobody's currently up, the provider doesn't support this, or the name
   *  didn't match the player pool. */
  current_nomination: { player_id: number; name: string; pos: string; team: string } | null;
  applied: boolean;
}

/** Cached ESPN keeper import, persisted in league settings (no migration). */
export interface KeeperImportCache {
  season: number;
  fetchedAt: string;
  candidates: KeeperCandidate[];
  /** Full prior draft when the importer could supply it (ESPN). */
  draftPicks?: PriorDraftPick[];
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
  /** Pull projections toward ADP/ECR order where the market ranks a player.
   *  Defaults to ON — backtested better on the full board at every position.
   *  Set false for a pool carrying no market ranks, or to undo it mid-draft. */
  marketAnchor?: boolean;
  /** Weight on OUR model in that blend; 1 = pure model, 0 = pure market order.
   *  Defaults to MARKET_ANCHOR_W (0.3), which the sweep found flat-optimal. */
  marketAnchorWeight?: number;
  /** Blend veteran projections with the FantasyPros expert projection, in
   *  points space (roadmap 0.1). Defaults to ON — backtested better on both
   *  the matched-population and full-board merged Spearman at every
   *  position. Set false for a pool carrying no expert projections at all,
   *  or to undo it mid-draft. */
  expertBlend?: boolean;
  /** Discount the projection for CURRENT reported injury status, expected
   *  games missed (roadmap 0.3). Defaults to ON. QB/RB are backtested; other
   *  positions are untouched (INJURY_K), so this only ever affects a QB or
   *  RB with a reported status — set false to undo it mid-draft. */
  injuryDiscount?: boolean;
  /** Project TEs from volume x shrunk efficiency instead of the points-pace
   *  blend (roadmap Phase 1). Defaults to ON. TE is the only position
   *  shipped (OPPORTUNITY_K) — QB/RB/WR were swept and did not clear the
   *  kill gate against the live board, so they're always untouched. A TE
   *  with no usable volume data (a rookie) falls back to the points-pace
   *  model regardless — set false to undo the whole thing mid-draft. */
  opportunityModel?: boolean;
  /** Discount the projection when a player changed teams this offseason
   *  (roadmap 1.3). Defaults to ON. RB/WR are backtested (against both the
   *  pure model and the live board); QB passed the former but not the
   *  latter, TE/qb_change/coach_change/pace never cleared the merge bar at
   *  all — so this only ever affects an RB or WR whose `last.team` differs
   *  from their current `team`. A player with no prior-season team on
   *  record (a rookie) is untouched regardless — set false to undo it
   *  mid-draft. */
  teamChangeDiscount?: boolean;
  /** Adjust auction MARKET price forecasts for how this league actually spends,
   *  learned from `keeperImport` prices. Defaults to ON; inert without history.
   *  Never touches dollarValue — see engine/auction-calibration.js. */
  auctionCalibration?: boolean;
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
  /** Real auction $ values pasted from a FantasyPros cheat sheet (or any
   *  source), keyed by player id — a PER-LEAGUE override of the shared
   *  `fantasy_players.aav` column, since values genuinely differ by who
   *  copied the sheet and when (injury news, a league's own consensus, a
   *  mid-draft refresh). `marketPrice()` prefers this over the board's own
   *  `aav`. See `AavPasteImport.tsx` / `/api/integrations/fantasypros/
   *  aav-paste-candidates`. */
  aavOverrides?: Record<number, number>;
  /** When the override above was last pasted in, for the "as of" badge. */
  aavImportedAt?: string;
  /** A SECOND-OPINION display source, uploaded from The Athletic's
   *  projections workbook — keyed by player id, StatLine-shaped
   *  (passYd/passTD/int/rushYd/rushTD/rec/recYd/recTD). Roadmap 0.1b
   *  gated blending this into valuation the same way FantasyPros (0.1)
   *  is blended and it FAILED the full-stack check (QB/TE flip sign
   *  between validation seasons, RB/WR under 0.01 Spearman) — so this
   *  NEVER feeds valuePoints/marketPrice/any engine stage. useBoard
   *  computes a display-only points/rank from it under THIS league's
   *  own scoring, the same role `fp_tier` plays next to the app's own
   *  computed tier. See AthleticUploadImport.tsx / CLAUDE.md. */
  athleticProjections?: Record<number, Record<string, number>>;
  /** When the workbook above was last uploaded, for the "as of" badge. */
  athleticImportedAt?: string;
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
    /** Extra COMPLETED seasons of draft prices, for auction calibration only. */
    history_seasons?: number;
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

  /** Match report for a pasted FantasyPros auction-values sheet — no write,
   *  no admin gate. The caller merges `candidates` into their OWN league's
   *  `settings.aavOverrides` via `patchLeague`. */
  aavPasteCandidates: (data: { text: string; season?: number }) => req<{
    season: number; parsed: number; skipped_lines: number;
    candidates: { id: number; name: string; pos: string; team: string; aav: number }[];
    matched: number; unmatched: number; unmatched_names: string[];
  }>("/api/integrations/fantasypros/aav-paste-candidates", {
    method: "POST", body: JSON.stringify(data),
  }),

  /** Match report for an uploaded copy of The Athletic's projections
   *  workbook — no write, second-opinion display only (see LeagueSettings
   *  .athleticProjections). Multipart, so this bypasses `req()`'s JSON
   *  Content-Type: a browser-set boundary is required for FormData and
   *  fetch only supplies one when Content-Type is left unset. */
  athleticUploadCandidates: async (file: File, season = 2026) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${BASE}/api/integrations/athletic/upload-candidates?season=${season}`, {
      method: "POST",
      headers: { ...authHeaders() },
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || res.statusText);
    }
    return res.json() as Promise<{
      season: number; sheets_found: string[]; parsed: number;
      candidates: { id: number; name: string; pos: string; team: string; proj: Record<string, number> }[];
      matched: number; unmatched: number; unmatched_names: string[];
    }>;
  },

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
  yahooConfig: () => req<{
    client_id_set: boolean; client_secret_set: boolean;
    client_id_shape: { length: number; ends_with_dashes: boolean; looks_like_app_id: boolean };
    redirect_uri: string; scope_sent: string | null; scope_from_env: boolean;
  }>("/api/integrations/yahoo/config"),
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
    my_team?: string; apply?: boolean; enable_backend_ws?: boolean; backfill?: boolean;
  }) => req<LiveSyncResult>(`/api/leagues/${leagueId}/sync-draft`, {
    method: "POST", body: JSON.stringify(data),
  }),

  /** Kills the backend-owned WebSocket watcher for this league, if one is
   *  running — see live_ws_registry.py "Browser-side ingest" for why this
   *  matters (that path can trigger ESPN's multi-location kick). */
  stopLiveWatcher: (leagueId: number) =>
    req<{ stopped: boolean }>(`/api/leagues/${leagueId}/stop-live-watcher`, { method: "POST" }),

  /** Get-or-create this league's live-ingest bookmarklet token — see
   *  liveBookmarklet.ts. */
  getLiveIngestToken: (leagueId: number) =>
    req<{ token: string }>(`/api/leagues/${leagueId}/live-ingest-token`, { method: "POST" }),

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

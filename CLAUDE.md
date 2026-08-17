# CLAUDE.md — Fantasy Draft Assistant

Onboarding for AI/dev sessions. Read this first, then `docs/UPDATES.md` for the
running history. Keep both current as you work.

## What it is

A full-stack fantasy-football draft assistant for **auction and snake** drafts.
It uses Value-Based Drafting (VBD) to turn projections into dollar values
(auction) and pick recommendations (snake), with a strength-of-schedule (SOS)
adjustment and live auction inflation.

- Frontend (Vercel): https://fantasy-draft-tool-flame.vercel.app
- Backend (Railway): https://fantasy-draft-production-43ab.up.railway.app
- Repo: `arimeltzer/fantasy-draft-tool` — work on branch
  `claude/frontend-redesign-shading-wmmi33`, then fast-forward `main` (both auto-deploy).

## Layout

```
backend/            FastAPI + async SQLAlchemy (asyncpg) + Postgres, JWT auth
  main.py             all routes (auth, players, sos, schedule, leagues, picks,
                      admin, league import, yahoo oauth)
  models.py           ORM: User, League, Player, SosMult, Schedule, PlayerLog, DraftPick
  database.py         async engine/session (db_dep), create_all_tables
  sos.py              server-side SOS recompute for /api/admin/reload-sos
  integrations/       ESPN + Yahoo league import (see below)
frontend/           React + TS + Vite + Tailwind (light design system)
  src/engine/         engine-core.js (projection+VBD) · auction-engine.js
                      (dollarValues/marketPrice/suggestBid/nominationScore) ·
                      snake-engine.js (pickScore + per-slot configs) ·
                      valuation-engine.js (back-compat re-export shim) ·
                      strength-of-schedule.js ·
                      keeper.js (keeper-cost rule engine, node fixture-tested) ·
                      keeperReco.js (keeper selection recommender, node-tested) ·
                      draft-order.js (full pick-by-pick board + traded picks,
                      node-tested; myPicks/teamPicks are DERIVED from it)
  src/components/, pages/, hooks/, lib/api.ts, lib/posStyles.ts
data-pipeline/      offline data prep -> JSON -> Postgres
  ingest_nflverse.py  pull players/schedule/logs from nflverse
  projections.py      ECR/ADP + projections enrichment (nflverse free OR FantasyPros API)
  fantasypros.py      FantasyPros public API client (x-api-key): rankings + projections
  load_to_db.py       load JSON into Postgres (also bakes SOS multipliers)
  sos_backtest.py / sos_engine.py   empirical SOS tuning (validated vs JS)
  projection_model.py   Python port of engine-core.js projectPoints (parity-tested)
  projection_parity.py  asserts the port == the shipped JS — run after ANY change
  projection_backtest.py  the SHIPPED model vs a naive baseline, scored on rank
                      correlation (see docs/PROJECTION_BACKTEST.md)
```

## Data flow

nflverse + FantasyPros → `data-pipeline/*` → `data/*.json` → `load_to_db.py` →
Postgres → backend `/api/*` → frontend board. The frontend engine recomputes
VBD/auction values client-side from the player rows + league settings.

## Database tables

- `fantasy_players` `(season, name, pos, team, age, proj jsonb, last jsonb, last2 jsonb, ecr, adp, aav)`, uniq `(season,name,pos,team)` — `last2` = 2-years-ago totals for the projection blend; `aav` = FantasyPros consensus auction average value (drives `marketPrice()`, falls back to the modeled log curve when null)
- `fantasy_draft_picks` also has `team_id int` (opponent slot; index into `League.settings.opponents[]`, NULL for mine)
- `fantasy_schedule` `(season, team, week, opp)`, uniq `(season,team,week)`
- `fantasy_player_logs` `(season, player_id, week, opp, fp)`, uniq `(season,player_id,week)`
- `fantasy_sos` `(season, team, pos, mult)` PK `(season,team,pos)`
- plus `fantasy_users`, `fantasy_leagues`, `fantasy_draft_picks`
- Schema is created with SQLAlchemy `create_all` — it does NOT alter existing
  tables, so adding a column needs a manual migration on Railway. Migrations live
  in `backend/migrations/*.sql` — run the SQL on Railway **before** deploying code
  that reads the new columns, or the ORM will 500 selecting a missing column.

## Key commands

```bash
# frontend
cd frontend && npm install && npm run build      # tsc -b && vite build
node frontend/src/engine/engine-core.selftest.mjs # scoring/VBD engine tests
node frontend/src/engine/keeper.selftest.mjs      # keeper-rule engine tests
node frontend/src/engine/keeperReco.selftest.mjs  # keeper recommender tests
node frontend/src/engine/draft-order.selftest.mjs # draft board / traded picks
npm --prefix frontend run selftest                # all engine/board node selftests above
npm --prefix frontend test                        # vitest: mounts the draft rooms for real
# backend (needs DATABASE_URL etc.)
cd backend && uvicorn main:app --reload
# integration parsers (no net/db) — regression guard
cd backend && python -m integrations.selftest
# nickname alias tables (playerName.ts vs name_aliases.py) must not drift
cd data-pipeline && python name_parity.py
# projection model: port parity, then backtest (both pull from nflverse)
cd data-pipeline && python projection_parity.py && python projection_backtest.py
# SOS tuning (pulls 10 seasons from nflverse)
cd data-pipeline && python sos_engine.py && python sos_backtest.py
# load/refresh DB (run locally; needs Railway DATABASE_PUBLIC_URL)
cd data-pipeline && python ingest_nflverse.py && python projections.py \
  --base data/players_base.json --out data/players_base.json && python load_to_db.py
```

## Environment variables (Railway backend unless noted)

- `DATABASE_URL` — Postgres (use the Railway **public** URL for external scripts: `DATABASE_PUBLIC_URL`)
- `JWT_SECRET`, `JWT_ALGORITHM`, `ACCESS_TOKEN_EXPIRE_MINUTES`
- `ALLOWED_ORIGINS` — exact Vercel origin incl. `https://` (CORS)
- `ADMIN_EMAIL`, `ADMIN_PASSWORD` — auto-creates an admin user on startup if the email is new
- `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, `YAHOO_REDIRECT_URI`. `YAHOO_SCOPE`
  defaults to `fspt-r` — do NOT leave it unrequested: a token with no fantasy
  scope authenticates fine and then 401s every fantasy call with
  `additional_authorization_required`. `GET /api/integrations/yahoo/config`
  reports what's configured (no secret values).
- `FANTASYPROS_API_KEY` — for `projections.py` (pipeline); never commit it
- Frontend (Vercel): `VITE_API_URL` — backend URL incl. `https://` (build-time, embedded by Vite)

## Integrations

- **League import** (`backend/integrations/`): provider-agnostic — adapters turn
  ESPN/Yahoo payloads into a `NormLeague`; `matching.py` maps players to
  `fantasy_players`; `POST /api/leagues/import` creates a league + picks and
  returns a match report. Deterministic core is fixture-tested
  (`python -m integrations.selftest`).
  - **ESPN**: unofficial read API; public leagues need nothing, private need
    `espn_s2`/`SWID` cookies. Works (no app registration). See `backend/INTEGRATIONS.md`.
  - **Yahoo (no API)**: `integrations/yahoo_paste.py` imports from the Draft
    Results + Starting Rosters pages pasted as text — no credentials at all.
    Rosters define who's keepable, draft results give the round cost; the
    "was kept" badge survives copy-paste as whitespace (surfaced for
    confirmation, not trusted silently) and sets `keeper_ineligible`. Draft
    slots come from round 1 only (trades break serpentine).
    `POST /api/integrations/yahoo/paste-candidates`, UI in `YahooPasteImport.tsx`.
    `POST /api/leagues/import-yahoo-paste` creates the league and persists what
    the pages prove: `opponents` (real names) + `teamSlots` (every team's round-1
    slot) + your `draftSlot`. Scoring/roster shape aren't on these pages.
  - **Yahoo (OAuth)**: official OAuth2, LIVE. Needs `YAHOO_CLIENT_ID`,
    `YAHOO_CLIENT_SECRET`, `YAHOO_REDIRECT_URI` (+ `YAHOO_SCOPE=fspt-r`) on
    Railway. Import: auth-url → exchange → `/api/integrations/yahoo/leagues`
    → `/api/leagues/import`. Keepers: `/api/integrations/yahoo/keeper-candidates`
    reads the prior season's `draftresults` (round or auction `cost`),
    `transactions;types=add` (top winning FAAB bid per player — optional, a
    league without it degrades to draft-only) and Yahoo's `is_keeper` flag
    (surfaced for confirmation, not trusted silently). Same response shape as
    the ESPN keeper route, so the planner consumes either.
    Tokens expire in ~1h: `/api/integrations/yahoo/refresh` + `lib/yahooAuth.ts`
    persist and refresh the session (localStorage) so the import modal and the
    keeper planner share one consent.
  - **Team names**: `settings.opponents` and each opponent `DraftPick.team_id`
    are populated from the platform's real team display names
    (`integrations/base.py opponent_team_ids()`) — not generic "Team N" labels.
  - **Scoring**: only points-per-reception is auto-detected (ESPN statId 53,
    Yahoo stat_id 11 — both validated). Full per-stat scoring (pass/rush/rec
    yards+TDs, INTs, fumbles) is NOT auto-mapped from ESPN/Yahoo — their statId
    schemes for the rest are undocumented/unlabeled and a wrong guess would be
    a *silent* valuation bug, so it's left to the League Settings → Scoring
    editor instead (raw rules are still pulled + counted in the import report,
    just not category-mapped). See `docs/METHODOLOGY.md` §2.
- **Live draft sync** (`integrations/live.py` + `parse_live_draft` on both
  adapters, `POST /api/leagues/{id}/sync-draft`): follows a draft in progress and
  logs picks. **Polling, not push** — neither platform exposes its draft-room
  socket. Both adapters join the DRAFT endpoint (order/owner/price; ESPN
  `mDraftDetail`, Yahoo `draftresults`) to the ROSTER endpoint (names), since
  neither alone identifies who was taken; a pick whose player hasn't hit a
  roster yet is skipped and picked up next poll. The route is **idempotent by
  player**, so re-polling can't duplicate and keepers already logged are left
  alone. ESPN uses `fetch_raw_league` (ONE request) — never `fetch_league`,
  which sweeps 18 weeks of transactions. UI: `LiveDraftPanel.tsx` +
  `hooks/useLiveDraft.ts` ("Live" button in both rooms); unmatched names are
  reported, never silently dropped.
- **SOS reload** (`/api/admin/reload-sos`, admin-only): fetches the prior season
  from nflverse over HTTPS, recomputes multipliers with the tuned params, upserts
  `fantasy_sos`. Self-contained; no local run. See `data-pipeline/SOS_TUNING_RESULTS.md`.
- **FantasyPros API** (`data-pipeline/fantasypros.py`): fresh, scoring-aware ECR/
  ADP/AAV into the player rows (replaces the limited free nflverse snapshot).
  `fetch_aav()` pulls consensus auction average value (type=auction) which
  `auction-engine.js marketPrice()` uses directly when present, instead of the
  modeled logarithmic curve.
- **Scheduled data refresh** (`.github/workflows/refresh-data.yml`): runs the
  full pipeline (ingest → FantasyPros enrichment → load_to_db) on a recurring
  cadence — weekly (Mondays) most of the year, daily every day in August and
  September. Needs two GitHub repo secrets: `FANTASYPROS_API_KEY` and
  `DATABASE_PUBLIC_URL` (Settings → Secrets and variables → Actions). Can also
  be triggered manually from the Actions tab (`workflow_dispatch`).

## Duplicate players & name matching

- A duplicate board row is not cosmetic: drafting one copy leaves the twin
  looking available, so the pool and every scarcity/tier/replacement number
  drawn from it stay wrong for the rest of the draft.
- **Two causes, two passes.** (1) Team spellings — `fantasy_players` is unique
  on `(season,name,pos,team)`, so ARI vs AZ (or a blank team from a load without
  roster data) splits a player. Merged on `(canonical name, pos)`, ignoring team.
  (2) **Nicknames** — one feed says "Josh Palmer", the other "Joshua Palmer".
  Merged on the given name folded through `GIVEN_NAME_ALIASES`, but ONLY when
  the rows don't name different teams: folding alone would merge Michael Thomas
  (NO) into Mike Thomas (LAR). A visible duplicate is recoverable; a silent
  merge of two players deletes one.
- The alias table is curated, never algorithmic. "Same surname + same first
  initial" would fold every diminutive for free and also merge real players.
  Missing entries stay visible duplicates — the safe failure.
- It lives twice: `frontend/src/lib/playerName.ts` (board) and
  `backend/integrations/name_aliases.py` (importer + pipeline, imported by
  `data-pipeline/teams.py`). **`data-pipeline/name_parity.py` asserts they
  match** — add an entry to one only and CI fails.
- Import matching (`matching.py`) has the alias as its WEAKEST tier: unique
  candidate or outright team agreement, position-scoped, gives up on ambiguity.

## Roster discipline in the snake recommender

- `needMult` once gave every position a two-deep bench allowance
  (`have < starter + 2`). In a one-QB league that scored a THIRD quarterback at
  0.88 — the same depth credit as a third RB — and no gate blocked a fourth. A
  mock draft surfaced it: three QBs and three TEs recommended ahead of startable
  skill players.
- `maxUseful(pos, roster, superflex)` now caps it: QB `starters + 1` (`+2` in
  superflex), TE `starters + 1`, K/DST `starters`, and RB/WR bounded by the
  BENCH itself so deep leagues aren't blocked from a sixth back. Exceeding the
  cap is a hard gate; a one-starter backup also drops to 0.60 so it can't
  outrank a startable RB/WR. `snake-engine.selftest.mjs` pins both directions.
- Separately, `Recommendations.tsx` caps one position at 2 of the 6 panel slots.
  You make one pick, so the 3rd-best QB isn't a choice — it's the same choice
  repeated, and it used to fill four slots the round a gate opened.

## Gotchas

- Auth uses `bcrypt` directly (NOT passlib — breaks on Python 3.13).
- `VITE_API_URL` and `ALLOWED_ORIGINS` must include `https://` and match exactly.
- Railway applies new env vars only on a fresh **deploy** (not "Restart").
- External pipeline scripts: use `DATABASE_PUBLIC_URL`, not the internal URL.
- nflverse weekly stats live under release tag **`stats_player`** (not the old
  `player_stats`); the gzipped CSV is parser-friendly (parquet needs heavy deps).
- The frontend is an intentional **light** theme (semantic tokens in
  `tailwind.config.ts`); the old inverted-slate hack was removed — don't reinstate it.
- **`npm run build` does not prove the UI renders** — bare text is valid JSX, so
  a component whose list render was deleted still type-checks and bundles
  clean. That shipped once: the SnakeRoom player list was replaced by the
  literal token `ROW_MAP_PLACEHOLDER` during a perf refactor and the board
  rendered no players. Now covered two ways: `draft-rooms.selftest.mjs` is a
  static source check for that exact hole (no bare ALL_CAPS token in markup,
  every room maps its filtered pool into keyed rows); `SnakeRoom.test.tsx` /
  `AuctionRoom.test.tsx` (vitest + `@testing-library/react`, config in
  `vitest.config.ts`) actually mount each room with a real store + engine
  output and assert players appear, filters work, and a pick round-trips —
  both fail against the buggy commit and pass on the fix. `npm test` runs them;
  `.github/workflows/frontend-ci.yml` runs build + selftest + vitest on every
  push/PR touching `frontend/**` — there was no frontend CI at all before this,
  which is the other reason the bug reached main. After touching a room's
  markup, run `npm test` and actually look at the page.

## Keepers (built)

- **Engine**: `frontend/src/engine/keeper.js` — generic rule (`maxKeepers`,
  `basis` price-vs-round, `priceSurcharge`, `undraftedRound`, `roundInflation`,
  `noConsecutive`) + presets (Yahoo 1/round/R13/no-repeat, ESPN ≤3/price/+$7).
  `keeperCost()` computes this-year cost; node-tested (`keeper.selftest.mjs`).
- **UI**: `components/shared/KeeperPlanner.tsx` (Keepers button in both rooms);
  rule config in `SettingsDrawer`. Rule persists in `league.settings.keeper`.
- **Storage**: keepers are `DraftPick` rows tagged via the `slot` text field
  (`lib/keeperPick.ts`) — no migration. Removed from pool; auction price feeds
  budget + inflation; snake round is the pick that team forfeits. Reset-draft
  keeps them; snake pick-clock ignores them. All-teams (my + opponents').
- **ESPN auto-fill**: `POST /api/integrations/espn/keeper-candidates` reads a
  prior-season ESPN league's draft (bid + round via `espn.py`/`matching.keeper_candidates`,
  fixture-tested) and maps it to the current pool; `KeeperAutofill.tsx` pre-fills
  the planner from it. The keeper *rule* still comes from league settings.
- **Recommendation**: `keeperReco.js` scores KV = surplus + scarcity + fit and
  set-optimizes (can keep fewer than max/none). Snake surplus is draft-slot aware
  (forfeited pick from `myPickNumbers`, which honors `settings.myPicks` for
  traded picks); availability valued on a market order (ADP→ECR→rank) minus all
  keepers. `KeeperRecommendations.tsx` in the planner.
  `predictOpponentKeepers()` predicts each opponent's likely keepers from the
  ESPN import and removes them from the availability pool (editable in the UI);
  `KeeperAutofill` "Load my roster" seeds your whole roster as candidates.
  Rivals' forfeited picks are priced from `settings.teamSlots` (team → draft
  slot) / `settings.teamPicks` (team → owned picks, traded), falling back to
  mid-round only for teams with neither — auto-filled by the Yahoo paste import
  and editable on the draft-order board (below).
- **Import persistence**: both keeper importers cache into
  `settings.keeperImport` (`KeeperImportCache.source` = `espn` | `yahoo-paste`),
  so the analysis is restored — and re-fed to the recommender — when the planner
  reopens. Committed keepers are separate: they're `DraftPick` rows.

## Draft order & traded picks (snake)

- **Board**: `engine/draft-order.js` models the whole draft — every overall pick
  owned by exactly one team. Base ownership is serpentine from each team's slot
  (`slotByTeam` is a strict bijection, so bad/duplicate imported slots still
  draw); `settings.pickOwners` (overall pick → team, `"__me__"` = you) stores
  ONLY the picks that changed hands.
- **Derived, never hand-edited**: `derivePickSettings()` recomputes
  `settings.myPicks` / `settings.teamPicks` from the board on save, so the
  engines (`myPickNumbers`, `keeperReco.picksForOwner`) and the board can't
  disagree. No trades → all three cleared, i.e. plain serpentine.
- **UI**: `components/shared/DraftOrderBoard.tsx` (full-screen, "Order" button
  in `SnakeRoom`) — round-1 seating (changing a seat swaps, keeping the order a
  permutation), the full pick grid where clicking a pick reassigns it, and a
  picks-by-team summary. League Settings only links to it.
- **Rounds**: `settings.rounds`, defaulting to one per roster spot (`roundsFor`).
- **Renaming a team**: names are KEYS (`teamSlots`, `teamPicks`, `keeperImport`
  candidates) and values (`pickOwners`), and committed keeper `DraftPick` rows
  tag their owner by name in `slot`. `renameTeam()` carries all of it and keeps
  the team's index in `opponents` (that index is `DraftPick.team_id`);
  `applyOpponentNames()` does the same for a bulk edit, treating list position
  as identity. Rejected renames return the same object (empty / colliding /
  reserved `"Me"`). UI: click a name on the board, or edit League Settings —
  both rooms then rewrite keeper picks through `updatePick({ slot })`.
- Node-tested (`draft-order.selftest.mjs`, 66 assertions) — the load-bearing one
  is that an untouched board equals `snakePicks()` for every team at 8/10/12
  teams, so the new authoring surface can't drift from the existing pick math.

## Open threads / next up

- **Yahoo OAuth is live** (import + keeper auto-fill + token refresh). The
  paste importer stays as the no-credential fallback. Untested against a real
  Yahoo payload: `draftresults` / `transactions` / `is_keeper` parsing is
  fixture-tested only — verify field-by-field on the first live pull.
- **Keeper refinements** (optional): true serpentine slot forfeiture in snake
  (v1 removes the player + shows the round cost but doesn't reorder the exact
  picks). Draft slots and traded picks are handled, for you and per opponent.
- **FantasyPros**: AAV is wired (migration `002_add_aav.sql`); tier surfacing
  (FantasyPros tiers vs. the computed VBD-gap tiers) is still open.
- **ESPN/Yahoo full scoring auto-detect** (optional): currently PPR-only by
  design (see Integrations) — could be added for real if calibrated against a
  captured live payload cross-checked against the league's own scoring page,
  same evidence-driven approach that resolved the waiver-transactions endpoint.

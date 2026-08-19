# CLAUDE.md — Fantasy Draft Assistant

Onboarding for AI/dev sessions. Read this first, then `docs/UPDATES.md` for the
running history. Keep both current as you work.

**Planned work lives in `docs/ROADMAP.md`** — phased, with a pre-committed KILL
GATE on every step. Read the gate before starting a step and report against it
before shipping: the v2 touchdown experiment raised the model's incremental
signal 10-25%, moved the actual board +0.003, and was correctly not shipped.

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
                      snake-engine.js (pickScore; per-slot configs COLLAPSED,
                      see roadmap 0.2) ·
                      valuation-engine.js (back-compat re-export shim) ·
                      projection-opportunity.js (volume x shrunk efficiency,
                      TE only, roadmap Phase 1) ·
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
  apply_aav_paste.py  push a pasted FantasyPros auction-values sheet to the live backend
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
# the SHIPPED market anchor must equal the Python that was backtested
cd data-pipeline && python anchor_parity.py
# the SHIPPED expert-projection blend must equal the Python that was backtested
cd data-pipeline && python expert_blend_parity.py
# the SHIPPED injury discount must equal the Python that was backtested
cd data-pipeline && python injury_discount_parity.py
# the SHIPPED opportunity model (TE only) must equal the Python that was backtested
cd data-pipeline && python opportunity_parity.py
# the SHIPPED team-change discount (RB/WR only) must equal the Python that was backtested
cd data-pipeline && python team_change_parity.py
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
  ADP into the player rows (replaces the limited free nflverse snapshot).
  `fetch_aav()` is a confirmed, documented **no-op** — the public v2 API has
  no auction-shaped endpoint at all (see its own docstring); this note used to
  say otherwise and was wrong. Real AAV comes in via the paste importer below
  instead, into the same `aav` column `auction-engine.js marketPrice()` already
  prefers over the modeled logarithmic curve when present.
- **FantasyPros auction values, pasted** (`backend/integrations/
  fantasypros_aav_paste.py`): the website's auction-values cheat sheet, copied
  as text — same fix as the Yahoo paste importer, for the same reason (no API
  access). Parses through the shared `matching.py` index/matcher ESPN/Yahoo
  import already use. `POST /api/admin/fantasypros/aav-paste` (admin-gated,
  `dry_run` default — `fantasy_players.aav` is season-wide shared data, not a
  per-league setting) writes it. `data-pipeline/apply_aav_paste.py` is the
  thin client (reads the sheet from a file; a curl one-liner can't survive the
  `$` and apostrophes in it). No frontend UI — matches how `reload-sos` and
  `admin/refresh` are already operated, directly rather than through a UI.
- **Scheduled data refresh** (`.github/workflows/refresh-data.yml`): runs the
  full pipeline (ingest → FantasyPros enrichment → load_to_db) on a recurring
  cadence — weekly (Mondays) most of the year, daily every day in August and
  September. Needs two GitHub repo secrets: `FANTASYPROS_API_KEY` and
  `DATABASE_PUBLIC_URL` (Settings → Secrets and variables → Actions). Can also
  be triggered manually from the Actions tab (`workflow_dispatch`).

## Market anchoring (shipped, on by default)

- The board no longer ranks on the model alone. `engine-core.js marketAnchor()`
  pulls `valuePoints` toward ADP/ECR order **for the players the market ranks**,
  by rank transfer onto our own points ladder; players the market ignores (~45%
  of the board) keep their projection untouched.
- **Why**: backtested 2017–2025, ADP beats this model on the players it ranks at
  every position (0.648/0.652/0.535/0.650 vs 0.497/0.551/0.472/0.594). Anchoring
  the covered half beat the pure model on the FULL board by **+0.052 QB /
  +0.047 RB / +0.016 TE / +0.022 WR** Spearman, top-24 hit rate up 3–5 points.
- **Weight is one number, 0.3, for all positions** — the per-position optima
  (0.2–0.5) sit on a flat curve and a single 0.3 is within 0.001 of the best
  everywhere. Four constants fit on their own evaluation data would generalize
  worse. `settings.marketAnchor` / `marketAnchorWeight` override it.
- **Pipeline order is load-bearing**: `projectAll` → `applyOpportunityModel` →
  `applyInjuryDiscount` → `blendExpertAll` → SOS → `marketAnchor` → `finalizeBoard`.
  VBD/tiers/replacement must be derived LAST,
  from whatever valuePoints ended up as. useBoard previously had its own
  duplicate copy of the replacement maths (with its own FLEX_SHARE) used only
  on the SOS path; that is gone.
- **`data-pipeline/anchor_parity.py` asserts the shipped JS is numerically
  identical to `blend_with_market`** — equality, not tolerance, 2300 values over
  a weight × coverage sweep plus ties. Otherwise the app ships arithmetic nobody
  measured while the commit message quotes the measurement.

## Expert projection blend (shipped, on by default; roadmap 0.1)

- Veterans used to ignore `player.proj` entirely — `projectPoints()` only read
  it in the rookie branch, so the FantasyPros expert projection sat unused in
  the same row as the model's own pace-based estimate. `engine-core.js
  blendExpertAll()` blends the two, in POINTS space (not rank transfer — the
  market anchor already extracts order, so a second market-like source needs
  to contribute magnitude to be worth anything). Players the experts don't
  cover — no projection, or a projection of exactly 0, read as "no opinion"
  — keep the model's number untouched.
- **Weight is FOUR numbers, one per position** (`EXPERT_BLEND_W`: QB 0.3,
  RB 0.2, TE 0.2, WR 0.4; K/DST 1.0 — never backtested, stay pure model) —
  the opposite call from the market anchor. Backtested 2019–2025, the
  per-position optimum here is narrower and NOT flat across positions (QB and
  WR sit more than a full weight-step apart at the top of their curves), so a
  single shared constant would give up real, measured signal rather than
  simplify for free. See `docs/ROADMAP.md` 0.1 for the sweep.
- **Kill gate passed at every position, both halves**: matched-population
  Spearman beats plain ADP, and the full-board merged (with market anchor)
  number beats the pre-0.1 board — QB +0.030, RB +0.037, TE +0.044, WR +0.020.
- Rookies are skipped in `blendExpertAll` — `rookieProjection()` inside
  `projectPoints()` already uses `player.proj` FIRST, at higher priority than
  the model; blending it in again would double-count the same number.
- `settings.expertBlend` overrides it off (mirrors `settings.marketAnchor`).
- **`data-pipeline/expert_blend_parity.py` asserts the shipped JS is
  numerically identical to `blend_expert`** — same equality-not-tolerance
  treatment as `anchor_parity.py`, 1,080+ values over a coverage × weight
  sweep plus the rookie-skip and zero-as-no-opinion edge cases.

## Injury-aware expected games (shipped for QB/RB only; roadmap 0.3)

- `InjuryBadge` used to report status without touching valuation at all.
  `engine-core.js applyInjuryDiscount()` converts CURRENT reported status
  (`player.injury.severity`) into expected games missed and discounts
  `valuePoints` accordingly — same shape/units as `durabilityMult` inside
  `projectPoints()` (which reacts to LAST season's games played; this reacts
  to what's reported for THIS one), but built as a separate post-`projectAll`
  stage rather than baked into `projectPoints`/`project_points()` — baking it
  in would corrupt `projection_backtest.py`'s own `base_projs`/`shipped_projs`
  baseline on every future re-run, the same reason the expert blend lives
  outside `projectPoints()` too.
- **Precondition checked first, not assumed**: `injury_probe.py` — the
  injuries endpoint is a flat URL (year as a query param, unlike the
  path-embedded projections/rankings endpoints already verified genuine), and
  the only caller before this always passed the current season, so a
  historical `year` had never been exercised. Result: 6 of 7 tested seasons
  (2019–2025) were a real, dated, distinct-per-season report — precondition
  cleared. Also routed `fetch_injuries()` through the existing `_get_json` 429
  backoff for the same reason `fetch_projections` needed it.
- **Ships per position, not all-or-nothing.** Swept `k` (scales
  `INJURY_GAMES_MISSED`: out=6, doubtful=2, questionable=0.5 games) 2017–2025.
  QB and RB clear the kill gate at k=0.5 (`spearman_total` improves >0.002
  without `spearman_pace` degrading >0.002). TE and WR do not — every k>0
  tried degraded their pace correlation past the gate before total improved
  past it, meaning the discount there would be re-discovering
  `durabilityMult` rather than adding information. Shipped as
  `INJURY_K = { QB: 0.5, RB: 0.5, WR: 0, TE: 0, K: 0, DST: 0 }`; K/DST were
  never in the backtest population at all.
- **Pipeline placement**: right after `projectAll()`, BEFORE the expert blend
  — this corrects the model's own estimate of the player's production, the
  same category durability already occupies, so it belongs upstream of
  signals blended in from elsewhere. Not tested in combination with the
  expert blend (the backtest scored it against the pure model alone), so
  keeping it untangled from that blend matches what was measured.
- `settings.injuryDiscount` overrides it off (mirrors `settings.expertBlend`).
- **`data-pipeline/injury_discount_parity.py` asserts the shipped JS is
  numerically identical to `injury_multiplier`** — same equality-not-tolerance
  treatment as the other two parity checks, 1,350+ values over a coverage × K
  sweep plus the no-severity/unrecognized-severity/floor-at-zero edge cases.

## Opportunity projection (shipped for TE only; roadmap Phase 1)

- Points are volume × efficiency, and only one of those repeats: `projection_v2.js`
  already established touchdown RATE is close to random year over year while
  touchdown VOLUME is not. `frontend/src/engine/projection-opportunity.js`
  generalizes that one level further — instead of patching shrunk touchdowns
  onto the points-pace blend, it splits the projection into two independent
  stages: `projectVolume` (next season's opportunities — targets, for the
  one position shipped — blended the same trend-weighted, durability-
  discounted way `projectPoints()` blends points pace) then a shrunk
  points-per-opportunity RATE (`computeLeagueEfficiency` +
  `projectPointsOpportunity`, same empirical-Bayes construction
  `projection_v2.js` uses for touchdown rate, generalized from touchdowns-only
  to the whole rate — v2 left yardage alone on the assumption it's stable
  "over hundreds of events", not true for a 40-target committee receiver).
- **Measured TWO ways, and the second one changed the answer.** Swept
  2017–2025 against the pre-Phase-0 pure model (same isolation every other
  gate in this file uses) — QB/TE/WR all passed. Re-swept against what is
  ACTUALLY live (injury discount + expert blend already applied, at their
  shipped weights) — only TE still passed. QB and WR's gains nearly vanished:
  both are the positions `EXPERT_BLEND_W` trusts experts most (0.3, 0.4), so
  the opportunity model's signal there was mostly what the expert blend was
  already extracting. RB failed both measures, landing within 0.0003 of v2's
  already-rejected RB result each time. See `docs/ROADMAP.md` Phase 1 for the
  full table.
- **Ships as one number**, `OPPORTUNITY_K = { TE: 2.0 }`, everyone else 0
  (inert — always falls back to the points-pace model). K/DST have no clean
  "opportunity" concept; a TE with no prior-season volume (a rookie) also
  falls back — same coverage rule 0.1/0.3 use.
- **Pipeline placement**: right after `projectAll()`, BEFORE the injury
  discount / expert blend — it REPLACES the model's own point estimate for
  TE (not an adjustment like the other two), so it has to run first; the
  backtest that validated `OPPORTUNITY_K` measured exactly that order.
- **No parity required on `computeLeagueEfficiency`'s input data.** The
  Python backtest pools opportunity across every prior NFL season it can
  load; the browser pools across whatever the current board carries (each
  TE's `last` + `last2`) — a client-side engine has no multi-season
  historical dataset to reach for. That's a necessary difference in what
  data FEEDS the formula, not in the formula itself, which is what
  `opportunity_parity.py` actually checks (same rates table fed to both
  sides directly, same as `anchor_parity.py` supplies ranks directly).
- `settings.opportunityModel` overrides it off (mirrors `settings.expertBlend`).
- **The real 1.1 needed no migration.** `fantasy_players.last`/`last2` are
  already JSONB; `ingest_nflverse.py` carries `carries`/`targets`/`attempts`
  as plain extra keys (`VOLUME` dict, mirroring `projection_backtest.py`'s
  own), and `load_to_db.py` already writes `last`/`last2` through untouched
  — confirmed by reading the insert, not assumed.
- **`data-pipeline/opportunity_parity.py` asserts the shipped JS is
  numerically identical to `project_points_opportunity`** — same
  equality-not-tolerance treatment as the other three parity checks, on the
  one number that matters, `proj`.

## Team-change discount (shipped for RB/WR only; roadmap 1.3)

- Four candidate context signals — team change, QB change, coaching change,
  pace — swept **INDEPENDENTLY** (the roadmap's own instruction: measure
  each feature's incremental contribution before adding it, so one real
  signal can't hide behind three noise ones). `data-pipeline/team_context.py`:
  team via nflverse `recent_team`; starting QB as the attempts leader on a
  team that season (spot-checked against known rosters — 2022 CLE ->
  Brissett, 2023 CLE -> Flacco); head coach as the modal `home_coach`/
  `away_coach` per team-season (0% null, matched real coaching history);
  pace as (pass attempts + rush carries + sacks suffered) / games — all
  independently verified real before use, same discipline as the injury
  endpoint check in `injury_probe.py`.
- **Ships per position, one feature only.** Swept 2017-2025, measured TWO
  ways like 1.1/1.2 taught to: against the pure model (`team_change` cleared
  the merge bar at QB/RB/WR; `qb_change`/`coach_change`/`pace` never did, at
  any position) and re-baselined against the ACTUAL live board (injury
  discount + expert blend + anchor) — QB's `team_change` gain nearly
  vanished there (QB already carries an injury discount at k=0.5 AND the
  highest-trust-after-WR expert-blend weight, 0.3) but RB (+0.0038) and WR
  (+0.0062) held up.
- **k=0.25 was the top of a grid that hadn't turned over — re-swept twice,
  not guessed at.** The first-shipped k=0.25 was the best VALUE TRIED, not
  a found peak. Re-swept out to 0.5 against the live board: RB's numbers
  genuinely roll over past k=0.4 (a real peak, +0.0051 there vs +0.0038 at
  0.25); WR was STILL climbing at k=0.5 (+0.0108) with no peak found, so a
  second re-sweep out to 0.9 followed it further — WR's real peak turned
  out to be k=0.7 (+0.0115, the single largest effect size measured
  anywhere in this phase, decaying smoothly and monotonically on both
  sides). Shipped as `TEAM_CHANGE_K = { RB: 0.4, WR: 0.7 }` (QB/TE/K/DST
  stay 0) in `frontend/src/engine/team-context.js` — both are now found
  peaks, not edges of whatever grid happened to be tried.
- **A destination-quality nuance was tried and killed.** The natural next
  question — does WHERE a player landed matter, not just THAT he moved —
  was tested as `apply_team_change_quality()`: multiplier = `1 - k*(1 -
  quality_z)`, `quality_z` the new team's offensive EPA/play (from
  `load_team_stats`, spot-checked against 2023's real reputations: SF/BUF/
  DAL/MIA top it, NYJ/CAR/NE bottom it) z-scored against that season's
  league. Identical to the flat discount at `quality_z=0`. It made things
  WORSE, not better — underperformed the flat discount at every position,
  including RB/WR where the flat version is strongest. Not shipped in any
  form; the binary "did you move" signal turned out to be doing real work
  that a continuous quality read diluted rather than sharpened.
- **Two more destination-quality proxies were tried and killed the same
  way.** O-line quality (`nflreadpy.load_pfr_advstats`, 2018-2025 only —
  RB signal = yards-before-contact/carry, QB/WR/TE signal = pressure rate
  allowed) and contract commitment (`nflreadpy.load_contracts()`,
  `apy_cap_pct`, position-scoped z-score) — both verified real before use,
  both reusing the same `apply_team_change_nuance(..., signal_key, k)`
  shape as the EPA attempt. Motivated by whether the WR discount (70%) is
  overly punitive for movers into a good spot. Against the pure model,
  commitment looked promising at every position; against the bar that
  actually matters — beating the flat discount ALREADY shipped — both
  failed everywhere tested, and WR's best commitment result at any k is
  still *worse* than the flat 70% (-0.0013). A big new contract, like a
  good landing-spot EPA reading, does not mark a mover the flat discount
  is overcharging. Not shipped in any form; `TEAM_CHANGE_K = { RB: 0.4,
  WR: 0.7 }` unchanged. See `docs/ROADMAP.md` 1.3 follow-up #2 for the
  full table.
- **A first pass at `qb_change` was a bug, not a result.** It compared
  team_now's QB using ONLY season Y-1 data on both sides — trivially
  identical to `team_changed` whenever the team didn't change (same lookup
  key), which is why its first-run numbers were byte-identical to
  `team_change`'s at every k. Caught by that tell, fixed to compare the
  player's own Y-1 QB against team_now's Y-season attempts leader (the same
  "season Y's own outcome as a preseason-knowable proxy" reasoning
  `coach_change` already uses) before being measured for real — the
  corrected version still didn't clear the gate, so the fix changed the
  numbers, not the ship decision.
- **Pipeline placement**: right after `applyOpportunityModel()`, before the
  injury discount — the backtest measured it applied to the pure model's own
  point estimate, before injury/expert/anchor touch it. Disjoint from the
  opportunity model in practice (TE only there, RB/WR only here), so their
  relative order doesn't change either one's result.
- **No migration needed.** `ingest_nflverse.py` now writes `last.team` — the
  team a player finished LAST season on (their off_team in their final week
  of that season, i.e. a mid-season trade lands them on the team they ended
  with) — as one more extra key in the already-JSONB `last` blob, compared
  against the player's CURRENT `team` column. A player with no `last.team`
  on record (a rookie) is untouched, same coverage rule every other stage
  here uses.
- `settings.teamChangeDiscount` overrides it off (mirrors `settings.opportunityModel`).
- **`data-pipeline/team_change_parity.py` asserts the shipped JS is
  numerically identical to `apply_flag_discount`** — same
  equality-not-tolerance treatment as the other four parity checks, on the
  one number that matters, `valuePoints`.

## Auction calibration (shipped, on by default, inert without history)

- FantasyPros has **no auction endpoint** (`fetch_aav` is an explicit no-op), so
  `marketPrice()` is a generic log curve identical for every league — unless
  real AAV has been pasted in (see the paste importer above), in which case
  `marketPrice()` uses that directly. Real rooms aren't generic: a league that
  spends 46% on RB against a curve assuming 37% makes every back underpriced
  for you.
- `engine/auction-calibration.js` learns **positional spend shares** from prior
  draft prices already cached in `settings.keeperImport.candidates` (read today
  only for keeper costs). Not per-player prices — last year's price for a given
  player says little about this year's; the room's spending SHAPE persists.
- Guards that matter: shrink toward neutral by sample size (`SHRINK_K0 = 40`),
  refuse below `MIN_PICKS = 40`, **renormalize to spend-neutral** so the pot and
  the inflation tracker are unchanged, drop absent positions from the reference,
  clamp to [0.6, 1.6].
- **Applied to `marketPrice` only.** `dollarValues` takes no calibration
  argument at all, and a selftest asserts it — contaminating what a player is
  WORTH with what the room will PAY collapses the bargain signal.
- **Survivorship**: `candidates` is built from END-OF-SEASON ROSTERS joined to
  draft prices, so players drafted and later dropped are absent — a sample of
  the picks that worked. **ESPN now also returns the full draft**
  (`espn.parse_draft_picks` -> `draft_picks` on the keeper-candidates response
  -> `keeperImport.draftPicks`), and `picksFromKeeperImport` prefers it.
  `draftDetail.picks` names players by id only, so positions come from the
  rosters where the player survived and from a `kona_player_info` lookup where
  he didn't; that lookup is best-effort and never blocks an import, and picks
  it can't name are skipped rather than guessed. Yahoo/paste still fall back to
  the roster sample. `coverage` (priced picks / teams x rosterSize) measures
  what's missing either way; below 0.75 the badge turns amber with a `*`.
- **Multiple seasons** (`history_seasons` on the ESPN keeper-candidates route,
  `espn.fetch_draft_history` via the `leagueHistory` host): older drafts are
  pooled as SHARES, weighted `RECENCY_DECAY ** age` so a departed roster of
  managers can't outvote the current one. More seasons = stronger adjustment.
- **It tests its own premise.** `assessStability` predicts each season's shares
  from the OTHER seasons (leave-one-out) and compares against the generic
  split. Verdict is **per position**, not global — a league steady at QB/TE but
  swingy at RB passes a global test and RB gets confidence it hasn't earned
  (a selftest caught exactly this). A position whose share fails is shrunk with
  double the prior. Note the distinction the metric gets right: swings that
  stay on ONE side of generic are a real level shift and still count; swings
  that STRADDLE it carry no usable signal and get shrunk. One season leaves
  stability `null` = UNKNOWN, not fine.
- `topHeaviness` is computed and shown but **not applied**; acting on it needs a
  separately validated model of the curve's shape.
- `CalibrationBadge` states the sample and per-position effect, and reads
  "generic prices" when there's no history — never adjust prices silently.

## Rookie draft capital (tried, roadmap 1.4 — NOT shipped)

- Rookies with no FantasyPros projection fall back to an ADP/ECR decaying
  curve (`rookieProjection()`/`rookie_projection()`). Tested replacing that
  fallback with an empirical model: expected rookie-season pace as the
  historical mean for every other rookie drafted in the same ROUND (not a
  continuous pick curve — same "don't fit more than the data supports"
  discipline that collapsed the snake-slot configs, roadmap 0.2), fit
  leave-one-year-out from `nflreadpy.load_draft_picks()` (1,633 drafted
  skill players, 1,296 rookie-season pace rows — draft order spot-checked
  against 2023's real results first).
- **Result: worse than the fallback at every position, on every measure** —
  solo, partial-vs-ADP, and the full board merged (rookies anchored
  together with returning players, re-baselined against the live board).
  RB's partial correlation (holding ADP constant) came back numerically
  IDENTICAL between the two models — draft capital carries essentially no
  signal ADP doesn't already have for rookies, because ADP compilers
  already price the draft the same way this model does; asking round to
  out-predict a consensus largely derived FROM the round is close to
  asking a proxy to beat its own source. QB/TE couldn't even run the
  partial-correlation diagnostic most years — too few ADP-ranked rookies at
  those positions to clear its sample floor.
- Not shipped in any form; the ADP/ECR-curve fallback is unchanged.
  `data-pipeline/rookie_capital.py` (15 fixture-test assertions) stays in
  the repo as a documented negative result, same treatment every other
  killed idea in this file gets. See `docs/ROADMAP.md` 1.4 for the full table.

## Outcome distributions (built + validated, roadmap 2.1 — NOT wired in)

- `data-pipeline/outcome_distribution.py`. A player's predictive distribution
  is his live-board projection times the empirical sample of `actual/projected`
  ratios from a matched cell, fit on strictly prior seasons. Empirical not
  parametric (fantasy outcomes are strongly right-skewed); RATIO not absolute
  residual (errors are heteroscedastic — pooling absolutely would give the deep
  bench an absurd interval and the elite a too-tight one); ratios deliberately
  NOT clipped, since clipping hides the tail the whole thing exists to describe.
- Scored with **CRPS** as well as coverage, and that is load-bearing: interval
  coverage alone is gamed by widening (a `[0, ∞)` interval covers 100%). CRPS is
  computed exactly via the sorted sample's Gini mean difference closed form, and
  pinned in the selftest to a hand-computed case plus both directions of its
  properness. PIT is reported to locate *where* a miscalibration lives.
- **Age was named by the roadmap and does not survive the data** — it failed the
  pre-committed 1% CRPS bar at every position in both populations, four times
  making CRPS worse. Rank earns it at RB/WR/TE, not QB. Same lesson as 1.3,
  where three of four roadmap-named signals failed.
- **The quantile definition is load-bearing and is `type6`, not the familiar
  `type7`.** An empirical 80% interval built at position `q(n-1)` (Hyndman-Fan
  type7, numpy/R's default) spans `0.8(n-1)` of the `n+1` gaps a future
  observation can fall into, so its expected coverage is `0.8(n-1)/(n+1)` —
  0.761 at n=40, 0.796 at n=450, always short. `type6` (Weibull, `q(n+1)`) is
  exactly unbiased at every n, and "the interval achieves nominal coverage for
  a future draw" is precisely what the calibration gate measures. Don't
  "simplify" this back to numpy's default.
- **Not usable yet, and the reason is precise.** Coverage misses the
  [0.75, 0.85] gate in OPPOSITE directions depending on whether players who were
  drafted and then never played are counted as zeros: survivors-only leaves QB
  too narrow (0.743), adding busts back over-widens RB (0.866) and WR (0.882).
  Only TE passes both. cov50 and PIT are fine everywhere, so the centre is
  right and the problem is entirely the tails. That population choice is a real
  modelling decision, **not** a column to select after seeing the results, and
  it blocks 2.2. See `docs/ROADMAP.md` 2.1.
- **QB's narrowness was chased down and is the MODEL's fault, not the
  estimator's** (roadmap 2.1 follow-up b). Switching to the correct `type6`
  estimator moved it only 0.730 → 0.743. Thin fits are not the problem.
- **And it is not a fit-side problem at all** (follow-up c). A rolling-window
  sweep (W = 5/4/3/2 against the flat pool, conditioning held fixed) moved QB
  into the band only at W=3, landing exactly on the 0.750 boundary and
  non-monotonically — noise, not signal — while costing RB +2.4% and TE +1.5%
  CRPS, breaching the pre-registered 1% tolerance. Varying W at a fixed
  evaluation year also separates the confound (b) could not: **changing the fit
  barely moves anything, so QB coverage is driven by the EVALUATION SEASON, not
  by how the fit is built.** No window, decay, or extra history can fix it. QB
  seasons genuinely differ in dispersion, and one pooled ratio distribution
  cannot express that — the likely real cause is QB's starter/backup
  bimodality, which the other three positions don't share. Don't re-try a
  recency-weighted fit here; it is the same lever, already measured as inert.
- Nothing consumes these — the roadmap requires the calibration check to pass
  first. `outcome_distribution_selftest.py` (47 assertions) runs in the
  backtest workflow.

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

## Snake slot configs: collapsed (roadmap 0.2)

- `DEFAULT_SNAKE_PARAMS.SLOTS` held ten per-draft-slot configs (~100 fitted
  numbers) whose grid search was never in this repo — trustable, not auditable.
- `engine/draft-sim.mjs` tests them the only way left: out of sample, replaying
  identical leagues (common random numbers) and changing only the config.
  **+10.67 pts where they were fitted (mean/SE 4.24), +2.53 held out (1.16).**
  The gap IS the overfitting; `SLOTS` is now `{}`.
- The lookup in `resolveSlotConfig` is deliberately kept, so a per-slot config
  can return the moment one earns it on held-out evidence. `adpAbs`/`adpAbsCeil`
  are now inert — only slot 10 ever set `adpAbsActive`.
- Run it: the `Slot config test (roadmap 0.2)` workflow (needs the API key —
  opponent bots draft by real ADP, or the comparison is against a strawman
  sharing our own biases).

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

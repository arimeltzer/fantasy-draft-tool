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
  live_ws_registry.py process-global registry of ESPN live-draft WebSocket
                      watchers (one per league), used by sync_draft
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
  - **Those cookies are stored once and reused** (`lib/espnAuth.ts`, mirroring
    `lib/yahooAuth.ts`). Three screens need them — import, keeper auto-fill,
    live sync — and each used to hold its own `useState("")`, so the pair was
    re-pasted per screen AND after every reload (`liveConfig` is plain
    component state that starts null). Now: prefilled everywhere, saved only
    on a call that DEMONSTRABLY WORKED (successful import / keeper fetch /
    sync that returned a result rather than setting `live.error`) so a typo
    can't overwrite a good pair, and never half-saved — `saveEspnCreds`
    no-ops unless BOTH halves are present, since ESPN rejects one without the
    other and a half-save turns "missing cookies" into a confusing "bad
    cookies" failure. `EspnCredsNote` renders "Saved in this browser · Forget"
    under every cookie input, so the storage is never invisible.
    **localStorage, deliberately NOT the DB**: `League.settings` is returned
    by the leagues API on every fetch, so cookies there would ride to the
    client constantly and into anything logging a response, and a DB
    compromise would leak a live ESPN ACCOUNT session per user — not merely
    fantasy data. Same call `yahooAuth.ts` already made for a longer-lived
    refresh token. Cost is per-browser storage, stated in the UI.
    `espnAuth.test.ts` pins the refusals (half pairs, clobbering, corrupt
    records, storage disabled).
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
  - **Which team is MINE is a TIERED match, and has to be** (`base.py
    resolve_my_team()`). It used to be exact-only (`key in (id,
    name.lower())`), so a team name typed with different punctuation or
    spacing — or left blank — matched NOTHING, `is_mine` stayed False for
    every team, and `opponent_team_ids` excluded nobody: a 14-team league
    imported **14** opponents instead of 13. Both rooms then render "You"
    PLUS all 14, with the user's own team sitting there as a rival that never
    drafts anyone. Hit in practice. Now tiered like `matching.py`: exact
    id/name → punctuation/case-folded name → UNIQUE substring either
    direction, **refusing on ambiguity** (attributing MY picks to a rival is
    worse than a visibly wrong count). Folding punctuation is safe for TEAM
    names in a way it is NOT for player names — two teams in one league
    almost never collide under it, and the tie-break refuses when they do.
    `NormTeam.ext_id` exists solely so the exact tier can match a numeric
    platform team id. The import report's `mine_found` already surfaced the
    failure, but only as a one-line note at import time.
    **`parse_live_draft` had the SAME exact-only copy** and was missed on the
    first pass — fixed separately after a mock draft reported "trouble
    assigning teams"; both now share `resolve_my_team_index()` (raw
    `(id, name)` pairs, so the live path's payload dicts and the import
    path's `NormTeam`s use one implementation).
    **A THIRD, unmigrated copy — `espn.resolve_team_ids()`, the live-WS-
    watcher/live-ingest connect-time lookup — was missed by both prior
    passes** because it lives in `espn.py` itself, not `base.py`, with its
    own inline `mine_key in (id, name.lower())` check. Reported live on a
    real ESPN mock draft, in auto/live-sync mode: "it identified the other
    teams but not mine (probably name vs number for the mock)." A mock
    draft's default team has no custom name at all — `_team_name()` falls
    back to `f"Team {id}"` — so a stored display name that didn't
    byte-for-byte match that generic label failed the exact-only check;
    `teams_by_id` (built from every team unconditionally) was never the
    broken half, only `my_team_id` came back None, so every SOLD event's
    `is_mine` was False and none of the user's own picks were ever credited
    to their roster while opponents looked completely normal — the same
    "other teams fine, mine silently wrong" signature as the first two
    instances of this bug. Now shares `resolve_my_team_index()` too.
    `test_resolve_team_ids` in `integrations/selftest.py` pins it.
  - **A 404 from `fetch_league` is now a typed `LookupError`** with a human
    message, mapped to HTTP 404 at all three routes, instead of httpx's raw
    `Client error '404' for url <the whole query string>`. The cause people
    actually hit is the SEASON, not the id: the keeper screen defaults to
    `CURRENT_SEASON - 1`, so a league that didn't exist last year 404s while
    the id is perfectly correct for this year. **ESPN mock drafts 404 here in
    any season** — mock leagues are not in the season league API at all, which
    is the same root cause as the REST backfill returning zero picks for them.
  - **The rooms now also guard the invariant downstream**, because an
    already-imported league keeps the bad list: `DraftOverview` warns when
    `opponents.length >= teams` (arithmetically impossible — an N-team league
    has N-1 opponents) and points at League Settings. Deliberately a WARNING,
    not a silent auto-fix: `settings.opponents` is index-keyed by
    `DraftPick.team_id`, so dropping an entry silently would re-point other
    teams' logged picks. `DraftOrderBoard`/`orderWarnings` already warned
    about this on the snake side; the auction room, where it was actually
    hit, had no equivalent.
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
  `hooks/useLiveDraft.ts` ("Live" button in both rooms, hook lifted to the
  room component so closing the panel doesn't stop the poll); unmatched names
  are reported, never silently dropped.
  - **ESPN's roster lag isn't brief — verified against a real in-progress
    draft.** The original code assumed the roster view catches up within a
    poll or two; on a real draft already at pick 57, it had resolved ZERO
    picks. `fetch_and_resolve_live_draft()` tops up with `kona_player_info`
    (player-universe-wide, not roster-scoped) for whatever the roster hasn't
    named yet — the exact fix already proven for the SAME survivorship
    problem in the keeper-candidates draft-history path (`unresolved_pick_ids`
    + `player_info_url`), reused rather than reinvented. Best-effort: a failed
    top-up returns the roster-only state instead of losing the poll.
  - **That top-up initially still didn't work — a second, distinct bug.**
    `draftDetail.picks` on a LIVE draft pre-populates placeholder rows for
    the WHOLE season (`playerId <= 0` for slots nobody's taken), which a
    completed draft never has — so `meta["drafted"]` read the raw array
    length (160 for a 10-team/16-round league, even on pick 1) instead of
    picks actually made, and those same placeholder ids polluted the
    `kona_player_info` lookup's id list. Fixed by filtering to
    `playerId > 0` wherever ids are counted or looked up; the raw slot
    count is kept separately as `meta["raw_pick_slots"]`, never conflated
    with `drafted` again. `meta["lookup"]` (ids attempted/found, last HTTP
    status or exception type) now rides along in the sync response and
    shows in the panel, so a future silent top-up failure is visible
    without server log access.
  - **Fourth bug — not a lag at all, a frozen CDN cache.** A raw payload
    sample pulled from the still-broken sync showed round 1 pick 1 as
    `playerId: -1` on every poll, well past pick 57 — `draftDetail.picks`
    itself was stale, not just the roster join. `lm-api-reads` sits behind
    a CDN that was serving one cached snapshot to every poll. Fixed by
    cache-busting `fetch_raw_league` only (a per-request timestamp query
    param + `Cache-Control`/`Pragma: no-cache` headers) — `fetch_league`'s
    once-per-import calls don't need it.
  - **The real finding, confirmed by capturing ESPN's OWN draft-room
    traffic: `draftDetail.picks` is a static skeleton until the draft is
    FINALIZED, not a live feed — polling it harder was never going to
    work.** ESPN's own `mDraftDetail` request, mid-draft past pick 57, came
    back with picks as bare `{id, teamId: -1}` — no `playerId` key at all.
    Their own client isn't using this endpoint for live pick data either;
    it almost certainly gets that over a separate channel (WebSocket/
    SockJS), out of scope here. This is why `parse_draft_picks` (completed
    PRIOR-season drafts, used for keeper import) works fine — by season's
    end the array has long since been committed — while nothing mid-draft
    ever will resolve via REST polling. **Live sync while a draft is
    ACTIVELY in progress is a confirmed dead end for ESPN via REST**, left
    as-is (degrades safely, never blocks manual pick entry) rather than
    removed, since `parse_live_draft`/the top-up/cache-busting fixes are
    all real, correct fixes for real bugs that just weren't the actual
    blocker.
  - **ESPN DOES have a live push channel — a full HAR capture of a real
    mock draft found it: `wss://fantasydraft.espn.com/game-1/league-
    {id}/JOIN`, confirmed as ESPN's OWN client's actual live mechanism,
    not a guess.** `integrations/espn_draft_ws.py` decodes and
    fixture-tests its plain-text line protocol against real captured lines
    (`NOMINATION`/`BID`/`SOLD`/`PASSED`/`CLOCK`/`JOINED`/`PING`/`PONG`) —
    `SOLD <nominatingTeamId> <playerId> <winningTeamId> <price> <flag>` is
    the live "a pick just happened" event this whole effort was after.
    `INIT`'s blob (the full-draft-so-far backfill sent once on connect) is
    left undecoded on purpose — a client that joins mid-draft only sees
    `SOLD` events from that point forward, which is the accepted scope.
  - **The JOIN url's auth token is SOLVED — a real ESPN endpoint, not a
    derived hash.** First attempt tried to reverse-engineer the 5th query
    param (`gameId:leagueId:teamId:swid:<signed-32-bit int>`) as a
    Java-`String.hashCode()`-style function of the SWID; none of several
    candidates matched the one captured example, and a match from one data
    point wouldn't have been trustworthy anyway. A SECOND captured HAR —
    this one with response bodies — showed it isn't derived client-side at
    all: `GET .../teams/{teamId}/draftSecurity` (`espn.
    fetch_draft_security()`, same espn_s2/SWID cookies as every other
    authenticated call here) returns the bare integer directly. Confirmed
    against TWO independent real examples (different league/team/value),
    not just one endpoint existing — `fetch_player_info()` was factored out
    of the roster top-up so both it and the new watcher share one lookup.
  - **Now wired in.** `live_ws_registry.py` (process-global, single-uvicorn-
    worker assumption — see its docstring) keeps one `LiveDraftWatcher` per
    league running in the background; `sync_draft`'s ESPN branch calls
    `ensure_watcher()` on every poll (idempotent — a lock per league id makes
    concurrent polls converge instead of racing to start two) and reads
    `watcher.state()`. Falls back to the old REST path if cookies are
    missing, `my_team` can't be matched to a numeric team id, or the
    security-token fetch itself fails — best-effort, same discipline as the
    roster top-up before it. `start_overall` seeds new picks past whatever's
    already logged when the watcher first starts (forward-only — see the
    `INIT`-blob note above, so picks made before the watcher connects aren't
    recovered by this path, only new ones from that point on). A dead
    watcher (bad auth, ESPN closing the connection, draft ending) is not
    auto-retried; the next poll's `ensure_watcher()` call sees the finished
    task and starts a fresh one — the same "poll picks it back up" pattern
    this app already leans on everywhere else. `state.meta["ws_start_error"]`
    carries why a watcher failed to start, visible in the sync response.
  - **Fifth bug — the backend-owned watcher, working as designed, is itself
    the problem.** Confirmed live, not theoretical: a Railway-server-side
    WebSocket connection to ESPN's draft channel — even a FAILED attempt,
    never mind a successful one — trips ESPN's multi-location login
    protection and kicks the user's own browser session out of the draft
    room. Worse under polling: a poll that hits `connect_timeout` (5s)
    doesn't retry the SAME connection, it lets the NEXT poll's
    `ensure_watcher()` start a brand new one — so with auto-poll on, this
    was re-attempting every 5-30s, repeatedly hitting ESPN's check instead
    of tripping it once. `enable_backend_ws` on `LiveDraftRequest` is now
    OFF by default for exactly this reason; `POST
    /api/leagues/{id}/stop-live-watcher` kills any watcher already running
    for a league that got caught by this before the flag flipped.
  - **Browser JS can't just open this same connection client-side either —
    checked against the actual Web platform spec, not assumed.** The
    standard `WebSocket` constructor has no headers parameter at all, and
    `Cookie` is on the fetch spec's forbidden-header list even where
    headers ARE settable elsewhere — so neither a pasted `espn_s2`/`SWID`
    nor the browser's own cookie jar (blocked anyway by `SameSite` on a
    cross-site request, since our frontend's origin isn't `espn.com`) can
    authenticate a NEW connection opened from this app's own JS.
  - **What does work: read the connection ESPN's OWN client already opens,
    instead of opening a new one.** `frontend/src/lib/liveBookmarklet.ts`
    builds a bookmarklet — dragged to the bookmarks bar, clicked from the
    ESPN draft-room tab itself — that monkey-patches `window.WebSocket` in
    that page's own origin (already logged in, nothing new to flag) and
    taps the `SOLD` lines off whatever socket ESPN's page opens, POSTing
    each one to `POST /api/leagues/{id}/live-ingest`. Patching the
    constructor only catches connections opened AFTER the patch runs, so a
    page whose socket was already open before the click needs a reload —
    the bookmarklet's own `alert()` says so rather than silently missing
    picks. Backed by `live_ws_registry.ingest_sold_event()`, a second,
    independent `LiveDraftWatcher` accumulator per league (the class was
    already a pure accumulator agnostic to where events come from) fed by
    HTTP push instead of a live socket read; `POST
    /api/leagues/{id}/live-ingest-token` hands out the per-league secret
    the bookmarklet authenticates with (get-or-create, stable across calls
    — regenerating would silently break a bookmarklet already installed).
    Not JWT-authed, since the bookmarklet runs on ESPN's origin with no
    access to this site's localStorage — the high-entropy token in the
    request body IS the trust boundary, same model as a webhook secret.
    `sync_draft` prefers this source outright the moment it has any data,
    ahead of the backend-owned path, since it doesn't share that path's
    kick-out risk at all. `ALLOWED_ORIGINS` now hardcodes
    `https://fantasy.espn.com`/`https://fantasydraft.espn.com` in addition
    to the env-driven app origin, since the bookmarklet's `fetch()` call
    runs from ESPN's origin, not ours, and needs its own CORS clearance.
  - **The bookmarklet has a real, hit-in-practice flaw: it can defeat
    itself.** Patching `window.WebSocket` only affects connections opened
    AFTER the click — if ESPN's socket was already open (the normal case
    mid-draft), the fix is "reload the page." But a reload wipes ALL page
    JS state, the patch included, since it only ever existed in that one
    page instance. The result is an unwinnable race: a human reloading and
    re-clicking can't reliably beat ESPN's own script back to opening the
    connection. `frontend/src/lib/liveBookmarklet.ts buildUserscript()`
    solves this properly — the same hook, declared `@run-at document-start`
    in a Tampermonkey/Violentmonkey userscript, which is GUARANTEED to run
    before any of the page's own JS, every load, no race. `downloadUserscript()`
    triggers a normal browser download of the `.user.js` file (this runs
    inside our OWN app's page, not a sandboxed context, so `<a download>`
    works normally). Promoted to the primary recommended option in
    `LiveDraftPanel`; the bookmarklet is kept as a collapsed no-extension
    fallback with its limitation stated up front, not discovered the hard
    way again.
  - **Three more real installation gotchas, found by a user actually
    walking through it live, not anticipated in advance:**
    (1) A downloaded `.user.js` file double-clicked in Windows Explorer
    runs under Windows Script Host's ancient JScript engine (`.js` file
    association), not the browser — produces a classic WSH syntax error
    (`800A03EA`) that looks like a bug in the generated script but isn't
    one; the browser/Tampermonkey never saw the file. Fix: install via
    Tampermonkey's own Dashboard → Utilities → "Import from file", which
    sidesteps the OS file association entirely.
    (2) The draft-room UI likely runs inside an iframe on a DIFFERENT
    espn.com subdomain than the top-level page (the WebSocket target is
    `fantasydraft.espn.com`, not `fantasy.espn.com`) — Tampermonkey injects
    into every matching frame by default, but only if `@match` actually
    covers that frame's URL. Widened from `https://fantasy.espn.com/*` to
    `https://*.espn.com/*`; the hook's own `fantasydraft.espn.com` filter
    on which WebSocket calls to tap already keeps this safe on unrelated
    ESPN pages.
    (3) Modern Chrome added a SEPARATE "Allow User Scripts" toggle at
    `chrome://extensions` (Manifest V3's dynamic-code restrictions), which
    Tampermonkey needs ON TOP OF its own "Site access: On all sites"
    permission — a script can be correctly installed, correctly matching,
    and still never fire if only one of these two is set. Both are now
    called out explicitly in the panel's install instructions.
  - **Confirmed working end-to-end on a real live draft** — picks populated
    on the board in real time via the userscript path once all three
    installation gotchas above were resolved.
  - **Backfill for joining late** (`LiveDraftRequest.backfill`, "Backfill
    prior picks" button in `LiveDraftPanel`): the live-ingest path is
    forward-only by design (the WebSocket's one-time `INIT` backfill blob
    is deliberately left undecoded — see `espn_draft_ws.py`), so picks made
    BEFORE the userscript/bookmarklet connects aren't recovered by it. Full
    `INIT` decoding was considered and rejected as the fix: undocumented,
    protobuf-shaped from a raw look at it, and reverse-engineering it
    without a real capture to check against isn't something to attempt
    live during a user's actual draft. The cheap alternative instead: the
    EXISTING REST roster-join path (`fetch_and_resolve_live_draft`,
    already shipped as the plain fallback) resolves fine for picks that
    are no longer brand new — the "roster hasn't caught up" problem is
    specifically about picks seconds old, not ones from several minutes or
    picks ago. One-shot, not run every poll (still the same roster-lag-prone
    path that's a confirmed dead end for keeping up with LIVE picks) —
    merged into `state.picks` before the existing per-player dedup loop, so
    it's safe to call repeatedly with no duplication risk. Verified safe to
    merge two pick sources at all: pick-adding dedupes by PLAYER id, not by
    `overall_pick`, and nothing downstream (`SnakeRoom`'s pick clock keys
    off `picks.length`, not the stored number) depends on `overall_pick`
    being globally sequential — display views re-sort by it, so mismatched
    numbering between the two sources still renders in a sane order.
  - **`on_the_clock` was itself wrong, caught live: it was reading the
    ingest watcher's OWN isolated pick count, not the league's true
    total.** A real draft at pick 52 showed as "pick 36 on the clock" — the
    ingest watcher numbers picks by arrival order from a `start_overall`
    baked into the userscript at DOWNLOAD time, which goes stale the moment
    ANY picks land through another route afterward (backfill, or just
    Tampermonkey install friction delaying when the hook actually
    connects). `sync_draft`'s `on_the_clock` was built from
    `state.complete_through`, i.e. that same isolated counter, so it
    under-reported the moment the two sources diverged. Fixed twice: (1)
    `live_ingest` now computes `start_overall` fresh from an actual
    `DraftPick` count query at watcher-creation time instead of trusting
    the client-supplied value; (2) more importantly, `on_the_clock` is now
    `len(have) + 1` — `have` is the TRUE set of distinct drafted players
    known to the league after this poll (every source already funnels
    through the same per-player dedup loop), which is what "how far has
    the draft progressed" actually means in a normal draft, independent of
    whatever overall-numbering quirks any one source's `state.picks`
    happens to carry.
  - **Still wrong after that fix, caught live a second time: the fix only
    covered the CLOCK, not the number attached to each individual pick.**
    A real draft at pick 68 showed its most recent pick logged as "#56" —
    `added[].overall` and the stored `DraftPick.overall_pick` still came
    from `lp.overall`, i.e. the ingest watcher's own arrival-index
    counter, unchanged by the first fix. Root cause: `liveBookmarklet.ts`
    posts each `SOLD` event best-effort over `fetch()` — "a missed POST is
    retried never" — so a single dropped request (a backgrounded tab
    throttling timers, one momentary network blip) permanently
    undercounts that source's own arrival-index from then on, with no way
    for it to self-heal; the gap only grows. Fixed the same way as
    `on_the_clock`: each newly-added pick's `overall` is now `len(have) +
    1` at insertion time — derived from what's actually confirmed
    persisted, not from any source's own counter, so a dropped POST just
    means a gap in NAMES (a pick missing until "Backfill prior picks" or
    manual entry fills it), never a growing, silently-wrong number
    attached to every pick that comes after it. Existing already-stored
    rows from before this fix keep whatever number they were given —
    cosmetic-only (`DraftLogModal` still sorts and renders them, just not
    in perfectly-true order for that range), not worth a live renumbering
    migration mid-draft for the risk it'd carry.
  - **Both fixes still weren't enough — caught live a THIRD time: the app
    was showing pick 73 when ESPN's own room was on 88, a real 15-pick
    gap, not just a numbering artifact.** `len(have)` can only be as
    accurate as what's actually IN the database — and the transport
    feeding it was the real problem: `liveBookmarklet.ts` posted each
    `SOLD` event individually, fire-and-forget, no retry. A single dropped
    request (a backgrounded browser tab throttling its timers, one
    momentary network blip) silently and PERMANENTLY lost that pick, with
    zero recovery path short of "Backfill prior picks" — and over a full
    draft session that compounds into exactly this kind of growing gap.
    **Fix: turn the transport itself into something that self-heals.** The
    hook now keeps a full local history of every `SOLD` line it's ever
    parsed and resends the WHOLE array on every send — on each new pick
    AND on a 5s periodic timer, so even a quiet stretch with no new picks
    eventually retries anything still missing. A single dropped POST now
    delays that pick by one resend cycle instead of losing it forever.
    Only safe because the backend dedupes: `live_ws_registry
    .ingest_sold_events` (plural — replaces `ingest_sold_event`, kept as a
    thin back-compat wrapper for an already-downloaded script) tracks
    player ids already fed into a league's watcher in `_ingest_seen`, so
    replaying the same event hundreds of times over a draft is a no-op
    past the first. Deliberately NOT pushed down into
    `LiveDraftWatcher.on_event` itself — a selftest pins that a repeat
    SOLD there appends a second entry (tolerating whatever ESPN's own
    reconnect redelivery does), so the resend-specific dedup lives one
    layer up, in the ingest path only, rather than changing shared
    accumulator semantics the live WebSocket path also depends on.
    `LiveIngestEvent.events: list[dict] | None` is the new batch shape;
    the old singular fields stay Optional so a userscript downloaded
    before this change keeps working until it's re-fetched.
  - **The `SOLD` line's two team-id positions were WRONG from the start —
    caught live via a direct cross-check, not a second HAR.** The original
    field order (`SOLD <nominatingTeamId> <playerId> <winningTeamId>
    <price> <flag>`) was never independently verified against a
    known-correct answer, just plausible-looking from one captured
    example. A user hit visibly wrong team assignment (Ja'Marr Chase shown
    on the wrong team) and, on request, cross-checked three consecutive
    `SOLD` lines directly against ESPN's own draft room: the SAME team won
    all three players, matching the value at the position originally
    labeled "nominating" every time — while the position originally
    labeled "winning" held values (11, 12, 13) completely outside the
    league's real 10-team id range. Player id and price positions were
    separately confirmed correct in the same exchange (prices matched
    exactly) and are unchanged. Diagnosing this took building visibility
    first: `LiveDraftWatcher.state()` now exposes `teams_by_id`,
    `my_team_id`, and the last 10 raw events (both team-id fields) via a
    "Debug: team ID mapping" section in `LiveDraftPanel` — without that,
    this would have been unfindable from guessing alone. The third
    position's true meaning is still unconfirmed (kept as
    `nominating_team_id` for the field name only; nothing downstream
    treats it as authoritative). Fixed in both places that parse this
    line — `espn_draft_ws.py` (backend, used by the disabled backend-WS
    path and fixture-tested) and `liveBookmarklet.ts` (the hook that
    actually runs client-side for the live-ingest path) — they must be
    kept in sync since they parse the same wire format independently.
  - **Live nomination pinning** (auction only, requested after the field-order
    fix above): the player currently up for auction jumps to the top of
    `AuctionRoom`'s board automatically, so you don't hunt for them mid-bid.
    Tracked off `BID`, deliberately NOT `NOMINATION` — `NOMINATION`'s exact
    wire shape was never verified against a real example the way `SOLD`'s
    was, and `SOLD`'s field order turned out to be wrong once already (right
    above), so this avoids trusting another unconfirmed shape. The
    nominating team's own opening bid registers within a moment of the
    nomination in ESPN's own auction UI, giving effectively the same timing.
    `LiveDraftWatcher.current_nomination_id` / `set_current_nomination()`
    track it (same lookup-flagging pattern as `on_event`); `state()`
    suppresses a stale value once that lot's `SOLD` has actually landed
    (`current_nomination_id` only advances on the NEXT bid, so between a
    sale and the next nomination it would otherwise still point at whoever
    just sold). Resolved to OUR internal player id in `sync_draft` the same
    way a drafted pick is (via `match_player`), returned as a top-level
    `current_nomination` field the frontend can use directly, separate from
    the raw ESPN-side version still in `meta` for the debug view.
    `AuctionRoom`'s `filtered` list moves that player to the front WITHOUT
    overriding an active search/position filter — if they don't match what
    you're currently looking at, they simply don't show, same as any other
    player — plus a pulsing "Nominated" badge so it's clear why they moved.
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
- **FantasyPros tier surfacing (shipped, both rooms).** `fantasypros.py
  parse_rankings()` was already extracting each player's consensus TIER from
  the rankings payload — it just went unused past that point.
  `data-pipeline/projections.py` now writes it onto `p["fpTier"]`, the same
  enrichment pass as ECR/ADP (both the matched-existing-player path and the
  added-rookie path); `load_to_db.py` upserts it into a new `fp_tier` column
  (migration `006_add_fp_tier.sql` — run on Railway before deploying code
  that reads it, same discipline every migration here follows). Threaded
  through untouched — `PlayerOut` → `ApiPlayer.fp_tier` → `useBoard.ts
  toEnginePlayer` → `BoardPlayer.fpTier` — no engine stage reads or writes
  it, since every pipeline stage already spreads `{...p, ...}` and this
  rides along for free.
  **Deliberately NOT merged with the app's own computed tier**
  (`engine-core.js finalizeBoard`'s mechanical 18-VBD-point gap, per
  position, never stored — recomputed client-side every time). They answer
  different questions — FantasyPros' is an expert panel's judgment call,
  the app's is a fixed numeric rule — and blending them would hide
  disagreement that's useful to see. Both rooms show them side by side next
  to the player name: the existing gray `T{n}` badge (computed) plus a new
  indigo `FP{n}` badge (FantasyPros), each with its own tooltip explaining
  what it is and that they're independent.
- **FantasyPros auction values, pasted** (`backend/integrations/
  fantasypros_aav_paste.py`): the website's auction-values cheat sheet, copied
  as text — same fix as the Yahoo paste importer, for the same reason (no API
  access). Parses through the shared `matching.py` index/matcher ESPN/Yahoo
  import already use. Two write paths, because "AAV" means two different
  things:
  - **Per-league** (`AavPasteImport.tsx`, the "Values" button in
    `AuctionRoom`): `POST /api/integrations/fantasypros/aav-paste-candidates`
    (any signed-in user, no admin gate, no write) returns a match report; the
    frontend merges it into `settings.aavOverrides` via the existing
    `PATCH /api/leagues/{id}`. This is the one a user actually wants —
    values genuinely differ by who copied the sheet and when (injury news, a
    later cut mid-draft), and it doesn't require an admin account. First
    version of this feature shipped admin-only and global; a user went
    looking for it in the app and couldn't find it, which is what prompted
    rebuilding it this way. `marketPrice()` prefers `aavOverrides` over the
    board's own `p.aav`.
  - **Global baseline** (`POST /api/admin/fantasypros/aav-paste`,
    admin-gated, `dry_run` default): writes the shared season-wide
    `fantasy_players.aav` column directly — the fallback every league without
    its own override reads. `data-pipeline/apply_aav_paste.py` is the thin
    client for this one (reads the sheet from a file; a curl one-liner can't
    survive the `$` and apostrophes in it). Still no frontend UI for this
    path, matching how `reload-sos`/`admin/refresh` are operated.
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
  `history_seasons` was capped at 6 in both the UI and a hardcoded backend
  `min()`; raised to 15 for a user who wanted 10 years — `fetch_draft_history`
  itself has no such limit, each season is independent and best-effort.
  - **The fetch-per-season diagnostics existed but were never shown anywhere**
    — `KeeperAutofill.tsx` captured `draft_meta.history` into state and never
    rendered it, so a user pulling 9 seasons had no way to tell "it worked"
    from "it silently returned nothing." Added a summary line ("N of M
    seasons loaded") with full per-season detail on hover.
  - **That visibility immediately found a real gap it was built to catch**:
    2016-2017 came back `history:ok players:HTTP 404` — the league/draft
    itself resolved fine via `history_league_url`'s existing per-season→
    leagueHistory fallback, but the SEPARATE player-name lookup
    (`player_info_url`) had no fallback of its own, leaving most of those two
    seasons' picks unnamed (present, priced, but unmatched to a position —
    useless to the calibration model, which needs position to attribute
    spend). Fixed with `history_player_info_url`, the identical fallback
    pattern `history_league_url` already established, tried only after the
    per-season URL 404s.
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

## Rookies-only board filter (shipped, both rooms) — NOT the same idea as 1.4

- **Different question from the one above.** 1.4 asked "can we PROJECT
  rookies better"; this is "can the user FIND rookies on the board" — a
  user's own observation that "especially near the end of the draft it's
  worth drafting a rookie with upside over an equal veteran." No new
  modeling: `BoardPlayer.rookie` already exists on every row (set by
  `projectPoints()`'s rookie branch) and this is a pure filter over it.
- `BoardControls` gains a `rookies` toggle (both rooms already share this
  component) that composes with — does not override — search and the
  position filter, same as `hideDrafted`/`hideTaken` already do. Shows a
  live count of rookies still undrafted, so the button also answers "is
  there anyone left to find" before it's clicked.
- Explicitly NOT a ranking model or a separate "top rookies" list — the
  board's existing sort (VBD/value) already ranks rookies against
  everyone else; this only narrows WHICH rows show, using the exact
  projection the rest of the board already trusts (the ADP/ECR curve
  1.4 tried and failed to beat). A tooltip says so, so the numbers
  aren't mistaken for a stats-based measurement they can't be.
- **Reported live: "over broad — pulling in defenses and kickers."**
  `BoardPlayer.rookie` means "no `last`/`last2` to project from," which is
  the right signal for VALUATION (it drives risk and gates the expert
  blend) but is broader than "rookie" in the sense a drafter means when
  clicking this filter. A DST hits the same no-stats branch every year for
  reasons that have nothing to do with being a rookie — it's a standing
  team-level entity, there is no such thing as a rookie defense — and a
  statless K is almost always a journeyman cycling rosters, not the rare
  true rookie kicker. `engine-core.js isRookieFilterMatch(player)` narrows
  it to `rookie && pos !== "K" && pos !== "DST"`, re-exported through both
  `auction-engine.js`/`snake-engine.js` (the "convenience re-export"
  pattern already used for `rankByAdp` etc.) and used by both rooms' filter
  predicate AND their rookie count — display-only, `BoardPlayer.rookie`
  itself and everything downstream of it (risk, `blendExpertAll`'s skip)
  is untouched.

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

## Bye-aware lineup value replaces `byeClash` in the snake recommender (roadmap 2.4)

- **The idea, proposed directly while revisiting the (rejected) roadmap 2.3**:
  "a model that assumes the maximum lineup each week of the season accounting
  for byes. That will appropriately build in the need for bench depth without
  putting too much weight on a single week." Filed as 2.4, explicitly NOT a
  reopening of 2.2 (CLOSED — weekly OUTCOME DISTRIBUTIONS failed calibration)
  because this is deterministic: no draw, no distribution, the only source of
  week-to-week difference is the real bye schedule, which 2.2a's own
  pre-registration had already classified as "handled structurally... no
  lineup slot, no draw" rather than something needing a fitted distribution.
- `engine/bye-lineup-value.js`: `seasonLineupValue()` sums, over every week,
  the best legal lineup fieldable from a roster given real byes;
  `marginalLineupValue()` is what adding one candidate is worth;
  `byeLineupMult()` is the ratio of that marginal value WITH real byes to
  WITHOUT — a drop-in replacement for `byeClash`'s multiplier, expressed the
  same way so it composes into `pickScore` unchanged. Unlike `byeClash`
  (a penalty only), this can be a CREDIT above 1 — a bench body that covers
  a bye others don't is worth real points, which a pure collision penalty
  can never express.
- **Gated properly before shipping, using the harness this codebase already
  had** (`draft-sim.mjs`, common random numbers): `realizedWeeklyPoints()`
  sets each week's lineup from PROJECTIONS (what a manager actually has on
  Sunday morning) against the REAL bye schedule, and scores it on what each
  player ACTUALLY did that week (`fantasy_player_logs`-equivalent weekly
  data from the export pipeline) — avoiding the circular trap of scoring an
  agent on the metric it optimizes. Two arms: **deployment** (2.4 vs the
  shipped `byeClash`) is the ship/no-ship number; **isolation** (bye-aware vs
  an identical bye-BLIND control) checks whether there's a bye signal at all,
  independent of whether it beats the specific shipped heuristic.
- **A REAL harness bug was found building this, not a hypothetical one**:
  `simulateDraft` had never been passed a bye schedule at all, so `pickScore`'s
  `byeClash` step had **never fired in any simulation this repo had ever
  run** — every prior "shipped agent" backtest number in this document was
  quietly generated by a bye-blind agent. Fixed as part of this step
  (`simulateDraft` now takes `byeByTeam` and builds the same
  `live.byeByTeam`/`live.rosterByesByPos` pair `SnakeRoom.tsx` does); found
  because it made the bye-aware and bye-blind control arms return
  byte-identical rosters, which is the value of running a genuine isolation
  control rather than just a deployment number.
- **First gate (432 drafts, 9 seasons x 4 slots x 12 seeds): inconclusive.**
  Deployment +4.55 pts, mean/SE 1.30 (short of the pre-registered >2 bar).
  Isolation +7.46 pts, mean/SE 2.53 (a real signal). Read honestly as
  underpowered rather than null — the two means weren't far apart, which a
  clean null would not produce. **User's call: run bigger rather than ship
  early or discard the isolation signal.**
- **Second gate (1,800 drafts, 9 seasons x 5 slots x 40 seeds): CLEARS THE
  BAR on both arms.** Deployment +4.67 pts, mean/SE **2.83**. Isolation
  +5.95 pts, mean/SE **4.23**. Point estimates landed close to the first
  run's on both arms, and per-season signs were consistent across both runs
  (2017/2021 strongly positive both times; 2019/2020/2022/2023 negative or
  flat both times) — the same real, modest-sized effect, not a different one
  appearing under more samples.
- **Shipped as the default in `SnakeRoom.tsx`**: `live.byeLineupMultFor` is
  now built from `byeLineupMult()` fed real `minePlayers` + `byeByTeam` data
  whenever the schedule has loaded, and `pickScore` uses it in place of
  `byeClash` whenever it's present (presence-gated, not a hard swap — same
  "missing data skips the effect" contract every bye-aware field in this
  engine already follows, so a room still loading its schedule degrades to
  the old `byeClash` behavior rather than guessing). `byeClash` itself is
  UNCHANGED and still exported — it's the fallback, and the documented prior
  baseline the gate measured against.
- **Deliberately NOT extended to the auction `$Max` ceiling in the same
  change.** The gate validated a SNAKE drafting decision (which player
  `pickScore` picks next, replayed to realized weekly points) — a different
  selection mechanism from competitive dollar bidding under a budget.
  Reusing the same validated value function as a price multiplier inside
  `ceilingFor` (the same category of reuse as `maxUseful`/3.6c and
  `firstBackupBoost`/3.6e in a second consumer) is a smaller extrapolation
  than a new model, but it's still an extrapolation past what THIS gate
  measured — left as an explicit next step rather than folded in silently.
  See `docs/ROADMAP.md` 2.4.

## `$Max` never exceeds your own remaining money (auction)

- **The bug, reported live: "$Max should never exceed my remaining budget —
  it should be adjusted for distributing the money I have left. Otherwise it
  is causing me to overspend."** Correct, and it could. `bindingCeiling`
  composed exactly two constraints — MY allocation (3.3) and the ROOM's money
  (3.4) — and once starters filled, `ceilingFor` passed
  `allocationCeiling = market`, which is a property of the PLAYER. So in the
  bench phase nothing in the composition knew what the bidder could afford.
  Reproduced before fixing: market $35, $8 left with 5 slots to fill (real
  max bid $4), rich room → **$Max read $35, overstated by $31**.
- `bindingCeiling` now takes `budgetCeiling` as a first-class third
  constraint, returns `binding: "budget"` when it's the tightest, and treats
  `budgetCeiling <= 0` as a real verdict (no money, no bid) the same way
  `allocationCeiling <= 0` already was. Ties resolve toward the constraint the
  user can act on — "you can't afford more" beats "he isn't worth more".
  Omitting the argument reproduces the old behaviour exactly, pinned by a
  selftest, so the starter-phase path (already capped via `bidCeiling`'s own
  `budget: dpBudget`) is unchanged.
- Callers pass `maxBid(budgetLeft, openSpots)` — everything you hold minus the
  $1 each remaining slot still needs. **Roster depth therefore drives the
  cap and deeper is tighter** (flagged by the user: "some rosters are deeper
  than 13"): `rosterSize` is summed from `settings.roster` including BENCH,
  so nothing hardcodes a size, and the same money spread over more unfilled
  slots leaves less for any one player. A selftest pins the relationship and
  the $1 floor.
- Surfaced as a `!` marker in amber, distinct from `*` (room-capped) and `~`
  (below market), with a tooltip naming YOUR cash and slots rather than the
  player's worth — the point being that he may genuinely be worth more, you
  just can't pay it.

## `$Max` once starters are filled (auction)

- `bidCeiling`'s own header says bench slots are "$1 filler and are NOT in the
  DP" — a scoping call for the STARTER-slot knapsack, not a claim that bench
  players are worthless. `AuctionRoom.tsx ceilingFor` used to translate that
  into `allocationCeiling: null` once `openStartSlots` emptied out, and
  `bindingCeiling` treats `null`/non-finite as UNCONSTRAINED — falling
  through to "whatever the room can theoretically pay", the SAME
  undifferentiated number for every remaining player regardless of value. A
  real, hit-in-practice bug, caught by a user whose starters filled and
  `$Max` went to one fixed price with nothing in the targets panel — not the
  design working as intended.
- **A flat `$1` for everyone was tried as the fix and rejected on the spot**
  ("if I can get a player for $2 I should [see that]") — it would only trade
  one undifferentiated number for a different undifferentiated one. Shipped
  instead: `allocationCeiling = market` once starters are full. Every
  remaining pick is bench value at that point, and a bench player's worth
  IS his own market price — there's no more "does this beat an alternative
  for my last open slot" question for the DP to answer. `bindingCeiling`
  still caps it by room capacity exactly as before, so a $2 real bargain
  reads as $2, a $20 player still on the board reads as the real stash he'd
  be, and the two are distinguishable again.
- **This is a value fix, not a depth model, and a user caught the gap in the
  same breath**: bench slots have real strategic worth beyond standalone
  market price — bye-week coverage, injury-replacement insurance — that
  market price alone doesn't capture. `bye-weeks.js byeClash` already exists
  and is wired into the SNAKE recommender, but it's a COLLISION PENALTY
  (don't stack too many shared-bye players at one position), not the
  INSURANCE CREDIT this would need (reward depth you already have coverage
  for) — a genuinely different model, and nothing in this codebase currently
  prices injury-replacement value at all (the existing "injury discount"
  discounts a player's OWN projection from HIS OWN reported status, not the
  value of backing him up). Deliberately NOT improvised live mid-draft under
  the same discipline every kill gate in this file exists to enforce —
  flagged as real follow-up work, not shipped as a guess. The user offered
  multi-year draft data for their league, useful for this AND for
  `auction-calibration.js`'s existing spend-share model.
- **Scoped as roadmap 3.6** (bye coverage + injury-replacement credit, two
  separate kill gates). Checked first: whether this could build on Phase 2's
  outcome distributions, the textbook-correct foundation for insurance value —
  it can't. 2.2's WEEKLY distributions (the actual prerequisite) are CLOSED,
  both the base fit and the player-season form-factor follow-up REJECTED
  (weekly draws understated season variance 3-4x; the form factor explained
  under 12% of the missing variance at every position — the gap is
  game-script/matchup-level correlation, not something a form factor patches).
  3.6a (bye coverage) reuses `byeClash` directly, no precondition risk. 3.6b
  (injury-replacement) sidesteps the closed distributions entirely by using a
  DIRECT historical accounting instead of a predictive one — needs its own
  precondition check first (does nflverse distinguish started vs. inactive at
  the player level), same discipline `injury_probe.py` established for 0.3.
  See `docs/ROADMAP.md` 3.6 for the full pre-registration.
- **3.6c shipped separately, ahead of 3.6a/3.6b — a policy port, not a new
  model.** The user's own stated roster-construction rule ("once starters are
  filled, one backup per position including QB, then maximize WR/RB value;
  little value past 2 QB/TE or 1 K/DST") turned out to already be validated,
  shippable logic: it's exactly what `snake-engine.js maxUseful()` caps for
  the SNAKE recommender (QB/TE `starters+1`, K/DST `starters`, RB/WR
  bench-bounded). `AuctionRoom.tsx ceilingFor` now reuses it directly — once
  starters are full AND a position in `{QB,TE,K,DST}` is already at its
  `maxUseful` depth, `allocationCeiling` floors to `1` instead of `market`;
  RB/WR are excluded from the check and keep real market-based bench value,
  matching the "little value past N of these, but always value RB/WR depth"
  asymmetry the user described. No new kill gate needed — reusing an
  already-validated cap in a second consumer, not a new statistical claim.
  See `docs/ROADMAP.md` 3.6c.
- **3.6e — "one strong backup" ceiling BOOST (shipped), the mirror case
  3.6c never covered.** 3.6c stops over-DEPTH (a 3rd QB); it does nothing
  about under-depth, so a team's FIRST bench body at a position priced
  identically to its fourth. A user's own explicit priority #2 ("having one
  strong backup at QB, RB, and WR"), stated below priority #1 ("points over
  the season") — so this is a NUDGE, not an override. `budget-path.js
  firstBackupBoost(pos, have, roster)` returns `BACKUP_BOOST_MULT` (1.15 —
  the SAME constant `snake-engine.js needMult()` already uses for "below a
  starter slot," reused rather than invented) exactly when `have === starters`
  (zero bench bodies yet, not "under-filled," a real edge case a selftest
  caught) at QB/RB/WR specifically; TE/K/DST are excluded since `maxUseful`
  already owns their depth policy and a boost there would fight it, not
  complement it. `AuctionRoom.tsx ceilingFor` multiplies `market` by the
  boost once starters are full, still capped by the room and the wallet as
  always (`bindingCeiling`) — a `↑` marker (teal) shows only when the boost
  is actually what's binding, same discipline `belowMarket`'s `~` already
  uses. Surfaced in both the main board and the "your targets" panel.
- **Real-time bye-collision flag (shipped, both rooms) — a deliberately
  UNPRICED alternative to 3.6a, per an explicit user call**: "I don't want to
  overdo the bye week adjustments... make the model bye week aware so it
  will flag for me when I have another player at the same position with the
  same bye week? I can then make the decision in real time." `bye-weeks.js
  byeCollisions(pos, bye, roster)` returns every one of YOUR OWN players at
  the SAME position on the SAME bye week as a board candidate — looser than
  `byeClash`/`byeReport` on purpose: it fires even for a pairing that isn't
  costing a start yet (a 3rd RB on a bye already covered by a 2nd), which
  `byeClash` would score as `mult: 1`, no penalty, nothing to see. Wired into
  both `AuctionRoom.tsx` and `SnakeRoom.tsx` as a small amber `CalendarX`
  badge next to the player's name (same slot as the injury/risk icons),
  tooltip naming the week and the teammate(s) it clashes with. Pure display —
  did not touch `valuePoints`, `$Max`, or `pickScore` at the time it shipped
  (3.9 below is the first thing that touches auction `$Max`); the
  snake recommender's existing `byeClash` penalty (small, capped, tied to an
  actual starter shortfall) is unchanged. `RosterPanel`'s roster-wide "BYE
  CONFLICTS" summary (via `byeReport`) is also unchanged and answers a
  different question (which weeks leave a STARTER SLOT short) from this one
  (which specific candidate on the board shares a week with a player I
  already have).
- **`byeLineupMult` reused as an auction bench-phase `$Max` multiplier
  (shipped, roadmap 3.9)** — 2.4's own record explicitly left this as a
  named next step ("a smaller extrapolation than a new model... but still
  worth a separate explicit decision"), picked up directly: "would we test
  your first suggestion before implementing? worth a shot." Bench-phase
  `ceilingFor` (once starters are full) now composes THREE things instead
  of two: `atCap ? 1 : Math.round(market * backupBoost * byeMult)` —
  `byeMult` from `byeLineupMult(p, minePlayers, {...})`, the identical call
  shape `SnakeRoom.tsx` already uses. Presence-gated on `byeByTeam` exactly
  like every other bye-aware field in this codebase.
  - **A real harness gap was found and fixed while scoping this, not
    discovered after a bad result.** `auction-sim.mjs`'s bench-phase branch
    had NEVER modeled 3.6c's `atCap`/3.6e's `firstBackupBoost` at all — it
    returned `undefined` (unconstrained, room-ceiling-only) the moment
    starters filled, which is not what `AuctionRoom.tsx` actually does.
    Fixed for every simulator mode, not just the new one, so the "control"
    arm any gate compares against is the real shipped behavior. `3.5`'s own
    already-closed gate result is unaffected — that fix only touches the
    bench phase, never the starter-phase DP 3.5 measured.
  - **First gate pass (10 seeds, slots 1/4/7/10): underpowered, not
    null — same signature 2.4's own first run had.** calm +1.09 pts
    (mean/SE 1.43), early-overspend +1.89 pts (mean/SE 1.83) — both under
    the bar, but 7 of 9 seasons positive in BOTH buckets, a small
    consistent effect rather than the wild season-to-season swings that
    marked 3.8's genuine null. User's call, offered directly: run bigger
    rather than ship early or discard the signal — the same fork 2.4 faced.
  - **Second gate pass (35 seeds, slots 1/3/5/7/9, ~4.4x scale-up — the
    same ratio 2.4's own second run used): CLEARS THE BAR in both
    buckets.** calm +1.70 pts (mean/SE **4.55**), early-overspend +1.79 pts
    (mean/SE **3.88**), 3,150 simulated auctions total. Point estimates
    landed close to the first run's — the same real effect, not a
    different one appearing under more samples. Shipped as the default;
    `firstBackupBoost` and `atCap` are unchanged.
- **Diminishing RB/WR bench depth (tried in the AUCTION room, gate FAILED,
  REVERTED) — 3.6c's "always value RB/WR depth" call was flat all the way
  down, and a real mid-draft moment
  showed the gap: a live `$Max` of $4 (budget-capped) for a 6th RB with
  ZERO QB or WR at all.** Investigated as a possible live-sync roster
  miscount first (the same bug class 3rd-instance-fixed just above this
  section) — ruled out by hand-tracing `remainingStartingSlots`/
  `bidCeiling` and confirming in Node that a genuinely-surplus RB (5 have
  vs. 2 starters + 1 FLEX) already prices at `pass`, correctly, when
  QB/WR starters are still open. The real case, once clarified: starters
  WERE full (QB/WR each had their one starter, zero backups), so the
  bench-phase branch was live and RB/WR's uncapped-by-design policy
  applied uncritically — a real, budget-capped price for a 6th RB, not a
  bug, just a flat policy the user then refined in the same breath:
  "build a bench that is diverse and not overloaded at one position...
  a 4th player creates depth, a 5th and down has diminishing returns —
  especially at the expense of a 3rd WR/RB [the other position]."
  `budget-path.js benchDepthMult(pos, have, roster, siblingHave)`:
  `capacity(pos) = roster[pos] + roster.FLEX` (the most bodies startable
  at one position at once); full value through `capacity + 1` (the
  user's stated "4th player creates depth"); geometric decay
  (`BENCH_DEPTH_DECAY = 0.85`) per body past that; an EXTRA one-time
  discount (`BENCH_DEPTH_IMBALANCE_MULT = 0.85`) stacked on while the
  FLEX-sibling position (`FLEX_SIBLING`: RB↔WR) hasn't reached its own
  capacity yet — the exact "at the expense of the other position" case
  reported. TE excluded — already has its own hard `maxUseful` cap and
  isn't symmetrically part of the RB↔WR FLEX relationship this reasons
  about. Was composed into `AuctionRoom.tsx ceilingFor`'s bench-phase
  branch as a fourth multiplier (`market * backupBoost * byeMult *
  depthMult`); a `depthCapped` flag (same "only claim it when it's
  actually binding" discipline as `backupBoosted`) drove a `↓` marker
  (stone/gray) in both the main board's `$Max` column and the "targets to
  consider" panel. `budget-path.selftest.mjs` still pins the function
  itself — depth-slot boundary, decay, imbalance stacking (including the
  exact reported 5-RB/0-WR case), sibling-caught-up no-penalty case, every
  other position untouched — since the function survives (reused by the
  snake-side port below); only its use as an auction price multiplier was
  reverted.
- **Initial call — "no kill gate needed, same reasoning as 3.6c/3.6e" —
  was WRONG, caught on direct question ("do we need to do a deeper test on
  this, or are you comfortable with it?").** 3.6c/3.6e's no-gate precedent
  only covers REUSING an already-tuned constant in a second consumer
  (`maxUseful`'s caps, `needMult`'s 1.15 — both validated elsewhere
  first). `BENCH_DEPTH_DECAY`/`BENCH_DEPTH_IMBALANCE_MULT` (both 0.85) are
  BRAND NEW numbers, never measured — the same category as 2.4/3.9, which
  DID get real gates precisely because they introduced new numbers rather
  than reusing validated ones. Unlike 2.4/3.9, this shipped to
  `AuctionRoom.tsx` BEFORE the gate ran — a real process gap, corrected
  going forward: `auction-sim.mjs` gained a `"treatment-depth"` mode
  (identical shape to `"treatment-bye"`, `"treatment"` forced back to the
  pre-3.6f baseline so the comparison isolates one change), pre-registered
  in `docs/ROADMAP.md` 3.6f with the same mean/SE > 2, stratified
  calm/early-overspend bar every gate in this phase uses.
- **RESULT: FAILED both buckets — reverted the same day.** 3,600 paired
  auctions (10 seeds x 4 slots x 9 seasons x 2 scenarios), scored on
  realized weekly points: calm mean/SE **-0.08** (mean -0.02 pts,
  7/360 wins), early-overspend mean/SE **-0.33** (mean -0.03 pts, 6/360
  wins) — both essentially a coin flip, not just short of the >2 bar.
  `AuctionRoom.tsx`'s `ceilingFor` no longer applies `depthMult`; the
  `depthCapped`/`↓` marker is gone from `AuctionRoom.tsx` and
  `NominationPanel.tsx`. `benchDepthMult`, `FLEX_SIBLING`, and
  `"treatment-depth"` are left in `budget-path.js`/`auction-sim.mjs` as
  dead code (not deleted) rather than removed outright, since the
  snake-side port below reuses the exact function. This is the first
  instance in this codebase of a SHIPPED default being reverted by its
  own retroactive gate — the discipline held even though it meant undoing
  live product behavior, not just declining to ship something new.
- **Ported to the SNAKE recommender anyway, at the user's explicit
  request in the same message that authorized the auction gate ("we will
  also want to transfer a same roster construction concept to snake
  drafts") — built and gated the RIGHT way this time, opt-in from the
  start rather than shipped-then-tested.** `snake-engine.js needMult()`
  gained two trailing params, `depthAware`/`siblingHave`; past the
  existing "still useful bench depth" branch it multiplies by the SAME
  `benchDepthMult()` 3.6f used, gated behind `depthAware` which defaults
  falsy — every existing caller, and `pickScore` itself, is byte-identical
  to pre-port behavior unless `liveState.benchDepthAware` is explicitly
  set. `draft-sim.mjs` threads a matching `cfg.benchDepth` opt-in flag
  onto `live.benchDepthAware`, mirroring `cfg.byeLineup`'s existing shape.
  `snake-engine.selftest.mjs` pins the opt-in contract (absent/false is a
  no-op) and the mechanism (a 5th RB with zero WR scores below the
  flag-off baseline; the same 5th RB scores higher, though still below
  baseline, once WR reaches its own capacity; QB/TE are untouched since
  `FLEX_SIBLING` only maps RB↔WR). Gated via `snake-bench-depth-test.mjs`
  (paired comparison, `realizedWeeklyPoints`, stratified over the
  bot-`temperature` knob as the snake-side analogue of calm/
  early-overspend) BEFORE any wiring into `SnakeRoom.tsx` was considered —
  precisely because the auction side's gate came back negative for the
  identical underlying claim and constants, a real prior against this
  clearing the bar too.
- **RESULT: FAILED both buckets — WORSE than shipped, not merely null,
  never wired.** 864 paired drafts (12 seeds x 4 slots x 9 seasons x 2
  scenarios): calm mean/SE **-10.14** (-29.14 pts, only 12/432 wins),
  chaotic mean/SE **-6.80** (-18.65 pts, 13/432 wins) — every one of 18
  season/scenario cells individually negative. A materially worse result
  than the auction side's near-zero null. **Likely mechanism** (consistent
  with the result, not separately isolated): the auction's discount only
  changes the PRICE paid for a player — you can still win him, just for
  less, so a wrong discount mostly reallocates spend. `needMult`'s
  identical discount instead lands on the SELECTION score that decides
  which player gets drafted next — a genuinely valuable 5th RB can score
  below a worse alternative at another position and get skipped outright,
  directly corrupting roster construction rather than shifting cash. Never
  wired into `SnakeRoom.tsx`, and per this result, never should be with
  these constants. See `docs/ROADMAP.md` 3.6f-snake for the full numbers.
- **A design-issue objection to BOTH 3.6f gates, raised directly and
  confirmed correct: "bench players by definition won't move the needle
  much [in the harness], but [bench depth] provides the injury protection
  we skipped. If you randomized injuries to starters, I'll bet we would
  see a different result."** Checked against the actual scorer, not
  assumed: `realizedWeeklyPoints` benches a rostered player for exactly
  one reason, a BYE — the lineup is otherwise set by static season
  projection, so a bench player can NEVER start because a starter got
  hurt. Since bye coverage is already priced separately, any bench-depth
  comparison run on this harness is close to a foregone null by
  construction — a null there is not evidence the real-world effect is
  absent. **Precondition checked first** (same discipline as
  `injury_probe.py`/0.3, and exactly roadmap 3.6b's own named blocking
  precondition — "does nflverse distinguish started vs inactive at the
  player level"): checked directly against `nflreadpy
  .load_player_stats()`, 2019-2024 — real weekly OUT rates among startable
  players (a zero-stat-line week that isn't a bye) are QB 5.2%, RB 10.1%,
  WR 7.7%, TE 8.5% (1,983-4,980 player-weeks each), matching the known
  RB-misses-most/QB-misses-least NFL pattern. `draft-sim.mjs
  realizedWeeklyPoints` gained an optional `injuryOracle` argument (`
  makeInjuryOracle(seed, missRateByPos, weeks)`, `INJURY_MISS_RATE` holds
  the real rates) — absent by default, byte-identical to every existing
  call site (2.4, 3.9, both plain 3.6f gates). ONE oracle is built per
  gate run and shared across every roster scored in it — load-bearing:
  the same real player must draw the SAME weekly pattern on whichever
  arm's roster he lands on, or the draws themselves would inject noise
  the paired-comparison design can't tell apart from the treatment.
  `auction-depth-mult-injury-test.mjs` / `snake-bench-depth-injury-test.mjs`
  re-run the EXACT already-decided 3.6f/3.6f-snake comparisons under this
  oracle — robustness checks, not new gates, same bar for comparability.
- **RESULT: both sides confirm their plain-harness verdicts — the design
  gap was real, but it is not where either effect's absence or harm comes
  from.** Auction, injury-aware: calm mean/SE **+0.83** (flipped sign from
  the plain run's -0.08, still nowhere near the bar), early-overspend
  **-0.31** (was -0.33) — still indistinguishable from noise over 3,600
  injury-aware paired auctions with real per-position OUT rates giving
  bench depth many genuine chances to be needed. Snake, injury-aware: calm
  **-10.29** (was -10.14), chaotic **-7.00** (was -6.80) — still decisively
  WORSE, at essentially the SAME magnitude as the plain-harness result;
  injuries didn't rescue it even slightly, consistent with the mechanism
  theory above — the harm comes from the roster already being built wrong
  by draft's end, which giving bench players more chances to play in the
  SCORING step does nothing to fix. **The user's hypothesis was worth
  testing and the reasoning was correct** — the harness genuinely could
  not see injury-insurance value before this fix — **but the empirical
  answer is that neither 3.6f result was actually caused by that gap.**
  Both stay unshipped exactly as already decided; `injuryOracle` itself is
  a real, validated addition to the harness, kept for any future gate that
  needs it. See `docs/ROADMAP.md` 3.6f-injury-check for the full numbers.

## Frontend visual refresh (shipped, both rooms and every page)

- A full "card-forward" restyle: warmer palette (`tailwind.config.ts`'s
  `paper`/`surface`/`raised`/`line`/`ink`/`muted`/`faint`/`gold` tokens
  retinted, token NAMES unchanged so every existing class repaints for
  free), JetBrains Mono for numerics, rounded-2xl cards, solid-color
  position badges, pill-shaped header/filter/action controls. Started as a
  Claude Design canvas mockup (two sketched directions, "card-forward"
  chosen over "refined terminal"), then built into the real app: both
  rooms' headers/board rows/side panels, `BoardControls`, and every
  remaining page/modal (mechanical `gray-*` → semantic-token sweep +
  radius bump, `Login`/`LeagueList` hand-restyled in full since they're
  the first screens a user sees).
- **A real live bug, not caught by any existing test: the auction room's
  "Nominated" badge appeared to swallow the player name — reported as
  "only happens full screen, fixed when I make the window smaller."**
  That direction is the opposite of ordinary responsive truncation (more
  width usually means MORE room), which is what made it worth actually
  reproducing rather than guessing: built a static repro from the
  compiled Tailwind bundle and screenshotted it with Playwright at both
  widths. The real cause is the 3-column main grid
  (`lg:grid-cols-[280px_minmax(0,1fr)]` →
  `xl:grid-cols-[280px_minmax(0,1fr)_300px]`): crossing the `xl` (1280px)
  breakpoint ADDS a fixed 300px right rail while the whole page stays
  capped at `max-w-[1400px]` — so the center board column gets
  **narrower**, not wider, exactly at "full screen" on a display wide
  enough to clear `xl`. A "smaller" window below `xl` drops the right
  rail and hands the center column all the remaining space instead.
  Repro confirmed a real player-name row over-truncates (`Chri…`) at the
  narrower `xl` width and shows far more (`Christopher W…`) just below
  it, with the exact same content. Fixed by letting the name+badge line
  wrap (`flex-wrap` on the row it lives in, both rooms) instead of
  forcing the "Nominated"/tier badges and the player name onto one
  unbreakable line — badges flow to a second line under pressure, the
  name gets whatever room is left on the first, and `truncate`/`min-w-0`
  on the name span stay as a safety net for a name that still doesn't
  fit alone. Verified against the real compiled CSS bundle, not a
  from-scratch approximation, before shipping the fix.

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
  is shipped — see below.
- **ESPN/Yahoo full scoring auto-detect** (optional): currently PPR-only by
  design (see Integrations) — could be added for real if calibrated against a
  captured live payload cross-checked against the league's own scoring page,
  same evidence-driven approach that resolved the waiver-transactions endpoint.
- **This is a DRAFT-DAY app — there is no in-season state anywhere in it.**
  Worth knowing before scoping any Phase 4 (in-season) work: there is no
  `current_week`, no FAAB budget field, no rest-of-season projection path,
  and `DraftPick` rows are draft-day only — never updated for in-season adds
  or drops. `projectPoints()` projects a FULL season from prior-season
  totals; nothing re-projects from partial in-season data. Any waiver /
  start-sit / trade feature is an infrastructure build first and a model
  second, and should be estimated that way. See `docs/ROADMAP.md` 4.1.
- **FAAB history is already parsed, and is the one Phase 4 precondition that
  IS cleared** — `espn.all_waivers()` returns `playerId -> winning bid`,
  merging the league ACTIVITY feed (`messageTypeId` 180, `from` = winning
  bid) with the `transactions` array's `bidAmount`; Yahoo carries the same
  via `faab_bid`. Both ship today (they feed the keeper price basis) and
  `fetch_draft_history`'s `leagueHistory` fallback reaches many seasons of
  it. That makes roadmap **4.1a** (league FAAB spend calibration, the direct
  analogue of `auction-calibration.js` — same shrink / recency-decay /
  per-category leave-one-season-out structure) the one part of 4.1 buildable
  today. 4.1b (per-claim value) needs the in-season infrastructure above;
  4.1c (ΔP(title) pricing, the roadmap's literal ask) is blocked on 2.3,
  which is itself gated on an unrun feasibility probe.

# Updates Log

Reverse-chronological record of notable changes so a new session can see what
happened and why. Newest first. Add an entry per meaningful chunk of work
(commit refs in parentheses).

---

## 2026-07 — Import→keeper chain + add/confirm opponents' keepers
- **Import remembers its source.** `POST /api/leagues/import` now stores
  `settings.source = {provider, extId}` on the created league. The keeper planner
  reads it and **pre-fills + auto-fetches** the prior season's ESPN draft
  (`KeeperAutofill` `source` prop; ESPN league ids are stable across seasons, so
  last year = same id at `season−1`). Public leagues load automatically; private
  ones 401 and prompt for cookies.
- **Add / confirm opponents' keepers.** The recommender's opponents panel now
  shows **confirmed** keepers (ones you entered) *and* **predicted** ones, and:
  - each prediction has a **confirm** button that commits it as that team's real
    keeper (and a "not kept" toggle to drop it from the pool math);
  - `predictOpponentKeepers` now respects what you've entered — it **excludes
    committed players and only predicts a team's remaining slots**
    (`committedIds` / `committedByOwner`), so confirming one no longer
    double-counts against the max. You can also add any specific opponent keeper
    via "Add a keeper" with that team as owner.

## 2026-07 — Keeper reco: analyze without committing (decouple analysis)
- **Fixed a conflation:** importing your ESPN roster used to require *committing*
  every player as a keeper pick (removed from the pool, treated as drafted) just
  to analyze them. Now the recommender evaluates your imported roster as
  **hypothetical candidates** — fetching from ESPN feeds the analysis directly and
  **nothing leaves the draft pool until you click Commit**.
- `KeeperRecommendations` candidate pool = committed "Me" keepers ∪ imported
  is_mine roster players; a **Commit** button turns the recommended set into real
  keeper picks (and drops committed ones it doesn't recommend). Rows show a
  `kept` chip when already committed.
- `KeeperAutofill` no longer pre-selects or bulk-commits your roster; its list is
  now an opt-in "commit specific known keepers" tool, with copy pointing to the
  analysis below.

## 2026-07 — Keeper reco: import my roster + predict opponents' keepers
- **Predict opponents' keepers** (`predictOpponentKeepers` in `keeperReco.js`,
  node-tested): from the ESPN import (every team's roster + draft cost), assume
  each opponent keeps their best-value players (same surplus logic, up to the
  league max). Those players are removed from the availability/market pool, so
  your snake "who's actually there at my forfeited pick" and auction market
  values reflect who won't be in the draft. Snake surplus is scored against a
  slot-agnostic mid-round pick (opponents' slots are unknown).
- **Evaluate my whole roster.** `KeeperAutofill` now surfaces the full fetched
  candidate list to the recommender and adds a **"Load my roster"** button that
  seeds every one of your rostered players as candidates, so the recommender
  prunes your final roster to the best keep set.
- **UI** (`KeeperRecommendations.tsx`): a "Predicted off the board" panel lists
  the predicted opponent keepers (team + cost), with a **Factor-in toggle** and
  per-player **override** (mark any you know they'll let go back as available).
  Predictions feed the depletion pool the recommendation is computed against.

## 2026-07 — Keeper recommendation (strategic, draft-position aware)
- **Recommendation engine** (`frontend/src/engine/keeperReco.js`, node
  fixture-tested): scores each candidate as **KV = surplus + scarcity + fit**.
  - *Surplus over the resource's alternative use*, not raw value: auction =
    inflation-adjusted market value − price; **snake = VBD(kept) − VBD(the player
    you'd actually get at the pick you forfeit)**. That forfeited pick comes from
    your **draft slot** via the serpentine schedule (`snakePicks`), so slot 1
    forfeiting round 3 gives up pick 25 while slot 12 gives up pick 36 — different
    opportunity cost. Availability is valued on a market order (ADP→ECR→our rank)
    with **all teams' keepers removed** from the pool.
  - *Scarcity* = the VBD cliff to the next available player at the position,
    amplified on the **wheel** (slot ends, where runs bite harder).
  - *Set optimizer* enumerates every subset up to the max, charges each snake
    keeper a **distinct** forfeited pick (a 2nd keeper in the same round costs an
    earlier, better pick), and keeps a candidate only when its marginal KV clears
    a **flexibility floor** — so it can recommend **fewer than the max, or none**.
- **UI** (`components/shared/KeeperRecommendations.tsx`, in the planner): ranked
  keep/hold table with surplus, scarcity, the pick you'd forfeit and who you'd get
  instead; a headline set with an explicit "why fewer than max" line; a draft-
  impact summary (keeper spend/budget for auction, forfeited picks for snake); a
  tunable flex floor; and an "Apply" that drops the keepers it doesn't recommend.

## 2026-07 — Keeper auto-fill from ESPN
- **Prices/rounds pulled automatically.** The ESPN adapter now parses each
  drafted player's **round** alongside the auction bid (`espn.py` `_draft_map`),
  and a pure `keeper_candidates(norm, index)` (`matching.py`, fixture-tested)
  maps a prior-season league's rosters + draft results onto the current player
  pool. New endpoint `POST /api/integrations/espn/keeper-candidates` returns the
  candidates (matched id, owner, bid, round) for a given ESPN league + season.
- **Planner auto-fill panel** (`components/shared/KeeperAutofill.tsx`): enter the
  league's prior-season ID (public, or private with `espn_s2`/`SWID`), fetch the
  draft, and get a checklist of every rostered player with its computed keeper
  cost — pre-selected where matched. "Add selected" bulk-seeds them as keepers.
  Undrafted players show as FA (fall to the rule's FA path); unmatched/already-
  kept rows are disabled. The keeper **rule** still comes from league settings —
  the API supplies only the raw cost basis.

## 2026-07 — Keeper planner (auction + snake)
- **Generic keeper engine** (`frontend/src/engine/keeper.js`, node fixture-tested
  in `keeper.selftest.mjs`): presets for **Yahoo** (1 keeper, drafted-round cost,
  R13 if a FA, no consecutive years) and **ESPN** (≤3 keepers, last price + $7),
  plus a Custom baseline. `keeperCost()` turns last year's price/round into this
  year's cost (surcharge, undrafted round, optional per-year round escalation,
  no-consecutive advisory); `validateKeepers()` enforces `maxKeepers` per team.
- **Planner UI** (`components/shared/KeeperPlanner.tsx`), opened from a **Keepers**
  button in both draft rooms: search a player, pick the owner (you or an opponent),
  enter last year's price/round (or mark FA), see the computed keeper cost live,
  and commit. Shows your keeper spend vs. budget (auction) or forfeited rounds
  (snake), and flags rule violations.
- **Seeding.** Keepers are stored as ordinary `DraftPick` rows, marked via the
  (previously unused) `slot` text field (`lib/keeperPick.ts`) — **no DB migration**.
  They're removed from the pool; auction keeper prices count against budget and
  feed inflation; snake keepers cost that team its round. "Reset draft" now keeps
  keepers; the snake pick-clock ignores keepers (they aren't live picks).
- **Inflation fix.** Auction inflation now counts **every** priced pick in the
  room (your buys, opponents' buys, and keepers), not just your own — money spent
  is money out of the pool whoever spent it.
- **Rule config** lives in `SettingsDrawer` (preset chips + fields), persisted in
  `league.settings.keeper`.

## 2026-07 — Draft board overview, editable draft log, explainer tooltips
- **Draft board panel** (`components/shared/DraftOverview.tsx`, both rooms'
  sidebar): every team at a glance — pick count and, for auctions, remaining
  budget; click a team to expand its picks (with prices). Snake picks logged
  via the plain ✕ land in an "Unassigned" bucket until attributed.
- **Editable draft log** (`components/shared/DraftLogModal.tsx`, "Edit log"
  button on the panel): full pick-by-pick list (round.pick for snake, overall #
  for auction) with inline fixes — swap the player (searchable), reassign which
  team drafted them, edit the price paid, or delete the pick. Backed by a new
  `PATCH /api/leagues/{id}/picks/{pick_id}` (partial update, explicit nulls
  clear fields) + `api.updatePick` + `draftStore.updatePick`.
- **Tooltips everywhere** (`components/shared/Tip.tsx` — fixed-position hover/
  tap popup that survives overflow-hidden containers, plus native `title`s):
  plain-English explanations for VBD, $Par/$Live, inflation, max bid, mkt ±,
  tier, risk, '25 pace, nomination drain/target, suggested bids, pick clock,
  needs, and roster auto-slotting.
- Verified end-to-end on a local SQLite test stack (JSONB shimmed to JSON in a
  scratch launcher; no repo changes): buys, opponent assignment, budget
  recalcs, player swap, price fix, and the PATCH round-trips.

## 2026-06 — FantasyPros API + project docs
- **FantasyPros enrichment.** `data-pipeline/fantasypros.py` pulls current,
  scoring-aware consensus ECR/ADP **and component projections** via the public
  API (`x-api-key`, `FANTASYPROS_API_KEY`). `projections.py` uses it
  automatically when the key is set — filling real `proj` stat lines (the value
  blend's accuracy ceiling) plus ECR/ADP — else falls back to the free nflverse
  snapshot. Both parsers fixture-tested; live calls validated where the key
  lives (sandbox egress blocks the API). `--no-fp-proj` keeps the baseline proj.
- **Docs.** Added `CLAUDE.md` (architecture/env/deploy/gotchas/status), this log,
  and `README.md`.

## 2026-06 — ESPN & Yahoo league import
- **Provider-agnostic import layer** (`backend/integrations/`): `base.py`
  (normalized model), `matching.py` (name/team → `fantasy_players`, fixture-
  tested), `espn.py`, `yahoo.py`, `selftest.py`. `POST /api/leagues/import`
  creates a league + picks from rosters and returns a match report. ESPN and
  Yahoo parsers validated against synthetic fixtures. (`45c9daf`)
- **ESPN**: works (public no-auth; private via `espn_s2`/`SWID`).
- **Yahoo**: OAuth2 + exchange + league-list picker (all seasons) built
  (`4d062b7`); error surfacing for token + leagues calls (`565607d`, `f00bc34`);
  optional `YAHOO_SCOPE` (`3b5e36b`).
  - **Blocked**: Yahoo's self-service dev console no longer grants the Fantasy
    Sports scope on new apps → `additional_authorization_required` on every
    fantasy call. Code is correct and ready; needs a Fantasy-scoped credential
    (pursuing https://sports.yahoo.com/developer/access/). Swap `YAHOO_*` env when obtained.
- **Frontend**: `ImportLeagueModal` on the league list (provider toggle, ESPN
  cookies, Yahoo connect + league dropdown), shows the mapping report.

## 2026-06 — Empirical SOS tuning + admin reload
- **Tuned SOS params** against 10 seasons (2015–2024), fully out-of-sample
  (`data-pipeline/sos_backtest.py`, `sos_engine.py` validated equal to the JS
  engine). Findings + numbers in `data-pipeline/SOS_TUNING_RESULTS.md`. Applied
  in both the JS engine and `load_to_db.py`:
  `yoyRetention` 0.35 → `{QB:.30,RB:.30,WR:.26,TE:.11}`, `sosWeight` 0.5 → 0.8,
  `cap` 0.06 → 0.04, `playoffWeight` 1.5 → 1.2. (`154240d`)
- **`POST /api/admin/reload-sos`** (admin-only, `backend/sos.py`): fetches the
  prior season from nflverse over HTTPS, recomputes multipliers, upserts
  `fantasy_sos` — no local run. (`c5e4e98`) Fixed nflverse release tag
  `player_stats` → `stats_player` + season fallback. (`ab2f9b7`)
- Repaired the stale projection backtest harness for the current nflreadpy API
  (projection-param tuning remains data-limited — no archived projections).

## 2026-06 — Frontend redesign (clean light theme, shaded rows)
- Replaced the inverted-slate-palette hack with an intentional light design
  system (semantic tokens in `tailwind.config.ts`, base/components in
  `index.css`). Player board now has **zebra striping + position-colored left
  accents** so each line is easy to read and differentiate; restyled every
  surface (board, panels, login, league list, settings, popover). (`dad78af`)

---

### Conventions
- Develop on `claude/frontend-redesign-shading-wmmi33`; fast-forward `main` to
  ship (Railway + Vercel auto-deploy on push to `main`).
- Keep the deterministic cores fixture-tested; live external calls (ESPN/Yahoo/
  FantasyPros/nflverse) can't run from the build sandbox (egress policy) — they
  validate against prod or a local run.

# Updates Log

Reverse-chronological record of notable changes so a new session can see what
happened and why. Newest first. Add an entry per meaningful chunk of work
(commit refs in parentheses).

---

## 2026-08 — Roadmap 0.1 shipped: veterans now use the expert projection too
- `blendExpertAll()` (`engine-core.js`) blends every veteran's model projection
  with FantasyPros' expert projection, in points space, at a **per-position**
  weight (`EXPERT_BLEND_W`: QB 0.3, RB 0.2, TE 0.2, WR 0.4; K/DST stay at 1.0 —
  never backtested). Unlike the market anchor's single shared 0.3, a single
  weight here would give up real signal: the per-position optimum is narrower
  and more position-dependent (QB and WR sit more than a full weight-step
  apart at the top of their curves).
- Wired into `useBoard.ts` right after `projectAll()`, before schedule
  strength and the market anchor — `projectAll -> blendExpertAll -> SOS ->
  marketAnchor -> finalizeBoard`. On by default (`settings.expertBlend`);
  rookies are skipped (`rookieProjection()` already used `player.proj` first,
  with higher priority — blending again would double-count it).
- `expert_blend_parity.py`/`.mjs` assert the shipped JS is numerically
  identical to the backtested Python `blend_expert()` (1,080+ values across 9
  cases, equality not tolerance), same treatment `anchor_parity.py` already
  gives the market anchor.
- **The kill gate passed at every position, both halves** (`docs/ROADMAP.md`
  0.1): matched-population Spearman beats plain ADP, and the full-board
  merged-with-anchor number beats the pre-0.1 board — QB +0.030, RB +0.037,
  TE +0.044, WR +0.020. Backtest run: `projection-backtest.yml` #32032864146.

## 2026-08 — Roadmap 0.1/0.2: kill-gated, one shipped, one collapsed
- **0.2 collapsed.** `DEFAULT_SNAKE_PARAMS.SLOTS` carried ~100 fitted numbers
  (10 draft slots × ~8 params) whose grid search was never checked into this
  repo — trustable, not auditable. Built `draft-sim.mjs`, a from-scratch draft
  simulator running the actual shipped `pickScore` (not a port), to test them
  out of sample instead: **+10.67 pts where they were fitted** (mean/SE
  4.24 — real), **+2.53 held out** (mean/SE 1.16 — indistinguishable from
  noise). `SLOTS` is now `{}`; the `resolveSlotConfig` lookup stays so a
  config that earns its place on held-out evidence can return.
- **0.1 validated first.** `projection_probe.py` confirmed FantasyPros'
  historical preseason projections are genuine (not hindsight, not stale) for
  6+ of 7 tested seasons — the precondition for blending them in at all.
  (First probe run misread a self-inflicted rate-limit as missing data;
  `fantasypros.py` now retries 429s with backoff — `RATE_LIMIT_RETRIES=4`.)
  `blend_expert()` (points-space, not rank transfer — magnitude matters here,
  unlike the market anchor which already extracts order) then cleared the
  kill gate; see the entry above for the ship.
- The simulator this took to build (`draft-sim.mjs` + selftest + export +
  runner + CI workflow) doubles as Phase 3's head-to-head harness, so the
  week it cost (not the "days" originally estimated) wasn't sunk.

## 2026-08 — Model vs. market on a matched population: the market wins
- Historical preseason ADP is available and genuine (correlation with that
  season's finish 0.53–0.66 — the band for real preseason opinion; hindsight
  would be >0.85). `adp_probe.py` checks this rather than assuming it.
- Scored over the **matched population** (only players both rank, ~185–299/yr),
  mean Spearman vs actual season total, 2017–2025:

  | pos | ADP (market) | shipped model | delta |
  |-----|--------------|---------------|-------|
  | QB  | **0.648** | 0.497 | −0.151 |
  | RB  | **0.652** | 0.551 | −0.101 |
  | TE  | **0.535** | 0.472 | −0.064 |
  | WR  | **0.650** | 0.594 | −0.056 |

- **This corrects the previous entry's optimistic read.** That comparison used
  two different populations — the exact error the matched run was built to
  avoid — and pointed the wrong way. On the same exam the market wins at every
  position. All correlations fall on the matched set because it contains only
  draftable players, which is a much harder ordering problem.
- What it doesn't mean: VBD, scarcity, tiers, keeper math, auction dollars and
  draft-order logic sit on top of the ranking and add value regardless. The
  tool's edge is the draft-mechanics layer, not player evaluation.
- The lead this exposes: `projectPoints()` never consults ECR/ADP for an
  established player. Market rank drives rookies, `rankByAdp` and
  `marketPrice`, but the veteran board ranking is pure prior-season stats —
  discarding the best predictor available. A model⊕market blend is now
  measurable in one run.

## 2026-08 — The projection model, finally measured
- `projection_model.py` is a line-for-line Python port of `engine-core.js`
  `projectPoints()`, and `projection_parity.py` asserts it matches the shipped JS
  over 444 players × 5 parameter sets (2220/2220 identical). Without that guard a
  drifting port measures a fiction just as convincingly as the old backtest did.
  - It caught a real one immediately: `f"{x:.1f}"` uses banker's rounding
    (220.25 → 220.2) where JS `toFixed(1)` rounds half away from zero
    (220.25 → 220.3). Now `Decimal(x)` + `ROUND_HALF_UP` on the exact binary
    value, which also matches JS on values that merely look like halves.
- `projection_backtest.py` scores it on **Spearman**, not MAE — a board is a
  ranking, and being uniformly low costs nothing if the order holds.
- **The model works.** vs "just use last season's pace", 2017–2025:
  QB 0.643 → **0.703**, RB 0.660 → **0.689**, TE 0.675 → **0.708**,
  WR 0.715 → **0.735**; ahead in **26 of 27** position-years.
- **The shipped parameters are already near-optimal** — best in a 20-combo grid
  beats them by 0.001–0.003, which is noise over 9 years. Nothing to retune.
- **The trend adjustment does nothing measurable.** Disabling it entirely moves
  Spearman by +0.0002…+0.0013 and wins 4–6 years of 9. Harmless, but it is
  complexity carrying no weight — don't extend it without evidence.
- Bounds stated in the doc: survivorship (players absent in year Y are excluded,
  not counted as misses), rookies untested (that path now covers ~349 of 959
  live players), and no ADP baseline — beating last-season pace is a low bar,
  beating the market is the real one.

## 2026-08 — FantasyPros projections fixed against the spec; injury flags
### Projections/ADP were parser bugs, not a plan tier
The upgraded subscription returned exactly the same `0 players`, so the cause
was ours. Read against the published OpenAPI spec rather than guessed:
- **Position field is `position_id`.** We read `player_position_id`/`position`,
  got `""`, and filtered every row out. That alone zeroed the whole pull.
- **`stats` is an ARRAY of stat objects, not a dict.** `_extract_stats` treated
  it as a dict, fell through to the player object, and read zeros for
  everything even when rows did parse.
- **Receptions are `rec_rec`.** Missing from the synonym list — PPR scoring
  depends on it.
- **ADP is `rank_adp`**, not `player_adp`; that is why ADP matched 0 and every
  rookie fell to the projection floor.
- **AAV does not exist on this API.** "auction" appears nowhere in the spec and
  `NFLRankingTypes` is WW/WAIVER/ROS/DRAFT/PRESEASON/SLEEPERS/ADP/BEST/PROSPECT/
  PRO/DEVY/ROOKIES/DYNADP. The old `type=auction` call was answered as an
  ordinary ranking pull, which is why it silently parsed to zero instead of
  failing. `fetch_aav()` is now an explicit no-op with the reason written down;
  `marketPrice()` uses its modeled curve, as it already did whenever aav was null.

### Injury flags
- New `/nfl/injuries` pull (`fetch_injuries`/`parse_injuries`), stored on the
  player row as `injury` jsonb (**migration 005**) and surfaced by
  `InjuryBadge` in both draft rooms.
- Severity is mapped from the spec's closed status enum — IR/PUP/OUT/COV-IR/
  Suspended are "out", Doubtful, Questionable, Not Starting below that. An
  unrecognised status is shown as a note rather than dropped: an unknown status
  is a reason to look, not to hide it.
- Out/IR renders as a filled red chip. The failure being prevented is drafting
  someone on IR without noticing, so it is deliberately hard to miss, while
  Questionable stays quiet because a badge that cries wolf gets ignored.
- **Valuations are untouched.** What an injury is worth depends on your IR spot,
  bench depth and the length of the absence — none of which the app knows, so it
  reports the status instead of silently discounting the player.

## 2026-08 — Rookie valuation: rank, not a flat floor
- Adding the 349 missing ranked players exposed the next problem. With no NFL
  history there is nothing to project from, so `rookieProjection()` derives a
  value from the positional ceiling decayed by market rank — but it read
  **ADP only**, and that pipeline run returned rankings with no ADP at all.
- Every added player therefore hit the `adp == null` floor branch and got the
  SAME value: 47.9 pts for every rookie RB, 46.2 for every WR. A top-15 rookie
  and the 878th-ranked player were indistinguishable, at replacement level.
  That is worse than being missing — a player shown at replacement level reads
  as a considered judgement rather than absent data.
- Rank now falls back ADP → ECR, the same fallback `rankByAdp()` already made
  and for the same reason. On the existing curve an ECR-15 rookie RB goes from
  47.9 to **156.1** pts; ECR 45 → 89.9; past the 200 span it decays to the
  floor as before.
- Precedence is unchanged where it was already right: a real market projection
  beats the rank curve, and ADP beats ECR when both exist.
- Rookie `risk` stays elevated (volatility 0.5 with no prior seasons), so the
  board flags them rather than presenting a rank-derived number as certain.
- engine-core selftest 10 → 17.

## 2026-08 — Rookies were missing entirely; duplicates weren't only about aliases
### Every incoming rookie was absent from the pool
- `ingest_nflverse.py` builds the player base by aggregating **last season's
  stats**, so anyone who has never taken an NFL snap produces no row. Rosters
  only supply team/age for players already in that aggregate.
- `projections.py` then only ENRICHED existing rows — `for p in players` — so a
  FantasyPros-ranked rookie could never enter the pool either. Jeremiyah Love
  and every other 2026 rookie simply did not exist in the app.
- That is worse than a bad projection: you cannot draft, or plan around, a
  player the tool never shows. Ranked players missing from the base are now
  added, carrying ECR/ADP/AAV/projection and flagged `rookie`. `parse_rankings`
  keeps the display name and team so they can be.
- The engine already handles a player with no history (leans on market rank,
  and the board labels it "no '25"), so nothing downstream needed changing.

### The duplicate was blank-vs-ARI, not only ARI-vs-AZ
- The earlier fix keyed dedupe on `(name, pos, team)` after canonicalizing
  aliases. Trey McBride survived it because his rows didn't differ by alias:
  `ingest_nflverse` falls back to `team = ""` whenever the roster fetch is
  unavailable, and a blank-vs-`ARI` pair splits exactly like `AZ`-vs-`ARI`.
- Key is now **(normalized name, position)** — team is reconciled, not part of
  identity. Within one season a name+position is one player. Name normalization
  matches `matching.py` (accents, punctuation, Jr/III, collapsed whitespace), so
  a stray double space can't split a row either.
- `backend/migrations/004_dedupe_players_by_name_pos.sql` applies the same key
  to stored rows: picks the most complete row, unions the rest onto it,
  re-points draft picks and player logs, deletes the losers. Re-runnable.
- Verified: three McBride rows (blank / ARI / AZ) collapse to one ARI row
  keeping the projection from the first, ECR+ADP from the second, AAV from
  the third.

## 2026-08 — Pick latency, and a player appearing twice
### The freeze between picks was the network, not the maths
- Measured the per-pick JS first: the whole live-state recompute is **0.22 ms**
  and the per-row work **1.9 ms**. Nowhere near the couple of seconds seen, so
  "it's recalculating" was the wrong diagnosis.
- The real cause: `addPick` **awaited the Railway round trip before touching
  state**. The board could not move until the API answered, so pick latency was
  exactly API latency. Nothing about a pick needs the server's opinion — the
  only field it supplies is the row id.
- Now optimistic: the pick lands immediately under a temporary id, swapped for
  the real one when the response arrives, and **rolled back if the call fails**
  (a phantom pick would hide a player who is still genuinely available).
- Supporting fixes, all measured:
  - `picks.find()` and `board.findIndex()` ran **per row** — ~600 × 600
    comparisons every render. Replaced with lookup maps built once per change:
    **1.92 ms → 0.16 ms (12×)**.
  - The row is now a `memo`'d `PlayerRow`, so a pick re-renders **one row**
    instead of the entire ~600-row pool.
  - On-the-clock reaches rows through a stable getter rather than a prop — as a
    prop it changed every pick and would have defeated the memo entirely.
  - `TeamPicker` builds its option list on first interaction, not on every
    render of every row.
- No functionality removed.

### One player, two rows (ARI and AZ)
- `fantasy_players` is unique on `(season, name, pos, team)`, so the team code
  is part of a player's identity. A feed spelling Arizona `AZ` where another
  says `ARI` therefore creates a **second row for the same player** — and
  drafting one copy leaves the twin looking available, which corrupts the
  remaining pool and every scarcity/tier/replacement number drawn from it.
- Fixed in three places:
  - `data-pipeline/teams.py` — one canonical alias map, applied at load, with
    `merge_player_rows()` unioning the split rows (typically one holds the
    projection, the other the ADP/AAV) instead of picking a winner.
  - `backend/migrations/003_canonicalize_team_codes.sql` — cleans rows already
    in the database: fills gaps on the survivor, re-points draft picks at it,
    deletes the twin, renames leftovers. Re-runnable.
  - `useBoard` — a client-side guard so a stale database still can't put a
    duplicate on a live board.

## 2026-08 — Assign the drafting team at the moment you log the pick
- **Before**: the snake board's ✕ meant only "someone took him". Saying WHO
  meant opening the draft log, finding the pick, and setting the team — several
  steps, during the one part of the app where seconds matter. (The auction room
  already had a winner dropdown; snake never got one.)
- **Now**: ✕ is replaced by a "Drafted by…" dropdown listing you plus every
  opponent. One click opens, one click logs the pick to that team.
- **The team on the clock is lifted to the top and labelled**, taken from
  `currentOwners()` — the same draft-order board the pick math uses, so traded
  picks are honoured instead of assuming plain serpentine. Everything else
  keeps league order so muscle memory survives.
- `teamOptions()` keeps each option's `teamId` bound to its index in
  `settings.opponents` (that index IS `DraftPick.team_id`), so reordering the
  display can't silently reassign picks to the wrong team.
- The header now shows `#<pick> <team>` — the app's idea of whose turn it is.
  If that drifts from the real room, it's visible before it mis-assigns
  anything, rather than after.
- ✓ ("I drafted him") is unchanged and still one click.

## 2026-08 — Fix: Yahoo 401 "additional_authorization_required"
- **Cause**: the fantasy scope was opt-in. `authorize_url()` only sent `scope`
  when `YAHOO_SCOPE` was set, so with it unset Yahoo issued a perfectly valid
  token carrying no Fantasy Sports permission — which then failed every fantasy
  call with a 401 that reads "Please provide valid credentials", pointing at the
  token or the client secret rather than the grant.
- **Fix**: `fspt-r` is now the default (fantasy read is the only thing this app
  uses). `YAHOO_SCOPE` still overrides; `"-"` opts out explicitly.
- **`check_fantasy_scope()`** recognises Yahoo's marker and raises a
  `FantasyScopeError` naming all three real causes in order: app permissions,
  a backend that never requested the scope (and Railway needing a **deploy**,
  not a restart), and an already-minted token that refreshing cannot upgrade.
  Applied to every fantasy fetch; other failures pass through untouched.
- Routes return **403** for this, not 502 — the request was fine, the grant was
  wrong — and the client drops the dead session on that signal, since refreshing
  an under-scoped token just returns another under-scoped token.
- **`GET /api/integrations/yahoo/config`** reports what the backend is actually
  sending (scope, redirect, whether id/secret are set — never their values),
  because a scope or redirect mismatch is otherwise invisible from the browser.

## 2026-08 — Fix: "Authorize with Yahoo" appeared to do nothing
- **Symptom**: clicking Authorize opened a tab, you approved, and landed back on
  the create-a-league screen as if nothing had happened.
- **Cause**: Yahoo's redirect URI is the app itself, so consent returns to a
  normal app screen with `?code=…` on the URL. Nothing read it. The only
  instruction to copy that code by hand was in a modal in the *other* tab, and
  the returned-to tab just looked like a fresh app.
- **Fix**: `YahooCallback` at the app root finishes the handshake — exchanges
  the code, stores the session, strips the query (a spent code must not replay
  on refresh), and reports the outcome. `started` guards against exchanging a
  single-use code twice under StrictMode's double-invoke.
- The import dialog is usually still open in the ORIGINAL tab, so
  `onYahooSession()` notifies it: `storage` fires cross-tab, and a custom event
  covers same-tab writes. The dialog fills in its league list on its own.
- Manual code entry stays as the fallback, relabelled as such, and both panels
  now seed from an existing session instead of demanding a fresh consent.
- A declined authorization (`?error=`) surfaces Yahoo's own reason instead of
  failing silently.

## 2026-08 — Live draft sync (ESPN + Yahoo)
- **What it is**: follow a draft that's happening right now and log picks
  automatically, instead of typing every one. "Live" button in both rooms.
- **What it is NOT**: a push feed. Neither ESPN nor Yahoo exposes its draft-room
  socket to outside apps, so this polls (5/10/30s, selectable). The interval is
  the latency floor, and the panel says so rather than implying instant picks.
- **The join both platforms need**: the draft endpoint (ESPN `mDraftDetail`,
  Yahoo `draftresults`) gives ORDER — overall pick, round, owning team, auction
  price — but identifies players by the platform's own numeric id. The roster
  endpoint gives NAMES. Neither alone says who was taken, so each adapter
  fetches both and joins them. Mid-draft the two views briefly disagree; a pick
  whose player isn't on a roster yet is **skipped, not logged as unknown**, and
  the next poll catches it.
- **Idempotent by player, not by pick number.** A player is drafted exactly
  once, so re-polling can't duplicate a pick, and keepers already logged aren't
  re-added when the platform lists them among the draft results. The platform's
  own overall pick number is preserved, so the log reads in true draft order.
- **One request per poll on ESPN**: new `fetch_raw_league`, deliberately not
  `fetch_league` — that one also sweeps 18 weeks of transactions for keeper
  waiver costs, which is right once and abusive on a loop.
- **Unmatched names are surfaced**, never silently dropped: a drafted player
  the pool doesn't contain would otherwise still look available on your board.
- `complete_through` uses the highest **contiguous** pick, so a gap in what the
  platform has published can't advance "on the clock" past a pick it hasn't
  actually reported.
- Fixture-tested (`test_live_draft`) on both platforms: ordering, unresolved
  picks, derived overall from round+pick, auction prices, empty boards, gaps.
  **Not yet run against a real draft** — the shapes come from the documented
  payloads, so expect to verify on the first live one.

## 2026-08 — Yahoo Fantasy API is live (credential granted)
- The OAuth **import** path was already built and only ever blocked on the
  Fantasy Sports scope, so it needed no code — set the Railway vars and it runs.
  What was genuinely missing was everything keeper-related plus token lifetime.
- **Keeper auto-fill over the API** (`/api/integrations/yahoo/keeper-candidates`):
  reads the prior season's `draftresults` and folds it onto the rosters, so
  costs come from the platform instead of a copied page.
  - `parse_draft_results()` — auction `cost` and/or snake `round` per player.
    Which one applies is the keeper RULE's call, same as ESPN and the paste path.
  - `parse_transactions()` — top **winning** FAAB bid per player from
    `transactions;types=add`. Failed claims and the drop side of an add/drop are
    excluded, and a player added twice keeps the higher bid, because the keeper
    price is the higher of draft and waiver. The whole call is optional: a
    league with no FAAB (or no transaction access) degrades to draft-only rather
    than failing the pull.
  - `parse_keeper_flags()` — Yahoo's own `is_keeper` block. Surfaced for
    confirmation rather than silently trusted, the same treatment the pasted
    keeper badge gets: the field is undocumented, and a wrong read would quietly
    delete real keeper options.
  - Yahoo identifies players by `player_key` ("449.p.31883") in draft results
    and transactions but by `player_id` on rosters, so everything joins on the
    numeric id via `player_num()`.
  - Response shape matches the ESPN keeper route exactly, so `KeeperPlanner`
    consumes either without special-casing.
- **Tokens now survive** (`/api/integrations/yahoo/refresh` + `lib/yahooAuth.ts`).
  Yahoo access tokens last about an hour and the token previously lived only in
  the import modal's React state — it died on reload and was invisible to the
  keeper planner, which runs long after the import. The session is now persisted
  and refreshed ahead of expiry, so one consent covers both screens; the panel
  has a Disconnect that clears it.
- **`YahooKeeperAutofill.tsx`** in the keeper planner: connect, pick last
  season's league (defaulted to `match_season - 1`), pull. Caches into
  `settings.keeperImport` with `source: "yahoo"` and rehydrates on reopen, like
  the other two importers.
- Fixture-tested (`test_yahoo_keeper`), covering the mixed key/id forms, blank
  draft slots, failed claims, drop-side rows, repeat adds, and absent
  transactions. **Not yet validated against a real Yahoo payload** — check the
  parsed fields on the first live pull.

## 2026-08 — Renaming a team (names change mid-season)
- **Team names are identifiers, not labels.** `teamSlots`, `teamPicks` and the
  cached keeper import are keyed by them, `pickOwners` stores them as values,
  and committed keeper `DraftPick` rows tag their owner by name inside `slot`.
  Editing a name in the opponents list therefore *silently orphaned* the rest:
  that team's draft slot fell back to a mid-round guess, its traded picks were
  dropped as "unknown team", and its keepers stopped being attributed to it.
- **`renameTeam(settings, from, to)`** carries every reference at once, keeping
  the team's position in `opponents` because that index IS `DraftPick.team_id` —
  reordering would reassign drafted players. Rejected renames (empty, colliding
  with another team, or the reserved `"Me"` / `"__me__"` that identify YOUR team
  in keeper picks and on the board) return the settings object unchanged, so a
  caller detects refusal by identity rather than by guessing.
- **`applyOpponentNames()`** treats list position as identity, so an edited line
  in League Settings is a rename of that team rather than a different team
  appearing — which is what makes carrying the keyed data correct instead of a
  guess. Appends and removals at the tail are *not* renames.
- **Where you rename**: click any team name on the draft-order board (pencil on
  hover; Enter commits, Escape cancels). A banner previews the renames before
  they apply, and everything stays local until Save. Editing the opponents list
  in League Settings works too, and now goes through the same path.
- **Outside settings**: both rooms rewrite committed keeper picks' owner via
  `updatePick`, which now carries `slot` (the backend PATCH already accepted it).
- draft-order selftest 66 → 88.

## 2026-08 — Draft-order board replaces typing raw pick numbers
- **Why**: traded picks were entered as overall pick numbers — "you own 1, 24,
  25, 48…", per team, in two text fields. That asks the user to do serpentine
  arithmetic in their head, type the answer, and then have no way to check it.
  Confusing by construction, and the fields fought back while typing (see the
  entry below).
- **`engine/draft-order.js`** (pure, node-tested) models the draft as what it
  actually is: every overall pick owned by exactly one team. Base ownership is
  serpentine from each team's slot; a trade is one override on one pick, stored
  in `settings.pickOwners` (overall pick → team, `"__me__"` = you).
  - `slotByTeam()` is a strict bijection over 1..teams: imported slots that are
    duplicated, missing, or out of range get claimed-then-filled rather than
    crashing, so a conflict shows up as a team seated oddly instead of a blank
    board.
  - `derivePickSettings()` recomputes `myPicks` / `teamPicks` from the board on
    save. Those are what the engines read, so the board and the pick math can't
    drift apart; with no trades all three are cleared and the league is back on
    the plain serpentine path.
  - 66 assertions. The load-bearing one: an untouched board is byte-identical to
    `snakePicks()` for every team at 8, 10 and 12 teams — the new authoring
    surface cannot disagree with the pick clock and keeper costs.
- **`DraftOrderBoard.tsx`** — full-screen, opened by the new **Order** button in
  the snake room. Round-1 seating (changing a seat *swaps* with the occupant, so
  the order stays a permutation), the full round × slot grid where clicking any
  pick reassigns it to another team, and a picks-by-team summary marking
  acquired picks. Traded cells are ringed and flagged; each has "back to
  ⟨original owner⟩". Edits are local until Save, so a misclick costs nothing.
- **League Settings** now only links to the board — the "Your picks" text field
  and the "Draft position by team" grid are gone.
- **`settings.rounds`** (default: one per roster spot) replaces the hardcoded
  18-round assumption in the pick clock.

## 2026-08 — Settings inputs that swallowed what you typed; paste imports the draft order
- **Three inputs in `SettingsDrawer` deleted your keystrokes.** Each was
  controlled by a lossy round-trip: the value was rebuilt from the parsed data
  on every change, so the separator you had just typed was parsed away and
  removed before the next character could land.
  - *Opponent teams*: `split("\n") → trim → filter(Boolean) → join("\n")` meant
    pressing Enter made an empty line that was immediately filtered out. The
    field could only ever hold one line — which also made clicking and the
    arrow keys look broken, since there was no second line to reach.
  - *Your picks* and the per-team *traded picks*: `parse → sort → join(", ")`
    ate the comma, so only one number could ever be entered.
  - Fix: raw text lives in the input, the parsed value is derived for storage.
    New `PickListInput` holds its own draft text and re-syncs only when an
    outside change disagrees with what its text parses to, so the two places
    that edit `myPicks` stay consistent without fighting the caret.
- **Your row in "Draft position by team" now edits `draftSlot` / `myPicks`.** It
  was writing `teamSlots["Me"]` / `teamPicks["Me"]` — keys no engine reads, so
  the value looked authoritative and was silently ignored.
- **Creating a league from a Yahoo paste now saves the whole draft order.** The
  route persisted `settings.opponents` but dropped `draft_slots`, even though
  round one of the paste proves every team's slot. Opponent keeper predictions
  therefore fell back to a mid-round guess the paste had already disproved.
  `settings.teamSlots` is now written at creation, so the prediction math is
  right without reopening the planner and re-pasting.

## 2026-08 — Per-team draft position, and Yahoo pastes that persist
- **Opponent keeper predictions now use each team's real draft position.**
  `predictOpponentKeepers` priced every rival's forfeited pick at the middle of
  the round (`(round-1)*teams + ceil(teams/2)`) — a flat assumption that makes a
  team drafting 1st and a team drafting 10th value the same round-5 keeper
  identically. They shouldn't: the late-drafting team gives up a worse pick, so
  the keeper is worth more to them, and that changes *who* gets predicted kept
  and therefore who's off the board.
  - New `settings.teamSlots` (team name → draft slot) and `settings.teamPicks`
    (team name → owned overall picks, for traded picks). `teamPicks` wins over
    `teamSlots`; the mid-round fallback survives only for teams we know nothing
    about, so nothing regresses for leagues that never enter this.
  - Same `pickForRound()` semantics as your own picks: two picks in a round →
    the earlier one; none → the next pick that team owns.
  - Edited in **League Settings → Draft position by team** (snake only, shown
    once opponents exist). Slot per team, plus an optional owned-picks override.
  - keeperReco selftest 40 → **43**: a late-drafting team values the same
    round-5 keeper more; `teamPicks` overrides `teamSlots`; an unknown team is
    still predicted via the fallback.
- **Yahoo paste imports now survive closing the planner.** `KeeperAutofill`
  (ESPN) cached its pull into `settings.keeperImport`, but `YahooPasteImport`
  cached nothing — so a snake/Yahoo league's keeper analysis vanished on
  reopening and read as "keeper data doesn't save for snake leagues". (The
  *committed* keeper picks always persisted; it was the imported analysis
  source that didn't.) `KeeperImportCache` gained `source` + `paste`, the paste
  panel writes the cache on parse and re-feeds the candidates to the recommender
  on mount, and shows a "saved import from …" banner so a stale paste is never
  mistaken for a fresh one.
- **"Save team names + draft slots"** now writes `teamSlots` for every team
  alongside `opponents`/`draftSlot` — one click wires the paste's draft order
  straight into the prediction math above.

## 2026-08 — Traded picks, snake settings fix, team names from paste
- **Snake leagues showed auction settings.** `SettingsDrawer` hardcoded an
  "Auction" heading and a "Budget / team" field regardless of format, even
  though it already received `format`. Budget is now auction-only; draft slot
  and pick order are snake-only; the opponents hint no longer claims to be
  about budget tracking in a snake league.
- **Traded draft picks are now modelled.** Serpentine order assumes your draft
  slot determines your picks — false the moment a league trades them (you can
  hold two picks in one round and none in another; the reference Yahoo league
  does exactly this). New `settings.myPicks` holds the overall pick numbers you
  actually own, editable in League Settings → Your picks (placeholder shows the
  serpentine default, so it's an override, not data entry from scratch).
  - `myPickNumbers(settings)` in `snake-engine.js` is the single source of
    truth: the override when present, serpentine otherwise.
  - `keeperReco` uses it, and `pickForRound()` now looks a round UP rather than
    indexing `myPicks[round-1]` — with two picks in a round the earlier (more
    valuable) one is the honest cost; with none you forfeit the next pick you
    own. Under serpentine this is identical to the old behavior.
  - The pick clock counts down to a pick you really own.
  - Tested end to end: trading away a round-3 pick pushes the forfeited pick
    later and raises that keeper's surplus (keeperReco 40/40).
- **Team names from the Yahoo paste**: the parse already knows all ten real
  names and your draft slot, so the keeper paste panel now offers to save them
  straight into `settings.opponents` (+ `draftSlot`) instead of making you
  retype them.

## 2026-08 — Yahoo import with NO API access (paste-based)
- **Why**: Yahoo's developer program no longer reliably grants the Fantasy
  Sports scope, so the OAuth path in `yahoo.py` can stay blocked indefinitely.
  Rather than wait on a credential, import from the two pages any league member
  can already see: **Draft Results** and **Starting Rosters**, pasted as text.
- **Parser** (`backend/integrations/yahoo_paste.py`, pure + fixture-tested
  against a real 10-team snake export):
  - Rosters decide **who** can be kept; draft results decide **what** they'd
    cost (the round they went in). Rostered-but-undrafted ⇒ waiver/FA pickup,
    no round, so the league's undrafted-round rule applies.
  - **Keeper badge**: Yahoo renders "was kept" as an icon; copying strips the
    icon but leaves its whitespace, so kept players carry a trailing space
    (draft) / blank line (rosters). In the reference league this flagged
    exactly one player per team across all ten — strong corroboration. Because
    it IS whitespace-derived, it's surfaced for confirmation, never silently
    committed.
  - **Truncated team names**: draft results abbreviate ("Becoming BEA...")
    while rosters carry them in full — prefix-matched, curly apostrophes
    normalized; ambiguous stems are reported rather than mis-attributed.
  - **Draft slots come from ROUND 1 ONLY.** Traded picks make later rounds
    non-serpentine (the reference league has a team holding two picks in one
    round and none in another), so inferring order from them would be wrong.
    Duplicate-team rounds are reported as a warning.
- **Keeper ineligibility is now first-class**: `NormPlayer.keeper_ineligible`
  carries platform ground truth that a player can't be kept again — stronger
  than inferring it from our own `noConsecutive` rule. The recommender
  **excludes** those players (recommending one would be an illegal keep) and
  also won't predict them as an opponent's keeper (which would wrongly deplete
  the draft pool your own valuation is measured against).
- **League creation from paste**: `POST /api/leagues/import-yahoo-paste` creates
  the league itself — real opponent names, team count, snake format, and your
  draft slot from round one — so the Yahoo tab in the import modal is no longer
  a dead end when OAuth 401s. Roster shape and scoring stay at defaults because
  neither pasted page carries them; the success panel says so and points at
  League Settings. Paste mode is the DEFAULT for Yahoo now, with the API flow
  still reachable for anyone who has the scope.
- **Endpoint + UI**: `POST /api/integrations/yahoo/paste-candidates` returns the
  same candidate shape as the ESPN endpoint, so the planner/recommender consume
  it unchanged. `YahooPasteImport.tsx` in the keeper planner shows the parse
  result: team count, detected draft order, the kept-player list to verify, and
  every warning.

## 2026-08 — Full per-stat scoring (not just PPR) + real team names on import
- **The gap:** valuations only ever configured points-per-reception. Every
  other scoring category (pass/rush/rec yards+TDs, INTs, fumbles) was
  hardcoded to a standard 4pt-pass-TD/-2-INT/6pt-rush-rec-TD table, silently,
  even though ESPN/Yahoo leagues frequently run something else (6pt passing
  TDs, -1 INT, TE premium, etc.) — a real accuracy gap in the exact numbers
  the app exists to produce.
- **Engine** (`engine-core.js`): `DEFAULT_SCORING` extracted as the single
  standard-scoring source of truth; new `resolveScoring(settings)` merges it
  with an optional `settings.scoring` per-category override, with `settings.ppr`
  always winning for receptions (unchanged single source of truth — never
  duplicated in `scoring`). Omitting `settings.scoring` entirely reproduces the
  old `defaultScoring(ppr)` byte for byte — purely additive, no behavior change
  for existing leagues. `useBoard.ts` (the single choke point feeding every
  board) now calls `resolveScoring` instead of `defaultScoring(ppr)`.
  Node-tested (`engine-core.selftest.mjs`), including a full-pipeline proof
  that a QB's `valuePoints` rises under 6pt-pass-TD/-1-INT scoring while an
  unrelated RB's is unaffected.
- **Settings UI**: new "Scoring" section in `SettingsDrawer` — editable
  Passing/Rushing/Receiving/Misc fields (yards, TDs, INT, fumble), pre-filled
  with the effective (default-or-overridden) values, "Reset to standard".
  Points/reception stays exactly where it was.
- **Import auto-detection stays PPR-only, on purpose.** ESPN/Yahoo both expose
  full scoring rules, but only as unlabeled numeric stat IDs; neither adapter's
  ID→category mapping could be verified from this build sandbox (no live
  egress), and a wrong guess would be a *silent* valuation bug — worse than
  not mapping at all, especially given the point of this change. Receptions
  (ESPN statId 53, Yahoo stat_id 11) stay auto-detected because they're already
  validated. Everything else is pulled and counted (not discarded) via
  `raw_scoring_items()` (ESPN) / `raw_stat_modifiers()` (Yahoo) and surfaced in
  the import report + a note pointing at the new Scoring editor. Fixture-tested.
- **Real team names on import** (opponents, not "Team 2"/"Team 3"): `NormTeam`
  names from ESPN/Yahoo now populate `settings.opponents`, and each opponent's
  seeded `DraftPick.team_id` is set to the matching index
  (`integrations/base.py opponent_team_ids()`, fixture-tested) — so an imported
  league's auction budget tracking and labels are correct immediately instead
  of landing in "Unassigned". Import report lists the imported team names.

## 2026-07 — Keeper import: cached, diagnosable, and refreshable
- **Cached import.** A successful ESPN pull is saved to
  `settings.keeperImport = {season, fetchedAt, candidates, waivers}` via the
  existing `PATCH /api/leagues/{id}` (JSONB — no migration). Reopening the planner
  loads the saved pull instantly instead of refetching; a **Refresh from ESPN**
  link re-pulls on demand.
- **Waiver source fixed.** `mTransactions2` returns an empty `transactions` array
  for football — ESPN serves FFL waiver claims through the **league activity
  feed** (`view=kona_league_communication`, `topics` → `messages`, messageTypeId
  **180**, `targetId`=player, `from`=winning FAAB bid). That feed is now the
  primary source (paged, with a leagueHistory fallback); the transactions array
  is kept as a fallback and both merge to the highest bid per player.
- **SOLVED — waiver history needs a scoringPeriodId.** A captured browser request
  for the report showed the two missing ingredients: transactions are scoped to a
  **week** (`scoringPeriodId=15`), and the filter is
  `{"transactions":{"filterType":{"value":["WAIVER","WAIVER_ERROR"]}}}`. Omit the
  week and ESPN returns no `transactions` key at all — which is why every
  variant looked "empty" and sent this chasing the activity feed for days.
  `fetch_league` now sweeps `scoringPeriodId` 0 then 1..18 with that filter,
  dedupes by transaction id, and keeps the highest EXECUTED bid per player.
  Regression-tested end to end (`test_waiver_weekly_fetch`, mocked client).
  The activity/communication routes stay as a fallback.
- **Resolved by probing (what ESPN actually requires).** Three rounds of live
  probes settled the waiver feed:
  1. `limit` is rejected without a sort (`FILTER_LIMIT_MISSING_SORT`) — every
     filter variant now carries `sortMessageDate`. With that, the current
     season's `/communication/` endpoint returns **200 `{"topics": [...]}`**, so
     the mechanism is proven.
  2. On the **base league** endpoint the filter nests under `communication`
     (`CommunicationGroupFilterParams` → `topics` / `topicsByType`), not `topics`
     at the root. Added as a second route, since it doesn't depend on the
     per-season communication group. `_topics()` reads either response shape.
  3. `mTransactions2` returns **no `transactions` key at all** for football, in
     any season, with or without a filter — a dead end, kept only as a fallback.
  - **Prior seasons:** the 2025 communication group is genuinely deleted
    (`404 COMMUNICATION_GROUP_NOT_FOUND`), so historical FAAB may be
    unrecoverable; the manual `w$` editor covers it. Live seasons will auto-pull.
- **Waiver probe.** `/api/integrations/espn/probe-activity` (+ a "Diagnose"
  button in the autofill panel) reports what ESPN actually returns — status,
  top-level JSON keys, body snippet — for ~9 candidate transaction/activity URLs
  including an auth sanity check. Waiver-history support could not be validated
  from the build sandbox (no ESPN egress), so this replaces guess-per-deploy with
  one round of real evidence. Read-only, stores nothing.
- **The actual 400:** `kona_league_communication` is only valid on the league's
  **`/communication/` sub-resource** — on the base league URL ESPN 400s no matter
  what filter you send (which is exactly what the live diagnostics showed: all
  six filter/endpoint variants 400, while `mTransactions2` on the base URL
  answered 200). `activity_url()` now appends `/communication/`; the selftest
  asserts it so it can't silently regress.
- **Filter negotiation.** The activity feed 400s on a `limit` above 25 and on
  filter keys it dislikes, so the page size is now 25 and `activity_filters()`
  offers three shapes (full → typed → plain); page 0 probes for one ESPN accepts
  and the rest is paged with that shape (verified offline against a simulated
  400). The winning shape is reported in the diagnostics (`activity/typed`).
- **Manual waiver editing.** Committed keepers now have an inline editable
  waiver field in the planner list (click `w$ –`), since ESPN doesn't reliably
  expose prior-season FAAB. Editing re-derives the cost immediately.
- **Waiver diagnostics.** `fetch_league` now tries three transaction strategies
  (filtered `mTransactions2` → bare → `leagueHistory`) and records each outcome in
  `NormLeague.meta`; the keeper-candidates response returns a `waivers` report
  (source, per-attempt result, players, max bid). The autofill panel shows
  "N waiver claims · max $X" or an explicit "No waiver data (attempts…)" so a
  league without FAAB history is obvious rather than silently draft-only.
  Fixes an earlier filter that included a `filterStatus` key ESPN 400s on.
- **Stale keeper costs.** Keeper costs live in the stored pick marker, so keepers
  committed before an import (or before waiver support) never recompute. The
  planner now detects those and offers **"Update costs"**, re-deriving each from
  the latest pull. Rows show a `w` flag when priced off the waiver claim, with the
  full derivation in the tooltip.

## 2026-07 — Keepers: waiver/FAAB claim value (higher of draft vs waiver)
- Many leagues set a keeper's cost to the **higher of what he was drafted for and
  what it cost to claim him off waivers**. `keeperCost` now takes an optional
  `waiver` value (same unit as `base`) and resolves the more-expensive of the two
  — bigger $ for price basis, earlier round for round basis — then applies the
  surcharge/escalation. A pure waiver pickup (undrafted) is valued at the claim
  instead of the generic FA default. Node-tested (`keeper.selftest.mjs`).
- Plumbed through the marker (`keeperPick.ts` `waiver`), the planner's Add form
  (a "Waiver / FAAB claim" field), and the recommender (cost re-derivation +
  commit re-encode).
- **ESPN auto-fill now pulls waiver/FAAB claims.** `espn.py` fetches
  `mTransactions2` (best-effort, isolated so it can't break the core import) and
  `_waiver_map` reduces it to each player's top executed FAAB acquisition bid;
  `keeper_candidates` carries `waiver`, and the autofill/recommender apply the
  higher-of-draft-vs-waiver cost automatically. Parser fixture-tested
  (`integrations.selftest`); waiver is a price-basis concept (ignored for snake).

## 2026-07 — Fix: import no longer drafts the whole league (keeper setup)
- **Root cause:** `POST /api/leagues/import` seeded *every* rostered player (all
  teams) as a drafted `DraftPick`. The keeper recommender counted any committed
  pick as "kept", so an imported league (a) suppressed all opponent predictions
  (every candidate looked already-kept), (b) never displayed opponents' players,
  and (c) emptied the draft pool.
- **Fixes:**
  - Import gains `seed_rosters` (default **off**): rosters are only logged as
    drafted picks for an in-progress draft. Keeper setups now start with a clean
    pool. Modal exposes a "Load rosters onto the draft board" checkbox; the report
    says which mode ran.
  - The keeper recommender now counts **only keeper-tagged picks** as kept
    (`committedKeeperIds`) for prediction exclusion, per-team slot accounting, and
    pool depletion — regular draft/import picks no longer break keeper analysis.

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

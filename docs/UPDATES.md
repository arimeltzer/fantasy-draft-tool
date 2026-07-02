# Updates Log

Reverse-chronological record of notable changes so a new session can see what
happened and why. Newest first. Add an entry per meaningful chunk of work
(commit refs in parentheses).

---

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

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
  src/engine/         valuation-engine.js (VBD/auction) + strength-of-schedule.js
  src/components/, pages/, hooks/, lib/api.ts, lib/posStyles.ts
data-pipeline/      offline data prep -> JSON -> Postgres
  ingest_nflverse.py  pull players/schedule/logs from nflverse
  projections.py      ECR/ADP + projections enrichment (nflverse free OR FantasyPros API)
  fantasypros.py      FantasyPros public API client (x-api-key): rankings + projections
  load_to_db.py       load JSON into Postgres (also bakes SOS multipliers)
  sos_backtest.py / sos_engine.py   empirical SOS tuning (validated vs JS)
```

## Data flow

nflverse + FantasyPros → `data-pipeline/*` → `data/*.json` → `load_to_db.py` →
Postgres → backend `/api/*` → frontend board. The frontend engine recomputes
VBD/auction values client-side from the player rows + league settings.

## Database tables

- `fantasy_players` `(season, name, pos, team, age, proj jsonb, last jsonb, ecr, adp)`, uniq `(season,name,pos,team)`
- `fantasy_schedule` `(season, team, week, opp)`, uniq `(season,team,week)`
- `fantasy_player_logs` `(season, player_id, week, opp, fp)`, uniq `(season,player_id,week)`
- `fantasy_sos` `(season, team, pos, mult)` PK `(season,team,pos)`
- plus `fantasy_users`, `fantasy_leagues`, `fantasy_draft_picks`
- Schema is created with SQLAlchemy `create_all` — it does NOT alter existing
  tables, so adding a column needs a manual migration on Railway.

## Key commands

```bash
# frontend
cd frontend && npm install && npm run build      # tsc -b && vite build
# backend (needs DATABASE_URL etc.)
cd backend && uvicorn main:app --reload
# integration parsers (no net/db) — regression guard
cd backend && python -m integrations.selftest
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
- `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, `YAHOO_REDIRECT_URI`, optional `YAHOO_SCOPE` (e.g. `fspt-r`)
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
  - **Yahoo**: official OAuth2 + league picker built and working EXCEPT Yahoo's
    self-service dev console won't grant the **Fantasy Sports** scope on new
    apps (token gets `additional_authorization_required`). Pursuing access via
    https://sports.yahoo.com/developer/access/ — once a Fantasy-scoped credential
    exists, swap the Railway `YAHOO_*` vars (+ `YAHOO_SCOPE` if needed) and it works.
- **SOS reload** (`/api/admin/reload-sos`, admin-only): fetches the prior season
  from nflverse over HTTPS, recomputes multipliers with the tuned params, upserts
  `fantasy_sos`. Self-contained; no local run. See `data-pipeline/SOS_TUNING_RESULTS.md`.
- **FantasyPros API** (`data-pipeline/fantasypros.py`): fresh, scoring-aware ECR/
  ADP into the player rows (replaces the limited free nflverse snapshot).

## Gotchas

- Auth uses `bcrypt` directly (NOT passlib — breaks on Python 3.13).
- `VITE_API_URL` and `ALLOWED_ORIGINS` must include `https://` and match exactly.
- Railway applies new env vars only on a fresh **deploy** (not "Restart").
- External pipeline scripts: use `DATABASE_PUBLIC_URL`, not the internal URL.
- nflverse weekly stats live under release tag **`stats_player`** (not the old
  `player_stats`); the gzipped CSV is parser-friendly (parquet needs heavy deps).
- The frontend is an intentional **light** theme (semantic tokens in
  `tailwind.config.ts`); the old inverted-slate hack was removed — don't reinstate it.

## Open threads / next up

- **Keeper Planner** (designed, not built): manual roster + last-year-cost entry →
  generic keeper rule (`maxKeepers`, round-vs-price, `undraftedRound`,
  `priceSurcharge`, `noConsecutive`) → seeds the board (pool removal + budget).
  Rules to support: Yahoo (1 keeper, draft-round cost / undrafted=R13, no repeat),
  ESPN (≤3 keepers, last cost +$7).
- **Yahoo Fantasy access** pending via the sports developer program.
- **FantasyPros**: validate a live pull where the key lives; AAV/tier surfacing
  needs a new `fantasy_players` column (migration).

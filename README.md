# Fantasy Draft Assistant

A full-stack fantasy-football draft tool for **auction and snake** drafts. It
turns projections into Value-Based-Drafting dollar values (auction) and pick
recommendations (snake), adjusts for strength of schedule, and tracks the draft
live (with auction inflation).

- **Live:** https://fantasy-draft-tool-flame.vercel.app
- **API:** https://fantasy-draft-production-43ab.up.railway.app

## Stack

- **Frontend** — React + TypeScript + Vite + Tailwind (Vercel). The valuation
  engine (`frontend/src/engine/`) computes VBD / auction values client-side.
- **Backend** — FastAPI + async SQLAlchemy + Postgres, JWT auth (Railway).
- **Data pipeline** — Python scripts that pull nflverse + FantasyPros data and
  load it into Postgres.

## Features

- VBD board for snake (rankings, tiers, recommendations) and auction (par
  values, live inflation, budget/max-bid).
- Strength-of-schedule multipliers, **empirically tuned** against 10 seasons
  (see `data-pipeline/SOS_TUNING_RESULTS.md`).
- **League import** from ESPN / Yahoo (settings + rosters) — see
  `backend/INTEGRATIONS.md`.
- Admin SOS reload endpoint that refreshes multipliers from live data.

## Develop

```bash
cd frontend && npm install && npm run build      # type-check + build
cd backend  && uvicorn main:app --reload         # needs DATABASE_URL etc.
cd backend  && python -m integrations.selftest   # import-layer tests
```

## Docs

- **`CLAUDE.md`** — architecture, env vars, deploy, gotchas, current status.
  Start here.
- **`docs/METHODOLOGY.md`** — how player values are computed (sourcing +
  formulas + parameters); self-contained for analysis.
- **`docs/UPDATES.md`** — running changelog.
- **`backend/INTEGRATIONS.md`** — ESPN/Yahoo import setup.
- **`data-pipeline/SOS_TUNING_RESULTS.md`** — SOS backtest method + results.

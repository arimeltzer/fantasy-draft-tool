-- Migration 001 — draft-algorithm port
-- Run manually on Railway Postgres (create_all does NOT alter existing tables).
-- Connect with the Railway PUBLIC url, e.g.:
--   psql "$DATABASE_PUBLIC_URL" -f backend/migrations/001_add_last2_and_team_id.sql
--
-- Idempotent: safe to re-run.

-- Second prior season totals, feeds the 2-year projection blend (engine-core.js projectPoints)
ALTER TABLE fantasy_players     ADD COLUMN IF NOT EXISTS last2 JSONB;

-- Opponent identity for auction picks: index into League.settings.opponents[].
-- NULL for my own picks (mine=true) or unattributed picks.
ALTER TABLE fantasy_draft_picks ADD COLUMN IF NOT EXISTS team_id INTEGER;

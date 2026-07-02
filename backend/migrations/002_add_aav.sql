-- Migration 002 — FantasyPros AAV (auction average value)
-- Run manually on Railway Postgres (create_all does NOT alter existing tables).
--   python data-pipeline/run_migration.py backend/migrations/002_add_aav.sql
-- Idempotent: safe to re-run.

ALTER TABLE fantasy_players ADD COLUMN IF NOT EXISTS aav FLOAT;

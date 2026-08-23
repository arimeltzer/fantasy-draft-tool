-- 006 — FantasyPros consensus tier on the player row.
--
-- create_all() never ALTERs an existing table, so this must run BEFORE the
-- code that selects the column, or the ORM 500s on every /api/players call.
--
-- Distinct from the app's own computed VBD-gap tier (engine-core.js
-- finalizeBoard, never stored — recomputed client-side from valuePoints
-- every time). This is FantasyPros' OWN consensus tier, from parse_rankings
-- (data-pipeline/fantasypros.py), surfaced alongside the computed one, never
-- blended into it.
--
-- Nullable: most players (anyone FantasyPros doesn't rank into a tier) have
-- no value here. Safe to re-run.

ALTER TABLE fantasy_players ADD COLUMN IF NOT EXISTS fp_tier integer;

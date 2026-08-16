-- 005 — injury status on the player row.
--
-- create_all() never ALTERs an existing table, so this must run BEFORE the
-- code that selects the column, or the ORM 500s on every /api/players call.
--
-- Shape (from data-pipeline/fantasypros.parse_injuries):
--   {"status": "Questionable", "short": "Q", "type": "Knee",
--    "severity": "out|doubtful|questionable|note", "chance": 65}
--
-- Nullable: no row means no reported injury. Safe to re-run.

ALTER TABLE fantasy_players ADD COLUMN IF NOT EXISTS injury jsonb;

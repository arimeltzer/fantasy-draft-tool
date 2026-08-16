-- 004 — one row per player per season.
--
-- 003 folded team ALIASES (AZ -> ARI). That wasn't enough: `team` is also
-- BLANK whenever the pipeline ran without roster data, and a blank-vs-ARI pair
-- splits into two rows exactly like an alias pair does. Within one season a
-- (name, position) identifies one player, so that is the real key.
--
-- Run 003 first, then this. Safe to re-run.
--
-- A duplicate is not cosmetic: drafting one copy leaves the twin looking
-- available, so the remaining pool and every scarcity/tier/replacement number
-- drawn from it are wrong for the rest of the draft.

BEGIN;

-- Normalized name: lowercase, drop punctuation and Jr/Sr/II..V, collapse spaces.
-- Mirrors backend/integrations/matching.py and data-pipeline/teams.py.
CREATE OR REPLACE FUNCTION fantasy_norm_name(txt text) RETURNS text AS $$
  SELECT trim(regexp_replace(
    regexp_replace(
      regexp_replace(lower(coalesce(txt, '')), '[.''`’]', '', 'g'),
      '\y(jr|sr|ii|iii|iv|v)\y', '', 'g'),
    '[^a-z0-9]+', ' ', 'g'));
$$ LANGUAGE sql IMMUTABLE;

-- Winner per (season, normalized name, pos): the row with the most data,
-- tie-broken by a non-blank team, then lowest id for determinism.
CREATE TEMP TABLE dupe_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT id, season, pos, fantasy_norm_name(name) AS nname,
         first_value(id) OVER (
           PARTITION BY season, fantasy_norm_name(name), pos
           ORDER BY ((proj IS NOT NULL)::int + (last IS NOT NULL)::int
                   + (last2 IS NOT NULL)::int + (ecr IS NOT NULL)::int
                   + (adp IS NOT NULL)::int + (aav IS NOT NULL)::int) DESC,
                    (coalesce(team,'') <> '')::int DESC, id ASC) AS keep_id
  FROM fantasy_players
)
SELECT id AS dupe_id, keep_id FROM ranked WHERE id <> keep_id;

-- 1. Union the loser's data onto the winner (only where the winner is missing).
UPDATE fantasy_players k SET
    proj  = COALESCE(k.proj,  d.proj),
    last  = COALESCE(k.last,  d.last),
    last2 = COALESCE(k.last2, d.last2),
    ecr   = COALESCE(k.ecr,   d.ecr),
    adp   = COALESCE(k.adp,   d.adp),
    aav   = COALESCE(k.aav,   d.aav),
    age   = COALESCE(k.age,   d.age),
    team  = CASE WHEN coalesce(k.team,'') = '' THEN d.team ELSE k.team END
FROM dupe_map m JOIN fantasy_players d ON d.id = m.dupe_id
WHERE k.id = m.keep_id;

-- 2. Re-point picks and logs at the surviving row before deleting.
UPDATE fantasy_draft_picks p SET player_id = m.keep_id
FROM dupe_map m WHERE p.player_id = m.dupe_id;

DELETE FROM fantasy_player_logs l USING dupe_map m
WHERE l.player_id = m.dupe_id
  AND EXISTS (SELECT 1 FROM fantasy_player_logs k
              WHERE k.player_id = m.keep_id AND k.season = l.season AND k.week = l.week);
UPDATE fantasy_player_logs l SET player_id = m.keep_id
FROM dupe_map m WHERE l.player_id = m.dupe_id;

-- 3. Drop the duplicates.
DELETE FROM fantasy_players d USING dupe_map m WHERE d.id = m.dupe_id;

COMMIT;

-- Verify: should return no rows.
-- SELECT season, fantasy_norm_name(name) AS n, pos, count(*)
--   FROM fantasy_players GROUP BY 1,2,3 HAVING count(*) > 1;

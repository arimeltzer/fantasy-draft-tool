-- 003 — fold team-abbreviation aliases to one canonical spelling.
--
-- fantasy_players is unique on (season, name, pos, team), so a source spelling
-- Arizona "AZ" while another spells it "ARI" produced TWO rows for one player.
-- On the draft board that is actively misleading: drafting one copy leaves the
-- other looking available, so the remaining pool and every scarcity number
-- drawn from it are wrong for the rest of the draft.
--
-- Run this, then 004 (which also catches rows split by a BLANK team), then
-- re-run the pipeline — it now canonicalizes at load (data-pipeline/teams.py).
--
-- Safe to run more than once.

BEGIN;

CREATE TEMP TABLE team_alias(bad text PRIMARY KEY, good text NOT NULL) ON COMMIT DROP;
INSERT INTO team_alias(bad, good) VALUES
  ('AZ','ARI'), ('ARZ','ARI'), ('CRD','ARI'),
  ('JAC','JAX'), ('WSH','WAS'), ('WFT','WAS'), ('OTI','TEN'),
  ('LA','LAR'), ('STL','LAR'), ('RAM','LAR'), ('SD','LAC'), ('SDG','LAC'),
  ('OAK','LV'), ('LVR','LV'), ('RAI','LV'),
  ('BLT','BAL'), ('RAV','BAL'), ('CLV','CLE'), ('HST','HOU'), ('HTX','HOU'),
  ('GNB','GB'), ('KAN','KC'), ('NWE','NE'), ('NOR','NO'), ('SFO','SF'), ('TAM','TB');

-- Alias row -> the canonical row it should merge into.
CREATE TEMP TABLE dupe_map ON COMMIT DROP AS
SELECT d.id AS dupe_id, k.id AS keep_id
FROM fantasy_players d
JOIN team_alias a ON d.team = a.bad
JOIN fantasy_players k
  ON k.season = d.season AND k.name = d.name AND k.pos = d.pos AND k.team = a.good;

-- 1. Union the alias row's data onto the survivor.
UPDATE fantasy_players k SET
    proj  = COALESCE(k.proj,  d.proj),
    last  = COALESCE(k.last,  d.last),
    last2 = COALESCE(k.last2, d.last2),
    ecr   = COALESCE(k.ecr,   d.ecr),
    adp   = COALESCE(k.adp,   d.adp),
    aav   = COALESCE(k.aav,   d.aav),
    age   = COALESCE(k.age,   d.age)
FROM dupe_map m JOIN fantasy_players d ON d.id = m.dupe_id
WHERE k.id = m.keep_id;

-- 2. Re-point draft picks at the survivor.
UPDATE fantasy_draft_picks p SET player_id = m.keep_id
FROM dupe_map m WHERE p.player_id = m.dupe_id;

-- 3. Re-point weekly logs BEFORE deleting anything.
--    fantasy_player_logs.player_id cascades on delete, so dropping the alias
--    row without this silently destroys that player's game log — which feeds
--    SOS and the common-opponents view. Only rows that would collide on
--    (season, week) are dropped, and only because an earlier row covers it.
DELETE FROM fantasy_player_logs l
USING dupe_map m
WHERE l.player_id = m.dupe_id
  AND EXISTS (
    SELECT 1 FROM fantasy_player_logs k
    LEFT JOIN dupe_map m2 ON m2.dupe_id = k.player_id
    WHERE COALESCE(m2.keep_id, k.player_id) = m.keep_id
      AND k.season = l.season AND k.week = l.week AND k.id < l.id);

UPDATE fantasy_player_logs l SET player_id = m.keep_id
FROM dupe_map m WHERE l.player_id = m.dupe_id;

-- 4. Drop the alias rows that now have a canonical twin.
DELETE FROM fantasy_players d USING dupe_map m WHERE d.id = m.dupe_id;

-- 5. Anything left on an alias code had no twin — rename it in place.
UPDATE fantasy_players d SET team = a.good FROM team_alias a WHERE d.team = a.bad;
UPDATE fantasy_schedule s SET team = a.good FROM team_alias a WHERE s.team = a.bad;
UPDATE fantasy_schedule s SET opp  = a.good FROM team_alias a WHERE s.opp  = a.bad;
UPDATE fantasy_sos     x SET team = a.good FROM team_alias a WHERE x.team = a.bad;

COMMIT;

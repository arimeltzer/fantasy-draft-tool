-- 003 — collapse duplicate player rows created by team-abbreviation aliases.
--
-- fantasy_players is unique on (season, name, pos, team), so a source spelling
-- Arizona "AZ" while another spells it "ARI" produced TWO rows for one player.
-- On the draft board that is actively misleading: drafting one copy leaves the
-- other looking available, so the remaining pool and every scarcity number
-- drawn from it are wrong for the rest of the draft.
--
-- Run BEFORE deploying, then re-run the pipeline (which now canonicalizes at
-- load time — data-pipeline/teams.py).
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

-- 1. Fill gaps on the surviving (canonical) row from its alias twin, so the
--    merge doesn't lose whichever fields only the alias row happened to have.
UPDATE fantasy_players k SET
    proj  = COALESCE(k.proj,  d.proj),
    last  = COALESCE(k.last,  d.last),
    last2 = COALESCE(k.last2, d.last2),
    ecr   = COALESCE(k.ecr,   d.ecr),
    adp   = COALESCE(k.adp,   d.adp),
    aav   = COALESCE(k.aav,   d.aav),
    age   = COALESCE(k.age,   d.age)
FROM fantasy_players d
JOIN team_alias a ON d.team = a.bad
WHERE k.season = d.season AND k.name = d.name AND k.pos = d.pos AND k.team = a.good;

-- 2. Re-point any draft picks that referenced the row about to disappear.
UPDATE fantasy_draft_picks p SET player_id = k.id
FROM fantasy_players d
JOIN team_alias a ON d.team = a.bad
JOIN fantasy_players k
  ON k.season = d.season AND k.name = d.name AND k.pos = d.pos AND k.team = a.good
WHERE p.player_id = d.id;

-- 3. Drop alias rows that now have a canonical twin.
DELETE FROM fantasy_players d
USING team_alias a, fantasy_players k
WHERE d.team = a.bad
  AND k.season = d.season AND k.name = d.name AND k.pos = d.pos AND k.team = a.good;

-- 4. Anything left with an alias code had no twin — just rename it in place.
UPDATE fantasy_players d SET team = a.good FROM team_alias a WHERE d.team = a.bad;
UPDATE fantasy_schedule s SET team = a.good FROM team_alias a WHERE s.team = a.bad;
UPDATE fantasy_schedule s SET opp  = a.good FROM team_alias a WHERE s.opp  = a.bad;
UPDATE fantasy_sos     x SET team = a.good FROM team_alias a WHERE x.team = a.bad;

COMMIT;

-- Verify: should return no rows.
-- SELECT season, name, pos, count(*) FROM fantasy_players
--  GROUP BY 1,2,3 HAVING count(*) > 1;

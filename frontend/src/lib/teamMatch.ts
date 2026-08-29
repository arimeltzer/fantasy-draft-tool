/**
 * teamMatch.ts — tiered team-name matching, ported from
 * backend/integrations/base.py's `resolve_my_team_index`.
 *
 * WHY THIS EXISTS. A keeper's `owner` label comes from a DIFFERENT source
 * than `settings.opponents`: the ESPN keeper-candidates pull reads a PRIOR
 * season's league (the season keepers were actually drafted in), while
 * `settings.opponents` is this CURRENT season's real team names from the
 * league import. A manager who renamed their team between seasons — common
 * on ESPN — makes those two strings differ, and a plain exact match
 * (`opponents.indexOf(owner)`) then fails silently: the pick still gets
 * marked taken (`mine: false`) but `team_id` stays `null`, so it can never
 * be attributed to that opponent's roster or budget. Reported live twice:
 * first as "keepers... are just off the board," fixed by wiring `teamId`
 * through at all; then again as "still isn't correct... unassigned instead
 * of on the right team" once a real name mismatch was hit.
 *
 * Same tiered, weakest-tier-last, refuse-on-ambiguity discipline
 * `resolve_my_team_index` already uses for "which team is mine": exact
 * match, then punctuation/case-folded, then a UNIQUE substring either
 * direction. Deliberately NOT folding harder than that — two different
 * opponents in one league colliding under this fold is rare, and guessing
 * wrong attributes a rival's keeper to the wrong team, which is worse than
 * leaving it unassigned (visibly wrong, and fixable by hand).
 */

/** Casefold and drop everything that isn't alphanumeric — safe for TEAM
 *  names (unlike player names, where folding can merge two real people;
 *  see playerName.ts). Mirrors base.py's `_fold_team_key` exactly. */
function foldTeamKey(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve `owner` to an index into `opponents`, or `undefined` if no tier
 * finds a unique match. Mirrors `resolve_my_team_index`'s three tiers.
 */
export function resolveOpponentIndex(owner: string, opponents: string[]): number | undefined {
  const key = (owner || "").trim();
  if (!key) return undefined;

  // Tier 1 — exact (case-insensitive).
  const low = key.toLowerCase();
  const exact = opponents.findIndex((name) => (name || "").trim().toLowerCase() === low);
  if (exact >= 0) return exact;

  // Tier 2 — punctuation/spacing folded away. Unique match only.
  const folded = foldTeamKey(key);
  if (folded) {
    const hits = opponents.map((name, i) => ({ i, f: foldTeamKey(name) })).filter((x) => x.f === folded);
    if (hits.length === 1) return hits[0].i;

    // Tier 3 — unique substring, either direction. Ambiguity gives up
    // rather than guessing — attributing a pick to the wrong team is worse
    // than leaving it visibly unassigned.
    const subHits = opponents
      .map((name, i) => ({ i, f: foldTeamKey(name) }))
      .filter((x) => x.f && (folded.includes(x.f) || x.f.includes(folded)));
    if (subHits.length === 1) return subHits[0].i;
  }

  return undefined;
}

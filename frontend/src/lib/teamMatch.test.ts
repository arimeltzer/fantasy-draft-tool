import { describe, it, expect } from "vitest";
import { resolveOpponentIndex } from "./teamMatch";

/**
 * Mirrors backend/integrations/selftest.py's `test_resolve_my_team` — this
 * is the same tiered discipline, ported for the SAME reason
 * `resolve_my_team_index` exists: a plain exact match silently fails the
 * moment a team's name differs even slightly from what it's being matched
 * against. Here that's a keeper's `owner` label (from a PRIOR season's ESPN
 * pull) against THIS season's `settings.opponents` — reported live as
 * "still isn't correct... unassigned instead of on the right team" after
 * the first fix (which only wired `teamId` through, still via a plain
 * exact `indexOf`) didn't survive a real team rename.
 */
const OPPONENTS = ["Team 1", "Ari's Astounding Team", "andrew's Angry Team"];

describe("resolveOpponentIndex", () => {
  it("tier 1 — exact name, case-insensitive", () => {
    expect(resolveOpponentIndex("Ari's Astounding Team", OPPONENTS)).toBe(1);
    expect(resolveOpponentIndex("ARI'S ASTOUNDING TEAM", OPPONENTS)).toBe(1);
  });

  it("tier 2 — punctuation and spacing folded away", () => {
    // The shape that actually broke: an apostrophe retyped differently, or
    // dropped entirely, between one season's export and the next.
    expect(resolveOpponentIndex("Aris Astounding Team", OPPONENTS)).toBe(1);
    expect(resolveOpponentIndex("  ari's   astounding team  ", OPPONENTS)).toBe(1);
  });

  it("tier 3 — unique substring, either direction", () => {
    expect(resolveOpponentIndex("Ari's Astounding", OPPONENTS)).toBe(1);
    expect(resolveOpponentIndex("Ari's Astounding Team 2026", OPPONENTS)).toBe(1);
  });

  it("refuses rather than guesses on no match or ambiguity", () => {
    // Attributing a keeper to the wrong team is worse than leaving it
    // visibly unassigned, which the manual owner-editor can then fix.
    expect(resolveOpponentIndex("", OPPONENTS)).toBeUndefined();
    expect(resolveOpponentIndex("Nobody's Team", OPPONENTS)).toBeUndefined();
    // "team" is inside all three names -> ambiguous, give up.
    expect(resolveOpponentIndex("Team", OPPONENTS)).toBeUndefined();
  });
});

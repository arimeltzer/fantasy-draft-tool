import { describe, it, expect } from "vitest";
import { dedupePlayers } from "./useBoard";
import type { ApiPlayer } from "@/lib/api";

/**
 * A duplicate on the board is not cosmetic. Drafting one copy leaves the twin
 * looking available, so the remaining pool — and every scarcity, tier and
 * replacement-level number drawn from it — is wrong for the rest of the draft.
 * A wrong MERGE is worse still: the player silently vanishes. Both directions
 * are pinned here.
 */
const p = (over: Partial<ApiPlayer> & { id: number; name: string; pos: string }): ApiPlayer => ({
  season: 2026, team: "", age: null, proj: null, last: null, last2: null,
  ecr: null, adp: null, aav: null, injury: null, ...over,
} as ApiPlayer);

const names = (rows: ApiPlayer[]) => rows.map((r) => r.name);

describe("dedupePlayers", () => {
  it("merges the same player split by a team alias (ARI vs AZ)", () => {
    const out = dedupePlayers([
      p({ id: 1, name: "Trey McBride", pos: "TE", team: "AZ", adp: 30 }),
      p({ id: 2, name: "Trey McBride", pos: "TE", team: "ARI", ecr: 28 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].team).toBe("ARI");
    // fields are unioned — one feed had the ADP, the other the ECR
    expect(out[0].adp).toBe(30);
    expect(out[0].ecr).toBe(28);
  });

  it("merges when one feed left the team blank", () => {
    const out = dedupePlayers([
      p({ id: 1, name: "Bijan Robinson", pos: "RB", team: "", adp: 2 }),
      p({ id: 2, name: "Bijan Robinson", pos: "RB", team: "ATL", ecr: 3 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].team).toBe("ATL");
  });

  it("merges a nickname against the legal name — the reported bug", () => {
    const out = dedupePlayers([
      p({ id: 1, name: "Josh Palmer", pos: "WR", team: "LAC", adp: 95 }),
      p({ id: 2, name: "Joshua Palmer", pos: "WR", team: "LAC", ecr: 92 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].adp).toBe(95);
    expect(out[0].ecr).toBe(92);
  });

  it("merges a nickname when the other row has no team", () => {
    const out = dedupePlayers([
      p({ id: 1, name: "Hollywood Brown", pos: "WR", team: "", adp: 110 }),
      p({ id: 2, name: "Marquise Brown", pos: "WR", team: "KC", ecr: 105 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].team).toBe("KC");
  });

  it("REFUSES to merge two different players who share a surname", () => {
    // Michael Thomas (NO) and Mike Thomas (LAR) were contemporaries. The
    // nickname table cannot tell them apart; the team disagreement can.
    const out = dedupePlayers([
      p({ id: 1, name: "Michael Thomas", pos: "WR", team: "NO", adp: 40 }),
      p({ id: 2, name: "Mike Thomas", pos: "WR", team: "LAR", adp: 180 }),
    ]);
    expect(out).toHaveLength(2);
    expect(names(out)).toEqual(["Michael Thomas", "Mike Thomas"]);
  });

  it("keeps players of the same name at different positions apart", () => {
    const out = dedupePlayers([
      p({ id: 1, name: "Josh Allen", pos: "QB", team: "BUF" }),
      p({ id: 2, name: "Josh Allen", pos: "RB", team: "JAX" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("leaves an ordinary board untouched", () => {
    const rows = [
      p({ id: 1, name: "Bijan Robinson", pos: "RB", team: "ATL" }),
      p({ id: 2, name: "Ja'Marr Chase", pos: "WR", team: "CIN" }),
      p({ id: 3, name: "Josh Allen", pos: "QB", team: "BUF" }),
    ];
    expect(names(dedupePlayers(rows))).toEqual(names(rows));
  });

  it("preserves board order, keeping the first row seen", () => {
    const out = dedupePlayers([
      p({ id: 1, name: "Joshua Palmer", pos: "WR", team: "LAC" }),
      p({ id: 2, name: "Bijan Robinson", pos: "RB", team: "ATL" }),
      p({ id: 3, name: "Josh Palmer", pos: "WR", team: "LAC" }),
    ]);
    expect(names(out)).toEqual(["Joshua Palmer", "Bijan Robinson"]);
  });

  it("does not mutate the caller's rows", () => {
    const rows = [
      p({ id: 1, name: "Trey McBride", pos: "TE", team: "AZ" }),
      p({ id: 2, name: "Trey McBride", pos: "TE", team: "ARI", ecr: 28 }),
    ];
    dedupePlayers(rows);
    expect(rows[0].team).toBe("AZ");
    expect(rows[0].ecr).toBeNull();
  });
});

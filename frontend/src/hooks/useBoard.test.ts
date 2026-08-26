import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { dedupePlayers, useBoard } from "./useBoard";
import type { ApiPlayer } from "@/lib/api";
import type { LeagueSettings } from "@/lib/api";

/**
 * A duplicate on the board is not cosmetic. Drafting one copy leaves the twin
 * looking available, so the remaining pool — and every scarcity, tier and
 * replacement-level number drawn from it — is wrong for the rest of the draft.
 * A wrong MERGE is worse still: the player silently vanishes. Both directions
 * are pinned here.
 */
const p = (over: Partial<ApiPlayer> & { id: number; name: string; pos: string }): ApiPlayer => ({
  season: 2026, team: "", age: null, proj: null, last: null, last2: null,
  ecr: null, adp: null, aav: null, fp_tier: null, injury: null, ...over,
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

/**
 * projBreakdown — the waterfall shown in the "Proj" hover.
 *
 * useBoard diffs valuePoints around each pipeline stage (trackStage) rather
 * than the stage functions themselves reporting anything, so the thing worth
 * pinning is that diff logic: every player gets an unconditional "Base
 * model" step, and each later stage appends a step ONLY for a player it
 * actually moved — a QB with no reported injury should carry no "Injury
 * discount" line at all, not one that says "no change".
 */
describe("useBoard projBreakdown", () => {
  const SETTINGS: LeagueSettings = {
    teams: 10,
    budget: 200,
    ppr: 0.5,
    roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6, SF: 0 },
    superflex: false,
  };

  const players: ApiPlayer[] = [
    // No injury, no expert projection, no market rank — should end up with
    // just the one unconditional step.
    p({
      id: 1, name: "Plain WR", pos: "WR", team: "SF",
      last: { gp: 16, pts: 200 }, last2: { gp: 16, pts: 190 },
    }),
    // Reported status at a position INJURY_K actually discounts (QB).
    p({
      id: 2, name: "Hurt QB", pos: "QB", team: "BUF",
      last: { gp: 16, pts: 300 }, last2: { gp: 16, pts: 280 },
      injury: { status: "Questionable", short: "Q", type: "Ankle", severity: "questionable", chance: 75 },
    }),
    // Prior-season target volume at TE — the one position the opportunity
    // model replaces the pace blend for.
    p({
      id: 3, name: "Volume TE", pos: "TE", team: "KC",
      last: { gp: 16, pts: 150, targets: 100 } as ApiPlayer["last"],
      last2: { gp: 16, pts: 140, targets: 95 } as ApiPlayer["last"],
    }),
    // Carries a FantasyPros expert projection to blend against.
    p({
      id: 4, name: "Expert WR", pos: "WR", team: "MIN",
      last: { gp: 16, pts: 180 }, last2: { gp: 16, pts: 170 },
      proj: { pts: 260 } as ApiPlayer["proj"],
    }),
    // Two ranked RBs whose market order DISAGREES with their own points, so
    // the anchor actually has something to pull — a single ranked player at
    // a position is its own ladder and never moves (see marketAnchor).
    p({
      id: 5, name: "Ranked-First RB", pos: "RB", team: "ATL",
      last: { gp: 16, pts: 150 }, last2: { gp: 16, pts: 140 }, adp: 1, ecr: 1,
    }),
    p({
      id: 6, name: "Ranked-Second RB", pos: "RB", team: "DAL",
      last: { gp: 16, pts: 250 }, last2: { gp: 16, pts: 240 }, adp: 2, ecr: 2,
    }),
    // Switched teams this offseason (last.team != team) at a position
    // TEAM_CHANGE_K actually discounts (RB).
    p({
      id: 7, name: "Moved RB", pos: "RB", team: "LAR",
      last: { gp: 16, pts: 220, team: "SEA" } as ApiPlayer["last"],
      last2: { gp: 16, pts: 210 },
    }),
  ];

  const byName = (rows: ReturnType<typeof useBoard>, name: string) =>
    rows.find((r) => r.name === name)!;

  it("gives an untouched player exactly one step: Base model", () => {
    const { result } = renderHook(() => useBoard(players, SETTINGS, undefined));
    const plain = byName(result.current, "Plain WR");
    expect(plain.projBreakdown?.map((s) => s.label)).toEqual(["Base model"]);
  });

  it("carries FantasyPros' own consensus tier through to the board, untouched", () => {
    const tiered = [...players, p({
      id: 8, name: "Tiered TE", pos: "TE", team: "SF", fp_tier: 3,
    })];
    const { result } = renderHook(() => useBoard(tiered, SETTINGS, undefined));
    expect(byName(result.current, "Tiered TE").fpTier).toBe(3);
    // Never blended into the app's own computed tier — a separate field.
    expect(byName(result.current, "Plain WR").fpTier).toBeUndefined();
  });

  it("computes a display-only Athletic points/rank from an uploaded projection, never touching valuePoints", () => {
    const withAthletic: LeagueSettings = {
      ...SETTINGS,
      athleticProjections: {
        // Ranked below Ranked-Second RB under this league's own scoring.
        5: { rushYd: 900, rushTD: 6, rec: 20, recYd: 150, recTD: 1 },
        6: { rushYd: 1400, rushTD: 12, rec: 30, recYd: 250, recTD: 2 },
      },
    };
    const before = renderHook(() => useBoard(players, SETTINGS, undefined)).result.current;
    const after = renderHook(() => useBoard(players, withAthletic, undefined)).result.current;

    const first = byName(after, "Ranked-First RB");
    const second = byName(after, "Ranked-Second RB");
    expect(first.athleticPoints).toBeGreaterThan(0);
    expect(second.athleticPoints).toBeGreaterThan(first.athleticPoints!);
    expect(second.athleticRank).toBe(1);
    expect(first.athleticRank).toBe(2);
    // A player nobody uploaded a projection for carries neither field.
    expect(byName(after, "Plain WR").athleticPoints).toBeUndefined();
    expect(byName(after, "Plain WR").athleticRank).toBeUndefined();
    // Never fed into valuation — valuePoints/vbd are byte-identical with or
    // without the upload present.
    expect(byName(after, "Ranked-First RB").valuePoints).toBe(byName(before, "Ranked-First RB").valuePoints);
    expect(byName(after, "Ranked-Second RB").vbd).toBe(byName(before, "Ranked-Second RB").vbd);
  });

  it("adds Injury discount only for the player it actually discounted", () => {
    const { result } = renderHook(() => useBoard(players, SETTINGS, undefined));
    const hurt = byName(result.current, "Hurt QB");
    expect(hurt.projBreakdown?.map((s) => s.label)).toEqual(["Base model", "Injury discount"]);
    expect(hurt.projBreakdown?.[1].detail).toMatch(/questionable/i);
  });

  it("adds Opportunity model (TE) for a TE with prior-season targets", () => {
    const { result } = renderHook(() => useBoard(players, SETTINGS, undefined));
    const te = byName(result.current, "Volume TE");
    expect(te.projBreakdown?.map((s) => s.label)).toEqual(["Base model", "Opportunity model (TE)"]);
  });

  it("adds Expert blend for a player with a FantasyPros projection", () => {
    const { result } = renderHook(() => useBoard(players, SETTINGS, undefined));
    const expert = byName(result.current, "Expert WR");
    expect(expert.projBreakdown?.map((s) => s.label)).toEqual(["Base model", "Expert blend"]);
  });

  it("adds Market anchor for ranked players the market disagrees with", () => {
    const { result } = renderHook(() => useBoard(players, SETTINGS, undefined));
    const rb1 = byName(result.current, "Ranked-First RB");
    const rb2 = byName(result.current, "Ranked-Second RB");
    expect(rb1.projBreakdown?.map((s) => s.label)).toEqual(["Base model", "Market anchor"]);
    expect(rb2.projBreakdown?.map((s) => s.label)).toEqual(["Base model", "Market anchor"]);
  });

  it("turning a stage off in settings removes its step", () => {
    const { result } = renderHook(() =>
      useBoard(players, { ...SETTINGS, expertBlend: false }, undefined));
    const expert = byName(result.current, "Expert WR");
    expect(expert.projBreakdown?.map((s) => s.label)).toEqual(["Base model"]);
  });

  it("adds Team change only for the RB/WR whose last.team differs from team", () => {
    const { result } = renderHook(() => useBoard(players, SETTINGS, undefined));
    const moved = byName(result.current, "Moved RB");
    expect(moved.projBreakdown?.map((s) => s.label)).toEqual(["Base model", "Team change"]);
    const stayed = byName(result.current, "Plain WR");
    expect(stayed.projBreakdown?.map((s) => s.label)).toEqual(["Base model"]);
  });

  it("turning team change off in settings removes its step", () => {
    const { result } = renderHook(() =>
      useBoard(players, { ...SETTINGS, teamChangeDiscount: false }, undefined));
    const moved = byName(result.current, "Moved RB");
    expect(moved.projBreakdown?.map((s) => s.label)).toEqual(["Base model"]);
  });
});

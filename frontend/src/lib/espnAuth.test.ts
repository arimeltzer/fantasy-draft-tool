import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  clearEspnCreds, hasEspnCreds, loadEspnCreds, onEspnCreds, saveEspnCreds,
} from "./espnAuth";

/**
 * These cookies are a credential, so the rules that matter are the refusals,
 * not the happy path: never persist half a pair (ESPN rejects one without the
 * other, and a half-save turns "missing cookies" into a confusing "bad
 * cookies" failure), never let a bad write clobber a good stored pair, and
 * never throw when storage itself is unavailable.
 */
beforeEach(() => {
  localStorage.clear();
});

describe("espnAuth", () => {
  it("round-trips a complete pair", () => {
    saveEspnCreds("AEA-s2-value", "{ABC-123}");
    expect(loadEspnCreds()).toMatchObject({ espnS2: "AEA-s2-value", swid: "{ABC-123}" });
    expect(hasEspnCreds()).toBe(true);
  });

  it("trims whitespace, which is how these get pasted", () => {
    saveEspnCreds("  s2  ", "\t{SWID}\n");
    expect(loadEspnCreds()).toMatchObject({ espnS2: "s2", swid: "{SWID}" });
  });

  it("refuses to store half a pair", () => {
    expect(saveEspnCreds("s2-only", "")).toBeNull();
    expect(saveEspnCreds("", "{SWID}")).toBeNull();
    expect(saveEspnCreds("   ", "  ")).toBeNull();
    expect(loadEspnCreds()).toBeNull();
    expect(hasEspnCreds()).toBe(false);
  });

  it("a half-filled save cannot clobber a good stored pair", () => {
    saveEspnCreds("good-s2", "{GOOD}");
    saveEspnCreds("", "");                      // e.g. a public-league sync
    expect(loadEspnCreds()).toMatchObject({ espnS2: "good-s2", swid: "{GOOD}" });
  });

  it("forgets on request", () => {
    saveEspnCreds("s2", "{SWID}");
    clearEspnCreds();
    expect(loadEspnCreds()).toBeNull();
    expect(hasEspnCreds()).toBe(false);
  });

  it("treats a half-written or corrupt record as absent, not as a crash", () => {
    localStorage.setItem("fantasy_espn", '{"espnS2":"s2"}');   // no swid
    expect(loadEspnCreds()).toBeNull();
    localStorage.setItem("fantasy_espn", "not json at all{");
    expect(loadEspnCreds()).toBeNull();
  });

  it("notifies subscribers on save and on clear, in the same tab", () => {
    const seen: (string | null)[] = [];
    const off = onEspnCreds((c) => seen.push(c?.espnS2 ?? null));

    saveEspnCreds("s2-a", "{A}");
    clearEspnCreds();
    off();
    saveEspnCreds("s2-b", "{B}");   // after unsubscribe — must not be seen

    expect(seen).toEqual(["s2-a", null]);
  });

  it("does not throw when localStorage is unavailable (private mode)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => { throw new Error("QuotaExceededError"); });
    expect(() => saveEspnCreds("s2", "{SWID}")).not.toThrow();
    expect(saveEspnCreds("s2", "{SWID}")).toBeNull();
    setItem.mockRestore();
  });
});

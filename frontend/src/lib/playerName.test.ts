import { describe, it, expect } from "vitest";
import { canonName, aliasName, sameTeamOrUnknown } from "./playerName";

describe("canonName", () => {
  it("folds case, accents, punctuation and suffixes", () => {
    expect(canonName("Ja'Marr Chase")).toBe("jamarr chase");
    expect(canonName("T.J. Hockenson")).toBe("tj hockenson");
    expect(canonName("Marvin Harrison Jr.")).toBe("marvin harrison");
    expect(canonName("Amon-Ra St. Brown")).toBe("amon ra st brown");
    expect(canonName("JOSHUA PALMER")).toBe("joshua palmer");
  });

  it("does NOT fold nicknames — that is a separate, riskier decision", () => {
    expect(canonName("Josh Palmer")).not.toBe(canonName("Joshua Palmer"));
  });
});

describe("aliasName", () => {
  it("folds the given name to its canonical form", () => {
    expect(aliasName("Josh Palmer")).toBe(aliasName("Joshua Palmer"));
    expect(aliasName("Mike Evans")).toBe(aliasName("Michael Evans"));
    expect(aliasName("Cam Ward")).toBe(aliasName("Cameron Ward"));
    expect(aliasName("Chig Okonkwo")).toBe(aliasName("Chigoziem Okonkwo"));
    expect(aliasName("Hollywood Brown")).toBe(aliasName("Marquise Brown"));
  });

  it("is idempotent on an already-canonical name", () => {
    expect(aliasName("Joshua Palmer")).toBe("joshua palmer");
    expect(aliasName(aliasName("Josh Palmer"))).toBe(aliasName("Josh Palmer"));
  });

  it("only ever touches the first token — surnames are identity", () => {
    // "Josh" as a SURNAME must survive untouched, or unrelated players merge.
    expect(aliasName("Cameron Josh")).toBe("cameron josh");
    expect(aliasName("Thomas Mike")).toBe("thomas mike");
  });

  it("leaves a single token alone", () => {
    expect(aliasName("Josh")).toBe("josh");
    expect(aliasName("")).toBe("");
  });

  it("keeps deliberately-ambiguous short names apart", () => {
    // Both forms are commonly the legal name, so folding them would merge real
    // and distinct players. Documented as excluded in playerName.ts.
    expect(aliasName("Drew Sample")).not.toBe(aliasName("Andrew Sample"));
    expect(aliasName("Nate Herbig")).not.toBe(aliasName("Nathan Herbig"));
    expect(aliasName("John Taylor")).not.toBe(aliasName("Jonathan Taylor"));
  });

  it("does not merge unrelated players who share a surname", () => {
    expect(aliasName("Josh Allen")).not.toBe(aliasName("Keenan Allen"));
    expect(aliasName("Mike Williams")).not.toBe(aliasName("Jameson Williams"));
  });
});

describe("sameTeamOrUnknown", () => {
  it("treats a blank team as agreement — the commonest half of a split pair", () => {
    expect(sameTeamOrUnknown("LAC", "")).toBe(true);
    expect(sameTeamOrUnknown(null, "LAC")).toBe(true);
    expect(sameTeamOrUnknown(undefined, undefined)).toBe(true);
  });

  it("agrees when the codes match, case-insensitively", () => {
    expect(sameTeamOrUnknown("lac", "LAC")).toBe(true);
  });

  it("reports a genuine contradiction, which is what blocks a bad merge", () => {
    expect(sameTeamOrUnknown("NO", "LAR")).toBe(false);
  });
});

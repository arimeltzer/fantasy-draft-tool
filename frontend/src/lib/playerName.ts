/**
 * Player-name canonicalization.
 *
 * Mirrored by `backend/integrations/matching.py` and `data-pipeline/teams.py`;
 * `data-pipeline/name_parity.py` asserts the alias tables stay identical, so add
 * an entry here and the parity check will tell you which copies you missed.
 *
 * TWO LEVELS, deliberately, because they carry different risk.
 *
 * `canonName` folds only what cannot change identity — accents, case,
 * punctuation, Jr/III. Two rows that agree here are the same player, full stop,
 * so they merge unconditionally.
 *
 * `aliasName` additionally folds the given name through the table below, so
 * "Josh Palmer" and "Joshua Palmer" meet. That is a genuine inference rather
 * than a normalization, and it can be wrong: Michael Thomas (NO) and Mike
 * Thomas (LAR) were both fantasy-relevant receivers at the same time, and this
 * table cannot tell them apart. So an alias match is NOT sufficient on its own —
 * the caller must also check the two rows do not name different teams (see
 * `sameTeamOrUnknown`). A split feed row agrees on team or leaves it blank; two
 * different players usually do not.
 */

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/**
 * Given-name variants → one canonical spelling.
 *
 * Curated rather than algorithmic on purpose. A generic rule ("same surname,
 * same first initial") would fold every diminutive for free and would also
 * quietly merge unrelated players; a table only ever merges names someone
 * chose to list, and anything missing stays a visible duplicate rather than a
 * silent corruption. Deliberately EXCLUDED as too ambiguous to be safe:
 * drew/andrew and nate/nathan (both short forms are commonly the legal name),
 * and the john/jon/jonathan cluster (John is not a diminutive of Jonathan —
 * folding them would merge two genuinely different names).
 */
export const GIVEN_NAME_ALIASES: Record<string, string> = {
  // everyday diminutives
  alex: "alexander", andy: "andrew", ben: "benjamin", benny: "benjamin",
  bill: "william", billy: "william", bob: "robert", bobby: "robert",
  brad: "bradley", cam: "cameron", charlie: "charles", chris: "christopher",
  chuck: "charles", dan: "daniel", danny: "daniel", dave: "david",
  dom: "dominic", ed: "edward", eddie: "edward", fred: "frederick",
  gabe: "gabriel", greg: "gregory", jake: "jacob", jeff: "jeffrey",
  jim: "james", jimmy: "james", joe: "joseph", joey: "joseph",
  josh: "joshua", ken: "kenneth", kenny: "kenneth", matt: "matthew",
  mike: "michael", nick: "nicholas", pat: "patrick", ray: "raymond",
  rich: "richard", ricky: "richard", rob: "robert", ron: "ronald",
  ronnie: "ronald", sam: "samuel", steve: "stephen", steven: "stephen",
  ted: "theodore", tim: "timothy", tom: "thomas", tommy: "thomas",
  tony: "anthony", vic: "victor", will: "william", zach: "zachary",
  zack: "zachary",
  // player-specific nicknames a feed may print instead of the legal name
  chig: "chigoziem", hollywood: "marquise", tank: "nathaniel",
};

/** Accents, case, punctuation and Jr/III folded; whitespace collapsed. */
export function canonName(name: string): string {
  return (name || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.'`\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !NAME_SUFFIXES.has(w))
    .join(" ");
}

/** `canonName` with the GIVEN name additionally folded to its canonical form.
 *  Only the first token is touched — surnames are identity, never nicknames. */
export function aliasName(name: string): string {
  const parts = canonName(name).split(" ").filter(Boolean);
  if (parts.length < 2) return parts.join(" ");   // single token: nothing to fold safely
  parts[0] = GIVEN_NAME_ALIASES[parts[0]] ?? parts[0];
  return parts.join(" ");
}

/** True when two team codes do not positively contradict each other.
 *  Blank counts as agreement: a load that ran without roster data leaves the
 *  column empty, which is the commonest half of a split pair. */
export function sameTeamOrUnknown(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a || "").toUpperCase();
  const y = (b || "").toUpperCase();
  return !x || !y || x === y;
}

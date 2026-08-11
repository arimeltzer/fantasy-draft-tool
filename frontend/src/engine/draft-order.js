/* ------------------------------------------------------------------ *
 * DRAFT ORDER — the full serpentine board, and who owns each pick
 * ------------------------------------------------------------------ *
 *
 * Traded picks used to be entered as raw overall pick numbers ("you own 1, 24,
 * 25, 48…"), per team, in two text fields. That asks the user to do the
 * serpentine arithmetic in their head and then type the answer, which is both
 * tedious and impossible to check by eye.
 *
 * The honest model is the board itself: every pick in the draft, owned by
 * exactly one team. Base ownership is serpentine from each team's slot; a trade
 * is a single override on one pick. Everything the engines need (`myPicks`,
 * `teamPicks`) is DERIVED from that board, so the two can never disagree.
 *
 * Pure module — no React, no DOM — so it is node-testable
 * (`draft-order.selftest.mjs`).
 */

/** Reserved owner id for the user's own team. Not a legal team name, so it
 *  can never collide with one the user (or an import) supplies. */
export const MY_TEAM = "__me__";

/** Every team identity in the league, "me" first, padded/truncated to
 *  `settings.teams` so the board always has exactly one column per team. */
export function teamLabels(settings = {}) {
  const teams = Math.max(1, Math.floor(settings.teams ?? 12));
  const labels = [MY_TEAM, ...(settings.opponents ?? []).filter(Boolean)];
  while (labels.length < teams) labels.push(`Team ${labels.length + 1}`);
  return labels.slice(0, teams);
}

/** Rounds in the draft: explicit override, else one per roster spot. */
export function roundsFor(settings = {}) {
  const explicit = Number(settings.rounds);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const total = Object.values(settings.roster ?? {})
    .reduce((a, b) => a + (Number(b) || 0), 0);
  return total > 0 ? Math.floor(total) : 16;
}

/**
 * Team -> draft slot, as a strict bijection over 1..teams.
 *
 * `settings.teamSlots` and `draftSlot` are user/import supplied and can be
 * incomplete, duplicated, or out of range. Rather than fail, claim the valid
 * ones (yours first, then league order — first claim wins a contested slot) and
 * fill everyone else into what's left. The board is therefore always drawable,
 * and a conflict shows up as a team sitting somewhere unexpected rather than as
 * a crash or a silently missing column.
 */
export function slotByTeam(settings = {}) {
  const labels = teamLabels(settings);
  const teams = labels.length;
  const inRange = (n) => Number.isFinite(n) && n >= 1 && n <= teams;

  const wanted = new Map();
  const mine = Number(settings.draftSlot);
  if (inRange(mine)) wanted.set(MY_TEAM, Math.floor(mine));
  for (const [name, slot] of Object.entries(settings.teamSlots ?? {})) {
    const n = Number(slot);
    if (name !== MY_TEAM && inRange(n)) wanted.set(name, Math.floor(n));
  }

  const taken = new Map();
  const out = {};
  for (const label of labels) {            // labels[0] is MY_TEAM, so you claim first
    const s = wanted.get(label);
    if (s != null && !taken.has(s)) { taken.set(s, label); out[label] = s; }
  }
  let next = 1;
  for (const label of labels) {
    if (out[label] != null) continue;
    while (taken.has(next)) next++;
    taken.set(next, label);
    out[label] = next;
  }
  return out;
}

/** Overall pick number -> owning team, before any trades. */
export function baseOwners(settings = {}, rounds = roundsFor(settings)) {
  const labels = teamLabels(settings);
  const teams = labels.length;
  const slots = slotByTeam(settings);
  const bySlot = {};
  for (const label of labels) bySlot[slots[label]] = label;

  const owners = {};
  for (let r = 1; r <= rounds; r++) {
    for (let i = 1; i <= teams; i++) {
      // Odd rounds run 1..teams, even rounds reverse — matching snakePicks().
      const slot = r % 2 === 1 ? i : teams - i + 1;
      owners[(r - 1) * teams + i] = bySlot[slot];
    }
  }
  return owners;
}

/** Overall pick number -> owning team, with `settings.pickOwners` trades
 *  applied. Overrides naming an unknown team or a pick outside the draft are
 *  ignored rather than trusted. */
export function currentOwners(settings = {}, rounds = roundsFor(settings)) {
  const owners = baseOwners(settings, rounds);
  const known = new Set(teamLabels(settings));
  for (const [key, owner] of Object.entries(settings.pickOwners ?? {})) {
    const pick = parseInt(key, 10);
    if (owners[pick] != null && known.has(owner)) owners[pick] = owner;
  }
  return owners;
}

/** Owner -> the overall picks they hold, ascending. */
export function picksByTeam(owners) {
  const out = {};
  for (const pick of Object.keys(owners).map(Number).sort((a, b) => a - b)) {
    (out[owners[pick]] ||= []).push(pick);
  }
  return out;
}

/** Round + slot-within-round for an overall pick, as "3.07". */
export function pickLabel(pick, teams) {
  const round = Math.floor((pick - 1) / teams) + 1;
  const inRound = ((pick - 1) % teams) + 1;
  return `${round}.${String(inRound).padStart(2, "0")}`;
}

/**
 * Turn an edited board back into league settings.
 *
 * `myPicks` / `teamPicks` are what the engines read, so they are derived here
 * and never hand-edited. With no trades they are cleared entirely, which keeps
 * an untouched league on the plain serpentine path (and keeps settings small).
 */
export function derivePickSettings(settings, owners, rounds = roundsFor(settings)) {
  const base = baseOwners(settings, rounds);
  const labels = teamLabels(settings);

  const pickOwners = {};
  for (const [pick, owner] of Object.entries(owners)) {
    if (base[pick] !== owner) pickOwners[pick] = owner;
  }
  const traded = Object.keys(pickOwners).length > 0;
  if (!traded) return { pickOwners: undefined, myPicks: undefined, teamPicks: undefined };

  const held = picksByTeam(owners);
  const teamPicks = {};
  for (const label of labels) {
    if (label === MY_TEAM) continue;
    teamPicks[label] = held[label] ?? [];
  }
  return { pickOwners, myPicks: held[MY_TEAM] ?? [], teamPicks };
}

/**
 * Rename a team everywhere its name is used as a key.
 *
 * Team names are identifiers, not labels: `teamSlots`, `teamPicks` and the
 * cached keeper import are keyed by them, and `pickOwners` stores them as
 * values. Editing the name in one place alone silently orphans the rest — the
 * team's draft slot falls back to a mid-round guess and its traded picks are
 * dropped as "unknown team". So renaming carries every reference at once.
 *
 * The position in `opponents` is preserved because that index IS
 * `DraftPick.team_id` — reordering it would reassign drafted players.
 *
 * Returns the settings unchanged when the rename is a no-op or would collide
 * with another team; callers should treat an unchanged return as "rejected".
 */
/** Labels that identify YOUR team elsewhere — `MY_TEAM` on the board, the
 *  literal "Me" inside committed keeper picks. An opponent taking either one
 *  would be indistinguishable from you. */
const RESERVED_NAMES = new Set([MY_TEAM, "Me"]);

export function renameTeam(settings, from, to) {
  const next = (to ?? "").trim();
  if (!from || !next || from === next || from === MY_TEAM) return settings;
  if (RESERVED_NAMES.has(next)) return settings;
  const opponents = settings.opponents ?? [];
  if (!opponents.includes(from)) return settings;
  if (opponents.some((o, i) => o === next && opponents[i] !== from)) return settings;

  const out = { ...settings, opponents: opponents.map((o) => (o === from ? next : o)) };

  const rekey = (obj) => {
    if (!obj) return obj;
    const copy = {};
    for (const [k, v] of Object.entries(obj)) copy[k === from ? next : k] = v;
    return copy;
  };
  if (settings.teamSlots) out.teamSlots = rekey(settings.teamSlots);
  if (settings.teamPicks) out.teamPicks = rekey(settings.teamPicks);
  if (settings.pickOwners) {
    out.pickOwners = Object.fromEntries(
      Object.entries(settings.pickOwners).map(([p, owner]) => [p, owner === from ? next : owner]));
  }
  // The cached keeper import groups candidates by owner name; without this the
  // renamed team's roster stops being attributed to them.
  const cache = settings.keeperImport;
  if (cache?.candidates?.length) {
    out.keeperImport = {
      ...cache,
      candidates: cache.candidates.map((c) => (c.owner === from ? { ...c, owner: next } : c)),
    };
  }
  return out;
}

/**
 * Apply a whole edited opponents list, treating position as identity.
 *
 * `opponents[i]` is team_id `i`, so a changed entry at position i is a RENAME
 * of that team, not a different team appearing — which is what makes carrying
 * the keyed data correct rather than a guess. Returns the new settings plus the
 * renames applied, so callers can also fix data living outside settings.
 */
export function applyOpponentNames(settings, nextNames) {
  const before = settings.opponents ?? [];
  const after = (nextNames ?? []).map((n) => n.trim()).filter(Boolean);
  const renames = [];
  let out = settings;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    if (before[i] === after[i]) continue;
    const renamed = renameTeam(out, before[i], after[i]);
    if (renamed !== out) { out = renamed; renames.push({ from: before[i], to: after[i] }); }
  }
  // Adds/removals at the tail are not renames — take the list as given.
  if ((out.opponents ?? []).length !== after.length || after.some((n, i) => (out.opponents ?? [])[i] !== n)) {
    out = { ...out, opponents: after };
  }
  return { settings: out, renames };
}

/** Things worth showing the user rather than silently absorbing. */
export function orderWarnings(settings, owners) {
  const labels = teamLabels(settings);
  const held = picksByTeam(owners);
  const out = [];

  const opponents = (settings.opponents ?? []).filter(Boolean);
  if (opponents.length > labels.length - 1) {
    out.push(
      `${opponents.length} opponent names for a ${labels.length}-team league — ` +
      "the extras are ignored here. If one of them is your own team, remove it in League Settings.");
  }
  for (const label of labels) {
    if ((held[label] ?? []).length === 0) {
      out.push(`${label === MY_TEAM ? "You have" : `${label} has`} no picks at all — check the trades.`);
    }
  }
  return out;
}

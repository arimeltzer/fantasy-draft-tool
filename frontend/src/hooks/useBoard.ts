import { useMemo } from "react";
import { valueBoard, resolveScoring } from "@/engine/valuation-engine.js";
import type { BoardPlayer } from "@/engine/valuation-engine.js";
import { ApiPlayer, LeagueSettings } from "@/lib/api";

function toEnginePlayer(p: ApiPlayer) {
  return {
    id: p.id,
    name: p.name,
    pos: p.pos as "QB" | "RB" | "WR" | "TE" | "K" | "DST",
    team: p.team,
    age: p.age ?? undefined,
    proj: p.proj ?? {},
    last: p.last ?? null,
    last2: p.last2 ?? null,
    ecr: p.ecr ?? undefined,
    adp: p.adp ?? undefined,
    aav: p.aav ?? undefined,
  };
}

const FLEX_SHARE: Record<string, number> = { RB: 0.5, WR: 0.42, TE: 0.08 };

/** Team spellings that mean the same franchise. Mirrors data-pipeline/teams.py
 *  and backend/integrations/matching.py. */
const TEAM_ALIASES: Record<string, string> = {
  AZ: "ARI", ARZ: "ARI", CRD: "ARI", JAC: "JAX", WSH: "WAS", WFT: "WAS",
  LA: "LAR", STL: "LAR", RAM: "LAR", SD: "LAC", SDG: "LAC",
  OAK: "LV", LVR: "LV", RAI: "LV", BLT: "BAL", RAV: "BAL", CLV: "CLE",
  HST: "HOU", HTX: "HOU", OTI: "TEN", GNB: "GB", KAN: "KC", NWE: "NE",
  NOR: "NO", SFO: "SF", TAM: "TB",
};

const canonTeam = (t: string) => TEAM_ALIASES[(t || "").toUpperCase()] ?? (t || "").toUpperCase();

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/** Mirrors backend `matching.normalize_name` / pipeline `teams.normalize_name`:
 *  accents, case, punctuation and Jr/III all folded, whitespace collapsed. */
function canonName(name: string): string {
  return (name || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.'`\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !NAME_SUFFIXES.has(w))
    .join(" ");
}

/**
 * Collapse the same player appearing twice under different team spellings.
 *
 * The database keys players on `(season, name, pos, team)`, so a feed calling
 * Arizona "AZ" while another calls it "ARI" yields two rows. A duplicate on the
 * board is not cosmetic: drafting one copy leaves the twin looking available,
 * so the remaining pool — and every scarcity, tier and replacement-level number
 * derived from it — is wrong for the rest of the draft.
 *
 * The pipeline now canonicalizes at load time and a migration cleans existing
 * rows; this stays as a guard so a stale database can't corrupt a live draft.
 * Fields are unioned rather than picking a winner, since the split usually
 * means one row has the projection and the other the ADP/AAV.
 */
function dedupePlayers(players: ApiPlayer[]): ApiPlayer[] {
  const byKey = new Map<string, ApiPlayer>();
  const out: ApiPlayer[] = [];
  for (const raw of players) {
    const p = { ...raw, team: canonTeam(raw.team) };
    // Keyed on name+position, NOT team. Team is the field the sources disagree
    // about — and it is blank whenever a load ran without roster data, so a
    // blank-vs-ARI pair splits exactly like an ARI-vs-AZ pair does.
    const key = `${canonName(p.name)}|${p.pos}`;
    const kept = byKey.get(key);
    if (!kept) {
      byKey.set(key, p);
      out.push(p);
      continue;
    }
    // Same player, two rows — keep whichever value is actually present.
    if (!kept.team && p.team) kept.team = p.team;
    kept.proj ??= p.proj;
    kept.last ??= p.last;
    kept.last2 ??= p.last2;
    kept.ecr ??= p.ecr;
    kept.adp ??= p.adp;
    kept.aav ??= p.aav;
    kept.age ??= p.age;
  }
  return out;
}

export function useBoard(
  players: ApiPlayer[] | undefined,
  settings: LeagueSettings | undefined,
  sos: Record<string, Record<string, number>> | undefined,
): BoardPlayer[] {
  return useMemo(() => {
    if (!players?.length || !settings) return [];

    const sc = resolveScoring(settings);
    const league = {
      teams: settings.teams,
      roster: settings.roster,
      superflex: settings.superflex,
    };

    const enginePlayers = dedupePlayers(players).map(toEnginePlayer);
    let board = valueBoard(enginePlayers, league, sc);

    if (sos && Object.keys(sos).length > 0) {
      board = board.map((p) => {
        const mult = sos[p.team]?.[p.pos] ?? 1;
        return { ...p, valuePoints: +(p.valuePoints * mult).toFixed(1) };
      });

      const repPts: Record<string, number> = {};
      for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
        const list = board
          .filter((p) => p.pos === pos)
          .sort((a: BoardPlayer, b: BoardPlayer) => b.valuePoints - a.valuePoints);
        const rosterCount = (settings.roster as Record<string, number>)[pos] ?? 0;
        const flexContrib = FLEX_SHARE[pos] ?? 0;
        const repIdx = Math.max(
          0,
          Math.floor(settings.teams * rosterCount + settings.teams * (settings.roster.FLEX ?? 0) * flexContrib) - 1,
        );
        repPts[pos] = list[Math.min(repIdx, list.length - 1)]?.valuePoints ?? 0;
      }

      board = board
        .map((p: BoardPlayer) => ({ ...p, vbd: +(p.valuePoints - (repPts[p.pos] ?? 0)).toFixed(1) }))
        .sort((a: BoardPlayer, b: BoardPlayer) => b.vbd - a.vbd);
    }

    return board;
  }, [players, settings, sos]);
}

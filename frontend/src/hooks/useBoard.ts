import { useMemo } from "react";
import { valueBoard, resolveScoring } from "@/engine/valuation-engine.js";
import type { BoardPlayer } from "@/engine/valuation-engine.js";
import { ApiPlayer, LeagueSettings } from "@/lib/api";
import { canonName, aliasName, sameTeamOrUnknown } from "@/lib/playerName";

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
    injury: p.injury ?? null,
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

/** Fold `src` into `kept`, keeping whichever value is actually present. The
 *  split usually means one row has the projection and the other the ADP/AAV. */
function absorb(kept: ApiPlayer, src: ApiPlayer): void {
  if (!kept.team && src.team) kept.team = src.team;
  kept.proj ??= src.proj;
  kept.last ??= src.last;
  kept.last2 ??= src.last2;
  kept.ecr ??= src.ecr;
  kept.adp ??= src.adp;
  kept.aav ??= src.aav;
  kept.age ??= src.age;
  kept.injury ??= src.injury;
}

/**
 * Collapse the same player appearing twice across disagreeing feeds.
 *
 * The database keys players on `(season, name, pos, team)`, so any field the
 * sources spell differently yields two rows. A duplicate on the board is not
 * cosmetic: drafting one copy leaves the twin looking available, so the
 * remaining pool -- and every scarcity, tier and replacement-level number drawn
 * from it -- is wrong for the rest of the draft.
 *
 * TWO PASSES, because the two causes carry different risk.
 *
 * Pass 1 -- same canonical name, same position. Team is ignored: it is the
 * field the sources disagree about (ARI vs AZ) and it is blank whenever a load
 * ran without roster data, so a blank-vs-ARI pair splits exactly like an alias
 * pair. Agreement on name+position within one season is proof of identity.
 *
 * Pass 2 -- same name once the GIVEN name is folded through the nickname table,
 * so "Josh Palmer" meets "Joshua Palmer". This is an inference, not a
 * normalization, and it can be wrong (Michael Thomas of NO and Mike Thomas of
 * LAR were contemporaries), so it additionally requires the two rows not to
 * name different teams. That is the evidence pass 1 can afford to throw away
 * and this pass cannot.
 */
export function dedupePlayers(players: ApiPlayer[]): ApiPlayer[] {
  const byExact = new Map<string, ApiPlayer>();
  const firstPass: ApiPlayer[] = [];
  for (const raw of players) {
    const p = { ...raw, team: canonTeam(raw.team) };
    const key = `${canonName(p.name)}|${p.pos}`;
    const kept = byExact.get(key);
    if (kept) { absorb(kept, p); continue; }
    byExact.set(key, p);
    firstPass.push(p);
  }

  const byAlias = new Map<string, ApiPlayer>();
  const out: ApiPlayer[] = [];
  for (const p of firstPass) {
    const key = `${aliasName(p.name)}|${p.pos}`;
    const kept = byAlias.get(key);
    // A positive team disagreement means these are two different people who
    // happen to share a surname and a nickname. Leave both on the board: a
    // visible duplicate is recoverable, a silent merge of two players is not.
    if (kept && sameTeamOrUnknown(kept.team, p.team)) { absorb(kept, p); continue; }
    if (!kept) byAlias.set(key, p);
    out.push(p);
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

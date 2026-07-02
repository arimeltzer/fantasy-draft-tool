import { useMemo } from "react";
import { valueBoard, defaultScoring } from "@/engine/valuation-engine.js";
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

export function useBoard(
  players: ApiPlayer[] | undefined,
  settings: LeagueSettings | undefined,
  sos: Record<string, Record<string, number>> | undefined,
): BoardPlayer[] {
  return useMemo(() => {
    if (!players?.length || !settings) return [];

    const sc = defaultScoring(settings.ppr);
    const league = {
      teams: settings.teams,
      roster: settings.roster,
      superflex: settings.superflex,
    };

    const enginePlayers = players.map(toEnginePlayer);
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

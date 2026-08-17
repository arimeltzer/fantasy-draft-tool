import { useMemo } from "react";
import {
  projectAll, finalizeBoard, marketAnchor, MARKET_ANCHOR_W, resolveScoring,
  blendExpertAll, EXPERT_BLEND_W, applyInjuryDiscount, INJURY_K,
} from "@/engine/valuation-engine.js";
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

    // Order is load-bearing. The injury discount corrects OUR projection for
    // CURRENT reported status first (roadmap 0.3 — same category as
    // durabilityMult, which it sits right beside); the expert blend corrects
    // it again with FantasyPros' veteran numbers next (roadmap 0.1 — still
    // the model's own point estimate, not a ranking correction); schedule
    // strength adjusts that finished projection next; the market anchor then
    // reads it; and replacement level, VBD and tiers are derived last, from
    // whatever valuePoints ended up being. Deriving VBD before an adjustment
    // (as the old SOS path did, then recomputing it by hand) is how the two
    // copies of the replacement maths drifted apart.
    let scored = projectAll(enginePlayers, sc);

    // Backtested 2017-2025: at k=0.5, QB and RB clear the roadmap 0.3 kill
    // gate (spearman_total improves without spearman_pace degrading); TE/WR
    // did not and stay at k=0 in INJURY_K, i.e. untouched. On by default —
    // a player with no reported injury status is untouched regardless.
    if (settings.injuryDiscount !== false) {
      scored = applyInjuryDiscount(scored, INJURY_K);
    }

    // Backtested 2019-2025: matched-population AND full-board merged Spearman
    // both clear the roadmap 0.1 kill gate at every position, at the weights
    // in EXPERT_BLEND_W. On by default for the same reason as the anchor
    // below — a league with no expert-projection coverage in its pool loses
    // nothing (blendExpertAll leaves uncovered players untouched), and a
    // mid-draft valuation change should be reversible without a deploy.
    if (settings.expertBlend !== false) {
      scored = blendExpertAll(scored, sc, EXPERT_BLEND_W);
    }

    if (sos && Object.keys(sos).length > 0) {
      scored = scored.map((p) => ({
        ...p,
        valuePoints: +(p.valuePoints * (sos[p.team]?.[p.pos] ?? 1)).toFixed(1),
      }));
    }

    // Backtested +0.05/+0.05/+0.02/+0.02 Spearman (QB/RB/TE/WR) against the
    // unanchored model on the full board, so it is on by default; the setting
    // exists because a league whose player pool carries no ADP or ECR at all
    // gains nothing from it, and because a mid-draft valuation change should
    // be reversible without a deploy.
    if (settings.marketAnchor !== false) {
      scored = marketAnchor(scored, settings.marketAnchorWeight ?? MARKET_ANCHOR_W);
    }

    return finalizeBoard(scored, league);
  }, [players, settings, sos]);
}

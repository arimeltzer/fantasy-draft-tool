import { useMemo } from "react";
import {
  projectAll, finalizeBoard, marketAnchor, MARKET_ANCHOR_W, resolveScoring, points, tierize,
  blendExpertAll, EXPERT_BLEND_W, applyInjuryDiscount, INJURY_K,
  applyOpportunityModel, OPPORTUNITY_K,
  applyTeamChangeDiscount, TEAM_CHANGE_K,
} from "@/engine/valuation-engine.js";
import type { BoardPlayer, ProjBreakdownStep } from "@/engine/valuation-engine.js";
import { ApiPlayer, LeagueSettings } from "@/lib/api";
import { canonName, aliasName, sameTeamOrUnknown } from "@/lib/playerName";

/**
 * Appends one waterfall step to every player whose `valuePoints` actually
 * moved between `before` and `after` — a stage that was a no-op for a given
 * player (e.g. injury discount on someone with no reported status) leaves no
 * trace, so the tooltip only ever shows what really happened. Pure UI
 * bookkeeping: none of the engine's own stage functions know this exists.
 */
function trackStage<T extends { id: number | string; valuePoints: number; projBreakdown?: ProjBreakdownStep[] }>(
  before: T[], after: T[], label: string, detail?: (p: T) => string | undefined,
): T[] {
  const prevById = new Map(before.map((p) => [p.id, p.valuePoints]));
  return after.map((p) => {
    const prev = prevById.get(p.id);
    if (prev == null || prev === p.valuePoints) return p;
    const step: ProjBreakdownStep = { label, value: p.valuePoints, detail: detail?.(p) };
    return { ...p, projBreakdown: [...(p.projBreakdown ?? []), step] };
  });
}

function toEnginePlayer(p: ApiPlayer) {
  return {
    id: p.id,
    name: p.name,
    pos: p.pos as "QB" | "RB" | "WR" | "TE" | "K" | "DST",
    team: p.team,
    age: p.age ?? undefined,
    yearsExp: p.years_exp ?? undefined,
    proj: p.proj ?? {},
    last: p.last ?? null,
    last2: p.last2 ?? null,
    ecr: p.ecr ?? undefined,
    adp: p.adp ?? undefined,
    aav: p.aav ?? undefined,
    fpTier: p.fp_tier ?? undefined,
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

    // Order is load-bearing. The opportunity model (TE only) REPLACES OUR
    // projection first (roadmap Phase 1 — volume x shrunk efficiency instead
    // of the points-pace blend); the team-change discount corrects that for
    // an RB/WR who switched teams next (roadmap 1.3 — measured applied to
    // the pure model's own estimate, before injury/expert/anchor touch it);
    // the injury discount corrects whatever that left with for CURRENT
    // reported status next (roadmap 0.3 — same category as durabilityMult,
    // which it sits right beside); the expert blend corrects it again with
    // FantasyPros' veteran numbers next (roadmap 0.1 — still the model's own
    // point estimate, not a ranking correction); schedule strength adjusts
    // that finished projection next; the market anchor then reads it; and
    // replacement level, VBD and tiers are derived last, from whatever
    // valuePoints ended up being. Deriving
    // VBD before an adjustment (as the old SOS path did, then recomputing it
    // by hand) is how the two copies of the replacement maths drifted apart.
    // The waterfall shown in the "Proj" hover (see /methodology) starts here
    // — every player gets a "Base model" step unconditionally, so the
    // tooltip always has at least one line even when nothing downstream
    // touches them.
    let scored = projectAll(enginePlayers, sc).map((p) => ({
      ...p,
      projBreakdown: [{
        label: "Base model",
        value: p.valuePoints,
        detail: p.rookie
          ? "No prior-season stats — projected from market rank"
          : "Two-season pace blend, age & durability adjusted",
      }],
    }));

    // Backtested 2017-2025 against the ACTUAL live board (injury discount +
    // expert blend already applied), not just the bare model — only TE
    // cleared the Phase 1 kill gate there; QB/WR's apparent gain against the
    // bare model turned out to be signal the expert blend was already
    // extracting, and RB never had anything. A player with no usable volume
    // (a rookie, or any non-TE position at OPPORTUNITY_K=0) passes through
    // with whatever projectAll() already gave them.
    if (settings.opportunityModel !== false) {
      const before = scored;
      scored = applyOpportunityModel(scored, sc, OPPORTUNITY_K);
      scored = trackStage(before, scored, "Opportunity model (TE)",
        () => "Replaces the pace blend above: volume × league-shrunk efficiency");
    }

    // Backtested 2017-2025, measured TWO ways like the opportunity model
    // taught to: against the pure model (QB/RB/WR cleared the phase kill
    // gate) and re-baselined against the live board (injury discount +
    // expert blend + anchor) — where QB's gain nearly vanished (already
    // captured by QB's injury discount + 0.3-weighted expert blend) but
    // RB/WR held up. Shipped as TEAM_CHANGE_K = { RB: 0.4, WR: 0.7 } — both
    // found peaks from a two-pass widened sweep (see team-context.js; WR's
    // 0.7 looks large but is the cleanest, biggest effect measured anywhere
    // in this phase). A player with no prior-season team on record (a
    // rookie) is untouched regardless. On by default — reversible mid-draft
    // without a deploy.
    if (settings.teamChangeDiscount !== false) {
      const before = scored;
      scored = applyTeamChangeDiscount(scored, TEAM_CHANGE_K);
      scored = trackStage(before, scored, "Team change",
        (p) => `Changed teams: ${p.last?.team ?? "?"} → ${p.team}`);
    }

    // Backtested 2017-2025: at k=0.5, QB and RB clear the roadmap 0.3 kill
    // gate (spearman_total improves without spearman_pace degrading); TE/WR
    // did not and stay at k=0 in INJURY_K, i.e. untouched. On by default —
    // a player with no reported injury status is untouched regardless.
    if (settings.injuryDiscount !== false) {
      const before = scored;
      scored = applyInjuryDiscount(scored, INJURY_K);
      scored = trackStage(before, scored, "Injury discount",
        (p) => p.injury?.severity ? `Reported: ${p.injury.severity}` : undefined);
    }

    // Backtested 2019-2025: matched-population AND full-board merged Spearman
    // both clear the roadmap 0.1 kill gate at every position, at the weights
    // in EXPERT_BLEND_W. On by default for the same reason as the anchor
    // below — a league with no expert-projection coverage in its pool loses
    // nothing (blendExpertAll leaves uncovered players untouched), and a
    // mid-draft valuation change should be reversible without a deploy.
    if (settings.expertBlend !== false) {
      const before = scored;
      scored = blendExpertAll(scored, sc, EXPERT_BLEND_W);
      scored = trackStage(before, scored, "Expert blend",
        (p) => `Blended with FantasyPros' projection (weight on our model: ${EXPERT_BLEND_W[p.pos] ?? 1})`);
    }

    if (sos && Object.keys(sos).length > 0) {
      const before = scored;
      scored = scored.map((p) => ({
        ...p,
        valuePoints: +(p.valuePoints * (sos[p.team]?.[p.pos] ?? 1)).toFixed(1),
      }));
      scored = trackStage(before, scored, "Schedule strength",
        (p) => `×${(sos[p.team]?.[p.pos] ?? 1).toFixed(2)} for ${p.team || "their"} opponents this season`);
    }

    // Backtested +0.05/+0.05/+0.02/+0.02 Spearman (QB/RB/TE/WR) against the
    // unanchored model on the full board, so it is on by default; the setting
    // exists because a league whose player pool carries no ADP or ECR at all
    // gains nothing from it, and because a mid-draft valuation change should
    // be reversible without a deploy.
    if (settings.marketAnchor !== false) {
      const before = scored;
      scored = marketAnchor(scored, settings.marketAnchorWeight ?? MARKET_ANCHOR_W);
      scored = trackStage(before, scored, "Market anchor",
        () => "Pulled toward ADP/ECR consensus order for players the market ranks");
    }

    const finalBoard = finalizeBoard(scored, league);

    // SECOND OPINION, DISPLAY ONLY (roadmap 0.1b) — computed AFTER
    // finalizeBoard, deliberately outside the valuation waterfall above:
    // blending The Athletic's projections into valuePoints was gated the
    // same two ways every signal here is required to clear and FAILED the
    // decisive one (QB/TE flip sign between validation seasons, RB/WR under
    // 0.01 Spearman — see CLAUDE.md). This never touches valuePoints/vbd/
    // tier; it's this league's own scoring applied to whatever stat line was
    // uploaded, tiered by the SAME gap rule (tierize/TIER_GAP) the app's own
    // `tier` uses on vbd — so the badge reads the same way ("a drop-off
    // tier") even though the number underneath comes from a different
    // source, the way `fpTier` is already weighed next to the app's own
    // computed tier. Positional rank is also kept, for the tooltip.
    const athleticOverrides = settings.athleticProjections;
    if (athleticOverrides && Object.keys(athleticOverrides).length > 0) {
      const withPts = finalBoard.map((p) => {
        const line = athleticOverrides[p.id as number];
        if (!line) return p;
        return { ...p, athleticPoints: +points(line, sc).toFixed(1) };
      });
      const rankOf = new Map<number | string, number>();
      const tierOf = new Map<number | string, number>();
      const byPos = new Map<string, typeof withPts>();
      for (const p of withPts) {
        if (p.athleticPoints == null) continue;
        const arr = byPos.get(p.pos) ?? [];
        arr.push(p);
        byPos.set(p.pos, arr);
      }
      // Same position scope as finalizeBoard's own tier (K/DST untiered) —
      // moot in practice since the uploader only covers QB/RB/WR/TE anyway,
      // but kept explicit rather than assumed.
      const TIERED_POS = new Set(["QB", "RB", "WR", "TE"]);
      for (const [pos, arr] of byPos) {
        arr.sort((a, b) => (b.athleticPoints as number) - (a.athleticPoints as number));
        arr.forEach((p, i) => rankOf.set(p.id, i + 1));
        if (TIERED_POS.has(pos)) {
          const tiers = tierize(arr, "athleticPoints");
          for (const p of arr) tierOf.set(p.id, tiers[p.id]);
        }
      }
      return withPts.map((p) => rankOf.has(p.id)
        ? { ...p, athleticRank: rankOf.get(p.id), athleticTier: tierOf.get(p.id) }
        : p);
    }

    return finalBoard;
  }, [players, settings, sos]);
}

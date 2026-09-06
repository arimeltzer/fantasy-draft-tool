import { BoardPlayer } from "./valuation-engine";
import { KeeperCost } from "./keeper";
import { KeeperRule } from "@/lib/api";

export interface RecoCandidate {
  id: number;
  player: BoardPlayer;
  cost: KeeperCost;
}

export interface RecoItem {
  cand: RecoCandidate;
  market: number;
  /** Roadmap 3.12 — the value actually credited toward surplus: equals
   *  `market` unless `insuranceDiscounted`, in which case it's `market *
   *  INSURANCE_MULT`. Snake only; unset for auction items. */
  keptValue?: number;
  /** Roadmap 3.12 — true when this keeper is a redundant QB/TE (a second
   *  same-position keeper past the starter count, non-superflex) and his
   *  value was discounted accordingly. Snake only. */
  insuranceDiscounted?: boolean;
  /** Roadmap 3.13 — display-only, never feeds surplus/kv: at MY next real
   *  pick after this keeper's forfeited pick, the best SAME-POSITION
   *  player the market expects to still be there (null = no later pick
   *  owned, or nothing left at the position). Answers "will I be able to
   *  draft a comparable/better one myself anyway" — every position, not
   *  just QB/TE; read it as a "you may not need to keep him" signal for
   *  insurance-only positions (QB non-superflex, TE) and as depth context
   *  everywhere else. Snake only; unset for auction items. */
  positionalFallback?: { player: BoardPlayer; pick: number; round: number | null; gap: number } | null;
  cost: number;
  surplus: number;
  scarcity: number;
  fit: number;
  kv: number;
  forfeit: BoardPlayer | null;
  forfeitPick: number | null;
  round?: number;
  recommended?: boolean;
}

export interface RecoContext {
  format: "auction" | "snake";
  board: BoardPlayer[];
  marketBoard: (BoardPlayer & { marketIdx: number })[];
  settings: {
    teams: number; draftSlot?: number; budget?: number; roster: Record<string, number>;
    /** Roadmap 3.12 — a superflex league's 2nd QB is real depth, not
     *  insurance; without this the discount would wrongly apply to it. */
    superflex?: boolean;
  };
  allKeptIds?: Set<number>;
  maxKeepers?: number;
  flexFloor?: number;
}

export interface RecoResult {
  best: { ids: number[]; totalKV: number; items: RecoItem[] };
  ranked: RecoItem[];
  byId: Record<number, RecoItem>;
  params: { flexFloor: number; slot: number; teams: number; scarceFactor: number };
}

export declare function marketOrder(board: BoardPlayer[]): (BoardPlayer & { marketIdx: number })[];
export declare function expectedAtPick(
  marketBoard: (BoardPlayer & { marketIdx: number })[], P: number, keptIds: Set<number>,
  pos?: string | null,
): BoardPlayer | null;
export declare function positionalFallback(
  player: BoardPlayer, marketBoard: (BoardPlayer & { marketIdx: number })[], keptIds: Set<number>,
  myPicks: number[], forfeitPick: number, teams?: number,
): { player: BoardPlayer; pick: number; round: number | null; gap: number } | null;
export declare function wheelFactor(slot: number, teams: number): number;
export declare function scarcityBonus(
  player: BoardPlayer, board: BoardPlayer[], keptIds: Set<number>, factor?: number,
): number;
export declare function auctionCandidateValue(
  cand: RecoCandidate, board: BoardPlayer[], keptIds: Set<number>, scarceFactor?: number,
): Omit<RecoItem, "cand" | "fit" | "kv" | "recommended">;
export declare function snakeCandidateValue(
  cand: RecoCandidate, board: BoardPlayer[], marketBoard: (BoardPlayer & { marketIdx: number })[],
  keptIds: Set<number>, myPicks: number[], assignedRound: number | undefined, scarceFactor: number,
  teams?: number, sameposKeptBefore?: number, roster?: Record<string, number>, superflex?: boolean,
): Omit<RecoItem, "cand" | "fit" | "kv" | "recommended">;
export declare function recommendKeepers(candidates: RecoCandidate[], ctx: RecoContext): RecoResult;
export declare function draftImpact(
  best: RecoResult["best"], ctx: Pick<RecoContext, "format" | "settings">,
): { keepers: number; spend: number | null; budgetLeft: number | null;
     forfeitedPicks: { round: number; overall: number }[] | null };

export interface PredictInput {
  player_id: number | null;
  is_mine: boolean;
  owner: string;
  bid: number | null;
  round: number | null;
  waiver?: number | null;
}

export interface PredictedKeeper {
  id: number;
  name: string;
  pos: string;
  surplus: number;
  cost: KeeperCost;
  base: number | null;
}

export declare function predictOpponentKeepers(
  candidates: PredictInput[],
  ctx: {
    format: "auction" | "snake";
    board: BoardPlayer[];
    marketBoard: (BoardPlayer & { marketIdx: number })[];
    settings: {
      teams: number;
      roster?: Record<string, number>;
      /** Team name -> draft slot; prices a rival's forfeited pick correctly. */
      teamSlots?: Record<string, number>;
      /** Team name -> owned overall picks (traded); wins over teamSlots. */
      teamPicks?: Record<string, number[]>;
    };
    rule: KeeperRule;
    floor?: number;
    baseKept?: Set<number>;
    committedIds?: Set<number>;
    committedByOwner?: Record<string, number>;
  },
): { keptIds: Set<number>; byTeam: Record<string, PredictedKeeper[]> };

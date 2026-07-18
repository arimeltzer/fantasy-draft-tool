import { BoardPlayer } from "./valuation-engine";
import { KeeperCost } from "./keeper";

export interface RecoCandidate {
  id: number;
  player: BoardPlayer;
  cost: KeeperCost;
}

export interface RecoItem {
  cand: RecoCandidate;
  market: number;
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
  settings: { teams: number; draftSlot?: number; budget?: number; roster: Record<string, number> };
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
): BoardPlayer | null;
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
): Omit<RecoItem, "cand" | "fit" | "kv" | "recommended">;
export declare function recommendKeepers(candidates: RecoCandidate[], ctx: RecoContext): RecoResult;
export declare function draftImpact(
  best: RecoResult["best"], ctx: Pick<RecoContext, "format" | "settings">,
): { keepers: number; spend: number | null; budgetLeft: number | null;
     forfeitedPicks: { round: number; overall: number }[] | null };

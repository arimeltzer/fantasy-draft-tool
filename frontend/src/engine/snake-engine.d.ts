export * from "./engine-core.js";

import type { EngineParams, BoardPlayer } from "./engine-core.js";

export interface SlotConfig {
  QB_MIN: number; QB2_MIN: number;
  WR_P1: number; WR_P2: number; WR_P3: number; WR_P4: number;
  ADP_W: number; AGE29: number; AGE31: number;
  adpAbsActive: boolean;
}

export interface SnakeParams extends EngineParams {
  teMinRound: number;
  te2MinRound: number;
  riskGateRounds: number;
  riskGateThreshold: number;
  adpAbs: number;
  adpAbsCeil: number;
  SLOT_DEFAULT: SlotConfig;
  SLOTS: Record<number, SlotConfig>;
}

export interface SnakeLiveState {
  round: number;
  teams: number;
  slot?: number;
  counts: Record<string, number>;
  roster: Record<string, number>;
  needs: Record<string, number>;
  bestVbd: number;
  posRemaining: Record<string, number>;
  adpRankById: Record<number, number>;
  cliffById?: Record<number, number>;
  poolSize: number;
}

export interface PickScoreResult {
  score: number;
  reasons: string[];
  blocked?: string;
}

export declare const DEFAULT_SNAKE_PARAMS: SnakeParams;

export declare function resolveSlotConfig(P: SnakeParams, teams: number, slot?: number): SlotConfig;
export declare function rankByAdp(players: { id: number | string; adp?: number | null }[]): Record<number, number>;
export declare function pickScore(
  player: BoardPlayer, liveState: SnakeLiveState, P?: SnakeParams
): PickScoreResult;
export declare function snakePicks(slot: number, teams: number, rounds?: number): number[];

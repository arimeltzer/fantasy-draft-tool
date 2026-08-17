import type { EngineParams, Player, Scoring, StatLine } from "./engine-core";

export declare const OPPORTUNITY_FIELDS: Record<string, (keyof StatLine)[]>;
/** Shipped efficiency-shrinkage strength, per position. Only TE is nonzero. */
export declare const OPPORTUNITY_K: Record<string, number>;

export declare function opportunity(line: StatLine | null | undefined, pos: string): number;

export declare function computeLeagueEfficiency(
  players: { pos: string; last?: StatLine | null; last2?: StatLine | null }[],
  sc: Scoring,
): Record<string, { rate: number; meanOpp: number }>;

export declare function projectPointsOpportunity(
  player: Player, sc: Scoring, rates: Record<string, { rate: number; meanOpp: number }>,
  k: number, P?: EngineParams,
): {
  proj: number; pace1: number | null; pace2: number | null; durMult: number; ageMult: number;
  volume: number; efficiency: number; ownEfficiency: number; rookie: boolean;
} | null;

/** Apply the opportunity model across a projected board. Players the model
 *  has nothing to say about pass through with whatever projectAll() gave
 *  them (also carries every other field on T unchanged). */
export declare function applyOpportunityModel<T extends {
  pos: string; age?: number; last?: StatLine | null; last2?: StatLine | null; valuePoints: number;
}>(
  players: T[], sc: Scoring, K?: Record<string, number>, P?: EngineParams,
): T[];

export interface StatLine {
  passYd?: number; passTD?: number; int?: number;
  rushYd?: number; rushTD?: number;
  rec?: number; recYd?: number; recTD?: number;
  fumbles?: number; pts?: number; gp?: number;
}

export interface Player {
  id: number | string;
  name: string;
  pos: "QB" | "RB" | "WR" | "TE" | "K" | "DST";
  team: string;
  age?: number;
  proj?: StatLine;
  last?: StatLine | null;
  last2?: StatLine | null;
  ecr?: number | null;
  adp?: number | null;
  aav?: number | null;
}

export interface Scoring {
  ptsPerPassYd: number; ptsPerPassTD: number; ptsPerInt: number;
  ptsPerRushYd: number; ptsPerRushTD: number;
  ptsPerRec: number; ptsPerRecYd: number; ptsPerRecTD: number;
  ptsPerFumble: number;
}

export interface RosterConfig {
  QB?: number; RB?: number; WR?: number; TE?: number;
  FLEX?: number; K?: number; DST?: number; BENCH?: number; SF?: number;
}

export interface League {
  teams: number;
  roster: RosterConfig;
  superflex?: boolean;
}

export interface ProjectionParams {
  primaryWeight: number;
  primaryWeightUp: number;
  primaryWeightDown: number;
  trendThreshold: number;
  durability: [number, number][];
  rookieCeil: Record<string, number>;
  rookieEraBonus: number;
  rookieAdpFloor: number;
  rookieAdpSpan: number;
  fragileQbTeams: string[];
  fragileQbWrMult: number;
}

export interface EngineParams {
  priorWeight: number;
  regressionStrength: number;
  projectedGames: number;
  age: Record<string, { declineStart: number; declinePerYear: number; youthPeak: number; youthBonus: number }>;
  ageClamp: [number, number];
  projection: ProjectionParams;
  flexShare: { RB: number; WR: number; TE: number };
  auction: { minBid: number };
}

export interface BoardPlayer extends Player {
  projPts: number;
  priorEquiv: number | null;
  valuePoints: number;
  ageMult: number;
  trend: number | null;
  rookie: boolean;
  risk: number;
  vbd: number;
  tier: number | null;
  parValue?: number;
  dollarValue?: number;
  paid?: number | null;
  adjValue?: number | null;
}

export declare const DEFAULT_PARAMS: EngineParams;
export declare const SCORING_PRESETS: Record<string, { ppr: number }>;

export declare function defaultScoring(ppr?: number): Scoring;
export declare function points(line: StatLine, sc: Scoring): number;
export declare function ageMultiplier(pos: string, age: number, P?: EngineParams): number;
export declare function projectPoints(
  player: Player, sc: Scoring, P?: EngineParams
): { proj: number; pace1: number | null; pace2: number | null; trend: number | null; durMult: number; ageMult: number; rookie: boolean };
export declare function projectValue(
  player: Player, sc: Scoring, P?: EngineParams
): { projPts: number; priorEquiv: number | null; valuePoints: number; ageMult: number; trend: number | null; rookie: boolean; risk: number };
export declare function replacementRanks(league: League, P?: EngineParams): Record<string, number>;
export declare function valueBoard(
  players: Player[], league: League, sc: Scoring, P?: EngineParams
): BoardPlayer[];

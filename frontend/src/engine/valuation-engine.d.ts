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
  ecr?: number | null;
  adp?: number | null;
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

export interface AuctionLeague {
  teams: number;
  budget: number;
  rosterSize: number;
}

export interface EngineParams {
  priorWeight: number;
  regressionStrength: number;
  projectedGames: number;
  age: Record<string, { declineStart: number; declinePerYear: number; youthPeak: number; youthBonus: number }>;
  ageClamp: [number, number];
  flexShare: { RB: number; WR: number; TE: number };
  auction: { minBid: number };
}

export interface BoardPlayer extends Player {
  projPts: number;
  priorEquiv: number | null;
  valuePoints: number;
  ageMult: number;
  risk: number;
  vbd: number;
  tier: number | null;
  parValue?: number;
  paid?: number | null;
  adjValue?: number | null;
}

export interface InflationResult {
  factor: number;
  board: BoardPlayer[];
  spent: number;
  remainingMoney: number;
  remainingSpots: number;
}

export declare const DEFAULT_PARAMS: EngineParams;
export declare const SCORING_PRESETS: Record<string, { ppr: number }>;

export declare function defaultScoring(ppr?: number): Scoring;
export declare function points(line: StatLine, sc: Scoring): number;
export declare function ageMultiplier(pos: string, age: number, P?: EngineParams): number;
export declare function projectValue(
  player: Player, sc: Scoring, P?: EngineParams
): { projPts: number; priorEquiv: number | null; valuePoints: number; ageMult: number; risk: number };
export declare function replacementRanks(league: League, P?: EngineParams): Record<string, number>;
export declare function valueBoard(
  players: Player[], league: League, sc: Scoring, P?: EngineParams
): BoardPlayer[];
export declare function snakePicks(slot: number, teams: number, rounds?: number): number[];
export declare function auctionValues(
  board: BoardPlayer[], auctionLeague: AuctionLeague, P?: EngineParams
): BoardPlayer[];
export declare function applyInflation(
  boardWithPar: BoardPlayer[],
  draftedPrices: { id: number | string; price: number }[],
  auctionLeague: AuctionLeague,
  P?: EngineParams,
): InflationResult;
export declare function maxBid(myBudgetLeft: number, myOpenSpots: number, minBid?: number): number;

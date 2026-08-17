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
  /** Reported injury, carried straight through from the player row. */
  injury?: {
    status: string; short?: string | null; type?: string | null;
    severity: "out" | "doubtful" | "questionable" | "note";
    chance?: number | null;
  } | null;
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
export declare const DEFAULT_SCORING: Omit<Scoring, "ptsPerRec">;

export declare function defaultScoring(ppr?: number): Scoring;
/** Resolve a league's full scoring rules: DEFAULT_SCORING + settings.scoring
 *  overrides, with settings.ppr always winning for ptsPerRec. Omitting
 *  settings.scoring reproduces defaultScoring(settings.ppr) exactly. */
export declare function resolveScoring(settings: {
  ppr?: number;
  scoring?: Partial<Omit<Scoring, "ptsPerRec">>;
}): Scoring;
export declare function points(line: StatLine, sc: Scoring): number;
export declare function ageMultiplier(pos: string, age: number, P?: EngineParams): number;
export declare function projectPoints(
  player: Player, sc: Scoring, P?: EngineParams
): { proj: number; pace1: number | null; pace2: number | null; trend: number | null; durMult: number; ageMult: number; rookie: boolean };
export declare function projectValue(
  player: Player, sc: Scoring, P?: EngineParams
): { projPts: number; priorEquiv: number | null; valuePoints: number; ageMult: number; trend: number | null; rookie: boolean; risk: number };
export declare function rankByAdp(players: { id: number | string; adp?: number | null; ecr?: number | null }[]): Record<number, number>;
export declare function replacementRanks(league: League, P?: EngineParams): Record<string, number>;
/** Default weight on OUR model when anchoring to the market (0.3). */
export declare const MARKET_ANCHOR_W: number;
/** Pull valuePoints toward the market's ordering where ADP/ECR ranks a player,
 *  by rank transfer onto our own points ladder. Ranked players only; the rest
 *  pass through untouched. `w` is the weight on our model. */
export declare function marketAnchor<T extends { id: number | string; pos: string; valuePoints: number }>(
  players: T[], w?: number, rankById?: Record<number | string, number> | null,
): T[];
/** Projection only — valuePoints without replacement level or VBD. */
export declare function projectAll(
  players: Player[], sc: Scoring, P?: EngineParams
): (Player & ReturnType<typeof projectValue>)[];
/** Replacement level, VBD and tiers from finished valuePoints. Runs LAST. */
export declare function finalizeBoard(
  scored: { id: number | string; pos: string; valuePoints: number }[],
  league: League, P?: EngineParams,
): BoardPlayer[];
export declare function valueBoard(
  players: Player[], league: League, sc: Scoring, P?: EngineParams,
  opts?: { anchor?: boolean; anchorW?: number },
): BoardPlayer[];

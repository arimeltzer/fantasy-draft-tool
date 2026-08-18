/**
 * Type definitions for lineup-optimizer.js
 * Roadmap 2.2b: weekly-lineup season simulator
 */

export interface Player {
  name: string;
  pos: string;
  team: string;
  proj_week?: number;
}

export interface RosterSettings {
  QB?: number;
  RB?: number;
  WR?: number;
  TE?: number;
  K?: number;
  DST?: number;
  FLEX?: number;
}

export interface LeagueSettings {
  roster: RosterSettings;
  bench: number;
  weeks?: number;
}

export interface LineupResult {
  starters: Player[];
  bench: Player[];
  score: number;
}

export interface SeasonStats {
  mean: number;
  sd: number;
  q5: number;
  q25: number;
  q50: number;
  q75: number;
  q95: number;
}

export type WeeklyOutcomes = Record<string, number>;
export type WeeklyDistributions = Record<string, number[]>;
export type Schedule = Record<string, Record<number, string>>;

/**
 * Select the best starting lineup for a given week.
 * Greedily picks highest-scoring available player at each position.
 */
export function optimizeLineup(
  roster: Player[],
  week: number,
  leagueSettings: LeagueSettings,
  weeklyOutcomes: WeeklyOutcomes,
  schedule: Schedule,
  season: number,
): LineupResult;

/**
 * Monte Carlo simulation of a full season.
 * For each of nDraws independent runs: iterate through weeks,
 * draw weekly outcomes, optimize lineups, accumulate season score.
 */
export function simulateSeason(
  roster: Player[],
  leagueSettings: LeagueSettings,
  weeklyDistributions: WeeklyDistributions,
  schedule: Schedule,
  season: number,
  rng?: () => number,
  nDraws?: number,
): number[];

/**
 * Compute quantile-based statistics from sorted season totals.
 */
export function seasonStats(sorted: number[]): SeasonStats;

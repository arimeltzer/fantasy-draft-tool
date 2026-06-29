export * from "./engine-core.js";

import type { EngineParams, BoardPlayer } from "./engine-core.js";

export interface AuctionLeague {
  teams: number;
  budget: number;
  rosterSize: number;
}

export interface AuctionParams extends EngineParams {
  auction: { minBid: number };
}

export interface InflationResult {
  factor: number;
  board: BoardPlayer[];
  spent: number;
  remainingMoney: number;
  remainingSpots: number;
}

export declare const DEFAULT_AUCTION_PARAMS: AuctionParams;

export declare function auctionValues(
  board: BoardPlayer[], auctionLeague: AuctionLeague, P?: AuctionParams
): BoardPlayer[];

export declare function applyInflation(
  boardWithPar: BoardPlayer[],
  draftedPrices: { id: number | string; price: number }[],
  auctionLeague: AuctionLeague,
  P?: AuctionParams,
): InflationResult;

export declare function maxBid(myBudgetLeft: number, myOpenSpots: number, minBid?: number): number;

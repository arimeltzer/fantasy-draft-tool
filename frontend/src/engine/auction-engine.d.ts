export * from "./engine-core.js";

import type { EngineParams, BoardPlayer } from "./engine-core.js";

export interface AuctionLeague {
  teams: number;
  budget: number;
  rosterSize: number;
  benchSpots?: number;
}

export interface AuctionParams extends EngineParams {
  auction: { minBid: number };
  POS_ALLOC: Record<string, number>;
  POS_ALLOC_14: Record<string, number>;
  LOG_A: number;
  LOG_A_14: number;
  ratioScaleBase: number;
  ratioScaleSlope: number;
  ratioScaleClamp: [number, number];
  qbMarketCap: number;
  richBudgetThreshold: number;
  dumpRatio: number;
  effectiveDvFloor: number;
}

export interface BidSuggestion {
  bid: number;
  market: number;
  dollarValue: number;
  pass: boolean;
}

export interface MyBidState {
  budget: number;
  openSpots: number;
  remainingDvSum: number;
  market: number;
}

export interface NominationDraftState {
  oppBudgets: number[];
  marketById: Record<number, number>;
  fractionDone?: number;
}

export interface NominationResult {
  score: number;
  isDump: boolean;
  market: number;
  effectiveDv: number;
  richFrac: number;
}

export interface InflationResult {
  /** The multiplier actually applied to every $Live price, bounded by
   *  INFLATION_CLAMP. */
  factor: number;
  board: BoardPlayer[];
  spent: number;
  remainingMoney: number;
  remainingSpots: number;
  /** The unbounded ratio, kept as a diagnostic — late in a draft it runs to
   *  hundreds as its denominator collapses. Never use it to price. */
  raw: number;
  /** `factor !== raw`: the bound bit. */
  clamped: boolean;
  /** False once too little priced value is left on the board for the ratio to
   *  estimate anything. */
  reliable: boolean;
  /** Share of the board's ORIGINAL above-$1 par value still undrafted. */
  coverage: number;
}

export declare const INFLATION_CLAMP: { min: number; max: number };
export declare const INFLATION_MIN_COVERAGE: number;

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

export declare function dollarValues(
  board: BoardPlayer[], auctionLeague: AuctionLeague, P?: AuctionParams
): BoardPlayer[];
export declare function marketPrice(
  adpRank: number, auctionLeague: AuctionLeague, P?: AuctionParams, pos?: string,
  aav?: number | null,
  /** League-specific positional price bias. See auction-calibration.js — it is
   *  applied to this FORECAST only, never to our own dollarValue. */
  calibration?: import("./auction-calibration.js").AuctionCalibration | null,
): number;
export declare function suggestBid(
  player: BoardPlayer, myState: MyBidState, P?: AuctionParams
): BidSuggestion;
export declare function nominationScore(
  player: BoardPlayer, draftState: NominationDraftState, P?: AuctionParams
): NominationResult;
export declare function nominationPhase(richFrac: number): "early" | "mid" | "late";

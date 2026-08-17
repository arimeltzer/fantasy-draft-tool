export interface AuctionCalibration {
  /** False when there was too little prior-season evidence to say anything.
   *  Consumers must treat an unusable calibration as the identity. */
  usable: boolean;
  /** Per-position multiplier on the MARKET price forecast. Spend-neutral:
   *  the model-share-weighted mean is 1, so the pot is unchanged. */
  posMult: Record<string, number>;
  /** Priced picks observed per position — what the shrinkage is driven by. */
  sample: Record<string, number>;
  observedShare: Record<string, number>;
  modelShare: Record<string, number>;
  totalSpend: number;
  pricedPicks: number;
  /** Priced picks as a fraction of a full draft (teams x rosterSize).
   *  Below ~0.75 the import is end-of-season survivors, not the draft. */
  coverage: number | null;
  /** Share of spend in the priciest 10% of picks. Reported, NOT applied. */
  topHeaviness: number | null;
  /** Seasons pooled, newest first. Empty when only one was available. */
  seasons?: number[];
  /** Leave-one-season-out test of the premise; null = UNKNOWN, not fine. */
  stability?: Stability | null;
  notes: string[];
}

export interface PriorPick { pos: string; price: number; season?: number; }

export interface Stability {
  seasons: number[];
  genericMAE: number;
  leagueMAE: number;
  /** >0: the league's own past predicts its future better than the
   *  generic split. <=0: the swings are noise, and the caller shrinks harder. */
  lift: number;
  persists: boolean;
}

export declare const POSITIONS: string[];
export declare const SHRINK_K0: number;
export declare const MIN_PICKS: number;
export declare const MULT_CLAMP: [number, number];

export declare function noCalibration(note?: string): AuctionCalibration;
export declare function calibrateAuction(
  picks: PriorPick[],
  league?: { teams?: number; rosterSize?: number },
  P?: unknown,
): AuctionCalibration;
export declare function picksFromKeeperImport(
  cache: {
    candidates?: { pos: string; bid: number | null }[];
    draftPicks?: { pos: string; bid: number | null; season?: number }[];
  } | null | undefined,
): PriorPick[];
export declare const RECENCY_DECAY: number;
export declare function assessStability(
  bySeason: Record<number, PriorPick[]>, modelShare: Record<string, number>,
): Stability | null;
export declare function describeCalibration(cal: AuctionCalibration | null | undefined): string;

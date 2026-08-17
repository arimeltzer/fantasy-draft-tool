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
  /** Share of spend in the priciest 10% of picks. Reported, NOT applied. */
  topHeaviness: number | null;
  notes: string[];
}

export interface PriorPick { pos: string; price: number; }

export declare const POSITIONS: string[];
export declare const SHRINK_K0: number;
export declare const MIN_PICKS: number;
export declare const MULT_CLAMP: [number, number];

export declare function noCalibration(note?: string): AuctionCalibration;
export declare function calibrateAuction(
  picks: PriorPick[],
  league?: { teams?: number },
  P?: unknown,
): AuctionCalibration;
export declare function picksFromKeeperImport(
  cache: { candidates?: { pos: string; bid: number | null }[] } | null | undefined,
): PriorPick[];
export declare function describeCalibration(cal: AuctionCalibration | null | undefined): string;

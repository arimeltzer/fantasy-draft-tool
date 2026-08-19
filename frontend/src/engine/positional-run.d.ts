export declare const RUN_POSITIONS: readonly ["QB", "RB", "WR", "TE"];
export declare const MIN_RUN_COUNT: number;

/** Per-position run hotness in [0, 1], keyed by RUN_POSITIONS. */
export declare function runHotness(
  recentPicks: string[],
  teams: number,
): Record<string, number>;

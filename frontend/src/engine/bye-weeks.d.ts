export declare const DEFAULT_REG_WEEKS: number;

export interface ByeClashResult {
  /** Multiplier to apply to the candidate's score; 1 when there is no clash. */
  mult: number;
  /** How many players already on the roster at this position share the bye. */
  sharing: number;
  /** Players at this position available in the clashing week. */
  available: number;
  /** Starter slots that go unfilled that week. */
  unfilled: number;
}

export interface ByeReportRow {
  week: number;
  pos: string;
  available: number;
  starters: number;
  /** Starter slots short in this week, EXCLUDING shortfall that is merely an
   *  incomplete roster rather than the bye's doing. */
  short: number;
}

/** {TEAM: [{week, opp}]} -> {TEAM: byeWeek | null}. Horizon is derived from
 *  the schedule itself unless `regWeeks` is given. */
export declare function byeByTeam(
  schedule: Record<string, { week: number; opp: string }[]> | null | undefined,
  regWeeks?: number | null,
): Record<string, number | null>;

/** Marginal cost of adding `bye` at a position, given the byes already
 *  rostered there. Returns mult 1 when the roster can already cover the week. */
export declare function byeClash(
  bye: number | null | undefined,
  rosterByes?: (number | null)[],
  starters?: number,
  opts?: { step?: number; max?: number },
): ByeClashResult;

/** Roster-wide view of which weeks leave which positions short of starters. */
export declare function byeReport(
  roster?: { pos: string; bye?: number | null }[],
  starters?: Record<string, number>,
): ByeReportRow[];

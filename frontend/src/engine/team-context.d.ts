import type { StatLine } from "./engine-core";

/** Shipped team-change discount, per position. Only RB/WR are nonzero
 *  (roadmap 1.3 — backtested against both the pure model and the live
 *  board; QB passed the former but not the latter, TE never passed). */
export declare const TEAM_CHANGE_K: Record<string, number>;

/** Apply the team-change discount across a projected board. A player with
 *  no prior-season team on record (`last.team`), or whose position carries
 *  no discount, passes through unchanged (also carries every other field
 *  on T unchanged). */
export declare function applyTeamChangeDiscount<T extends {
  pos: string; team: string; last?: StatLine | null; valuePoints: number;
}>(
  players: T[], K?: Record<string, number>,
): T[];

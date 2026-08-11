import { LeagueSettings } from "@/lib/api";

/** Owner id for the user's own team (not a legal team name). */
export declare const MY_TEAM: "__me__";

/** Overall pick number -> owning team label. */
export type PickOwners = Record<number, string>;

type OrderSettings = Partial<LeagueSettings> & {
  teams?: number;
  opponents?: string[];
  draftSlot?: number;
  teamSlots?: Record<string, number>;
  pickOwners?: Record<string, string>;
  rounds?: number;
  roster?: Record<string, number>;
};

export declare function teamLabels(settings?: OrderSettings): string[];
export declare function roundsFor(settings?: OrderSettings): number;
export declare function slotByTeam(settings?: OrderSettings): Record<string, number>;
export declare function baseOwners(settings?: OrderSettings, rounds?: number): PickOwners;
export declare function currentOwners(settings?: OrderSettings, rounds?: number): PickOwners;
export declare function picksByTeam(owners: PickOwners): Record<string, number[]>;
export declare function pickLabel(pick: number, teams: number): string;
export declare function derivePickSettings(
  settings: OrderSettings, owners: PickOwners, rounds?: number,
): {
  pickOwners: Record<string, string> | undefined;
  myPicks: number[] | undefined;
  teamPicks: Record<string, number[]> | undefined;
};
export declare function orderWarnings(settings: OrderSettings, owners: PickOwners): string[];

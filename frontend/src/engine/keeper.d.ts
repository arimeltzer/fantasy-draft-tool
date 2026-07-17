import { KeeperRule } from "@/lib/api";

export interface KeeperEntry {
  base: number | null;
  fa?: boolean;
  kept?: number;
  owner?: string;
}

export interface KeeperCost {
  basis: "price" | "round";
  price: number | null;
  round: number | null;
  advisory: string[];
}

export declare const KEEPER_PRESETS: Record<"yahoo" | "espn" | "custom", KeeperRule>;
export declare function defaultKeeperRule(format: "auction" | "snake"): KeeperRule;
export declare function normalizeKeeperRule(rule: Partial<KeeperRule> | undefined, format: "auction" | "snake"): KeeperRule;
export declare function keeperCost(entry: KeeperEntry, rule: KeeperRule): KeeperCost;
export declare function validateKeepers(
  entries: (KeeperEntry & { owner?: string })[],
  rule: KeeperRule,
): { ok: boolean; errors: string[]; perOwner: Record<string, KeeperEntry[]> };
export declare function ownerKeeperSpend(
  entries: (KeeperEntry & { owner?: string })[],
  rule: KeeperRule,
  owner?: string,
): number;

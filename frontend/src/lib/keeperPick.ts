/* Keepers are stored as ordinary DraftPick rows, marked via the (otherwise
 * unused) `slot` text field so no DB migration is needed. The marker carries
 * the owner label and the raw last-year cost, so the planner can re-derive and
 * edit costs later. The computed auction price also lives in the pick's `price`
 * column (so budget / inflation / roster all work with zero special-casing). */
import { DraftEntry } from "@/store/draftStore";

export interface KeeperMeta {
  k: 1;                       // marker discriminant
  owner: string;              // "Me" or an opponent team label
  base: number | null;        // last year's price (auction) or round (snake)
  basis: "price" | "round";
  kept: number;               // consecutive years already kept
  round?: number;             // computed round cost (snake)
}

/** Encode a keeper marker for DraftPick.slot. */
export function encodeKeeper(meta: KeeperMeta): string {
  return JSON.stringify(meta);
}

/** Decode a pick's slot into keeper meta, or null if it isn't a keeper. */
export function decodeKeeper(slot: string | null | undefined): KeeperMeta | null {
  if (!slot) return null;
  try {
    const m = JSON.parse(slot);
    return m && m.k === 1 ? (m as KeeperMeta) : null;
  } catch {
    return null;
  }
}

export function isKeeper(pick: Pick<DraftEntry, "slot">): boolean {
  return decodeKeeper(pick.slot) != null;
}

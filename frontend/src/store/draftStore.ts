import { create } from "zustand";
import { api, ApiPick } from "@/lib/api";

export interface DraftEntry {
  pickId: number;
  playerId: number | null;
  overallPick: number;
  mine: boolean;
  teamId: number | null;
  price: number | null;
  slot: string | null;
  /** True while the server hasn't confirmed this pick yet (optimistic row). */
  pending?: boolean;
}

interface DraftState {
  leagueId: number | null;
  picks: DraftEntry[];
  syncing: boolean;

  hydrate: (leagueId: number) => Promise<void>;
  addPick: (data: { playerId?: number; mine: boolean; teamId?: number; price?: number; slot?: string }) => Promise<void>;
  updatePick: (pickId: number, data: Partial<{ playerId: number | null; mine: boolean; teamId: number | null; price: number | null; slot: string | null }>) => Promise<void>;
  removePick: (pickId: number) => Promise<void>;
  clear: () => void;
}

function mapPick(p: ApiPick): DraftEntry {
  return {
    pickId: p.id,
    playerId: p.player_id,
    overallPick: p.overall_pick,
    mine: p.mine,
    teamId: p.team_id,
    price: p.price,
    slot: p.slot,
  };
}

export const useDraftStore = create<DraftState>((set, get) => ({
  leagueId: null,
  picks: [],
  syncing: false,

  hydrate: async (leagueId) => {
    set({ leagueId, syncing: true });
    try {
      const serverPicks = await api.picks(leagueId);
      set({ picks: serverPicks.map(mapPick) });
    } finally {
      set({ syncing: false });
    }
  },

  addPick: async (data) => {
    const { leagueId } = get();
    if (!leagueId) return;

    // Show the pick immediately, then reconcile with the server.
    //
    // This used to await the round trip before touching state, so every pick
    // froze the board for as long as the API took — which reads as "the app is
    // recalculating" but is really just waiting on the network. Nothing about
    // a pick needs the server's opinion: the only field it supplies is the row
    // id, so we use a temporary one and swap it when the response lands.
    const tempId = -Date.now() - Math.floor(Math.random() * 1000);
    const optimistic: DraftEntry = {
      pickId: tempId,
      playerId: data.playerId ?? null,
      overallPick: get().picks.length + 1,
      mine: data.mine,
      teamId: data.teamId ?? null,
      price: data.price ?? null,
      slot: data.slot ?? null,
      pending: true,
    };
    set((s) => ({ picks: [...s.picks, optimistic] }));

    try {
      const serverPick = await api.addPick(leagueId, {
        player_id: data.playerId,
        mine: data.mine,
        team_id: data.teamId,
        price: data.price,
        slot: data.slot,
      });
      set((s) => ({
        picks: s.picks.map((p) => (p.pickId === tempId ? mapPick(serverPick) : p)),
      }));
    } catch (e) {
      // Roll the row back rather than leaving a pick that only exists here —
      // a phantom pick would hide a player who is still on the board.
      set((s) => ({ picks: s.picks.filter((p) => p.pickId !== tempId) }));
      throw e;
    }
  },

  updatePick: async (pickId, data) => {
    const { leagueId } = get();
    if (!leagueId) return;
    const body: Parameters<typeof api.updatePick>[2] = {};
    if ("playerId" in data) body.player_id = data.playerId;
    if ("mine" in data) body.mine = data.mine;
    if ("teamId" in data) body.team_id = data.teamId;
    if ("price" in data) body.price = data.price;
    // Keepers carry their owner label inside `slot`, so a team rename edits it.
    if ("slot" in data) body.slot = data.slot;
    const serverPick = await api.updatePick(leagueId, pickId, body);
    set((s) => ({ picks: s.picks.map((p) => (p.pickId === pickId ? mapPick(serverPick) : p)) }));
  },

  removePick: async (pickId) => {
    const { leagueId } = get();
    if (!leagueId) return;
    set((s) => ({ picks: s.picks.filter((p) => p.pickId !== pickId) }));
    await api.deletePick(leagueId, pickId).catch(() => {
      get().hydrate(leagueId);
    });
  },

  clear: () => set({ leagueId: null, picks: [] }),
}));

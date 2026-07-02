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
}

interface DraftState {
  leagueId: number | null;
  picks: DraftEntry[];
  syncing: boolean;

  hydrate: (leagueId: number) => Promise<void>;
  addPick: (data: { playerId?: number; mine: boolean; teamId?: number; price?: number; slot?: string }) => Promise<void>;
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
    const serverPick = await api.addPick(leagueId, {
      player_id: data.playerId,
      mine: data.mine,
      team_id: data.teamId,
      price: data.price,
      slot: data.slot,
    });
    set((s) => ({ picks: [...s.picks, mapPick(serverPick)] }));
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

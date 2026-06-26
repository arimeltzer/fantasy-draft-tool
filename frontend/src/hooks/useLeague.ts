import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, LeagueSettings } from "@/lib/api";

export function useLeague(id: number) {
  return useQuery({
    queryKey: ["league", id],
    queryFn: () => api.getLeague(id),
    enabled: !!id,
  });
}

export function useLeagues() {
  return useQuery({
    queryKey: ["leagues"],
    queryFn: () => api.leagues(),
  });
}

export function usePatchLeague(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<{ name: string; settings: LeagueSettings }>) =>
      api.patchLeague(id, data),
    onSuccess: (updated) => {
      qc.setQueryData(["league", id], updated);
      qc.invalidateQueries({ queryKey: ["leagues"] });
    },
  });
}

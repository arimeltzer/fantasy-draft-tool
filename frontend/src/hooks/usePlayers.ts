import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function usePlayers(season = 2026) {
  return useQuery({
    queryKey: ["players", season],
    queryFn: () => api.players(season),
    staleTime: 5 * 60 * 1000,
  });
}

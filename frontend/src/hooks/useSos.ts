import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useSos(season = 2026) {
  return useQuery({
    queryKey: ["sos", season],
    queryFn: () => api.sos(season),
    staleTime: 10 * 60 * 1000,
  });
}

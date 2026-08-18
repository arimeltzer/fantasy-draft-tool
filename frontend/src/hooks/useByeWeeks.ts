import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { byeByTeam } from "@/engine/bye-weeks.js";

/**
 * {TEAM: byeWeek} for a season, derived from the schedule already served by
 * `/api/schedule` — a bye is a week missing from a team's game list, so this
 * needs no new endpoint, table or migration.
 *
 * Shares the schedule query key with anything else reading the raw schedule,
 * so enabling byes costs no extra request.
 */
export function useByeWeeks(season = 2026) {
  return useQuery({
    queryKey: ["schedule", season],
    queryFn: () => api.schedule(season),
    staleTime: 60 * 60 * 1000,   // a schedule does not change mid-draft
    select: (schedule) => byeByTeam(schedule) as Record<string, number | null>,
  });
}

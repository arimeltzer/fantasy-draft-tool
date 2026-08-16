import { MY_TEAM } from "@/engine/draft-order.js";

export interface TeamOption {
  /** null = your team; otherwise the index into settings.opponents (team_id). */
  teamId: number | null;
  label: string;
  onClock?: boolean;
}

/**
 * Build the pick-assignment list for a draft row.
 *
 * The team on the clock is sorted to the top and flagged. In a snake draft the
 * next picker is knowable, and mid-draft the difference between hunting a name
 * in a ten-item list and clicking the first one is the difference between
 * keeping up with the room and falling behind it.
 */
export function teamOptions(
  opponents: string[],
  onClockOwner?: string,
): TeamOption[] {
  const opts: TeamOption[] = [
    { teamId: null, label: "Me", onClock: onClockOwner === MY_TEAM },
    ...opponents.map((label, i) => ({ teamId: i, label, onClock: label === onClockOwner })),
  ];
  // Stable apart from lifting the on-the-clock team; everything else keeps
  // league order so muscle memory still works.
  const idx = opts.findIndex((o) => o.onClock);
  if (idx > 0) opts.unshift(...opts.splice(idx, 1));
  return opts;
}

interface Props {
  opponents: string[];
  /** Team label on the clock, from the draft-order board (snake only). */
  onClockOwner?: string;
  onPick: (teamId: number | null) => void;
  title?: string;
  className?: string;
}

/**
 * One-control "who drafted this player".
 *
 * Replaces marking a player merely as taken and then opening the draft log to
 * say by whom — the team is chosen at the moment the pick is logged, which is
 * the only moment you actually know it.
 */
export default function TeamPicker({ opponents, onClockOwner, onPick, title, className = "" }: Props) {
  const opts = teamOptions(opponents, onClockOwner);
  return (
    <select
      value=""
      title={title ?? "Who drafted this player?"}
      onChange={(e) => {
        if (e.target.value === "") return;
        onPick(e.target.value === "mine" ? null : Number(e.target.value));
      }}
      className={`min-w-0 rounded border border-gray-300 bg-gray-50 px-1 py-1 text-xs text-gray-600 hover:text-gray-800 focus:border-gray-400 focus:outline-none ${className}`}
    >
      <option value="" disabled>Drafted by…</option>
      {opts.map((o) => (
        <option key={o.teamId ?? "mine"} value={o.teamId === null ? "mine" : o.teamId}>
          {o.label}{o.onClock ? " · on the clock" : ""}
        </option>
      ))}
    </select>
  );
}

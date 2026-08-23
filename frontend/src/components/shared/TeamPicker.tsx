import { useState } from "react";
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
  /** Reads the team on the clock. A GETTER, not a value: it changes on every
   *  pick, and as a prop it would re-render every row in the player list. */
  getOnClock?: () => string | undefined;
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
export default function TeamPicker({ opponents, getOnClock, onPick, title, className = "" }: Props) {
  // Options are built on first interaction, not on every render: with the whole
  // player pool on screen that is hundreds of selects, and the list is only
  // ever read once the dropdown is actually open.
  const [opened, setOpened] = useState(false);
  const opts = opened ? teamOptions(opponents, getOnClock?.()) : [];
  return (
    <select
      value=""
      title={title ?? "Who drafted this player?"}
      onMouseDown={() => setOpened(true)}
      onFocus={() => setOpened(true)}
      onKeyDown={() => setOpened(true)}
      onChange={(e) => {
        if (e.target.value === "") return;
        onPick(e.target.value === "mine" ? null : Number(e.target.value));
      }}
      className={`min-w-0 rounded-lg border border-line bg-surface px-1.5 py-1.5 text-xs text-muted hover:text-ink focus:border-faint focus:outline-none ${className}`}
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

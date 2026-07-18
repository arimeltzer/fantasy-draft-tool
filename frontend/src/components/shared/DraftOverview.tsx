import { useMemo, useState } from "react";
import { Users, ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { posStyle } from "@/lib/posStyles";
import { BoardPlayer } from "@/engine/valuation-engine.js";
import { LeagueSettings } from "@/lib/api";
import { DraftEntry } from "@/store/draftStore";
import Tip from "@/components/shared/Tip";

interface Props {
  picks: DraftEntry[];
  board: BoardPlayer[];
  settings: LeagueSettings;
  mode: "auction" | "snake";
  onEditLog: () => void;
}

export interface TeamRow {
  key: string;
  label: string;
  teamId: number | null; // null = me, -1 = unassigned
  mine: boolean;
  picks: DraftEntry[];
  spent: number;
}

export function buildTeamRows(picks: DraftEntry[], settings: LeagueSettings): TeamRow[] {
  const opponents = settings.opponents?.length
    ? settings.opponents
    : Array.from({ length: Math.max(0, settings.teams - 1) }, (_, i) => `Team ${i + 2}`);

  const rows: TeamRow[] = [
    { key: "me", label: "You", teamId: null, mine: true, picks: [], spent: 0 },
    ...opponents.map((label, i) => ({ key: `opp-${i}`, label, teamId: i, mine: false, picks: [], spent: 0 })),
  ];
  const unassigned: TeamRow = { key: "un", label: "Unassigned", teamId: -1, mine: false, picks: [], spent: 0 };

  for (const p of picks) {
    let row: TeamRow;
    if (p.mine) row = rows[0];
    else if (p.teamId != null && p.teamId >= 0 && p.teamId < opponents.length) row = rows[p.teamId + 1];
    else row = unassigned;
    row.picks.push(p);
    row.spent += p.price ?? 0;
  }
  if (unassigned.picks.length > 0) rows.push(unassigned);
  return rows;
}

export default function DraftOverview({ picks, board, settings, mode, onEditLog }: Props) {
  const [openTeam, setOpenTeam] = useState<string | null>(null);

  const playerById = useMemo(() => new Map(board.map((p) => [p.id as number, p])), [board]);
  const rows = useMemo(() => buildTeamRows(picks, settings), [picks, settings]);

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-100 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-gray-500" />
          <Tip tip="Every team's draft at a glance. Click a team to see who they've taken; use Edit log to fix any pick entered incorrectly.">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-600">Draft board</h2>
          </Tip>
        </div>
        <button
          onClick={onEditLog}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-gray-50 border border-gray-300 text-gray-600 hover:text-gray-800 hover:border-gray-400"
          title="Open the full pick-by-pick log to review and edit entries"
        >
          <Pencil className="w-3 h-3" /> Edit log
        </button>
      </div>

      <div className="grid grid-cols-[16px_1fr_auto_auto] gap-x-2 text-2xs uppercase tracking-wider text-gray-400 px-1 mb-1">
        <span />
        <span>Team</span>
        <Tip tip="Players drafted so far by this team." underline={false}><span>Picks</span></Tip>
        {mode === "auction" && (
          <Tip tip="Auction money remaining out of the starting budget (spent shown when expanded)." underline={false}>
            <span className="text-right">$ Left</span>
          </Tip>
        )}
      </div>

      <div className="space-y-0.5">
        {rows.map((row) => {
          const open = openTeam === row.key;
          const left = settings.budget - row.spent;
          return (
            <div key={row.key}>
              <button
                onClick={() => setOpenTeam(open ? null : row.key)}
                className={`w-full grid grid-cols-[16px_1fr_auto_auto] gap-x-2 items-center px-1 py-1 rounded text-xs text-left hover:bg-gray-200/60 ${row.mine ? "font-semibold text-gray-800" : "text-gray-600"}`}
              >
                {open ? <ChevronDown className="w-3 h-3 text-gray-400" /> : <ChevronRight className="w-3 h-3 text-gray-400" />}
                <span className="truncate">{row.label}</span>
                <span className="font-mono tabular-nums text-gray-500">{row.picks.length}</span>
                {mode === "auction" && (
                  <span className={`font-mono tabular-nums text-right ${row.teamId === -1 ? "text-gray-400" : left < 15 ? "text-rose-600" : "text-amber-700"}`}>
                    {row.teamId === -1 ? "—" : `$${left}`}
                  </span>
                )}
              </button>

              {open && (
                <div className="ml-5 mb-1.5 mt-0.5 space-y-0.5">
                  {row.picks.length === 0 && <div className="text-xs text-gray-400 italic px-1">No picks yet.</div>}
                  {row.picks.map((p) => {
                    const pl = p.playerId != null ? playerById.get(p.playerId) : undefined;
                    const st = pl ? posStyle(pl.pos) : null;
                    return (
                      <div key={p.pickId} className="flex items-center gap-1.5 text-xs px-1">
                        <span className="font-mono text-2xs text-gray-400 w-6">#{p.overallPick}</span>
                        {st && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.dot}`} />}
                        <span className="truncate flex-1 text-gray-700">{pl ? pl.name : "Unknown player"}</span>
                        {pl && <span className="font-mono text-2xs text-gray-400">{pl.pos}</span>}
                        {mode === "auction" && p.price != null && (
                          <span className="font-mono text-amber-700">${p.price}</span>
                        )}
                      </div>
                    );
                  })}
                  {mode === "auction" && row.teamId !== -1 && row.picks.length > 0 && (
                    <div className="text-2xs font-mono text-gray-400 px-1 pt-0.5">
                      spent ${row.spent} of ${settings.budget}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {picks.length === 0 && (
        <div className="text-xs text-gray-500 italic mt-1 px-1">Nothing drafted yet — picks show up here as they're logged.</div>
      )}
    </div>
  );
}

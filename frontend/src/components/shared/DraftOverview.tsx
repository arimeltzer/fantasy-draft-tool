import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Pencil, AlertTriangle } from "lucide-react";
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

  // An N-team league has N-1 opponents, so N or more is arithmetically
  // impossible — not a judgement call. The usual cause is an import where the
  // user's own team wasn't identified (`report.mine_found` false): nothing is
  // excluded from `settings.opponents`, so the room renders "You" PLUS every
  // team including yours, and your own name sits there as a rival that never
  // drafts anyone. Surfaced here rather than silently corrected because the
  // fix is a REMOVAL from an index-keyed list — every pick's `teamId` indexes
  // into it, so dropping an entry silently would re-point other teams' picks.
  // `DraftOrderBoard` already warns about this on the snake side via
  // `orderWarnings`; the auction room had no equivalent, which is where it
  // was actually hit.
  const extraTeams = useMemo(() => {
    const opponents = (settings.opponents ?? []).filter(Boolean);
    return opponents.length >= settings.teams
      ? opponents.length + 1 - settings.teams
      : 0;
  }, [settings.opponents, settings.teams]);

  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
      <div className="flex items-center justify-between mb-0.5">
        <Tip tip="Every team's draft at a glance. Click a team to see who they've taken; use Edit log to fix any pick entered incorrectly.">
          <h2 className="text-xs font-bold text-muted">Draft board</h2>
        </Tip>
        <button
          onClick={onEditLog}
          className="flex items-center gap-1 text-xs font-bold text-gold hover:text-gold/80"
          title="Open the full pick-by-pick log to review and edit entries"
        >
          <Pencil className="w-3 h-3" /> Edit log
        </button>
      </div>
      <div className="text-2xs text-faint mb-3">Every team's draft — click one to see who they've taken</div>

      {extraTeams > 0 && (
        <div className="mb-3 flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-2xs leading-snug text-amber-800">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>
            {(settings.opponents ?? []).filter(Boolean).length + 1} teams listed for a{" "}
            {settings.teams}-team league. Your own team is probably still in the opponent
            list from the import — it's the one showing no picks. Remove it in League
            Settings so budgets and $Max count the right {settings.teams - 1} rivals.
          </span>
        </div>
      )}

      {mode === "auction" && (
        <div className="grid grid-cols-[16px_1fr_auto_auto] gap-x-2 text-2xs uppercase tracking-wider text-faint px-1 mb-1">
          <span />
          <span>Team</span>
          <Tip tip="Players drafted so far by this team." underline={false}><span>Picks</span></Tip>
          <Tip tip="Auction money remaining out of the starting budget (spent shown when expanded)." underline={false}>
            <span className="text-right">$ Left</span>
          </Tip>
        </div>
      )}

      <div className="flex flex-col">
        {rows.map((row) => {
          const open = openTeam === row.key;
          const left = settings.budget - row.spent;
          return (
            <div key={row.key}>
              <button
                onClick={() => setOpenTeam(open ? null : row.key)}
                className={`w-full grid grid-cols-[16px_1fr_auto_auto] gap-x-2 items-center px-1.5 py-1.5 rounded-lg text-xs text-left hover:bg-raised ${row.mine ? "font-bold text-ink bg-amber-50/70" : "font-semibold text-muted"}`}
              >
                {open ? <ChevronDown className="w-3 h-3 text-faint" /> : <ChevronRight className="w-3 h-3 text-faint" />}
                <span className="truncate">{row.label}</span>
                <span className="font-mono tabular-nums text-faint">{row.picks.length} picks</span>
                {mode === "auction" && (
                  <span className={`font-mono font-bold tabular-nums text-right w-9 ${row.teamId === -1 ? "text-faint" : left < 15 ? "text-rose-600" : "text-gold"}`}>
                    {row.teamId === -1 ? "—" : `$${left}`}
                  </span>
                )}
              </button>

              {open && (
                <div className="pl-6 pr-1 mb-2 mt-0.5 flex flex-col gap-1">
                  {row.picks.length === 0 && <div className="text-xs text-faint italic">No picks yet.</div>}
                  {row.picks.map((p) => {
                    const pl = p.playerId != null ? playerById.get(p.playerId) : undefined;
                    return (
                      <div key={p.pickId} className="flex items-center gap-1.5 text-xs">
                        <span className="font-mono text-2xs text-faint w-6">#{p.overallPick}</span>
                        <span className="truncate flex-1 text-muted">{pl ? pl.name : "Unknown player"}</span>
                        {pl && <span className="font-mono text-2xs text-faint">{pl.pos}</span>}
                        {mode === "auction" && p.price != null && (
                          <span className="font-mono font-semibold text-gold">${p.price}</span>
                        )}
                      </div>
                    );
                  })}
                  {mode === "auction" && row.teamId !== -1 && row.picks.length > 0 && (
                    <div className="text-2xs font-mono text-faint pt-0.5">
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
        <div className="text-xs text-faint italic mt-1 px-1">Nothing drafted yet — picks show up here as they're logged.</div>
      )}
    </div>
  );
}

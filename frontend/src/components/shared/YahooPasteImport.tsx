import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, Loader2, AlertTriangle, Check, ChevronDown } from "lucide-react";
import { api, KeeperCandidate, KeeperImportCache, YahooPasteReport } from "@/lib/api";

interface Props {
  /** Same contract as KeeperAutofill: hand the parsed candidates upward so the
   *  recommender/planner consume them exactly like an ESPN pull. */
  onCandidates: (c: KeeperCandidate[]) => void;
  matchSeason?: number;
  /** Real opponent names + your draft slot, parsed from the same pages — the
   *  planner writes them into league settings so you don't retype them. */
  onLeagueInfo?: (info: {
    opponents: string[];
    draftSlot?: number;
    teamSlots?: Record<string, number>;
  }) => void;
  /** Opponent names already saved, so the offer to apply can be hidden once used. */
  currentOpponents?: string[];
  /** Previously-parsed paste, restored from league settings so the import
   *  survives closing the planner (same persistence the ESPN pull has). */
  cached?: KeeperImportCache;
  onCache?: (c: KeeperImportCache) => void;
}

const CURRENT_SEASON = 2026;

/**
 * Yahoo import that needs no API access.
 *
 * Yahoo's developer program no longer reliably grants the Fantasy Sports scope,
 * so OAuth can be blocked indefinitely. Every league member can still open
 * their league's Draft Results and Starting Rosters pages — pasting those in
 * gives the keeper tools everything they need (who's on each roster, and what
 * round each player cost).
 */
export default function YahooPasteImport({ onCandidates, matchSeason = CURRENT_SEASON, onLeagueInfo, currentOpponents, cached, onCache }: Props) {
  const restored = cached?.source === "yahoo-paste" ? cached : undefined;
  const [open, setOpen] = useState(!!restored);
  const [draftText, setDraftText] = useState("");
  const [rostersText, setRostersText] = useState("");
  const [myTeam, setMyTeam] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<YahooPasteReport | null>(restored?.paste ?? null);
  const [count, setCount] = useState<{ matched: number; total: number } | null>(
    restored ? { matched: restored.candidates.length, total: restored.candidates.length } : null);
  const [restoredAt] = useState<string | undefined>(restored?.fetchedAt);
  const [applied, setApplied] = useState(false);

  // Re-feed a restored import to the recommender on mount, so reopening the
  // planner shows the same analysis without another paste.
  const rehydrated = useRef(false);
  useEffect(() => {
    if (restored?.candidates?.length && !rehydrated.current) {
      rehydrated.current = true;
      onCandidates(restored.candidates);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored]);

  const parse = async () => {
    setLoading(true); setError(null); setReport(null); setCount(null);
    try {
      const res = await api.yahooPasteCandidates({
        draft_text: draftText,
        rosters_text: rostersText,
        match_season: matchSeason,
        my_team: myTeam.trim() || undefined,
      });
      setReport(res.paste ?? null);
      setCount({ matched: res.matched, total: res.candidates.length });
      onCandidates(res.candidates);
      // Persist so reopening the planner doesn't require pasting again.
      onCache?.({
        season: 0,
        fetchedAt: new Date().toISOString(),
        candidates: res.candidates,
        source: "yahoo-paste",
        paste: res.paste,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-line bg-raised/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-muted hover:text-ink"
      >
        <ClipboardPaste className="h-3.5 w-3.5" />
        Yahoo — paste from league pages (no API needed)
        <ChevronDown className={`ml-auto h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-hair px-3 py-3">
          <p className="text-2xs leading-snug text-faint">
            Yahoo's API needs developer access that's no longer reliably granted, so import by copying
            two pages from your league instead. On each page select all (Ctrl/Cmd+A), copy, and paste below.
            Nothing is committed until you review the result.
          </p>

          <label className="block text-xs">
            <span className="mb-1 block text-muted">
              1. <span className="font-medium text-ink">Starting Rosters</span> page — required
              <span className="text-faint"> (defines who can be kept)</span>
            </span>
            <textarea
              rows={4}
              value={rostersText}
              onChange={(e) => setRostersText(e.target.value)}
              placeholder={"Team Name\n\nPos\tPlayer\nQB\t\nJosh Allen\n..."}
              className="w-full rounded-md border border-line bg-sunken px-2 py-1 font-mono text-2xs text-ink focus:border-brand focus:outline-none"
            />
          </label>

          <label className="block text-xs">
            <span className="mb-1 block text-muted">
              2. <span className="font-medium text-ink">Draft Results</span> page
              <span className="text-faint"> (gives each player's round = keeper cost)</span>
            </span>
            <textarea
              rows={4}
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              placeholder={"Round 1\n1.\tCeeDee Lamb\tTeam Name\n..."}
              className="w-full rounded-md border border-line bg-sunken px-2 py-1 font-mono text-2xs text-ink focus:border-brand focus:outline-none"
            />
          </label>

          <label className="block text-xs">
            <span className="mb-1 block text-muted">
              Your team name <span className="text-faint">(optional — exactly as it appears)</span>
            </span>
            <input
              value={myTeam}
              onChange={(e) => setMyTeam(e.target.value)}
              placeholder="Becoming BEARable"
              className="w-full rounded-md border border-line bg-sunken px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none"
            />
          </label>

          <button
            onClick={parse}
            disabled={loading || !rostersText.trim()}
            className="btn-brand w-full justify-center px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Parse pasted pages
          </button>

          {restoredAt && (
            <p className="rounded-md border border-line bg-sunken px-2.5 py-1.5 text-2xs text-muted">
              Showing a saved import from {new Date(restoredAt).toLocaleDateString()} — paste again to refresh.
            </p>
          )}

          {error && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-2xs text-rose-700">
              {error}
            </p>
          )}

          {report && (
            <div className="space-y-2">
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-2xs text-emerald-800">
                <div className="flex items-center gap-1.5 font-medium">
                  <Check className="h-3.5 w-3.5" />
                  {report.teams} teams · {report.picks} picks over {report.rounds} rounds
                  {count ? ` · ${count.matched}/${count.total} players matched` : ""}
                </div>
                {Object.keys(report.draft_slots).length > 0 && (
                  <div className="mt-1 font-mono text-2xs text-emerald-700">
                    Draft order:{" "}
                    {Object.entries(report.draft_slots)
                      .sort((a, b) => a[1] - b[1])
                      .map(([t, s]) => `${s}. ${t}`)
                      .join(" · ")}
                  </div>
                )}
              </div>

              {/* The same paste already contains the real team names — offer to
                  save them rather than making the user retype ten of them. */}
              {onLeagueInfo && report.team_names.length > 0 && (
                <div className="rounded-md border border-line bg-sunken px-2.5 py-2 text-2xs">
                  <div className="mb-1 font-medium text-ink">
                    Team names found ({report.team_names.length})
                  </div>
                  <div className="mb-1.5 leading-relaxed text-muted">
                    {report.team_names.join(", ")}
                  </div>
                  {applied ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600">
                      <Check className="h-3 w-3" /> Saved to league settings
                    </span>
                  ) : (
                    <button
                      onClick={() => {
                        const opponents = myTeam.trim()
                          ? report.team_names.filter((t) => t !== myTeam.trim())
                          : report.team_names;
                        onLeagueInfo({
                          opponents,
                          draftSlot: myTeam.trim() ? report.draft_slots[myTeam.trim()] : undefined,
                          // Every team's slot — lets opponent keeper predictions
                          // price a rival's forfeited pick from their real spot.
                          teamSlots: report.draft_slots,
                        });
                        setApplied(true);
                      }}
                      className="text-brand hover:underline"
                    >
                      Save team names + draft slots
                      {myTeam.trim() && report.draft_slots[myTeam.trim()]
                        ? ` + draft slot ${report.draft_slots[myTeam.trim()]}`
                        : ""}
                      {currentOpponents?.length ? " (replaces current)" : ""}
                    </button>
                  )}
                </div>
              )}

              {report.kept_detected.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-2xs text-amber-900">
                  <div className="mb-1 font-medium">
                    Detected as kept last year — can't be kept again ({report.kept_detected.length})
                  </div>
                  <div className="leading-relaxed">{report.kept_detected.join(", ")}</div>
                  <div className="mt-1 text-amber-700">
                    These are excluded from keeper recommendations. Verify the list — it comes from a
                    badge that copy-paste reduces to whitespace.
                  </div>
                </div>
              )}

              {report.warnings.length > 0 && (
                <ul className="space-y-1 rounded-md border border-line bg-sunken px-2.5 py-2">
                  {report.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-2xs text-muted">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                      {w}
                    </li>
                  ))}
                </ul>
              )}

              {report.undrafted_on_roster.length > 0 && (
                <div className="rounded-md border border-line bg-sunken px-2.5 py-2 text-2xs text-muted">
                  <span className="font-medium text-ink">
                    Added mid-season ({report.undrafted_on_roster.length})
                  </span>{" "}
                  — no draft round, so your league's undrafted-round rule applies:{" "}
                  {report.undrafted_on_roster.join(", ")}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

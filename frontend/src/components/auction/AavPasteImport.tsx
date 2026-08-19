import { useState } from "react";
import { ClipboardPaste, Loader2, AlertTriangle, Check, X, Trash2 } from "lucide-react";
import { api, LeagueSettings } from "@/lib/api";

interface Props {
  settings: LeagueSettings;
  onSave: (patch: Partial<LeagueSettings>) => void;
  onClose: () => void;
  season?: number;
}

const CURRENT_SEASON = 2026;

/**
 * Real auction dollar values, pasted from a FantasyPros cheat sheet (or any
 * source in the same shape) — same fix as the Yahoo paste importer, for the
 * same reason: FantasyPros' public API has no auction endpoint at all
 * (`fetch_aav()` is a confirmed no-op).
 *
 * PER-LEAGUE, not admin-only. An earlier version of this wrote straight to
 * the shared `fantasy_players.aav` column and required an admin account — a
 * user who went looking for this in the app couldn't find it, because it
 * didn't exist here. Values genuinely differ by who copied the sheet and
 * when (injury news, a league's own consensus, a mid-draft refresh), so this
 * writes to THIS league's `settings.aavOverrides` instead: any signed-in user
 * can paste it, and re-pasting any time replaces the override, matching
 * "updatable to reflect changing conditions."
 */
export default function AavPasteImport({ settings, onSave, onClose, season = CURRENT_SEASON }: Props) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    parsed: number; matched: number; unmatched: number; unmatchedNames: string[];
  } | null>(null);
  const [candidates, setCandidates] = useState<{ id: number; aav: number }[]>([]);
  const [applied, setApplied] = useState(false);

  const existingCount = Object.keys(settings.aavOverrides ?? {}).length;

  const preview = async () => {
    setLoading(true); setError(null); setResult(null); setCandidates([]); setApplied(false);
    try {
      const res = await api.aavPasteCandidates({ text, season });
      setResult({
        parsed: res.parsed, matched: res.matched, unmatched: res.unmatched,
        unmatchedNames: res.unmatched_names,
      });
      setCandidates(res.candidates);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const apply = () => {
    if (!candidates.length) return;
    const next: Record<number, number> = { ...(settings.aavOverrides ?? {}) };
    for (const c of candidates) next[c.id] = c.aav;
    onSave({ aavOverrides: next, aavImportedAt: new Date().toISOString() });
    setApplied(true);
  };

  const clearOverrides = () => {
    if (!confirm(`Remove ${existingCount} pasted auction value${existingCount === 1 ? "" : "s"} for this league? Prices fall back to the shared default.`)) return;
    onSave({ aavOverrides: {}, aavImportedAt: undefined });
  };

  return (
    <div className="border-b border-gray-200 bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-4 space-y-3">
        <div className="flex items-center gap-2">
          <ClipboardPaste className="w-4 h-4 text-gray-500" />
          <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold">
            Real auction values — paste from FantasyPros
          </h3>
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-gray-500 leading-snug max-w-2xl">
          FantasyPros' API has no auction-values endpoint, but the site's auction values cheat sheet can be
          copied out as text. Copy the whole table (one player per line — rank, name, position, points, $
          value) and paste it below. Nothing is saved until you review the match and apply it, and it only
          affects THIS league — re-paste any time to refresh for injury news or a later cut of the sheet.
        </p>

        {existingCount > 0 && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-800">
            <span>
              <Check className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />
              {existingCount} pasted value{existingCount === 1 ? "" : "s"} active for this league
              {settings.aavImportedAt && ` · as of ${new Date(settings.aavImportedAt).toLocaleDateString()}`}
            </span>
            <button onClick={clearOverrides} className="flex items-center gap-1 text-rose-600 hover:text-rose-700">
              <Trash2 className="w-3 h-3" /> Clear
            </button>
          </div>
        )}

        <textarea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"1.\tJahmyr Gibbs (DET - RB)\t302\t$63\n2.\tPuka Nacua (LAR - WR)DTD\t223\t$61\n..."}
          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 font-mono text-2xs text-gray-700 focus:outline-none focus:border-amber-500"
        />

        <div className="flex items-center gap-2">
          <button
            onClick={preview}
            disabled={loading || !text.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-600 text-white text-xs font-medium hover:bg-amber-700 disabled:opacity-50"
          >
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Preview match
          </button>
          {result && !applied && result.matched > 0 && (
            <button
              onClick={apply}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700"
            >
              Apply {result.matched} value{result.matched === 1 ? "" : "s"} to this league
            </button>
          )}
          {applied && (
            <span className="flex items-center gap-1 text-xs text-emerald-700">
              <Check className="w-3.5 h-3.5" /> Applied
            </span>
          )}
        </div>

        {error && (
          <p className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-2xs text-rose-700">
            {error}
          </p>
        )}

        {result && (
          <div className="rounded-md border border-gray-200 bg-white px-2.5 py-2 text-2xs text-gray-600 space-y-1">
            <div>
              Parsed {result.parsed} rows · matched {result.matched} · unmatched {result.unmatched}
            </div>
            {result.unmatchedNames.length > 0 && (
              <div className="flex items-start gap-1.5 text-gray-500">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-500" />
                <span>Not found in this season's pool: {result.unmatchedNames.join(", ")}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

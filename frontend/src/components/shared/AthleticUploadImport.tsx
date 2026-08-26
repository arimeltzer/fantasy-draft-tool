import { useState } from "react";
import { Upload, Loader2, AlertTriangle, Check, X, Trash2 } from "lucide-react";
import { api, LeagueSettings } from "@/lib/api";

interface Props {
  settings: LeagueSettings;
  onSave: (patch: Partial<LeagueSettings>) => void;
  onClose: () => void;
  season?: number;
}

const CURRENT_SEASON = 2026;

/**
 * A SECOND OPINION, not a valuation input. Uploads a live copy of The
 * Athletic's downloadable projections workbook (Jake's model) and stores its
 * raw per-category stat lines in `settings.athleticProjections`, keyed by
 * player id — `useBoard` turns that into a display-only points/rank next to
 * the board's own projection, the same role `fp_tier` already plays next to
 * the app's own computed tier.
 *
 * Roadmap 0.1b tried blending this source into valuation the way FantasyPros
 * (0.1) is blended, gated it the same two ways every signal here is required
 * to clear, and FAILED the decisive one — see CLAUDE.md "Second expert
 * source: The Athletic". Nothing uploaded here ever reaches valuePoints,
 * marketPrice, or any engine stage.
 *
 * FLUID BY DESIGN: the workbook is refreshed on The Athletic's own schedule,
 * so re-upload any time — same "just grabbed this today" discipline as
 * AavPasteImport/YahooPasteImport. The raw file is parsed on the backend and
 * discarded; only the matched, per-player stat numbers persist, in THIS
 * league's own settings.
 */
export default function AthleticUploadImport({ settings, onSave, onClose, season = CURRENT_SEASON }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    parsed: number; matched: number; unmatched: number; unmatchedNames: string[]; sheetsFound: string[];
  } | null>(null);
  const [candidates, setCandidates] = useState<{ id: number; proj: Record<string, number> }[]>([]);
  const [applied, setApplied] = useState(false);

  const existingCount = Object.keys(settings.athleticProjections ?? {}).length;

  const preview = async () => {
    if (!file) return;
    setLoading(true); setError(null); setResult(null); setCandidates([]); setApplied(false);
    try {
      const res = await api.athleticUploadCandidates(file, season);
      setResult({
        parsed: res.parsed, matched: res.matched, unmatched: res.unmatched,
        unmatchedNames: res.unmatched_names, sheetsFound: res.sheets_found,
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
    const next: Record<number, Record<string, number>> = { ...(settings.athleticProjections ?? {}) };
    for (const c of candidates) next[c.id] = c.proj;
    onSave({ athleticProjections: next, athleticImportedAt: new Date().toISOString() });
    setApplied(true);
  };

  const clearOverrides = () => {
    if (!confirm(`Remove ${existingCount} uploaded Athletic projection${existingCount === 1 ? "" : "s"} for this league?`)) return;
    onSave({ athleticProjections: {}, athleticImportedAt: undefined });
  };

  return (
    <div className="border-b border-line bg-surface">
      <div className="max-w-6xl mx-auto px-4 py-4 space-y-3">
        <div className="flex items-center gap-2">
          <Upload className="w-4 h-4 text-muted" />
          <h3 className="text-xs uppercase tracking-wider text-muted font-semibold">
            Second opinion — upload The Athletic's projections
          </h3>
          <button onClick={onClose} className="ml-auto text-faint hover:text-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-muted leading-snug max-w-2xl">
          Upload your copy of The Athletic's downloadable projections workbook (.xlsx). This is a
          display-only second opinion — shown next to the board's own projection, never blended
          into valuation (tested and rejected, see CLAUDE.md). It only affects THIS league;
          re-upload any time to refresh for a later cut of the sheet.
        </p>

        {existingCount > 0 && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-800">
            <span>
              <Check className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />
              {existingCount} player{existingCount === 1 ? "" : "s"} active for this league
              {settings.athleticImportedAt && ` · as of ${new Date(settings.athleticImportedAt).toLocaleDateString()}`}
            </span>
            <button onClick={clearOverrides} className="flex items-center gap-1 text-rose-600 hover:text-rose-700">
              <Trash2 className="w-3 h-3" /> Clear
            </button>
          </div>
        )}

        <input
          type="file"
          accept=".xlsx,.xlsm"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setApplied(false); }}
          className="block w-full text-xs text-muted file:mr-3 file:py-1.5 file:px-3 file:rounded-full file:border-0 file:bg-teal-600 file:text-white file:text-xs file:font-medium file:cursor-pointer hover:file:bg-teal-700"
        />

        <div className="flex items-center gap-2">
          <button
            onClick={preview}
            disabled={loading || !file}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-medium hover:bg-teal-700 disabled:opacity-50"
          >
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Preview match
          </button>
          {result && !applied && result.matched > 0 && (
            <button
              onClick={apply}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700"
            >
              Apply {result.matched} player{result.matched === 1 ? "" : "s"} to this league
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
          <div className="rounded-md border border-line bg-white px-2.5 py-2 text-2xs text-muted space-y-1">
            <div>
              Sheets found: {result.sheetsFound.join(", ") || "none"} · parsed {result.parsed} rows ·
              matched {result.matched} · unmatched {result.unmatched}
            </div>
            {result.unmatchedNames.length > 0 && (
              <div className="flex items-start gap-1.5 text-muted">
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

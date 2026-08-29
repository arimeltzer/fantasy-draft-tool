import { useState } from "react";
import { ClipboardPaste, Loader2, AlertTriangle, Check, X } from "lucide-react";
import { api, ScoringRules } from "@/lib/api";

interface Props {
  onApply: (patch: { scoring: Partial<ScoringRules>; ppr?: number }) => void;
  onClose: () => void;
}

const PROVIDERS: { key: "yahoo" | "espn"; label: string; placeholder: string; helpUrl: string }[] = [
  {
    key: "yahoo",
    label: "Yahoo",
    placeholder: "Offense\tLeague Value\tYahoo Default Value\nPassing Yards\n...",
    helpUrl: "League → Settings → Scoring Categories",
  },
  {
    key: "espn",
    label: "ESPN",
    placeholder: "Passing\nEvery 25 passing yards (PY25)1\nTD Pass (PTD)4\n...",
    helpUrl: "League → Settings → Scoring Settings",
  },
];

/**
 * Real per-stat scoring rules, pasted from a platform's own Scoring settings
 * page — same fix as the Yahoo draft-results and FantasyPros auction-values
 * importers, for the same reason: neither platform's API labels its scoring
 * rules with anything this app has ever verified a mapping for (see
 * `yahoo.raw_stat_modifiers`), so only receptions is auto-detected on
 * import and everything else defaults to standard. Reported live: "when I
 * imported my Yahoo league it only imported ppr. 42 other scoring rules not
 * auto-mapped." The platform's own Scoring PAGE, by contrast, labels every
 * rule in plain English — nothing to guess there.
 *
 * Only the 8 categories `ScoringRules` actually models (pass/rush/rec
 * yards+TDs, INTs, fumbles) plus PPR can come back as `scoring`/`ppr`.
 * Kicker and Defense/Special Teams rules, and any bonus-only category
 * (40+-yard bonuses, points-in-a-game brackets), are NOT modeled anywhere
 * in this engine — they're surfaced under `unmapped` so nothing pasted is
 * silently lost, but nothing is invented to represent them either.
 */
export default function ScoringPasteImport({ onApply, onClose }: Props) {
  const [provider, setProvider] = useState<"yahoo" | "espn">("yahoo");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    scoring: Partial<ScoringRules>;
    ppr: number | null;
    matched: { label: string; raw: string; field: string; value: number }[];
    unmapped: { label: string; raw: string; section: string }[];
    warnings: string[];
  } | null>(null);
  const [applied, setApplied] = useState(false);

  const cfg = PROVIDERS.find((p) => p.key === provider)!;

  const preview = async () => {
    setLoading(true); setError(null); setResult(null); setApplied(false);
    try {
      const res = await api.scoringPasteCandidates(provider, { text });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const apply = () => {
    if (!result || !result.matched.length) return;
    onApply({ scoring: result.scoring, ppr: result.ppr ?? undefined });
    setApplied(true);
  };

  return (
    <div className="border-b border-line bg-surface">
      <div className="max-w-6xl mx-auto px-4 py-4 space-y-3">
        <div className="flex items-center gap-2">
          <ClipboardPaste className="w-4 h-4 text-muted" />
          <h3 className="text-xs uppercase tracking-wider text-muted font-semibold">
            Import real scoring rules
          </h3>
          <div className="ml-auto flex items-center gap-1">
            {PROVIDERS.map((p) => (
              <button
                key={p.key}
                onClick={() => { setProvider(p.key); setResult(null); setApplied(false); }}
                className={`px-2 py-0.5 rounded-full text-2xs font-medium border ${
                  provider === p.key
                    ? "bg-amber-600 text-white border-amber-600"
                    : "border-line text-muted hover:text-ink"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="text-faint hover:text-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-muted leading-snug max-w-2xl">
          Neither platform's API labels most scoring rules with anything reliable to auto-map (only
          points/reception is auto-detected on import) — but {cfg.label}'s own Scoring settings page
          ({cfg.helpUrl}) labels every rule in plain English. Copy that whole page's text and paste it
          below. Only pass/rush/rec yards & TDs, interceptions, and fumbles lost feed this app's model —
          Kicker and Defense/Special Teams rules aren't scored from a stat line here, so they're listed
          but not applied.
        </p>

        <textarea
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={cfg.placeholder}
          className="w-full rounded-md border border-line bg-white px-2 py-1.5 font-mono text-2xs text-ink focus:outline-none focus:border-amber-500"
        />

        <div className="flex items-center gap-2">
          <button
            onClick={preview}
            disabled={loading || !text.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-medium hover:bg-amber-700 disabled:opacity-50"
          >
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Preview match
          </button>
          {result && !applied && result.matched.length > 0 && (
            <button
              onClick={apply}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700"
            >
              Apply {result.matched.length} rule{result.matched.length === 1 ? "" : "s"} below
            </button>
          )}
          {applied && (
            <span className="flex items-center gap-1 text-xs text-emerald-700">
              <Check className="w-3.5 h-3.5" /> Applied — review the values below, then Save
            </span>
          )}
        </div>

        {error && (
          <p className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-2xs text-rose-700">
            {error}
          </p>
        )}

        {result && (
          <div className="rounded-md border border-line bg-white px-2.5 py-2 text-2xs text-muted space-y-1.5">
            <div>
              Matched {result.matched.length} rule{result.matched.length === 1 ? "" : "s"} this app models
              {result.ppr != null && ` (including points/reception: ${result.ppr})`} · {result.unmapped.length}{" "}
              other row{result.unmapped.length === 1 ? "" : "s"} not modeled by this engine
            </div>
            {result.matched.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-0.5 pt-0.5">
                {result.matched.map((m) => (
                  <div key={m.label} className="flex justify-between gap-2">
                    <span className="truncate" title={m.label}>{m.label}</span>
                    <span className="font-mono text-ink shrink-0">{m.value}</span>
                  </div>
                ))}
              </div>
            )}
            {result.warnings.length > 0 && (
              <div className="flex items-start gap-1.5 text-amber-700 pt-1">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>
                  Bonus brackets can't be represented as a flat rate — base rate used, bonus ignored:{" "}
                  {result.warnings.join("; ")}
                </span>
              </div>
            )}
            {result.unmapped.length > 0 && (
              <details className="pt-1">
                <summary className="cursor-pointer text-faint hover:text-muted">
                  Not modeled by this app ({result.unmapped.length}) — Kicker/Defense scoring is valued
                  from historical stats, not a per-category rule
                </summary>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-0.5 pt-1">
                  {result.unmapped.map((u, i) => (
                    <div key={`${u.label}-${i}`} className="flex justify-between gap-2 text-faint">
                      <span className="truncate" title={u.label}>{u.label}</span>
                      <span className="font-mono shrink-0">{u.raw}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

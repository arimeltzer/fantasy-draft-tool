import { useState } from "react";
import { X, RotateCcw, ListOrdered } from "lucide-react";
import { KEEPER_PRESETS, normalizeKeeperRule } from "@/engine/keeper.js";
import { DEFAULT_SCORING, resolveScoring } from "@/engine/valuation-engine.js";
import { applyOpponentNames } from "@/engine/draft-order.js";
import type { TeamRename } from "@/engine/draft-order.js";
import { LeagueSettings, KeeperRule, ScoringRules } from "@/lib/api";
import Tip from "@/components/shared/Tip";

/** One team per line; blanks and stray whitespace are ignored, not stored. */
const parseOpponents = (text: string) =>
  text.split("\n").map((s) => s.trim()).filter(Boolean);

interface Props {
  settings: LeagueSettings;
  onSave: (s: LeagueSettings) => void;
  onClose: () => void;
  format?: "auction" | "snake";
  /** Opens the draft-order board, which owns seating and traded picks. */
  onOpenDraftOrder?: () => void;
  /** Team renames made here, for data outside league settings (keeper picks). */
  onRenames?: (renames: TeamRename[]) => void;
}

export default function SettingsDrawer({ settings, onSave, onClose, format = "auction", onOpenDraftOrder, onRenames }: Props) {
  const [local, setLocal] = useState<LeagueSettings>(settings);
  // The opponents textarea keeps its own raw text. Rendering it from the parsed
  // array instead round-trips through a lossy transform (trim + drop blanks),
  // so pressing Enter created an empty line that was immediately filtered away
  // — the newline vanished and the caret jumped to the end, making it
  // impossible to start a second name. Raw text in, parsed array derived out.
  const [oppText, setOppText] = useState(() => (settings.opponents ?? []).join("\n"));
  const keeper: KeeperRule = normalizeKeeperRule(local.keeper, format);
  const isAuction = format === "auction";
  // How many picks changed hands, for the badge next to the board link.
  const tradedPicks = Object.keys(local.pickOwners ?? {}).length;

  /**
   * Editing a name in the opponents list is a RENAME of that team, because the
   * list position is its `DraftPick.team_id`. Names are also keys (draft seat,
   * traded picks, keeper import), so the diff is applied through
   * applyOpponentNames rather than just storing the new strings — otherwise a
   * mid-season name change silently drops that team's slot and trades.
   */
  const save = () => {
    const { settings: next, renames } = applyOpponentNames(
      { ...local, opponents: settings.opponents }, local.opponents ?? []);
    if (renames.length) onRenames?.(renames);
    onSave(next);
  };

  const set = (patch: Partial<LeagueSettings>) => setLocal((s) => ({ ...s, ...patch }));
  const setRoster = (k: string, v: number) =>
    setLocal((s) => ({ ...s, roster: { ...s.roster, [k]: v } }));
  const setScoring = (k: keyof ScoringRules, v: number) =>
    setLocal((s) => ({ ...s, scoring: { ...s.scoring, [k]: v } }));
  const resetScoring = () => setLocal((s) => ({ ...s, scoring: {} }));
  // Effective values (defaults merged with any override) — what actually
  // drives valuations right now, whether or not the league has customized it.
  const sc = resolveScoring(local);
  const scoringCustomized = Object.keys(local.scoring ?? {}).length > 0;
  const setKeeper = (patch: Partial<KeeperRule>) =>
    setLocal((s) => ({ ...s, keeper: { ...normalizeKeeperRule(s.keeper, format), ...patch } }));
  const applyPreset = (p: "yahoo" | "espn" | "custom") =>
    setLocal((s) => ({ ...s, keeper: { ...KEEPER_PRESETS[p], enabled: s.keeper?.enabled ?? true } }));

  const numField = (label: string, value: number, onChange: (v: number) => void, step = 1) => (
    <label key={label} className="flex items-center justify-between gap-2 text-xs">
      <span className="text-gray-500">{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-20 px-2 py-1 rounded bg-gray-50 border border-gray-300 text-right font-mono text-gray-700 focus:outline-none focus:border-gray-400"
      />
    </label>
  );

  return (
    <div className="border-b border-gray-200 bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-4 grid sm:grid-cols-3 gap-5">
        <div className="space-y-2">
          <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold">
            {isAuction ? "Auction" : "League"}
          </h3>
          {numField("Teams", local.teams, (v) => set({ teams: v }))}
          {/* Budget is meaningless in a snake draft — don't show a field whose
              value can never affect anything in this format. */}
          {isAuction && numField("Budget / team ($)", local.budget, (v) => set({ budget: v }))}
          {numField("Points / reception", local.ppr, (v) => set({ ppr: v }), 0.5)}
          <label className="flex items-center justify-between gap-2 text-xs">
            <span className="text-gray-500">Superflex</span>
            <input
              type="checkbox"
              checked={local.superflex}
              onChange={(e) => set({ superflex: e.target.checked, roster: { ...local.roster, SF: e.target.checked ? 1 : 0 } })}
              className="accent-amber-500 w-4 h-4"
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-xs">
            <Tip tip="Pulls projections toward expert consensus order for players the market ranks, and leaves the rest to the model. Backtested 2017–2025, this ranked the full board better than the model alone at every position. Turn it off only if this pool has no ADP/ECR data.">
              <span className="text-gray-500">Anchor to market ranks</span>
            </Tip>
            <input
              type="checkbox"
              checked={local.marketAnchor !== false}
              onChange={(e) => set({ marketAnchor: e.target.checked })}
              className="accent-amber-500 w-4 h-4"
            />
          </label>
          {local.marketAnchor !== false && (
            <label className="flex items-center justify-between gap-2 text-xs">
              <Tip tip="How much of YOUR model survives the anchor. 1 = ignore the market, 0 = follow it exactly. 0.3 is the backtested optimum and the curve is flat from about 0.2 to 0.5, so small changes here matter little.">
                <span className="text-gray-500 pl-3">↳ model weight</span>
              </Tip>
              <input
                type="number" min={0} max={1} step={0.1}
                value={local.marketAnchorWeight ?? 0.3}
                onChange={(e) => set({ marketAnchorWeight: Math.min(1, Math.max(0, Number(e.target.value))) })}
                className="w-16 px-2 py-1 rounded bg-gray-50 border border-gray-300 text-right font-mono text-xs"
              />
            </label>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Roster (per team)</h3>
          {(["QB","RB","WR","TE","FLEX","K","DST","BENCH"] as const).map((k) =>
            numField(k, local.roster[k] ?? 0, (v) => setRoster(k, v))
          )}
        </div>

        <div className="space-y-2">
          {/* Draft slot / pick order only mean something in a snake draft. */}
          {!isAuction && (
            <>
              <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Your draft slot</h3>
              {numField("Draft slot", local.draftSlot ?? 1, (v) => set({ draftSlot: v }))}

              {/* Traded picks are authored on the draft-order board, where the
                  serpentine order is drawn for you — not typed as raw overall
                  pick numbers, which meant doing the arithmetic by hand. */}
              {onOpenDraftOrder && (
                <>
                  <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold pt-2">Draft order</h3>
                  <p className="text-xs text-gray-400 leading-snug">
                    Everyone's seat and every pick in the draft, including any that were traded.
                  </p>
                  <button
                    onClick={onOpenDraftOrder}
                    className="flex w-full items-center justify-center gap-1.5 rounded border border-gray-300 bg-gray-50 px-2 py-1.5 text-xs text-gray-600 hover:border-gray-400 hover:text-gray-800"
                  >
                    <ListOrdered className="h-3.5 w-3.5" />
                    Open draft order
                  </button>
                  {tradedPicks > 0 && (
                    <p className="text-2xs text-amber-600">
                      {tradedPicks} pick{tradedPicks === 1 ? "" : "s"} traded — keeper costs and the
                      pick clock follow the board, not serpentine order.
                    </p>
                  )}
                </>
              )}
            </>
          )}

          <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold pt-2">Opponent teams</h3>
          <p className="text-xs text-gray-400 leading-snug">
            One name per line{isAuction ? " (for budget tracking)" : ""}. Leave blank to auto-name.
          </p>
          <textarea
            rows={4}
            value={oppText}
            placeholder={Array.from({ length: Math.max(0, local.teams - 1) }, (_, i) => `Team ${i + 2}`).join("\n")}
            onChange={(e) => {
              setOppText(e.target.value);
              set({ opponents: parseOpponents(e.target.value) });
            }}
            className="w-full px-2 py-1 rounded bg-gray-50 border border-gray-300 font-mono text-xs text-gray-700 focus:outline-none focus:border-gray-400"
          />
        </div>
      </div>

      <div className="mx-auto max-w-6xl border-t border-hair px-4 py-4">
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <h3 className="eyebrow">Scoring</h3>
          <span className="chip border-line bg-raised text-muted">
            Points / reception is set above ({local.ppr})
          </span>
          {scoringCustomized && (
            <button
              onClick={resetScoring}
              className="ml-auto flex items-center gap-1 text-2xs text-muted hover:text-ink"
              title="Clear all overrides and go back to standard scoring for every category below"
            >
              <RotateCcw className="h-3 w-3" /> Reset to standard
            </button>
          )}
        </div>
        <p className="mb-2.5 text-2xs text-faint leading-snug">
          Every category below feeds directly into projections and dollar values — a league using 6pt
          passing TDs or -1 INTs (instead of the 4pt / -2 standard) should enter that here, or QB value
          in particular will be under/over-valued. Importing a league only auto-detects points/reception;
          everything else defaults to standard until you set it.
        </p>
        <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-2">
            <h4 className="text-2xs font-semibold uppercase tracking-wide text-faint">Passing</h4>
            {numField("Pts / pass yard", sc.ptsPerPassYd, (v) => setScoring("ptsPerPassYd", v), 0.01)}
            {numField("Pts / pass TD", sc.ptsPerPassTD, (v) => setScoring("ptsPerPassTD", v), 0.5)}
            {numField("Pts / INT", sc.ptsPerInt, (v) => setScoring("ptsPerInt", v), 0.5)}
          </div>
          <div className="space-y-2">
            <h4 className="text-2xs font-semibold uppercase tracking-wide text-faint">Rushing</h4>
            {numField("Pts / rush yard", sc.ptsPerRushYd, (v) => setScoring("ptsPerRushYd", v), 0.01)}
            {numField("Pts / rush TD", sc.ptsPerRushTD, (v) => setScoring("ptsPerRushTD", v), 0.5)}
          </div>
          <div className="space-y-2">
            <h4 className="text-2xs font-semibold uppercase tracking-wide text-faint">Receiving</h4>
            {numField("Pts / rec yard", sc.ptsPerRecYd, (v) => setScoring("ptsPerRecYd", v), 0.01)}
            {numField("Pts / rec TD", sc.ptsPerRecTD, (v) => setScoring("ptsPerRecTD", v), 0.5)}
          </div>
          <div className="space-y-2">
            <h4 className="text-2xs font-semibold uppercase tracking-wide text-faint">Misc</h4>
            {numField("Pts / fumble lost", sc.ptsPerFumble, (v) => setScoring("ptsPerFumble", v), 0.5)}
            <p className="pt-1 text-2xs text-faint leading-snug">
              Standard: {DEFAULT_SCORING.ptsPerPassTD}pt pass TD, {DEFAULT_SCORING.ptsPerInt} INT,{" "}
              {DEFAULT_SCORING.ptsPerRushTD}/{DEFAULT_SCORING.ptsPerRecTD}pt rush/rec TD.
            </p>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl border-t border-hair px-4 py-4">
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <h3 className="eyebrow">Keepers</h3>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={keeper.enabled}
              onChange={(e) => setKeeper({ enabled: e.target.checked })}
              className="h-4 w-4 accent-brand"
            />
            Enabled
          </label>
          <div className="ml-auto flex items-center gap-1">
            {(["yahoo", "espn", "custom"] as const).map((p) => (
              <button
                key={p}
                onClick={() => applyPreset(p)}
                className={`chip capitalize ${keeper.preset === p ? "border-brand bg-brand/10 text-brand" : "border-line bg-raised text-muted hover:text-ink"}`}
              >
                {KEEPER_PRESETS[p].label}
              </button>
            ))}
          </div>
        </div>

        {keeper.enabled && (
          <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted">Cost basis</span>
              <select
                value={keeper.basis}
                onChange={(e) => setKeeper({ basis: e.target.value as "price" | "round" })}
                className="w-24 rounded-md border border-line bg-sunken px-2 py-1 text-ink focus:border-brand focus:outline-none"
              >
                <option value="price">Price ($)</option>
                <option value="round">Round</option>
              </select>
            </label>
            {numField("Max keepers / team", keeper.maxKeepers, (v) => setKeeper({ maxKeepers: v }))}
            {keeper.basis === "price"
              ? numField("Price surcharge ($)", keeper.priceSurcharge, (v) => setKeeper({ priceSurcharge: v }))
              : numField("Undrafted round", keeper.undraftedRound, (v) => setKeeper({ undraftedRound: v }))}
            {keeper.basis === "round" &&
              numField("Round escalation / yr", keeper.roundInflation, (v) => setKeeper({ roundInflation: v }))}
            <label className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted">No consecutive years</span>
              <input
                type="checkbox"
                checked={keeper.noConsecutive}
                onChange={(e) => setKeeper({ noConsecutive: e.target.checked })}
                className="h-4 w-4 accent-brand"
              />
            </label>
          </div>
        )}
      </div>

      <div className="max-w-6xl mx-auto px-4 pb-3 flex items-center justify-between">
        <button onClick={onClose} className="flex items-center gap-1 text-gray-500 hover:text-gray-600 text-xs">
          <X className="w-3.5 h-3.5" /> Cancel
        </button>
        <button
          onClick={() => { save(); onClose(); }}
          className="text-xs px-3 py-1.5 rounded bg-amber-50 border border-amber-300 text-amber-700 hover:bg-amber-100"
        >
          Save settings
        </button>
      </div>
    </div>
  );
}

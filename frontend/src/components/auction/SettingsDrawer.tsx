import { useState } from "react";
import { X } from "lucide-react";
import { KEEPER_PRESETS, normalizeKeeperRule } from "@/engine/keeper.js";
import { LeagueSettings, KeeperRule } from "@/lib/api";

interface Props {
  settings: LeagueSettings;
  onSave: (s: LeagueSettings) => void;
  onClose: () => void;
  format?: "auction" | "snake";
}

export default function SettingsDrawer({ settings, onSave, onClose, format = "auction" }: Props) {
  const [local, setLocal] = useState<LeagueSettings>(settings);
  const keeper: KeeperRule = normalizeKeeperRule(local.keeper, format);

  const set = (patch: Partial<LeagueSettings>) => setLocal((s) => ({ ...s, ...patch }));
  const setRoster = (k: string, v: number) =>
    setLocal((s) => ({ ...s, roster: { ...s.roster, [k]: v } }));
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
          <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Auction</h3>
          {numField("Teams", local.teams, (v) => set({ teams: v }))}
          {numField("Budget / team ($)", local.budget, (v) => set({ budget: v }))}
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
        </div>

        <div className="space-y-2">
          <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Roster (per team)</h3>
          {(["QB","RB","WR","TE","FLEX","K","DST","BENCH"] as const).map((k) =>
            numField(k, local.roster[k] ?? 0, (v) => setRoster(k, v))
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Your draft slot</h3>
          {numField("Draft slot", local.draftSlot ?? 1, (v) => set({ draftSlot: v }))}

          <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold pt-2">Opponent teams</h3>
          <p className="text-xs text-gray-400 leading-snug">One name per line (for auction budget tracking). Leave blank to auto-name.</p>
          <textarea
            rows={4}
            value={(local.opponents ?? []).join("\n")}
            placeholder={Array.from({ length: Math.max(0, local.teams - 1) }, (_, i) => `Team ${i + 2}`).join("\n")}
            onChange={(e) => set({ opponents: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
            className="w-full px-2 py-1 rounded bg-gray-50 border border-gray-300 font-mono text-xs text-gray-700 focus:outline-none focus:border-gray-400"
          />
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
          onClick={() => { onSave(local); onClose(); }}
          className="text-xs px-3 py-1.5 rounded bg-amber-50 border border-amber-300 text-amber-700 hover:bg-amber-100"
        >
          Save settings
        </button>
      </div>
    </div>
  );
}

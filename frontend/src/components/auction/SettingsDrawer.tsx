import { useState } from "react";
import { X } from "lucide-react";
import { LeagueSettings } from "@/lib/api";

interface Props {
  settings: LeagueSettings;
  onSave: (s: LeagueSettings) => void;
  onClose: () => void;
}

export default function SettingsDrawer({ settings, onSave, onClose }: Props) {
  const [local, setLocal] = useState<LeagueSettings>(settings);

  const set = (patch: Partial<LeagueSettings>) => setLocal((s) => ({ ...s, ...patch }));
  const setRoster = (k: string, v: number) =>
    setLocal((s) => ({ ...s, roster: { ...s.roster, [k]: v } }));

  const numField = (label: string, value: number, onChange: (v: number) => void, step = 1) => (
    <label key={label} className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted">{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-20 rounded-md border border-line bg-sunken px-2 py-1 text-right font-mono text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15"
      />
    </label>
  );

  return (
    <div className="border-b border-line bg-surface shadow-card">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-5 sm:grid-cols-3">
        <div className="space-y-2.5">
          <h3 className="eyebrow">Auction</h3>
          {numField("Teams", local.teams, (v) => set({ teams: v }))}
          {numField("Budget / team ($)", local.budget, (v) => set({ budget: v }))}
          {numField("Points / reception", local.ppr, (v) => set({ ppr: v }), 0.5)}
          <label className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted">Superflex</span>
            <input
              type="checkbox"
              checked={local.superflex}
              onChange={(e) => set({ superflex: e.target.checked, roster: { ...local.roster, SF: e.target.checked ? 1 : 0 } })}
              className="h-4 w-4 accent-brand"
            />
          </label>
        </div>

        <div className="space-y-2.5">
          <h3 className="eyebrow">Roster (per team)</h3>
          {(["QB","RB","WR","TE","FLEX","K","DST","BENCH"] as const).map((k) =>
            numField(k, local.roster[k] ?? 0, (v) => setRoster(k, v))
          )}
        </div>

        <div className="space-y-2.5">
          <h3 className="eyebrow">Your draft slot</h3>
          {numField("Draft slot", local.draftSlot ?? 1, (v) => set({ draftSlot: v }))}
        </div>
      </div>

      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 pb-4">
        <button onClick={onClose} className="flex items-center gap-1 text-xs text-muted hover:text-ink">
          <X className="h-3.5 w-3.5" /> Cancel
        </button>
        <button
          onClick={() => { onSave(local); onClose(); }}
          className="btn-brand px-3.5 py-1.5 text-xs"
        >
          Save settings
        </button>
      </div>
    </div>
  );
}

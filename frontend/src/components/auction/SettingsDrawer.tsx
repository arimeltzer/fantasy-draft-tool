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
      <span className="text-slate-400">{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-20 px-2 py-1 rounded bg-slate-950 border border-slate-700 text-right font-mono text-slate-200 focus:outline-none focus:border-slate-500"
      />
    </label>
  );

  return (
    <div className="border-b border-slate-800 bg-slate-900/60">
      <div className="max-w-6xl mx-auto px-4 py-4 grid sm:grid-cols-3 gap-5">
        <div className="space-y-2">
          <h3 className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Auction</h3>
          {numField("Teams", local.teams, (v) => set({ teams: v }))}
          {numField("Budget / team ($)", local.budget, (v) => set({ budget: v }))}
          {numField("Points / reception", local.ppr, (v) => set({ ppr: v }), 0.5)}
          <label className="flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-400">Superflex</span>
            <input
              type="checkbox"
              checked={local.superflex}
              onChange={(e) => set({ superflex: e.target.checked, roster: { ...local.roster, SF: e.target.checked ? 1 : 0 } })}
              className="accent-amber-500 w-4 h-4"
            />
          </label>
        </div>

        <div className="space-y-2">
          <h3 className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Roster (per team)</h3>
          {(["QB","RB","WR","TE","FLEX","K","DST","BENCH"] as const).map((k) =>
            numField(k, local.roster[k] ?? 0, (v) => setRoster(k, v))
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Your draft slot</h3>
          {numField("Draft slot", local.draftSlot ?? 1, (v) => set({ draftSlot: v }))}
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 pb-3 flex items-center justify-between">
        <button onClick={onClose} className="flex items-center gap-1 text-slate-500 hover:text-slate-300 text-xs">
          <X className="w-3.5 h-3.5" /> Cancel
        </button>
        <button
          onClick={() => { onSave(local); onClose(); }}
          className="text-xs px-3 py-1.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-200 hover:bg-amber-500/25"
        >
          Save settings
        </button>
      </div>
    </div>
  );
}

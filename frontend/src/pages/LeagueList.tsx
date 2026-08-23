import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Gavel, Zap, Trash2, LogOut, Download } from "lucide-react";
import { useLeagues } from "@/hooks/useLeague";
import { api, clearToken, LeagueSettings } from "@/lib/api";
import ImportLeagueModal from "@/components/ImportLeagueModal";

const DEFAULT_SETTINGS: LeagueSettings = {
  teams: 12,
  budget: 200,
  ppr: 0.5,
  roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 7, SF: 0 },
  superflex: false,
  draftSlot: 6,
};

export default function LeagueList() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: leagues, isLoading } = useLeagues();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState("");
  const [format, setFormat] = useState<"auction" | "snake">("snake");

  const createMut = useMutation({
    mutationFn: () => api.createLeague({ name: name.trim(), format, settings: DEFAULT_SETTINGS }),
    onSuccess: (league) => {
      qc.invalidateQueries({ queryKey: ["leagues"] });
      nav(`/league/${league.id}`);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteLeague(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leagues"] }),
  });

  const logout = () => { clearToken(); nav("/login"); };

  return (
    <div className="min-h-screen bg-paper px-4 py-10 font-sans">
      <div className="max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-7">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-gold grid place-items-center shadow-[0_4px_10px_rgba(180,83,9,0.2)]">
              <span className="text-lg">🏈</span>
            </div>
            <div>
              <h1 className="text-lg font-extrabold tracking-tight text-ink leading-none">My Leagues</h1>
              <p className="text-xs text-muted mt-1">Select a league to enter your war room</p>
            </div>
          </div>
          <button onClick={logout} className="flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-ink px-3.5 py-2 rounded-full border border-line bg-surface hover:border-faint">
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </button>
        </div>

        {isLoading && (
          <div className="text-sm text-muted text-center py-8">Loading…</div>
        )}

        <div className="flex flex-col gap-2.5 mb-6">
          {leagues?.map((league) => (
            <div
              key={league.id}
              className="flex items-center gap-3.5 rounded-2xl border border-line bg-surface px-4 py-3.5 shadow-card hover:border-faint cursor-pointer group"
              onClick={() => nav(`/league/${league.id}`)}
            >
              <div className={`w-10 h-10 rounded-xl grid place-items-center shrink-0 ${league.format === "auction" ? "bg-gradient-to-br from-amber-400 to-gold" : "bg-gradient-to-br from-emerald-400 to-emerald-600"}`}>
                {league.format === "auction"
                  ? <Gavel className="w-4 h-4 text-white" />
                  : <Zap className="w-4 h-4 text-white" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm truncate text-ink">{league.name}</div>
                <div className="text-xs text-faint font-mono capitalize">{league.format}</div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${league.name}"?`)) deleteMut.mutate(league.id); }}
                className="opacity-0 group-hover:opacity-100 text-faint hover:text-rose-500 p-1.5 rounded-lg hover:bg-rose-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {!isLoading && leagues?.length === 0 && (
            <div className="text-sm text-faint text-center py-8 border border-dashed border-line rounded-2xl">
              No leagues yet. Create one below.
            </div>
          )}
        </div>

        {creating ? (
          <div className="rounded-2xl border border-line bg-surface p-5 space-y-4 shadow-card">
            <h2 className="text-sm font-bold text-ink">New League</h2>
            <div>
              <label className="block text-xs font-bold text-muted mb-1.5">League name</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-sunken border border-line text-sm text-ink focus:outline-none focus:border-gold/60"
                placeholder="My Fantasy League 2026"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-muted mb-1.5">Format</label>
              <div className="flex gap-2">
                {(["auction", "snake"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFormat(f)}
                    className={`flex-1 py-2.5 rounded-xl border text-sm font-semibold capitalize flex items-center justify-center gap-2 ${
                      format === f
                        ? f === "auction"
                          ? "bg-amber-50 border-amber-300 text-amber-700"
                          : "bg-emerald-50 border-emerald-300 text-emerald-700"
                        : "bg-surface border-line text-muted"
                    }`}
                  >
                    {f === "auction" ? <Gavel className="w-4 h-4" /> : <Zap className="w-4 h-4" />}
                    {f}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => createMut.mutate()}
                disabled={!name.trim() || createMut.isPending}
                className="flex-1 py-2.5 rounded-xl bg-gradient-to-br from-amber-400 to-gold text-white text-sm font-bold hover:opacity-95 disabled:opacity-50 transition-opacity"
              >
                {createMut.isPending ? "Creating…" : "Create League"}
              </button>
              <button onClick={() => { setCreating(false); setName(""); }} className="px-4 py-2.5 rounded-xl bg-raised border border-line text-sm font-semibold text-muted hover:border-faint">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <button
              onClick={() => setCreating(true)}
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl border-2 border-dashed border-line text-muted hover:border-gold/50 hover:text-ink text-sm font-semibold transition-colors"
            >
              <Plus className="w-4 h-4" /> New League
            </button>
            <button
              onClick={() => setImporting(true)}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-line bg-surface text-muted hover:border-faint hover:text-ink text-sm font-semibold shadow-card transition-colors"
            >
              <Download className="w-4 h-4" /> Import from ESPN / Yahoo
            </button>
          </div>
        )}
      </div>

      {importing && <ImportLeagueModal onClose={() => setImporting(false)} />}
    </div>
  );
}

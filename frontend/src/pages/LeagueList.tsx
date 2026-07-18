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
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">My Leagues</h1>
            <p className="text-xs text-gray-500 mt-0.5">Select a league to enter your war room</p>
          </div>
          <button onClick={logout} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-600 px-2 py-1.5 rounded border border-gray-200 hover:border-gray-300">
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </button>
        </div>

        {isLoading && (
          <div className="text-sm text-gray-500 text-center py-8">Loading…</div>
        )}

        <div className="space-y-2 mb-6">
          {leagues?.map((league) => (
            <div
              key={league.id}
              className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-100 px-4 py-3 hover:border-gray-300 cursor-pointer group"
              onClick={() => nav(`/league/${league.id}`)}
            >
              <div className={`w-8 h-8 rounded grid place-items-center shrink-0 ${league.format === "auction" ? "bg-amber-50 border border-amber-300" : "bg-emerald-50 border border-emerald-300"}`}>
                {league.format === "auction"
                  ? <Gavel className="w-4 h-4 text-amber-400" />
                  : <Zap className="w-4 h-4 text-emerald-600" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">{league.name}</div>
                <div className="text-xs text-gray-500 font-mono capitalize">{league.format}</div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${league.name}"?`)) deleteMut.mutate(league.id); }}
                className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-rose-400 p-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {!isLoading && leagues?.length === 0 && (
            <div className="text-sm text-gray-500 text-center py-6 border border-dashed border-gray-200 rounded-lg">
              No leagues yet. Create one below.
            </div>
          )}
        </div>

        {creating ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-4">
            <h2 className="text-sm font-semibold">New League</h2>
            <div>
              <label className="block text-xs text-gray-500 mb-1">League name</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 rounded bg-gray-50 border border-gray-300 text-sm focus:outline-none focus:border-gray-400"
                placeholder="My Fantasy League 2026"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Format</label>
              <div className="flex gap-2">
                {(["auction", "snake"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFormat(f)}
                    className={`flex-1 py-2 rounded border text-sm capitalize flex items-center justify-center gap-2 ${
                      format === f
                        ? f === "auction"
                          ? "bg-amber-50 border-amber-300 text-amber-700"
                          : "bg-emerald-50 border-emerald-300 text-emerald-700"
                        : "bg-gray-50 border-gray-300 text-gray-500"
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
                className="flex-1 py-2 rounded bg-amber-50 border border-amber-300 text-amber-700 text-sm hover:bg-amber-100 disabled:opacity-50"
              >
                {createMut.isPending ? "Creating…" : "Create League"}
              </button>
              <button onClick={() => { setCreating(false); setName(""); }} className="px-4 py-2 rounded bg-gray-100 border border-gray-300 text-sm hover:border-gray-400">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <button
              onClick={() => setCreating(true)}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-lg border border-dashed border-gray-300 text-gray-500 hover:border-gray-400 hover:text-gray-700 text-sm transition-colors"
            >
              <Plus className="w-4 h-4" /> New League
            </button>
            <button
              onClick={() => setImporting(true)}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-gray-200 bg-gray-100 text-gray-600 hover:border-gray-300 hover:text-gray-800 text-sm transition-colors"
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

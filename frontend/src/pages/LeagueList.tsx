import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Gavel, Zap, Trash2, LogOut, ChevronRight } from "lucide-react";
import { useLeagues } from "@/hooks/useLeague";
import { api, clearToken, LeagueSettings } from "@/lib/api";

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
    <div className="min-h-screen bg-paper px-4 py-10">
      <div className="mx-auto max-w-lg">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink">My Leagues</h1>
            <p className="mt-0.5 text-xs text-muted">Select a league to enter your war room</p>
          </div>
          <button onClick={logout} className="btn-ghost px-2.5 py-1.5 text-xs">
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>

        {isLoading && (
          <div className="py-8 text-center text-sm text-muted">Loading…</div>
        )}

        <div className="mb-6 space-y-2">
          {leagues?.map((league) => {
            const auction = league.format === "auction";
            return (
              <div
                key={league.id}
                className="group flex cursor-pointer items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card transition-colors hover:border-line hover:bg-raised"
                onClick={() => nav(`/league/${league.id}`)}
              >
                <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ring-1 ${auction ? "bg-gold/10 ring-gold/25" : "bg-brand/10 ring-brand/25"}`}>
                  {auction
                    ? <Gavel className="h-4 w-4 text-gold" />
                    : <Zap className="h-4 w-4 text-brand" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{league.name}</div>
                  <div className="font-mono text-2xs capitalize text-muted">{league.format}</div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${league.name}"?`)) deleteMut.mutate(league.id); }}
                  className="rounded-md p-1.5 text-faint opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-500 group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                <ChevronRight className="h-4 w-4 text-faint" />
              </div>
            );
          })}
          {!isLoading && leagues?.length === 0 && (
            <div className="rounded-xl border border-dashed border-line py-8 text-center text-sm text-muted">
              No leagues yet. Create one below.
            </div>
          )}
        </div>

        {creating ? (
          <div className="card space-y-4 p-5">
            <h2 className="text-sm font-semibold text-ink">New League</h2>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">League name</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="field"
                placeholder="My Fantasy League 2026"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">Format</label>
              <div className="flex gap-2">
                {(["auction", "snake"] as const).map((f) => {
                  const active = format === f;
                  return (
                    <button
                      key={f}
                      onClick={() => setFormat(f)}
                      className={`flex flex-1 items-center justify-center gap-2 rounded-lg border py-2.5 text-sm capitalize transition-colors ${
                        active
                          ? f === "auction"
                            ? "border-gold bg-gold/10 text-gold"
                            : "border-brand bg-brand/10 text-brand"
                          : "border-line bg-surface text-muted hover:bg-raised"
                      }`}
                    >
                      {f === "auction" ? <Gavel className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
                      {f}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => createMut.mutate()}
                disabled={!name.trim() || createMut.isPending}
                className="btn-brand flex-1 py-2.5"
              >
                {createMut.isPending ? "Creating…" : "Create League"}
              </button>
              <button onClick={() => { setCreating(false); setName(""); }} className="btn-ghost px-4 py-2.5">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line py-3.5 text-sm text-muted transition-colors hover:border-brand/40 hover:text-brand"
          >
            <Plus className="h-4 w-4" /> New League
          </button>
        )}
      </div>
    </div>
  );
}

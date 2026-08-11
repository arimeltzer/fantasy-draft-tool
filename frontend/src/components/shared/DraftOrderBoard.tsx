import { useMemo, useState } from "react";
import { X, ArrowLeftRight, RotateCcw, Check, AlertTriangle, ListOrdered } from "lucide-react";
import {
  MY_TEAM, teamLabels, roundsFor, slotByTeam, baseOwners, currentOwners,
  picksByTeam, pickLabel, derivePickSettings, orderWarnings,
} from "@/engine/draft-order.js";
import type { PickOwners } from "@/engine/draft-order.js";
import { LeagueSettings } from "@/lib/api";

interface Props {
  settings: LeagueSettings;
  onSave: (s: LeagueSettings) => void;
  onClose: () => void;
}

/** Stable per-team tint so a traded pick is recognisable at a glance. */
const TINTS = [
  "bg-sky-100 text-sky-900 border-sky-300",
  "bg-violet-100 text-violet-900 border-violet-300",
  "bg-amber-100 text-amber-900 border-amber-300",
  "bg-rose-100 text-rose-900 border-rose-300",
  "bg-teal-100 text-teal-900 border-teal-300",
  "bg-lime-100 text-lime-900 border-lime-300",
  "bg-fuchsia-100 text-fuchsia-900 border-fuchsia-300",
  "bg-cyan-100 text-cyan-900 border-cyan-300",
  "bg-orange-100 text-orange-900 border-orange-300",
  "bg-indigo-100 text-indigo-900 border-indigo-300",
  "bg-stone-100 text-stone-900 border-stone-300",
];
const MINE_TINT = "bg-emerald-200 text-emerald-950 border-emerald-500 font-semibold";

/**
 * The whole draft, pick by pick, with ownership editable by clicking a pick.
 *
 * This replaces entering traded picks as raw overall pick numbers in text
 * fields, which required doing the serpentine arithmetic by hand and gave no
 * way to check the result. Here the serpentine order is drawn for you and a
 * trade is one click: pick the cell, pick the new owner.
 */
export default function DraftOrderBoard({ settings, onSave, onClose }: Props) {
  const labels: string[] = useMemo(() => teamLabels(settings), [settings]);
  const teams = labels.length;
  const [rounds, setRounds] = useState<number>(() => roundsFor(settings));
  const slots: Record<string, number> = useMemo(() => slotByTeam(settings), [settings]);

  // Working copy of the board. Edits stay local until Save, so a misclick is
  // undoable by closing without saving.
  const [owners, setOwners] = useState<PickOwners>(() => currentOwners(settings, roundsFor(settings)));
  const [order, setOrder] = useState<Record<string, number>>(slots);
  const [selected, setSelected] = useState<number | null>(null);

  // Base ownership under the CURRENT slot assignment — recomputed as the base
  // order is edited, so "traded" always means "differs from the serpentine you
  // are looking at", not from some stale earlier order.
  const draft = useMemo(
    () => ({ ...settings, teams, draftSlot: order[MY_TEAM],
             teamSlots: Object.fromEntries(Object.entries(order).filter(([t]) => t !== MY_TEAM)) }),
    [settings, teams, order],
  );
  const base: PickOwners = useMemo(() => baseOwners(draft, rounds), [draft, rounds]);

  const held = useMemo(() => picksByTeam(owners), [owners]);
  const warnings = useMemo(() => orderWarnings(draft, owners), [draft, owners]);
  const tradedCount = useMemo(
    () => Object.keys(owners).filter((p) => owners[+p] !== base[+p]).length, [owners, base]);

  const nameOf = (label: string) => (label === MY_TEAM ? "You" : label);
  const tintOf = (label: string) =>
    label === MY_TEAM ? MINE_TINT : TINTS[Math.max(0, labels.indexOf(label) - 1) % TINTS.length];

  /** Re-seat a team, swapping with whoever holds that slot so the order stays a
   *  permutation. Ownership follows the new seating for untraded picks. */
  const setSlot = (team: string, slot: number) => {
    if (!Number.isFinite(slot) || slot < 1 || slot > teams) return;
    const prev = order[team];
    const occupant = Object.keys(order).find((t) => order[t] === slot);
    const next = { ...order, [team]: slot };
    if (occupant && occupant !== team) next[occupant] = prev;
    setOrder(next);
    // Keep explicit trades, re-derive everything else from the new seating.
    const nextBase = baseOwners(
      { ...settings, teams, draftSlot: next[MY_TEAM],
        teamSlots: Object.fromEntries(Object.entries(next).filter(([t]) => t !== MY_TEAM)) },
      rounds);
    setOwners((cur) => {
      const out: PickOwners = { ...nextBase };
      for (const p of Object.keys(cur).map(Number)) {
        if (cur[p] !== base[p] && out[p] != null) out[p] = cur[p];   // a real trade survives
      }
      return out;
    });
  };

  const assign = (pick: number, owner: string) => {
    setOwners((cur) => ({ ...cur, [pick]: owner }));
    setSelected(null);
  };

  const resetPick = (pick: number) => assign(pick, base[pick]);

  const resetAll = () => {
    setOwners(baseOwners(draft, rounds));
    setSelected(null);
  };

  const changeRounds = (n: number) => {
    if (!Number.isFinite(n) || n < 1 || n > 40) return;
    setRounds(n);
    const nextBase = baseOwners(draft, n);
    setOwners((cur) => {
      const out: PickOwners = { ...nextBase };
      for (const p of Object.keys(cur).map(Number)) {
        if (cur[p] !== base[p] && out[p] != null) out[p] = cur[p];
      }
      return out;
    });
  };

  const save = () => {
    const derived = derivePickSettings(draft, owners, rounds);
    onSave({
      ...settings,
      draftSlot: order[MY_TEAM],
      teamSlots: Object.fromEntries(Object.entries(order).filter(([t]) => t !== MY_TEAM)),
      rounds,
      pickOwners: derived.pickOwners,
      myPicks: derived.myPicks,
      teamPicks: derived.teamPicks,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-gray-50">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <ListOrdered className="h-5 w-5 text-gray-500" />
          <div>
            <h1 className="text-sm font-semibold leading-none tracking-tight">Draft order</h1>
            <p className="mt-0.5 font-mono text-xs leading-none text-gray-500">
              {teams} teams · {rounds} rounds · {teams * rounds} picks
              {tradedCount > 0 ? ` · ${tradedCount} traded` : ""}
            </p>
          </div>
          <label className="ml-3 flex items-center gap-1.5 text-xs text-gray-500">
            Rounds
            <input
              type="number" min={1} max={40} value={rounds}
              onChange={(e) => changeRounds(parseInt(e.target.value, 10))}
              className="w-14 rounded border border-gray-300 bg-gray-50 px-1.5 py-0.5 text-right font-mono text-gray-700 focus:border-gray-400 focus:outline-none"
            />
          </label>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <button
              onClick={resetAll}
              className="flex items-center gap-1.5 rounded border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-gray-600 hover:border-gray-300"
              title="Undo every trade and return to plain serpentine order"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset trades
            </button>
            <button
              onClick={save}
              className="flex items-center gap-1.5 rounded border border-emerald-600 bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700"
            >
              <Check className="h-3.5 w-3.5" /> Save order
            </button>
            <button onClick={onClose} className="rounded p-1.5 text-gray-500 hover:bg-gray-200" title="Close without saving">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-4 space-y-4">
        {warnings.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            {warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-amber-900">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                {w.replace(MY_TEAM, "You")}
              </li>
            ))}
          </ul>
        )}

        {/* ── Base order: who drafts where in round 1 ─────────────── */}
        <section className="rounded-lg border border-gray-200 bg-gray-100 p-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-600">Round 1 order</h2>
          <p className="mt-0.5 mb-2 text-xs text-gray-500">
            Each team's seat. Changing one swaps it with whoever sits there; the board below
            re-flows serpentine around it, and any trades you've made stay put.
          </p>
          <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {labels.slice().sort((a, b) => order[a] - order[b]).map((team) => (
              <div key={team} className="flex items-center gap-2 text-xs">
                <span className="w-5 shrink-0 text-right font-mono text-gray-400">{order[team]}.</span>
                <span className={`min-w-0 flex-1 truncate rounded border px-1.5 py-0.5 ${tintOf(team)}`} title={nameOf(team)}>
                  {nameOf(team)}
                </span>
                <select
                  value={order[team]}
                  onChange={(e) => setSlot(team, parseInt(e.target.value, 10))}
                  className="w-16 rounded border border-gray-300 bg-gray-50 px-1 py-0.5 font-mono text-gray-700 focus:border-gray-400 focus:outline-none"
                >
                  {Array.from({ length: teams }, (_, i) => i + 1).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </section>

        {/* ── The board ───────────────────────────────────────────── */}
        <section className="rounded-lg border border-gray-200 bg-gray-100 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-600">Every pick</h2>
            <span className="rounded-full border border-gray-300 bg-gray-50 px-2 py-0.5 text-2xs text-gray-500">
              click a pick to give it to another team
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0.5 text-2xs">
              <thead>
                <tr>
                  <th className="w-8 px-1 text-right font-mono font-normal text-gray-400">rd</th>
                  {Array.from({ length: teams }, (_, i) => i + 1).map((s) => (
                    <th key={s} className="px-1 pb-1 text-center font-normal text-gray-400">
                      <div className="font-mono">{s}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rounds }, (_, r) => r + 1).map((round) => (
                  <tr key={round}>
                    <td className="px-1 text-right align-middle font-mono text-gray-400">{round}</td>
                    {Array.from({ length: teams }, (_, i) => i + 1).map((col) => {
                      // Column = draft seat. In even rounds the seat that picks
                      // first is the last one, so the pick number runs backwards.
                      const inRound = round % 2 === 1 ? col : teams - col + 1;
                      const pick = (round - 1) * teams + inRound;
                      const owner = owners[pick];
                      const traded = owner !== base[pick];
                      const open = selected === pick;
                      return (
                        <td key={col} className="relative p-0 align-top">
                          <button
                            onClick={() => setSelected(open ? null : pick)}
                            className={`w-full rounded border px-1 py-1 text-left leading-tight transition
                              ${tintOf(owner)} ${traded ? "ring-1 ring-gray-900/40" : ""}
                              ${open ? "ring-2 ring-gray-900" : ""} hover:brightness-95`}
                            title={traded
                              ? `Pick ${pick} (${pickLabel(pick, teams)}) — traded from ${nameOf(base[pick])} to ${nameOf(owner)}`
                              : `Pick ${pick} (${pickLabel(pick, teams)}) — ${nameOf(owner)}`}
                          >
                            <span className="flex items-center gap-0.5 font-mono opacity-60">
                              {pickLabel(pick, teams)}
                              {traded && <ArrowLeftRight className="h-2.5 w-2.5" />}
                            </span>
                            <span className="block truncate">{nameOf(owner)}</span>
                          </button>

                          {open && (
                            <div className="absolute left-0 top-full z-20 mt-1 w-44 rounded-lg border border-gray-300 bg-gray-50 p-1 shadow-lg">
                              <div className="px-1.5 py-1 text-2xs text-gray-500">
                                Pick {pick} · {pickLabel(pick, teams)} → give to
                              </div>
                              <div className="max-h-56 overflow-y-auto">
                                {labels.map((team) => (
                                  <button
                                    key={team}
                                    onClick={() => assign(pick, team)}
                                    className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-gray-200
                                      ${team === owner ? "font-semibold text-gray-900" : "text-gray-600"}`}
                                  >
                                    <span className={`h-2 w-2 shrink-0 rounded-full border ${tintOf(team)}`} />
                                    <span className="truncate">{nameOf(team)}</span>
                                    {team === owner && <Check className="ml-auto h-3 w-3" />}
                                  </button>
                                ))}
                              </div>
                              {traded && (
                                <button
                                  onClick={() => resetPick(pick)}
                                  className="mt-1 flex w-full items-center gap-1.5 border-t border-gray-200 px-1.5 pt-1.5 text-xs text-gray-500 hover:text-gray-800"
                                >
                                  <RotateCcw className="h-3 w-3" /> back to {nameOf(base[pick])}
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Who ends up with what ───────────────────────────────── */}
        <section className="rounded-lg border border-gray-200 bg-gray-100 p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-600">Picks by team</h2>
          <div className="space-y-1">
            {labels.slice().sort((a, b) => order[a] - order[b]).map((team) => {
              const mine = team === MY_TEAM;
              const list = held[team] ?? [];
              return (
                <div key={team} className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-1.5 py-1 text-xs ${mine ? "bg-emerald-50" : ""}`}>
                  <span className={`w-36 shrink-0 truncate ${mine ? "font-semibold text-gray-800" : "text-gray-600"}`}>
                    {nameOf(team)}
                  </span>
                  <span className="w-8 shrink-0 font-mono text-gray-400">{list.length}</span>
                  <span className="min-w-0 flex-1 font-mono text-2xs text-gray-500">
                    {list.map((p) => {
                      const traded = owners[p] !== base[p];
                      return (
                        <span key={p} className={traded ? "text-emerald-700 font-semibold" : ""}>
                          {pickLabel(p, teams)}{traded ? "*" : ""}{" "}
                        </span>
                      );
                    })}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-2xs text-gray-400">
            * acquired by trade. Keeper costs and the pick clock use these lists.
          </p>
        </section>
      </div>
    </div>
  );
}

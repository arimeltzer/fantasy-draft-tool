import { useMemo, useState } from "react";
import { X, Lock, Plus, Trash2, AlertTriangle, Search } from "lucide-react";
import { keeperCost, normalizeKeeperRule, validateKeepers } from "@/engine/keeper.js";
import type { BoardPlayer } from "@/engine/valuation-engine.js";
import { LeagueSettings, KeeperCandidate, KeeperImportCache } from "@/lib/api";
import { usePatchLeague } from "@/hooks/useLeague";
import { DraftEntry } from "@/store/draftStore";
import { decodeKeeper, encodeKeeper } from "@/lib/keeperPick";
import { resolveOpponentIndex } from "@/lib/teamMatch";
import { posStyle } from "@/lib/posStyles";
import KeeperAutofill from "./KeeperAutofill";
import YahooPasteImport from "./YahooPasteImport";
import YahooKeeperAutofill from "./YahooKeeperAutofill";
import KeeperRecommendations from "./KeeperRecommendations";

interface Props {
  format: "auction" | "snake";
  leagueId: number;
  settings: LeagueSettings;
  board: BoardPlayer[];
  picks: DraftEntry[];
  addPick: (d: { playerId?: number; mine: boolean; teamId?: number; price?: number; slot?: string }) => Promise<void>;
  removePick: (pickId: number) => Promise<void>;
  onClose: () => void;
}

interface KeeperRow {
  pick: DraftEntry;
  player: BoardPlayer | undefined;
  owner: string;
  base: number | null;
  waiver: number | null;
  fa: boolean;
  kept: number;
  cost: ReturnType<typeof keeperCost>;
}

export default function KeeperPlanner({
  format, leagueId, settings, board, picks, addPick, removePick, onClose,
}: Props) {
  const rule = useMemo(() => normalizeKeeperRule(settings.keeper, format), [settings.keeper, format]);
  const priceBasis = rule.basis === "price";
  const patchLeague = usePatchLeague(leagueId);

  // Persist a fresh ESPN pull into league settings so it survives reloads.
  const cacheImport = (c: KeeperImportCache) =>
    patchLeague.mutate({ settings: { ...settings, keeperImport: c } });

  // Full ESPN candidate list (all teams) from the last auto-fill, so the
  // recommender can predict opponents' keepers.
  const [importedCandidates, setImportedCandidates] = useState<KeeperCandidate[]>([]);

  // Real opponent names when the league has them (import, or typed into
  // League Settings) — falls back to generic labels only when it doesn't.
  // Matters beyond display: predicted/confirmed opponent keepers key off the
  // REAL ESPN/Yahoo team name (see KeeperRecommendations), so a manually
  // -added keeper picked from a generic "Team 2" here would silently fail to
  // match the same team's prediction instead of replacing it.
  const owners = useMemo(() => {
    const real = settings.opponents ?? [];
    return ["Me", ...(real.length
      ? real
      : Array.from({ length: Math.max(0, settings.teams - 1) }, (_, i) => `Team ${i + 2}`))];
  }, [settings.teams, settings.opponents]);

  const opponentNames = useMemo(() => owners.slice(1), [owners]);

  // `DraftPick.team_id` is an index into `settings.opponents[]` — the SAME
  // convention AuctionRoom/SnakeRoom's own winner dropdown already writes.
  // A committed keeper used to omit this entirely: `addPick({ mine: owner
  // === "Me" })` alone marks an opponent keeper as taken (off the board)
  // but attributes it to NO specific team — reported live as "keepers...
  // are just off the board," not on the team that kept them.
  //
  // Fixed once with a plain `owners.indexOf(owner)`, then reported AGAIN as
  // "still isn't correct... unassigned instead of on the right team." Root
  // cause: an owner label from the ESPN keeper-candidates pull (ANY of
  // KeeperAutofill's bulk commit, or KeeperRecommendations' predicted/
  // confirmed list) names a team in a PRIOR season's league, not this one —
  // a manager who renamed their team between seasons makes that string
  // differ from this season's `settings.opponents`, and a plain exact match
  // then silently fails. `resolveOpponentIndex` applies the SAME tiered,
  // refuse-on-ambiguity matching `resolve_my_team_index` already uses
  // server-side for "which team is mine" (exact -> punctuation-folded ->
  // unique substring). The manual "Add a keeper" form's own owner is always
  // picked verbatim from this same `owners` list, so it still resolves on
  // tier 1 exactly as before — this only changes behavior for owner labels
  // from a DIFFERENT source.
  const teamIdFor = (owner: string): number | undefined => {
    if (owner === "Me") return undefined;
    return resolveOpponentIndex(owner, opponentNames);
  };

  const playerById = useMemo(() => new Map(board.map((p) => [p.id as number, p])), [board]);
  const takenIds = useMemo(() => new Set(picks.map((p) => p.playerId).filter(Boolean) as number[]), [picks]);

  const keeperRows: KeeperRow[] = useMemo(() => {
    return picks
      .map((pick) => ({ pick, meta: decodeKeeper(pick.slot) }))
      .filter((x): x is { pick: DraftEntry; meta: NonNullable<ReturnType<typeof decodeKeeper>> } => x.meta != null)
      .map(({ pick, meta }) => ({
        pick,
        player: pick.playerId != null ? playerById.get(pick.playerId) : undefined,
        owner: meta.owner,
        base: meta.base,
        fa: meta.base == null,
        kept: meta.kept ?? 0,
        waiver: meta.waiver ?? null,
        cost: keeperCost({ base: meta.base, waiver: meta.waiver ?? null, fa: meta.base == null, kept: meta.kept ?? 0 }, rule),
      }));
  }, [picks, playerById, rule]);

  // Keepers committed before an import (or before waiver support) carry stale
  // costs — their marker is what's stored, so nothing recomputes on its own.
  // Find the ones the latest ESPN pull would price differently.
  const staleKeepers = useMemo(() => {
    if (importedCandidates.length === 0) return [];
    const byPlayer = new Map(
      importedCandidates.filter((c) => c.player_id != null).map((c) => [c.player_id as number, c]),
    );
    const out: { row: KeeperRow; base: number | null; waiver: number | null; newCost: ReturnType<typeof keeperCost> }[] = [];
    for (const row of keeperRows) {
      const pid = row.pick.playerId;
      const c = pid != null ? byPlayer.get(pid) : undefined;
      if (!c) continue;
      const base = priceBasis ? c.bid : c.round;
      const waiver = priceBasis ? c.waiver : null;
      if (base === row.base && (waiver ?? null) === (row.waiver ?? null)) continue;
      const newCost = keeperCost({ base, waiver, fa: base == null, kept: row.kept }, rule);
      const changed = priceBasis ? newCost.price !== row.cost.price : newCost.round !== row.cost.round;
      if (changed) out.push({ row, base, waiver, newCost });
    }
    return out;
  }, [importedCandidates, keeperRows, priceBasis, rule]);

  // Edit a committed keeper's waiver claim in place (ESPN can't always supply
  // prior-season FAAB, so this is the manual path). Markers aren't patchable,
  // so the pick is re-created with the new value.
  const [editing, setEditing] = useState<{ pickId: number; value: string } | null>(null);
  const saveWaiver = async (row: KeeperRow, raw: string) => {
    setEditing(null);
    const waiver = raw.trim() === "" ? null : Number(raw);
    if (waiver != null && !Number.isFinite(waiver)) return;
    if ((waiver ?? null) === (row.waiver ?? null)) return;
    const cost = keeperCost({ base: row.base, waiver, fa: row.base == null, kept: row.kept }, rule);
    await removePick(row.pick.pickId);
    await addPick({
      playerId: row.pick.playerId as number,
      mine: row.owner === "Me",
      teamId: teamIdFor(row.owner),
      price: priceBasis ? (cost.price ?? undefined) : undefined,
      slot: encodeKeeper({
        k: 1, owner: row.owner, basis: rule.basis, kept: row.kept,
        base: row.base, waiver, round: cost.round ?? undefined,
      }),
    });
  };

  // Manual escape hatch for whatever automatic owner matching can't resolve
  // — a team renamed beyond what `resolveOpponentIndex`'s tiers can follow,
  // or a league whose `settings.opponents` never got real names at all.
  // Reported live, twice, before this existed: "still isn't correct...
  // unassigned instead of on the right team." Same remove+re-add pattern as
  // `saveWaiver` — markers aren't patchable in place.
  const saveOwner = async (row: KeeperRow, newOwner: string) => {
    if (newOwner === row.owner) return;
    await removePick(row.pick.pickId);
    await addPick({
      playerId: row.pick.playerId as number,
      mine: newOwner === "Me",
      teamId: teamIdFor(newOwner),
      price: priceBasis ? (row.cost.price ?? undefined) : undefined,
      slot: encodeKeeper({
        k: 1, owner: newOwner, basis: rule.basis, kept: row.kept,
        base: row.base, waiver: row.waiver, round: row.cost.round ?? undefined,
      }),
    });
  };

  const [refreshing, setRefreshing] = useState(false);
  const refreshCosts = async () => {
    if (staleKeepers.length === 0 || refreshing) return;
    setRefreshing(true);
    try {
      // No API to patch a pick's marker, so re-create each with the new cost.
      for (const { row, base, waiver, newCost } of staleKeepers) {
        await removePick(row.pick.pickId);
        await addPick({
          playerId: row.pick.playerId as number,
          mine: row.owner === "Me",
          teamId: teamIdFor(row.owner),
          price: priceBasis ? (newCost.price ?? undefined) : undefined,
          slot: encodeKeeper({
            k: 1, owner: row.owner, basis: rule.basis, kept: row.kept,
            base, waiver, round: newCost.round ?? undefined,
          }),
        });
      }
    } finally {
      setRefreshing(false);
    }
  };

  const validation = useMemo(
    () => validateKeepers(keeperRows.map((r) => ({ owner: r.owner, base: r.base, fa: r.fa, kept: r.kept })), rule),
    [keeperRows, rule],
  );

  const mySpend = keeperRows
    .filter((r) => r.owner === "Me" && r.cost.price != null)
    .reduce((s, r) => s + (r.cost.price || 0), 0);
  const myRounds = keeperRows
    .filter((r) => r.owner === "Me" && r.cost.round != null)
    .map((r) => r.cost.round as number)
    .sort((a, b) => a - b);

  // ── add form ──────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState("Me");
  const [base, setBase] = useState<string>("");
  const [waiver, setWaiver] = useState<string>("");
  const [fa, setFa] = useState(false);
  const [kept, setKept] = useState(0);
  const [selected, setSelected] = useState<BoardPlayer | null>(null);
  const [saving, setSaving] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return board
      .filter((p) => !takenIds.has(p.id as number))
      .filter((p) => p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q))
      .slice(0, 6);
  }, [query, board, takenIds]);

  const baseNum = base === "" ? null : Number(base);
  const waiverNum = waiver === "" ? null : Number(waiver);
  const preview = selected
    ? keeperCost({ base: fa ? null : baseNum, waiver: waiverNum, fa: fa || baseNum == null, kept }, rule)
    : null;

  const reset = () => { setSelected(null); setQuery(""); setBase(""); setWaiver(""); setFa(false); setKept(0); };

  const add = async () => {
    if (!selected) return;
    setSaving(true);
    const cost = keeperCost({ base: fa ? null : baseNum, waiver: waiverNum, fa: fa || baseNum == null, kept }, rule);
    try {
      await addPick({
        playerId: selected.id as number,
        mine: owner === "Me",
        teamId: teamIdFor(owner),
        price: priceBasis ? (cost.price ?? undefined) : undefined,
        slot: encodeKeeper({
          k: 1, owner, basis: rule.basis, kept,
          base: fa ? null : baseNum,
          waiver: waiverNum,
          round: cost.round ?? undefined,
        }),
      });
      reset();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-b border-line bg-surface shadow-card">
      <div className="mx-auto max-w-6xl px-4 py-5">
        <div className="mb-4 flex items-center gap-2">
          <Lock className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-semibold tracking-tight">Keeper planner</h3>
          <span className="chip border-line bg-raised text-muted">
            {rule.label ?? rule.preset} · {priceBasis ? `+$${rule.priceSurcharge}` : `R${rule.undraftedRound} if FA`} · max {rule.maxKeepers}/team
          </span>
          <button onClick={onClose} className="ml-auto flex items-center gap-1 text-xs text-muted hover:text-ink">
            <X className="h-3.5 w-3.5" /> Close
          </button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          {/* ── Add keeper ─────────────────────────────────────────── */}
          <div>
            <h4 className="eyebrow mb-2">Add a keeper</h4>
            <div className="card p-3">
              {!selected ? (
                <div className="relative">
                  <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-1.5">
                    <Search className="h-3.5 w-3.5 text-faint" />
                    <input
                      autoFocus
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search player to keep…"
                      className="w-full bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
                    />
                  </div>
                  {matches.length > 0 && (
                    <div className="mt-1 overflow-hidden rounded-md border border-line bg-surface shadow-card">
                      {matches.map((p) => {
                        const st = posStyle(p.pos);
                        return (
                          <button
                            key={p.id}
                            onClick={() => setSelected(p)}
                            className={`flex w-full items-center gap-2 border-l-[3px] px-2.5 py-1.5 text-left text-sm hover:bg-hover ${st.accent}`}
                          >
                            <span className={`font-mono text-2xs font-semibold ${st.text}`}>{p.pos}</span>
                            <span className="flex-1 truncate text-ink">{p.name}</span>
                            <span className="font-mono text-2xs text-faint">{p.team}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-2xs font-semibold ${posStyle(selected.pos).text}`}>{selected.pos}</span>
                    <span className="font-medium text-ink">{selected.name}</span>
                    <span className="font-mono text-2xs text-faint">{selected.team}</span>
                    <button onClick={reset} className="ml-auto text-xs text-muted hover:text-ink">change</button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs">
                      <span className="mb-1 block text-muted">Owner</span>
                      <select
                        value={owner}
                        onChange={(e) => setOwner(e.target.value)}
                        className="w-full rounded-md border border-line bg-sunken px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none"
                      >
                        {owners.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </label>

                    <label className="text-xs">
                      <span className="mb-1 block text-muted">
                        {priceBasis ? "Last year's price ($)" : "Round drafted last year"}
                      </span>
                      <input
                        type="number"
                        disabled={fa}
                        value={base}
                        onChange={(e) => setBase(e.target.value)}
                        placeholder={priceBasis ? "e.g. 15" : "e.g. 5"}
                        className="w-full rounded-md border border-line bg-sunken px-2 py-1 text-right font-mono text-sm text-ink focus:border-brand focus:outline-none disabled:opacity-40"
                      />
                    </label>
                  </div>

                  <label className="block text-xs">
                    <span className="mb-1 block text-muted">
                      {priceBasis ? "Waiver / FAAB claim ($, optional)" : "Waiver claim round (optional)"}
                    </span>
                    <input
                      type="number"
                      value={waiver}
                      onChange={(e) => setWaiver(e.target.value)}
                      placeholder={priceBasis ? "e.g. 30" : "e.g. 4"}
                      className="w-full rounded-md border border-line bg-sunken px-2 py-1 text-right font-mono text-sm text-ink focus:border-brand focus:outline-none"
                    />
                    <span className="mt-1 block text-2xs text-faint">
                      If claimed off waivers, the keeper cost is the higher of draft {priceBasis ? "price" : "round"} and this claim.
                    </span>
                  </label>

                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      <input type="checkbox" checked={fa} onChange={(e) => setFa(e.target.checked)} className="h-3.5 w-3.5 accent-brand" />
                      {priceBasis ? "Free agent last year" : "Undrafted / FA last year"}
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      Kept before
                      <input
                        type="number" min={0} value={kept}
                        onChange={(e) => setKept(Math.max(0, Number(e.target.value) || 0))}
                        className="w-14 rounded-md border border-line bg-sunken px-1.5 py-1 text-right font-mono text-ink focus:border-brand focus:outline-none"
                      />
                      yr
                    </label>
                  </div>

                  {preview && (
                    <div className="flex items-center justify-between rounded-md border border-line bg-raised px-3 py-2 text-sm">
                      <span className="text-muted">Keeper cost</span>
                      <span className="font-mono font-semibold text-ink">
                        {preview.basis === "price" ? `$${preview.price}` : `Round ${preview.round}`}
                      </span>
                    </div>
                  )}
                  {preview?.advisory.map((a, i) => (
                    <p key={i} className="flex items-start gap-1.5 text-2xs text-amber-600">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {a}
                    </p>
                  ))}

                  <button
                    onClick={add}
                    disabled={saving}
                    className="btn-brand w-full justify-center px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add keeper
                  </button>
                </div>
              )}
            </div>

            <p className="mt-2 text-2xs text-faint">
              Keepers are removed from the draft pool and seeded onto the board.
              {priceBasis
                ? " Their price counts against budget and drives auction inflation."
                : " Their round is the pick that team forfeits."}
            </p>

            <KeeperAutofill
              rule={rule}
              takenIds={takenIds}
              addPick={addPick}
              teamIdFor={teamIdFor}
              onCandidates={setImportedCandidates}
              source={settings.source}
              cached={settings.keeperImport}
              onCache={cacheImport}
            />

            <YahooKeeperAutofill
              onCandidates={setImportedCandidates}
              cached={settings.keeperImport}
              onCache={cacheImport}
            />

            <YahooPasteImport
              onCandidates={setImportedCandidates}
              currentOpponents={settings.opponents}
              cached={settings.keeperImport}
              onCache={cacheImport}
              onLeagueInfo={({ opponents, draftSlot, teamSlots }) =>
                patchLeague.mutate({
                  settings: {
                    ...settings,
                    opponents,
                    ...(draftSlot ? { draftSlot } : {}),
                    ...(teamSlots ? { teamSlots } : {}),
                  },
                })
              }
            />
          </div>

          {/* ── Current keepers ───────────────────────────────────── */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="eyebrow">Keepers ({keeperRows.length})</h4>
              {priceBasis ? (
                <span className="font-mono text-2xs text-faint">
                  your spend ${mySpend} / ${settings.budget}
                </span>
              ) : myRounds.length > 0 ? (
                <span className="font-mono text-2xs text-faint">
                  you forfeit R{myRounds.join(", R")}
                </span>
              ) : null}
            </div>

            {staleKeepers.length > 0 && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-2xs text-amber-800">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                <span>
                  {staleKeepers.length} keeper{staleKeepers.length === 1 ? " was" : "s were"} saved with an older cost
                  {priceBasis ? " (before waiver claims were pulled)" : ""}.
                </span>
                <button
                  onClick={refreshCosts}
                  disabled={refreshing}
                  className="ml-auto shrink-0 font-medium underline hover:no-underline disabled:opacity-50"
                >
                  {refreshing ? "Updating…" : "Update costs"}
                </button>
              </div>
            )}

            <div className="card divide-y divide-hair">
              {keeperRows.length === 0 && (
                <div className="px-3 py-6 text-center text-xs italic text-faint">No keepers yet.</div>
              )}
              {keeperRows.map((r) => {
                const st = r.player ? posStyle(r.player.pos) : null;
                // The stored marker's owner label can be something that
                // isn't (or isn't anymore) a real option here — a prior
                // season's ESPN name `resolveOpponentIndex` couldn't match
                // at all. A native <select> with no matching <option>
                // silently shows the FIRST one (misleadingly "Me"), so keep
                // the row's actual stored label selectable even when it's
                // stale, rather than letting the dropdown lie about it.
                const ownerOptions = owners.includes(r.owner) ? owners : [r.owner, ...owners];
                return (
                  <div key={r.pick.pickId} className={`flex items-center gap-2 border-l-[3px] px-3 py-2 text-sm ${st?.accent ?? "border-l-transparent"}`}>
                    <select
                      value={r.owner}
                      onChange={(e) => saveOwner(r, e.target.value)}
                      title="Owner — reassign here if this keeper landed on the wrong team"
                      className={`w-20 shrink-0 truncate rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-2xs font-mono font-semibold hover:border-line hover:bg-raised focus:outline-none focus:border-brand ${r.owner === "Me" ? "text-brand" : "text-faint"}`}
                    >
                      {ownerOptions.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                    {r.owner !== "Me" && r.pick.teamId == null && (
                      <span title="Couldn't match this owner to a team in your league (often a team renamed since last season) — pick the right one from the dropdown to the left.">
                        <AlertTriangle className="h-3 w-3 shrink-0 text-amber-600" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-ink">
                      {r.player?.name ?? `#${r.pick.playerId}`}
                      {r.player && <span className="ml-1 font-mono text-2xs text-faint">{r.player.pos}·{r.player.team}</span>}
                    </span>
                    {priceBasis && (
                      editing?.pickId === r.pick.pickId ? (
                        <input
                          autoFocus
                          type="number"
                          value={editing.value}
                          placeholder="w$"
                          onChange={(e) => setEditing({ pickId: r.pick.pickId, value: e.target.value })}
                          onBlur={(e) => saveWaiver(r, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveWaiver(r, (e.target as HTMLInputElement).value);
                            if (e.key === "Escape") setEditing(null);
                          }}
                          className="w-14 rounded-lg border border-brand bg-sunken px-1 py-0.5 text-right font-mono text-2xs text-ink focus:outline-none"
                        />
                      ) : (
                        <button
                          onClick={() => setEditing({ pickId: r.pick.pickId, value: r.waiver?.toString() ?? "" })}
                          className="w-14 rounded-lg px-1 py-0.5 text-right font-mono text-2xs text-faint hover:bg-raised hover:text-ink"
                          title="Waiver / FAAB claim — click to edit"
                        >
                          {r.waiver != null ? `w$${r.waiver}` : "w$ –"}
                        </button>
                      )
                    )}
                    <span
                      className="font-mono text-2xs text-muted"
                      title={r.cost.basis === "price"
                        ? `draft ${r.base != null ? `$${r.base}` : "FA"}${r.waiver != null ? ` · waiver $${r.waiver}` : ""} + $${rule.priceSurcharge}`
                        : `drafted R${r.base ?? rule.undraftedRound}`}
                    >
                      {r.cost.basis === "price" ? `$${r.cost.price}` : `R${r.cost.round}`}
                      {r.waiver != null && r.base != null && r.waiver > r.base && (
                        <span className="ml-1 text-amber-600" title="priced off the waiver claim">w</span>
                      )}
                    </span>
                    <button
                      onClick={() => removePick(r.pick.pickId)}
                      className="rounded-lg p-1 text-faint hover:bg-raised hover:text-rose-600"
                      title="Remove keeper"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>

            {!validation.ok && validation.errors.map((e, i) => (
              <p key={i} className="mt-2 flex items-start gap-1.5 text-2xs text-rose-600">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {e}
              </p>
            ))}
          </div>
        </div>

        <KeeperRecommendations
          format={format}
          settings={settings}
          board={board}
          picks={picks}
          addPick={addPick}
          removePick={removePick}
          importedCandidates={importedCandidates}
        />
      </div>
    </div>
  );
}

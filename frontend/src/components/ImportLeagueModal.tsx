import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { X, Loader2, Check, AlertTriangle, ChevronRight } from "lucide-react";
import { api, ImportReport } from "@/lib/api";

interface Props {
  onClose: () => void;
}

type Provider = "espn" | "yahoo";

export default function ImportLeagueModal({ onClose }: Props) {
  const nav = useNavigate();
  const qc = useQueryClient();

  const [provider, setProvider] = useState<Provider>("espn");
  const [season, setSeason] = useState(2026);
  const [name, setName] = useState("");

  // ESPN
  const [espnId, setEspnId] = useState("");
  const [showPrivate, setShowPrivate] = useState(false);
  const [espnS2, setEspnS2] = useState("");
  const [swid, setSwid] = useState("");
  const [myTeam, setMyTeam] = useState("");

  // Yahoo
  const [yahooKey, setYahooKey] = useState("");
  const [yahooCode, setYahooCode] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [guid, setGuid] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [yahooList, setYahooList] = useState<{ key: string; name: string; season: number; num_teams: number }[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [newId, setNewId] = useState<number | null>(null);

  const connectYahoo = async () => {
    setError("");
    try {
      const { url } = await api.yahooAuthUrl();
      window.open(url, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start Yahoo connect");
    }
  };

  const exchangeYahoo = async () => {
    setError(""); setConnecting(true);
    try {
      const tok = await api.yahooExchange(yahooCode.trim());
      setAccessToken(tok.access_token);
      setGuid(tok.guid);
      // Pull the account's leagues (all seasons) so the user can pick one.
      try {
        const { leagues } = await api.yahooLeagues(tok.access_token);
        setYahooList(leagues);
        if (leagues.length === 1) setYahooKey(leagues[0].key);
        else if (leagues.length === 0) setError("Connected, but Yahoo returned no NFL leagues for this account.");
      } catch (le) {
        setError("Connected, but listing your leagues failed: " +
          (le instanceof Error ? le.message : "error") +
          ". You can still type a league key below.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Yahoo code exchange failed");
    } finally {
      setConnecting(false);
    }
  };

  const loadLeagues = async () => {
    if (!accessToken) return;
    setError("");
    try {
      const { leagues } = await api.yahooLeagues(accessToken);
      setYahooList(leagues);
      if (leagues.length === 0) setError("Yahoo returned no NFL leagues for this account.");
    } catch (e) {
      setError("Listing leagues failed: " + (e instanceof Error ? e.message : "error"));
    }
  };

  const submit = async () => {
    setError(""); setLoading(true); setReport(null);
    try {
      const res = await api.importLeague(
        provider === "espn"
          ? {
              provider, ext_id: espnId.trim(), season, name: name.trim() || undefined,
              espn_s2: espnS2.trim() || undefined, swid: swid.trim() || undefined,
              my_team: myTeam.trim() || undefined,
            }
          : {
              provider, ext_id: yahooKey.trim(), season, name: name.trim() || undefined,
              access_token: accessToken || undefined, my_guid: guid || undefined,
            }
      );
      qc.invalidateQueries({ queryKey: ["leagues"] });
      setReport(res.report);
      setNewId(res.league.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setLoading(false);
    }
  };

  const canSubmit =
    provider === "espn" ? espnId.trim().length > 0
                        : yahooKey.trim().length > 0 && accessToken.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Import a league</h2>
          <button onClick={onClose} className="rounded-md p-1 text-faint hover:bg-raised hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        {report ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              <div className="flex items-center gap-2 font-medium">
                <Check className="h-4 w-4" /> Imported {report.teams} teams
              </div>
              <div className="mt-1 font-mono text-2xs text-emerald-700">
                {report.format} · {report.players_matched} players matched · {report.players_unmatched} unmatched
                {report.mine_found ? " · your team flagged" : " · no “my team” identified"}
              </div>
            </div>
            {report.players_unmatched > 0 && (
              <div className="rounded-lg border border-line bg-sunken p-3">
                <div className="mb-1 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-faint">
                  <AlertTriangle className="h-3 w-3 text-amber-500" /> Unmatched (left off the board)
                </div>
                <div className="max-h-32 overflow-y-auto scroll-tidy text-xs text-muted">
                  {report.unmatched_sample.join(", ")}
                  {report.players_unmatched > report.unmatched_sample.length ? " …" : ""}
                </div>
              </div>
            )}
            <button onClick={() => newId && nav(`/league/${newId}`)} className="btn-brand w-full py-2.5">
              Open league <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* provider toggle */}
            <div className="flex gap-2">
              {(["espn", "yahoo"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setProvider(p)}
                  className={`flex-1 rounded-lg border py-2 text-sm font-medium capitalize transition-colors ${
                    provider === p ? "border-brand bg-brand/10 text-brand" : "border-line bg-surface text-muted hover:bg-raised"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>

            {provider === "espn" ? (
              <>
                <Field label="ESPN League ID" hint="from the URL: …/leagues/THIS_NUMBER">
                  <input className="field" value={espnId} onChange={(e) => setEspnId(e.target.value)} placeholder="123456" />
                </Field>
                <Field label="My team (optional)" hint="team name or id, to flag your roster">
                  <input className="field" value={myTeam} onChange={(e) => setMyTeam(e.target.value)} placeholder="Team Ari" />
                </Field>
                <button onClick={() => setShowPrivate((v) => !v)} className="text-2xs text-muted underline">
                  {showPrivate ? "Hide" : "Private league? Add cookies"}
                </button>
                {showPrivate && (
                  <div className="space-y-3 rounded-lg border border-line bg-sunken p-3">
                    <p className="text-2xs text-faint">Copy from a logged-in espn.com browser session (DevTools → Application → Cookies).</p>
                    <Field label="espn_s2"><input className="field font-mono text-xs" value={espnS2} onChange={(e) => setEspnS2(e.target.value)} /></Field>
                    <Field label="SWID"><input className="field font-mono text-xs" value={swid} onChange={(e) => setSwid(e.target.value)} placeholder="{XXXX-...}" /></Field>
                  </div>
                )}
              </>
            ) : !accessToken ? (
              <div className="space-y-2 rounded-lg border border-line bg-sunken p-3">
                <button onClick={connectYahoo} className="btn-ghost w-full py-2 text-xs">1. Authorize with Yahoo (opens a tab)</button>
                <Field label="2. Paste the code Yahoo gives you" hint="from the redirect URL">
                  <div className="flex gap-2">
                    <input className="field font-mono text-xs" value={yahooCode} onChange={(e) => setYahooCode(e.target.value)} placeholder="auth code" />
                    <button onClick={exchangeYahoo} disabled={!yahooCode.trim() || connecting} className="btn-ghost px-3 text-xs">
                      {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Connect"}
                    </button>
                  </div>
                </Field>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                  <Check className="h-3.5 w-3.5" /> Yahoo connected
                </div>
                {yahooList.length > 0 ? (
                  <Field label="Pick your league" hint="includes past seasons">
                    <select className="field" value={yahooKey} onChange={(e) => setYahooKey(e.target.value)}>
                      <option value="">Select a league…</option>
                      {yahooList.map((l) => (
                        <option key={l.key} value={l.key}>
                          {l.name} — {l.season} ({l.num_teams} tm)
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <>
                    <button onClick={loadLeagues} className="btn-ghost w-full py-2 text-xs">
                      Reload my leagues
                    </button>
                    <Field label="…or enter the league key manually" hint="lowercase L: nfl.l.123456">
                      <input className="field" value={yahooKey} onChange={(e) => setYahooKey(e.target.value)} placeholder="nfl.l.123456" />
                    </Field>
                  </>
                )}
              </>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="Season"><input type="number" className="field" value={season} onChange={(e) => setSeason(Number(e.target.value) || 2026)} /></Field>
              <Field label="Name (optional)"><input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="keep imported" /></Field>
            </div>

            {error && (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</p>
            )}

            <button onClick={submit} disabled={!canSubmit || loading} className="btn-brand w-full py-2.5">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Import league"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted">{label}</span>
        {hint && <span className="text-[10px] text-faint">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

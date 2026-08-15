import { useEffect, useRef, useState } from "react";
import { Check, AlertTriangle, Loader2, X } from "lucide-react";
import { api } from "@/lib/api";
import { saveYahooSession } from "@/lib/yahooAuth";

/**
 * Completes the Yahoo OAuth round trip.
 *
 * Yahoo's redirect URI is the app itself, so consent sends the browser back to
 * a normal app screen with `?code=…` on the URL. That looked exactly like
 * "nothing happened, I'm back where I started" — the code was in the address
 * bar and only a note in a modal (in the *other* tab) said to copy it.
 *
 * Mounted at the app root, this finishes the exchange automatically: swap the
 * code for tokens, store the session, strip the query so a refresh can't
 * replay a spent code, and say so. Storing the session also fires a `storage`
 * event, so a modal left open in the original tab flips to "connected" without
 * the user shuttling anything between tabs.
 *
 * Manually pasting the code still works, and is the fallback if this fails.
 */
export default function YahooCallback() {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const started = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const denied = params.get("error");

    const strip = () => {
      params.delete("code");
      params.delete("error");
      params.delete("error_description");
      params.delete("state");
      const q = params.toString();
      window.history.replaceState({}, "",
        window.location.pathname + (q ? `?${q}` : "") + window.location.hash);
    };

    if (denied) {
      setState("error");
      setMessage(params.get("error_description") || "Yahoo authorization was declined.");
      strip();
      return;
    }
    if (!code || started.current) return;
    started.current = true;   // auth codes are single-use; never exchange twice

    setState("working");
    (async () => {
      try {
        const tok = await api.yahooExchange(code);
        saveYahooSession(tok);
        setState("done");
        setMessage("Yahoo connected — pick your league to import, or open Keepers.");
      } catch (e) {
        setState("error");
        setMessage(
          (e instanceof Error ? e.message : String(e)) +
          " — you can still paste the code manually in the import dialog.");
      } finally {
        // Strip either way: a spent or rejected code must not survive a reload.
        strip();
      }
    })();
  }, []);

  if (state === "idle") return null;

  const tone = state === "error"
    ? "border-rose-300 bg-rose-50 text-rose-800"
    : state === "done"
      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
      : "border-gray-300 bg-gray-50 text-gray-700";

  return (
    <div className={`fixed inset-x-0 top-0 z-[60] mx-auto mt-3 flex w-fit max-w-[92vw] items-center gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg ${tone}`}>
      {state === "working" && <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting to Yahoo…</>}
      {state === "done" && <><Check className="h-3.5 w-3.5" /> {message}</>}
      {state === "error" && <><AlertTriangle className="h-3.5 w-3.5 shrink-0" /> <span>{message}</span></>}
      {state !== "working" && (
        <button onClick={() => setState("idle")} className="ml-1 rounded p-0.5 opacity-60 hover:opacity-100">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

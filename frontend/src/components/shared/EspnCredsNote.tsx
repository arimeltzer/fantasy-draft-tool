import { useEffect, useState } from "react";
import { EspnCreds, clearEspnCreds, loadEspnCreds, onEspnCreds } from "@/lib/espnAuth";

/**
 * "Saved on this device · Forget" line, shown under the espn_s2/SWID inputs.
 *
 * Deliberately shared by all three screens that take these cookies (import,
 * keeper auto-fill, live sync) so the storage is never invisible: anything
 * remembering a credential should say that it is, and offer to stop. Styling is
 * kept neutral (`text-2xs`, muted) because those three screens use three
 * different class conventions; `className` lets each caller nudge it.
 */
export default function EspnCredsNote({ className = "" }: { className?: string }) {
  const [creds, setCreds] = useState<EspnCreds | null>(() => loadEspnCreds());
  useEffect(() => onEspnCreds(setCreds), []);

  if (!creds) return null;
  const when = new Date(creds.savedAt).toLocaleDateString();
  return (
    <p className={`text-2xs text-muted ${className}`}>
      Saved in this browser on {when} — reused for import, keepers and live sync.{" "}
      <button
        type="button"
        onClick={clearEspnCreds}
        className="underline hover:text-ink"
        title="Remove the stored espn_s2/SWID cookies from this browser"
      >
        Forget
      </button>
    </p>
  );
}

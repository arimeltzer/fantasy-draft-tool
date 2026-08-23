import Tip from "@/components/shared/Tip";
import type { ProjBreakdownStep } from "@/engine/valuation-engine.js";

/**
 * Renders the "Proj" number as a Tip whose popup is the waterfall of pipeline
 * stages that produced it (see useBoard.ts's trackStage calls). Falls back to
 * a plain span if a board somehow has no breakdown (e.g. a stale cached
 * player object) so this never throws on an empty array.
 *
 * The popup itself is pointer-events-none (Tip.tsx), so a link inside it
 * wouldn't reliably be clickable — the "what do these mean?" explanation
 * instead lives in the table header, next to Player (see Methodology.tsx).
 */
export default function ProjTip({ steps, value }: { steps: ProjBreakdownStep[] | undefined; value: number }) {
  if (!steps?.length) {
    return <span title="Projected fantasy points this season under your league's scoring">{value}pt</span>;
  }
  const tip = (
    <div className="space-y-1">
      <div className="font-medium text-ink">How this projection was built</div>
      {steps.map((s, i) => (
        <div key={i}>
          <span className="text-muted">{i === 0 ? "" : "→ "}{s.label}: </span>
          <span className="font-mono">{s.value}pt</span>
          {s.detail && <div className="text-faint">{s.detail}</div>}
        </div>
      ))}
    </div>
  );
  return <Tip tip={tip}>{value}pt</Tip>;
}

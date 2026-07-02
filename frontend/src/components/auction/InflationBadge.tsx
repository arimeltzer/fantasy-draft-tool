import { Flame } from "lucide-react";

interface Props { factor: number }

export default function InflationBadge({ factor }: Props) {
  const hot  = factor > 1.05;
  const cold = factor < 0.95;
  const explain = hot
    ? "Teams are overpaying, so the money left chases fewer players — remaining players will cost more than their par value."
    : cold
    ? "Teams are underpaying, so bargains are out there — remaining players should go below par value."
    : "Prices are tracking par values so far.";
  return (
    <div title={`Live inflation multiplier applied to every $Live price. ${explain}`} className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded border font-mono text-xs cursor-help ${
      hot  ? "bg-rose-50 border-rose-200 text-rose-600" :
      cold ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700" :
             "bg-gray-50 border-gray-200 text-gray-600"
    }`}>
      <Flame className="w-3.5 h-3.5" />
      inflation ×{factor.toFixed(2)}
    </div>
  );
}

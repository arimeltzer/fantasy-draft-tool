import { Flame } from "lucide-react";

interface Props { factor: number }

export default function InflationBadge({ factor }: Props) {
  const hot  = factor > 1.05;
  const cold = factor < 0.95;
  return (
    <div className={`hidden items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-xs sm:flex ${
      hot  ? "border-rose-200 bg-rose-50 text-rose-600" :
      cold ? "border-emerald-200 bg-emerald-50 text-emerald-600" :
             "border-line bg-surface text-muted"
    }`}>
      <Flame className="h-3.5 w-3.5" />
      inflation ×{factor.toFixed(2)}
    </div>
  );
}

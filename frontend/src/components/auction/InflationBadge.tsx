import { Flame } from "lucide-react";

interface Props { factor: number }

export default function InflationBadge({ factor }: Props) {
  const hot  = factor > 1.05;
  const cold = factor < 0.95;
  return (
    <div className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded border font-mono text-xs ${
      hot  ? "bg-rose-50 border-rose-200 text-rose-600" :
      cold ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700" :
             "bg-gray-50 border-gray-200 text-gray-600"
    }`}>
      <Flame className="w-3.5 h-3.5" />
      inflation ×{factor.toFixed(2)}
    </div>
  );
}

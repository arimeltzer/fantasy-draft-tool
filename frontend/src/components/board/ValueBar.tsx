import { posStyle } from "@/lib/posStyles";

interface Props {
  pos: string;
  vbd: number;
  maxVbd: number;
}

export default function ValueBar({ pos, vbd, maxVbd }: Props) {
  const st = posStyle(pos);
  const pct = Math.max(2, (Math.max(0, vbd) / Math.max(1, maxVbd)) * 100);
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="w-14 h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div className={`h-full ${st.bar}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-xs text-slate-300 w-9 text-right tabular-nums">{vbd}</span>
    </div>
  );
}

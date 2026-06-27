import { posStyle } from "@/lib/posStyles";

interface Props {
  pos: string;
  vbd: number;
  maxVbd: number;
}

export default function ValueBar({ pos, vbd, maxVbd }: Props) {
  const st = posStyle(pos);
  const pct = Math.max(3, (Math.max(0, vbd) / Math.max(1, maxVbd)) * 100);
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-line">
        <div className={`h-full rounded-full ${st.bar}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-9 text-right font-mono text-xs tnum text-ink">{vbd}</span>
    </div>
  );
}

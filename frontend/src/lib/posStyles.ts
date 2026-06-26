export const POS_STYLES: Record<string, { text: string; dot: string; bar: string; chip: string }> = {
  QB:  { text: "text-rose-300",    dot: "bg-rose-400",    bar: "bg-rose-500/70",    chip: "bg-rose-500/10 text-rose-300 border-rose-500/30" },
  RB:  { text: "text-emerald-300", dot: "bg-emerald-400", bar: "bg-emerald-500/70", chip: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" },
  WR:  { text: "text-sky-300",     dot: "bg-sky-400",     bar: "bg-sky-500/70",     chip: "bg-sky-500/10 text-sky-300 border-sky-500/30" },
  TE:  { text: "text-amber-300",   dot: "bg-amber-400",   bar: "bg-amber-500/70",   chip: "bg-amber-500/10 text-amber-300 border-amber-500/30" },
  K:   { text: "text-violet-300",  dot: "bg-violet-400",  bar: "bg-violet-500/70",  chip: "bg-violet-500/10 text-violet-300 border-violet-500/30" },
  DST: { text: "text-cyan-300",    dot: "bg-cyan-400",    bar: "bg-cyan-500/70",    chip: "bg-cyan-500/10 text-cyan-300 border-cyan-500/30" },
};

export const fallbackStyle = {
  text: "text-slate-300", dot: "bg-slate-400", bar: "bg-slate-500/70",
  chip: "bg-slate-500/10 text-slate-300 border-slate-500/30",
};

export function posStyle(pos: string) {
  return POS_STYLES[pos] ?? fallbackStyle;
}

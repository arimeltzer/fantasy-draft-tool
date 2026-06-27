/**
 * Per-position visual language for the light theme.
 *
 * Each position carries a consistent hue used across the app:
 *  - text   : colored label text
 *  - dot    : small status dot
 *  - bar     : solid value-bar fill
 *  - chip   : pill (light bg + colored text + border)
 *  - accent : left border color used to differentiate each board row
 *  - rail   : faint background tint pairing with the accent on a row
 */
export interface PosStyle {
  text: string;
  dot: string;
  bar: string;
  chip: string;
  accent: string;
  rail: string;
}

export const POS_STYLES: Record<string, PosStyle> = {
  QB: {
    text: "text-rose-600", dot: "bg-rose-500", bar: "bg-rose-500",
    chip: "bg-rose-50 text-rose-700 border-rose-200",
    accent: "border-l-rose-400", rail: "bg-rose-50/60",
  },
  RB: {
    text: "text-emerald-600", dot: "bg-emerald-500", bar: "bg-emerald-500",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
    accent: "border-l-emerald-400", rail: "bg-emerald-50/60",
  },
  WR: {
    text: "text-sky-600", dot: "bg-sky-500", bar: "bg-sky-500",
    chip: "bg-sky-50 text-sky-700 border-sky-200",
    accent: "border-l-sky-400", rail: "bg-sky-50/60",
  },
  TE: {
    text: "text-amber-600", dot: "bg-amber-500", bar: "bg-amber-500",
    chip: "bg-amber-50 text-amber-700 border-amber-200",
    accent: "border-l-amber-400", rail: "bg-amber-50/60",
  },
  K: {
    text: "text-violet-600", dot: "bg-violet-500", bar: "bg-violet-500",
    chip: "bg-violet-50 text-violet-700 border-violet-200",
    accent: "border-l-violet-400", rail: "bg-violet-50/60",
  },
  DST: {
    text: "text-cyan-600", dot: "bg-cyan-500", bar: "bg-cyan-500",
    chip: "bg-cyan-50 text-cyan-700 border-cyan-200",
    accent: "border-l-cyan-400", rail: "bg-cyan-50/60",
  },
};

export const fallbackStyle: PosStyle = {
  text: "text-slate-600", dot: "bg-slate-400", bar: "bg-slate-400",
  chip: "bg-slate-100 text-slate-600 border-slate-200",
  accent: "border-l-slate-300", rail: "bg-slate-50",
};

export function posStyle(pos: string): PosStyle {
  return POS_STYLES[pos] ?? fallbackStyle;
}

import type { Config } from "tailwindcss";

/**
 * Clean, intentional light design system.
 *
 * Neutrals and a handful of semantic surface tokens are defined explicitly so
 * the UI reads as a deliberate light theme (rather than the previous trick of
 * inverting Tailwind's slate scale). Default Tailwind colors are left intact so
 * position accents (rose / emerald / sky / amber / violet / cyan) work normally.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["\"JetBrains Mono\"", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
        xs:   ["0.75rem",   { lineHeight: "1.1rem" }],
        sm:   ["0.8125rem", { lineHeight: "1.25rem" }],
        base: ["0.875rem",  { lineHeight: "1.4rem" }],
        lg:   ["1rem",      { lineHeight: "1.5rem" }],
        xl:   ["1.25rem",   { lineHeight: "1.75rem" }],
        "2xl":["1.5rem",    { lineHeight: "2rem" }],
      },
      colors: {
        // App surfaces — warm "card-forward" palette (roadmap: UI refresh,
        // Direction B). Token NAMES are unchanged from the previous cool-gray
        // palette on purpose, so every existing `bg-paper`/`text-muted`/etc.
        // class across the app repaints for free with no per-usage edits.
        paper:    "#f6f3ee", // page background
        surface:  "#ffffff", // cards, table body
        raised:   "#faf8f4", // panel headers, inset chips
        sunken:   "#f8f4ec", // inputs, wells
        // Lines
        line:     "#e8e1d6", // standard border
        hair:     "#efe9de", // hairline divider
        // Text
        ink:      "#201a12", // primary text
        muted:    "#6b6255", // secondary text
        faint:    "#a49c8c", // tertiary / labels
        // Row shading (zebra)
        stripe:   "#faf7f0", // alternate row tint
        hover:    "#f3ede0", // row hover
        // Brand accents
        brand:    "#0d9488", // snake / primary (teal)
        gold:     "#b45309", // auction (amber-700)
      },
      boxShadow: {
        card: "0 1px 2px rgba(32, 26, 18, 0.05), 0 1px 3px rgba(32, 26, 18, 0.06)",
        pop:  "0 8px 24px rgba(32, 26, 18, 0.08), 0 2px 6px rgba(32, 26, 18, 0.06)",
      },
      borderRadius: {
        xl: "0.75rem",
      },
    },
  },
  plugins: [],
} satisfies Config;

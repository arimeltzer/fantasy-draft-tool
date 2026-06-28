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
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
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
        // App surfaces
        paper:    "#eef1f5", // page background
        surface:  "#ffffff", // cards, table body
        raised:   "#f1f4f8", // table headers, inset chips
        sunken:   "#f8fafc", // inputs, wells
        // Lines
        line:     "#dfe4ea", // standard border
        hair:     "#eaeef3", // hairline divider
        // Text
        ink:      "#16202e", // primary text
        muted:    "#5a6573", // secondary text
        faint:    "#9aa4b2", // tertiary / labels
        // Row shading (zebra)
        stripe:   "#f6f8fb", // alternate row tint
        hover:    "#eaf0f7", // row hover
        // Brand accents
        brand:    "#0d9488", // snake / primary (teal)
        gold:     "#a16207", // auction (amber-700)
      },
      boxShadow: {
        card: "0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06)",
        pop:  "0 8px 24px rgba(16, 24, 40, 0.12), 0 2px 6px rgba(16, 24, 40, 0.08)",
      },
      borderRadius: {
        xl: "0.75rem",
      },
    },
  },
  plugins: [],
} satisfies Config;

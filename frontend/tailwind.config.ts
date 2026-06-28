import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      fontSize: {
        xs:   ['0.8125rem', { lineHeight: '1.25rem' }],
        sm:   ['0.9375rem', { lineHeight: '1.5rem'  }],
        base: ['1.0625rem', { lineHeight: '1.75rem' }],
        lg:   ['1.1875rem', { lineHeight: '1.75rem' }],
        xl:   ['1.3125rem', { lineHeight: '1.875rem'}],
      },
    },
  },
  plugins: [],
} satisfies Config;

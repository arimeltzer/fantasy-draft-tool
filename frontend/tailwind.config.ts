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
      colors: {
        slate: {
          100: '#111827',
          200: '#1f2937',
          300: '#374151',
          400: '#6b7280',
          500: '#9ca3af',
          600: '#d1d5db',
          700: '#4b5563',
          800: '#f3f4f6',
          900: '#f9fafb',
          950: '#ffffff',
        },
        amber: {
          200: '#92400e',
          300: '#b45309',
          400: '#d97706',
        },
        emerald: {
          200: '#065f46',
          300: '#047857',
          400: '#059669',
        },
        rose: {
          300: '#be123c',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;

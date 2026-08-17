import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Separate from vite.config.ts so the dev/build config stays free of test
// concerns, and so `test` is typed (vite's own defineConfig does not know it).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // The engine suites are plain node scripts with their own runner; they are
    // run separately (see CLAUDE.md) and must not be collected here.
    exclude: ["**/node_modules/**", "**/*.selftest.mjs"],
    restoreMocks: true,
  },
});

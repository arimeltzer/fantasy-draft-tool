/* Backward-compatible type shim — mirrors valuation-engine.js.
   All types now live in the split engines; re-export them here so existing
   `@/engine/valuation-engine.js` imports keep resolving to the same types. */
export * from "./engine-core.js";
export * from "./auction-engine.js";
export * from "./snake-engine.js";

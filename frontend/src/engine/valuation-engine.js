/* =====================================================================
   VALUATION ENGINE — backward-compatible re-export shim.
   ---------------------------------------------------------------------
   Logic has been split into format-specific engines:

     engine-core.js    shared VBD pipeline (scoring, projectValue, valueBoard)
     auction-engine.js auctionValues, applyInflation, maxBid, DEFAULT_AUCTION_PARAMS
     snake-engine.js   snakePicks, DEFAULT_SNAKE_PARAMS

   All existing imports from this file continue to work unchanged.
   For new code, import directly from the format-specific engine.
   ===================================================================== */
export * from "./engine-core.js";
export { DEFAULT_AUCTION_PARAMS, auctionValues, applyInflation, maxBid } from "./auction-engine.js";
export { DEFAULT_SNAKE_PARAMS, snakePicks } from "./snake-engine.js";

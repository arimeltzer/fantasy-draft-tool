/**
 * opportunity_parity.mjs — JS side of the opportunity-model parity check.
 *
 * Reads {players, rates, k} as JSON on stdin, runs the SHIPPED
 * projectPointsOpportunity for each player, and prints each result's `proj`
 * (or null on fallback) as JSON. `opportunity_parity.py` drives it and
 * compares against project_points_opportunity().
 */
import { projectPointsOpportunity } from "../frontend/src/engine/projection-opportunity.js";
import { defaultScoring } from "../frontend/src/engine/engine-core.js";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const { players, rates, k, ppr } = JSON.parse(raw);
  const sc = defaultScoring(ppr ?? 0.5);
  const out = players.map((p) => {
    const r = projectPointsOpportunity(p, sc, rates, k);
    return r ? r.proj : null;
  });
  process.stdout.write(JSON.stringify(out));
});

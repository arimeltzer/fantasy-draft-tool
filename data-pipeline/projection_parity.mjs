/* Runs the REAL engine over players on stdin; projection_parity.py compares.
   Reading the shipped module directly is the point — anything else would be a
   second copy that can drift alongside the Python one. */
import { projectPoints, defaultScoring } from "../frontend/src/engine/engine-core.js";

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const { players, ppr, params } = JSON.parse(raw);
  const sc = defaultScoring(ppr);
  const out = players.map((p) => {
    const r = projectPoints(p, sc, params ?? undefined);
    return { proj: r.proj, ageMult: r.ageMult, durMult: r.durMult, rookie: r.rookie };
  });
  process.stdout.write(JSON.stringify(out));
});

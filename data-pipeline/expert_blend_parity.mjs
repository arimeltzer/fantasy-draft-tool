/**
 * expert_blend_parity.mjs — JS side of the expert-blend parity check.
 *
 * Reads {players, W, sc} as JSON on stdin, runs the SHIPPED blendExpertAll,
 * and prints the resulting valuePoints as JSON. `expert_blend_parity.py`
 * drives it and compares against blend_expert().
 */
import { blendExpertAll } from "../frontend/src/engine/engine-core.js";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const { players, W, sc } = JSON.parse(raw);
  const out = blendExpertAll(players, sc, W);
  process.stdout.write(JSON.stringify(out.map((p) => p.valuePoints)));
});

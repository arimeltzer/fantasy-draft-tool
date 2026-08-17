/**
 * anchor_parity.mjs — JS side of the market-anchor parity check.
 *
 * Reads {players, ranks, w} as JSON on stdin, runs the SHIPPED marketAnchor,
 * and prints the resulting valuePoints as JSON. `anchor_parity.py` drives it
 * and compares against blend_with_market().
 *
 * Ranks are passed in explicitly rather than derived from adp/ecr here, so the
 * check isolates the transfer arithmetic from the (separately tested) question
 * of how a rank is chosen.
 */
import { marketAnchor } from "../frontend/src/engine/engine-core.js";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const { players, ranks, w } = JSON.parse(raw);
  const out = marketAnchor(players, w, ranks);
  process.stdout.write(JSON.stringify(out.map((p) => p.valuePoints)));
});

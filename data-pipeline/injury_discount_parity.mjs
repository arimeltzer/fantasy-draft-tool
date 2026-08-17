/**
 * injury_discount_parity.mjs — JS side of the injury-discount parity check.
 *
 * Reads {players, K} as JSON on stdin, runs the SHIPPED applyInjuryDiscount,
 * and prints the resulting valuePoints as JSON. `injury_discount_parity.py`
 * drives it and compares against injury_multiplier().
 */
import { applyInjuryDiscount } from "../frontend/src/engine/engine-core.js";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const { players, K } = JSON.parse(raw);
  const out = applyInjuryDiscount(players, K);
  process.stdout.write(JSON.stringify(out.map((p) => p.valuePoints)));
});

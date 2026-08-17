/**
 * team_change_parity.mjs — JS side of the team-change discount parity check.
 *
 * Reads {players, K} as JSON on stdin, runs the SHIPPED
 * applyTeamChangeDiscount, and prints the resulting valuePoints as JSON.
 * `team_change_parity.py` drives it and compares against apply_flag_discount().
 */
import { applyTeamChangeDiscount } from "../frontend/src/engine/team-context.js";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const { players, K } = JSON.parse(raw);
  const out = applyTeamChangeDiscount(players, K);
  process.stdout.write(JSON.stringify(out.map((p) => p.valuePoints)));
});

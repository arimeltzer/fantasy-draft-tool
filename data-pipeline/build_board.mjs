/* =====================================================================
   build_board.mjs — run the whole chain, end to end
   ---------------------------------------------------------------------
   Reads the JSON from ingest_nflverse.py + projections.py, computes
   strength-of-schedule, runs the valuation engine WITH the SOS multiplier
   applied, and writes the finished outputs your tools consume.

   PREREQS in the same folder:
     valuation-engine.js, strength-of-schedule.js,
     data/{sos_logs,schedule_2026,players_base}.json

   RUN
     node build_board.mjs --data ./data --scoring half-ppr --teams 12 --budget 200

   WRITES
     data/players.json     finished rows your auction/snake tools import
     data/players.csv      same, in the auction tool's paste-in CSV schema
     data/sos.json         { team: { pos: multiplier } }
     data/board_preview.csv the computed board (sanity check)
   + prints a top-40 board to the console.
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";
import {
  defaultScoring, DEFAULT_PARAMS, projectValue, replacementRanks, auctionValues,
} from "./valuation-engine.js";
import {
  adjustedDefenseRatings, regressYoY, buildSosMultipliers, DEFAULT_SOS_PARAMS,
} from "./strength-of-schedule.js";

/* ---- args ---- */
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const DATA = arg("data", "./data");
const ppr = ({ standard: 0, "half-ppr": 0.5, ppr: 1 })[arg("scoring", "half-ppr")] ?? 0.5;
const teams = +arg("teams", 12), budget = +arg("budget", 200);
const superflex = arg("superflex", "") === "true";
const roster = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 7, SF: superflex ? 1 : 0 };
const rosterSize = roster.QB + roster.RB + roster.WR + roster.TE + roster.FLEX + roster.K + roster.DST + roster.BENCH + roster.SF;

const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
const write = (f, obj) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(obj, null, 2));

/* ---- load ---- */
const logs = read("sos_logs.json");
const schedule = read("schedule_2026.json");
const all = read("players_base.json");
const players = all.filter((p) => p.proj && Object.keys(p.proj).length);
if (players.length < all.length) {
  console.log(`  • ${all.length - players.length} players skipped (no proj — run projections.py or ingest with --baseline-proj)`);
}

/* ---- strength of schedule ---- */
const est = regressYoY(adjustedDefenseRatings(logs, DEFAULT_SOS_PARAMS), DEFAULT_SOS_PARAMS);
const sos = buildSosMultipliers(schedule, est, DEFAULT_SOS_PARAMS);

/* ---- valuation, with SOS folded into valuePoints, then VBD ---- */
function boardWithSos(players, league, sc, P, sos) {
  const scored = players.map((pl) => {
    const pv = projectValue(pl, sc, P);
    const m = sos?.[pl.team]?.[pl.pos] ?? 1;
    return { ...pl, ...pv, sosMult: +m.toFixed(3), valuePoints: +(pv.valuePoints * m).toFixed(1) };
  });
  const rep = replacementRanks(league, P);
  const repPts = {};
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    const list = scored.filter((p) => p.pos === pos).sort((a, b) => b.valuePoints - a.valuePoints);
    const idx = Math.max(0, Math.floor(rep[pos]) - 1);
    repPts[pos] = list.length ? (list[Math.min(idx, list.length - 1)]?.valuePoints ?? 0) : 0;
  }
  return scored.map((p) => ({ ...p, vbd: +(p.valuePoints - (repPts[p.pos] ?? 0)).toFixed(1) }))
               .sort((a, b) => b.vbd - a.vbd);
}

const sc = defaultScoring(ppr);
const league = { teams, roster, superflex };
let board = boardWithSos(players, league, sc, DEFAULT_PARAMS, sos);
board = auctionValues(board, { teams, budget, rosterSize }, DEFAULT_PARAMS);

/* ---- outputs ---- */
write("players.json", players);  // raw enriched rows; tools recompute under live settings
write("sos.json", sos);

const C = ["passYd","passTD","int","rushYd","rushTD","rec","recYd","recTD"];
const csvRow = (p) => [
  `"${p.name}"`, p.pos, p.team || "", p.age ?? "",
  ...C.map((k) => p.proj?.[k] ?? 0),
  ...C.map((k) => p.last?.[k] ?? 0), p.last?.gp ?? 0,
].join(",");
const csvHead = ["name","pos","team","age",
  ...C.map((k) => "p_" + k.replace("int","int")), ...C.map((k) => "l_" + k), "l_gp"].join(",");
fs.writeFileSync(path.join(DATA, "players.csv"), [csvHead, ...players.map(csvRow)].join("\n"));

const previewHead = "rank,name,pos,team,age,valuePts,vbd,auction$,sosMult,ecr";
const previewRows = board.map((p, i) =>
  [i + 1, `"${p.name}"`, p.pos, p.team || "", p.age ?? "", p.valuePoints, p.vbd, p.parValue, p.sosMult, p.ecr ?? ""].join(","));
fs.writeFileSync(path.join(DATA, "board_preview.csv"), [previewHead, ...previewRows].join("\n"));

/* ---- console preview ---- */
console.log(`\nSOS-adjusted board — ${teams}-team, ${ppr === 1 ? "PPR" : ppr === 0.5 ? "half-PPR" : "standard"}, $${budget} budget\n`);
console.table(board.slice(0, 40).map((p, i) => ({
  "#": i + 1, name: p.name, pos: p.pos, team: p.team, age: p.age,
  vbd: p.vbd, "$": p.parValue, sos: p.sosMult, ecr: p.ecr ?? "—",
  mkt: p.ecr ? (p.ecr - (i + 1) >= 0 ? `+${(p.ecr - (i + 1)).toFixed(0)}` : (p.ecr - (i + 1)).toFixed(0)) : "—",
})));
console.log(`\n✓ wrote players.json, players.csv, sos.json, board_preview.csv to ${DATA}`);
console.log("  'mkt' = consensus ECR minus your rank. Positive = you value him above the market.");

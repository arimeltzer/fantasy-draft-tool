/* =====================================================================
   STRENGTH OF SCHEDULE  —  common-opponent method, year over year
   ---------------------------------------------------------------------
   Plugs into valuation-engine.js. Produces a per-team, per-position
   multiplier you fold into projectValue(), plus a human-readable
   "common opponents" view for any player.

   WHY THIS AND NOT RAW POINTS-ALLOWED
   A defense's raw fantasy-points-allowed is contaminated by WHICH
   offenses it faced (circular) and barely repeats year to year (noisy).
   We fix the first with an iterative opponent adjustment — the
   whole-league version of "compare through common opponents" — and the
   second with deliberate regression to the mean.

   PIPELINE
     2025 game logs ─► adjustedDefenseRatings()   opponent-adjusted, per position
                              │
                              ▼
                       regressYoY()               pull toward average (defenses are noisy)
                              │
            2026 schedule ─►  buildSosMultipliers()  weighted by fantasy-playoff weeks
                              │
                              ▼
                       { team: { pos: mult } }     → multiply into valuePoints

     + commonOpponents(player)  the literal year-over-year view:
       the defenses on his 2026 slate he ALSO faced in 2025, and how he did.

   HONEST DEFAULTS: SOS is a secondary signal. It is capped at ±6% and
   weighted toward Weeks 15–17 (where leagues are won). Turn the knobs,
   but resist letting schedule outweigh talent — it shouldn't.
   ===================================================================== */

export const DEFAULT_SOS_PARAMS = {
  iterations: 12,            // SRS-style solve; converges fast
  // How much of a 2025 defensive rating carries to 2026. Low on purpose:
  // defensive fantasy-points-allowed is weakly autocorrelated (~0.3–0.4).
  // Scalar, or per-position object e.g. { RB:0.40, WR:0.35, TE:0.30, QB:0.30 }.
  yoyRetention: 0.35,
  sosWeight: 0.5,            // how strongly schedule nudges value
  cap: 0.06,                 // hard limit: SOS moves a player ±6% at most
  playoffWeeks: [15, 16, 17],
  playoffWeight: 1.5,        // those matchups count more
};

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/* ------------------------------------------------------------------ *
 * 1. Opponent-adjusted defense ratings (the common-opponent solve)
 * ------------------------------------------------------------------ *
 * logs: [{ week, off, def, pos, fp }]
 *   fp = fantasy points the OFF's `pos` group scored vs `def`
 *        (i.e., points `def` allowed to `pos`) in that game.
 *
 * Returns per position:
 *   def[pos][team]  = points allowed to `pos` ABOVE league average,
 *                     after removing the strength of offenses faced.
 *                     >0 = soft matchup (good for the offense).
 *   off[pos][team], leagueAvg[pos]
 * ------------------------------------------------------------------ */
export function adjustedDefenseRatings(logs, params = DEFAULT_SOS_PARAMS) {
  const positions = [...new Set(logs.map((l) => l.pos))];
  const teams = [...new Set(logs.flatMap((l) => [l.off, l.def]))];
  const out = { def: {}, off: {}, leagueAvg: {} };

  for (const pos of positions) {
    const rows = logs.filter((l) => l.pos === pos);
    const lg = mean(rows.map((r) => r.fp));
    const off = Object.fromEntries(teams.map((t) => [t, 0]));
    const def = Object.fromEntries(teams.map((t) => [t, 0]));

    for (let it = 0; it < params.iterations; it++) {
      const nOff = {}, nDef = {};
      for (const t of teams) {
        const og = rows.filter((r) => r.off === t);
        nOff[t] = og.length ? mean(og.map((r) => r.fp - lg - def[r.def])) : 0;
        const dg = rows.filter((r) => r.def === t);
        nDef[t] = dg.length ? mean(dg.map((r) => r.fp - lg - off[r.off])) : 0;
      }
      // center so adjustments are identifiable (sum ≈ 0 = league average)
      const mO = mean(Object.values(nOff)), mD = mean(Object.values(nDef));
      for (const t of teams) { off[t] = nOff[t] - mO; def[t] = nDef[t] - mD; }
    }
    out.def[pos] = def; out.off[pos] = off; out.leagueAvg[pos] = +lg.toFixed(2);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. Year-over-year regression
 * ------------------------------------------------------------------ *
 * Pull each 2025 rating toward 0 (league average). Optionally blend a
 * prior-year solve for stability (recency-weighted).
 * ------------------------------------------------------------------ */
export function regressYoY(ratings, params = DEFAULT_SOS_PARAMS, priorRatings = null, priorWeight = 0.25) {
  const ret = params.yoyRetention;
  const get = (pos) => (typeof ret === "object" ? (ret[pos] ?? 0.35) : ret);
  const out = { def: {}, leagueAvg: ratings.leagueAvg };
  for (const pos in ratings.def) {
    out.def[pos] = {};
    for (const team in ratings.def[pos]) {
      let r = ratings.def[pos][team];
      if (priorRatings?.def?.[pos]?.[team] != null) {
        r = (1 - priorWeight) * r + priorWeight * priorRatings.def[pos][team];
      }
      out.def[pos][team] = +(r * get(pos)).toFixed(3);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 3. Per-team SOS multipliers from the 2026 schedule
 * ------------------------------------------------------------------ *
 * schedule: { TEAM: [{ week, opp }, ...] }
 * Returns:  { TEAM: { pos: multiplier } }, centered at 1.0
 * ------------------------------------------------------------------ */
export function buildSosMultipliers(schedule, est, params = DEFAULT_SOS_PARAMS) {
  const out = {};
  for (const team in schedule) {
    out[team] = {};
    for (const pos in est.def) {
      let acc = 0, w = 0;
      for (const g of schedule[team]) {
        const wt = params.playoffWeeks.includes(g.week) ? params.playoffWeight : 1;
        acc += wt * (est.def[pos][g.opp] ?? 0); // opponent's softness vs this position
        w += wt;
      }
      const sosScore = w ? acc / w : 0;
      const rel = est.leagueAvg[pos] ? sosScore / est.leagueAvg[pos] : 0;
      let m = 1 + rel * params.sosWeight;
      m = Math.min(1 + params.cap, Math.max(1 - params.cap, m));
      out[team][pos] = +m.toFixed(3);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4. The literal "common opponents, year over year" view (per player)
 * ------------------------------------------------------------------ *
 * playerLogs: [{ week, opp, fp }]   the player's 2025 games
 * teamSchedule: [{ week, opp }]     his team's 2026 slate
 * Returns the defenses he'll see AGAIN, what he did last time, and the
 * opponent-adjusted, regressed estimate for this year.
 * ------------------------------------------------------------------ */
export function commonOpponents(playerLogs, teamSchedule, est, pos) {
  const slate = new Set(teamSchedule.map((g) => g.opp));
  const rows = playerLogs
    .filter((l) => slate.has(l.opp))
    .map((l) => ({ opp: l.opp, fp2025: l.fp, adjEst: +(est.def?.[pos]?.[l.opp] ?? 0).toFixed(2) }))
    .sort((a, b) => b.fp2025 - a.fp2025);
  return { games: rows, count: rows.length, avgFp: +mean(rows.map((r) => r.fp2025)).toFixed(1) };
}

/* ------------------------------------------------------------------ *
 * 5. INTEGRATION into valuation-engine.js  (≈ two lines)
 * ------------------------------------------------------------------ *
 *   // pass the multiplier map through:
 *   export function projectValue(player, sc, P, sos = null) {
 *     ...
 *     const ageMult = ageMultiplier(player.pos, player.age, P);
 *     const sosMult = sos?.[player.team]?.[player.pos] ?? 1;          // <— add
 *     const valuePoints = +((projPts + correction) * ageMult * sosMult).toFixed(1);  // <— mult in
 *     ...
 *   }
 *   // then thread `sos` through valueBoard(players, league, sc, P, sos).
 * The SOS map flows into BOTH the snake and auction tools unchanged.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * DEMO — tiny 6-team league, one position, so you can watch it work.
 * Call demo() in Node or a scratch file.
 * ------------------------------------------------------------------ */
export function demo() {
  const logs = [
    // off, def, fp (RB points the offense scored vs that defense)
    { week: 1, off: "ATL", def: "CAR", pos: "RB", fp: 28 },
    { week: 2, off: "ATL", def: "NO",  pos: "RB", fp: 22 },
    { week: 3, off: "ATL", def: "TB",  pos: "RB", fp: 12 },
    { week: 1, off: "SF",  def: "TB",  pos: "RB", fp: 9  },
    { week: 2, off: "SF",  def: "CAR", pos: "RB", fp: 31 },
    { week: 3, off: "SF",  def: "NO",  pos: "RB", fp: 18 },
    { week: 1, off: "TB",  def: "ATL", pos: "RB", fp: 14 },
    { week: 2, off: "TB",  def: "SF",  pos: "RB", fp: 7  },
    { week: 3, off: "TB",  def: "ATL", pos: "RB", fp: 16 },
    { week: 1, off: "CAR", def: "SF",  pos: "RB", fp: 6  },
    { week: 2, off: "CAR", def: "ATL", pos: "RB", fp: 19 },
    { week: 3, off: "NO",  def: "ATL", pos: "RB", fp: 24 },
    { week: 1, off: "NO",  def: "SF",  pos: "RB", fp: 11 },
  ];
  const ratings = adjustedDefenseRatings(logs);
  const est = regressYoY(ratings);
  const schedule = {
    ATL: [{ week: 1, opp: "CAR" }, { week: 15, opp: "TB" }, { week: 16, opp: "SF" }],
  };
  const sos = buildSosMultipliers(schedule, est);

  console.log("adjusted RB def (raw 2025):", ratings.def.RB);
  console.log("regressed estimate for 2026:", est.def.RB);
  console.log("ATL SOS multiplier (RB):", sos.ATL.RB);
  console.log(
    "Bijan common opponents:",
    commonOpponents(
      [{ week: 1, opp: "CAR", fp: 28 }, { week: 3, opp: "TB", fp: 12 }, { week: 9, opp: "SF", fp: 20 }],
      schedule.ATL, est, "RB"
    )
  );
  return { ratings, est, sos };
}

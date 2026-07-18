# Valuation Methodology & Data Sourcing

A self-contained description of how the Fantasy Draft Assistant turns raw data
into player values, written so it can be analyzed independently of the code.
Source of truth: `frontend/src/engine/valuation-engine.js` and
`frontend/src/engine/strength-of-schedule.js`.

> **Where it runs.** All player-value math (blend, age, VBD, tiers, auction
> prices, inflation, and applying the SOS multiplier) runs **client-side in the
> browser** (`frontend/src/hooks/useBoard.ts`). The cloud database only stores
> *inputs*: player projection/last-season stat lines, ECR/ADP, the precomputed
> SOS multipliers, schedule, game logs, and the user's leagues/picks.

---

## 1. Data sources

| Field | Source | Notes |
|---|---|---|
| Player universe, teams, ages | nflverse (`ingest_nflverse.py`) | players who matter for fantasy |
| `last` (prior-season actual stat line + games played) | nflverse weekly/season stats | per-game pace basis |
| `proj` (this-season projected stat line) | **FantasyPros API** (auto when `FANTASYPROS_API_KEY` is set) or a projections CSV (`projections.py --proj-csv`); else the ingest baseline | component stats (pass/rush/rec yds, TDs, etc.) |
| `ecr` (expert consensus rank), `adp` | FantasyPros — free nflverse `load_ff_rankings()`, or the FantasyPros API (`fantasypros.py`, scoring-aware) | market baseline |
| Schedule (2026 opponents per week) | nflverse | drives SOS |
| Game logs (2025 weekly fantasy pts vs each defense) | nflverse | drives SOS opponent adjustment |

The pipeline writes JSON → `load_to_db.py` upserts into Postgres → the API serves
it → the browser computes values.

## 2. Scoring

Configurable PPR (0 / 0.5 / 1.0). A stat line → fantasy points:
`passYd*0.04 + passTD*4 + int*(-2) + rushYd*0.1 + rushTD*6 + rec*PPR + recYd*0.1
+ recTD*6 + fumbles*(-2)`. K/DST may carry a pre-scored `pts`.

## 3. Player value blend (the core forecast)

For each player:
1. **Projection points** `projPts` = score(`proj`) under league scoring.
2. **Prior-season pace** `priorEquiv` = (score(`last`) / gamesPlayed) × `projectedGames`
   — last year normalized to a full season (so injuries/partial years aren't
   over-punished). Rookies / no prior → `priorEquiv = null`.
3. **Blend (correction toward last year):**
   `correction = priorWeight × (1 − regressionStrength) × (priorEquiv − projPts)`
   `blended = projPts + correction`
   - `priorWeight` = how much last year's pace pulls the projection.
   - `regressionStrength` = mean-reversion damping (outlier seasons are partly luck).
4. **Age multiplier** (see §4): `valuePoints = blended × ageMult`.

So a player's value starts at the projection and is nudged toward last year's
full-season pace, damped for regression, then scaled by an age curve.

## 4. Age curve

Per position, value holds until `declineStart`, then drops `declinePerYear`/yr;
young players at/under `youthPeak` get a small `youthBonus`. Clamped to
`ageClamp` so it never runs away.

| Pos | declineStart | declinePerYear | youthPeak | youthBonus |
|---|---|---|---|---|
| QB | 35 | 0.03 | — | — |
| RB | 27 | 0.05 | 23 | +0.03 |
| WR | 30 | 0.03 | 24 | +0.02 |
| TE | 31 | 0.03 | 25 | +0.02 |
| K/DST | none | 0 | — | — |

`ageClamp = [0.85, 1.06]`.

## 5. Risk (0–1, informational)

`risk = min(1, 0.5·divergence + 0.3·injury + 2·max(0, ageDecline))`
- `divergence` = |priorEquiv − projPts| / projPts (forecast disagreement)
- `injury` = fraction of last season missed
- `ageDecline` = 1 − ageMult once past the decline age

## 6. Replacement level & VBD

VBD = a player's value above a replacement-level player at the same position.
Replacement rank per position = `teams × starters_at_pos`, plus a share of FLEX
spread across RB/WR/TE by `flexShare` = **RB 0.50 / WR 0.42 / TE 0.08**.
Superflex adds `teams × SF` to the QB pool. The replacement value is the
`valuePoints` of the player at that rank; `vbd = valuePoints − replacementValue`.
The board is sorted by VBD.

## 7. Tiers

Within QB/RB/WR/TE, sort by VBD and start a new tier whenever the VBD gap to the
previous player exceeds **18 points** (a heuristic "cliff" detector).

## 8. Strength of schedule (SOS)

A per-team, per-position multiplier (centered at 1.0) folded into `valuePoints`.

**Method (common-opponent / SRS-style):**
1. **Opponent-adjusted defense ratings** from last season's game logs: iteratively
   solve for how many fantasy points each defense allows to each position *above
   league average, after removing the strength of offenses faced* (12 iterations,
   re-centered each pass). This de-contaminates raw points-allowed.
2. **Year-over-year regression:** shrink each rating toward the mean by
   `yoyRetention` (defense quality barely repeats; see tuning below).
3. **Build multipliers** from the 2026 schedule: weight each opponent's softness
   by week (playoff weeks 15–17 ×`playoffWeight`), normalize by league average,
   scale by `sosWeight`, and clamp to ±`cap`.

**Empirical tuning (10 seasons, 2015–2024, out-of-sample — see
`data-pipeline/SOS_TUNING_RESULTS.md`):**
- `yoyRetention` is the MSE-optimal shrink (regression slope of this-year on
  last-year softness): **QB 0.30, RB 0.30, WR 0.26, TE 0.11** (TE defense is
  ~noise year to year). Overall predictive skill is modest: Pearson r ≈ 0.27.
- A full season of schedule moves a player **≤3%** even at calibrated weights, so
  SOS is deliberately a *secondary* signal.
- `sosWeight = 0.8`, `cap = 0.04`, `playoffWeight = 1.2` (weeks 15–17 are *less*
  predictable from last year, so the playoff tilt is mild).

## 9. Auction values

From VBD:
- Every drafted slot costs at least `minBid = $1`. Total discretionary money =
  `teams×budget − totalRosterSpots×$1`.
- Each positive-VBD player's **par value** = `$1 + (player.vbd / Σ positive vbd) ×
  discretionary`. Non-positive-VBD players = `$1`.
- **Live inflation:** as real winning bids are entered, remaining money is
  repriced against remaining par value: `factor = remainingDiscretionary /
  remainingParDiscretionary`; each undrafted player's live price =
  `$1 + (par − $1) × factor`. >1 = the room is overpaying (your targets cost more).
- **Max bid** = `budgetLeft − (openSpots − 1) × $1`.

## 10. Snake pick timing

`snakePicks(slot, teams)` returns the overall pick numbers a draft slot owns
across rounds (serpentine order), used to show "you're up in N picks" and to
drive need-based recommendations.

## 10a. Keepers

A keeper is a player retained from last season instead of entering the draft.
The league's keeper rule (`frontend/src/engine/keeper.js`) turns last year's cost
into this year's cost:

- **Price basis (ESPN-style):** `thisPrice = lastPrice + priceSurcharge`
  (default +$7; a FA keeper costs the surcharge, min $1). `maxKeepers` default 3.
- **Round basis (Yahoo-style):** `thisRound = lastRound − roundInflation × yearsKept`
  (default no escalation; a FA keeper costs `undraftedRound`, default R13).
  `maxKeepers` default 1, with a `noConsecutive` advisory (can't keep two years
  running).

Keepers seed the board as pre-filled picks: the player leaves the pool, an
auction keeper's price counts against that team's budget and feeds inflation
(§9), and a snake keeper's round is the pick that team forfeits. All keeper math
is client-side like the rest of the engine.

Base costs can be entered by hand or **auto-filled from ESPN**: the planner reads
a prior-season ESPN league's draft (auction bid / snake round per player) and
maps it to the current pool, pre-filling each keeper's base cost. The keeper
*rule* (surcharge, undrafted round, escalation, max) still comes from your league
settings — the provider supplies only what was paid, not your league's policy.

### 10b. Keeper selection recommendation (`keeperReco.js`)

Which keepers to *keep* is scored as **KV = surplus + scarcity + fit**:

- **Surplus over the resource's alternative use**, not raw value:
  - *Auction:* `surplus = inflation-adjusted market value − keeper price`.
  - *Snake:* `surplus = VBD(kept) − VBD(the player you'd actually get at the pick
    you forfeit)`. The forfeited overall pick is **draft-slot specific** — it
    comes from the serpentine schedule (`snakePicks(draftSlot, teams)`), so slot 1
    forfeiting round 3 gives up pick 25 while slot 12 gives up pick 36. Who's
    available there is read off a **market draft order** (ADP → ECR → our rank)
    with every team's keepers removed from the pool.
- **Scarcity:** the VBD cliff from the player to the next *available* player at his
  position — amplified on the **wheel** (slots near the ends, where longer gaps
  between your picks make positional runs bite harder). **Snake only** — in an
  auction, scarcity is already priced into the market/par value (you can re-buy a
  scarce player for money), so it is *not* added to auction KV (which would also
  be a unit mismatch: dollars vs. fantasy points). Auction KV = surplus + fit.
- **Fit:** a small nudge toward filling starter slots, against overloading one
  position.

The set is chosen by enumerating every subset up to the keeper max, charging each
snake keeper a **distinct** forfeited pick (a second keeper in the same round
costs an earlier, better pick), and including a candidate only when its marginal
KV clears a tunable **flexibility floor** — so the recommendation can be **fewer
than the max, or none**. Outputs a keep/hold verdict per candidate plus a
draft-impact summary. It is a decision aid (a projection of a chaotic event), and
the snake pick-value depends on ADP coverage (board-rank fallback where thin).

**Predicting opponents' keepers.** From the ESPN import (every team's final
roster + each player's draft cost), `predictOpponentKeepers` assumes each
opponent keeps their best-value players — the same surplus logic, up to the
league max — and removes them from the availability/market pool. That makes your
own numbers honest: the stud on another roster who's an obvious keep won't be
counted as available at your forfeited pick, and the auction market reflects who
never enters the draft. Opponents' draft slots are unknown, so their snake
surplus is scored against a slot-agnostic mid-round pick. Predictions are a
heuristic and are shown in the UI with per-player overrides.

## 11. Current parameter reference

```jsonc
// valuation-engine.js DEFAULT_PARAMS
priorWeight: 0.35,
regressionStrength: 0.25,
projectedGames: 17,
ageClamp: [0.85, 1.06],
flexShare: { RB: 0.50, WR: 0.42, TE: 0.08 },
auction: { minBid: 1 },
tierGap: 18,                 // (inline constant in valueBoard)

// strength-of-schedule.js DEFAULT_SOS_PARAMS (empirically tuned)
iterations: 12,
yoyRetention: { QB: 0.30, RB: 0.30, WR: 0.26, TE: 0.11 },
sosWeight: 0.8,
cap: 0.04,
playoffWeeks: [15, 16, 17],
playoffWeight: 1.2,
```

## 12. Known limitations / things worth scrutinizing

- **Projection quality is the ceiling.** Values are only as good as `proj`. If
  `proj` is a thin baseline rather than real expert projections, the blend leans
  heavily on last-year pace. (FantasyPros projections CSV / API improves this.)
- **`priorWeight` / `regressionStrength` are not empirically tuned** — tuning them
  needs archived *projections* for past years, which we don't have. Only SOS is
  backtested.
- **Age curves are heuristics**, not fit to data.
- **`flexShare` and the tier gap (18)** are hand-chosen heuristics.
- **Replacement level** uses a static flex split; it doesn't re-solve as positions
  are drafted (the live board hides drafted players but replacement ranks are
  computed on the full pool).
- **SOS signal is genuinely small** (≤3% season swing, r≈0.27) — by design, but
  worth confirming it's weighted appropriately for your league.
- **Risk is informational** and does not feed back into value or VBD.

---

*To analyze the algorithm, this document plus the two engine files
(`valuation-engine.js`, `strength-of-schedule.js`) are fully self-contained.*

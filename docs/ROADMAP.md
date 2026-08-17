# ROADMAP — from a good pricing engine to a championship engine

Written after an audit of the shipped tool (see "Where this came from" at the
end). Ordered by expected championship impact per unit of work, and gated so
that work which does not pay off gets **stopped rather than shipped**.

## How to use this document

Each step below has a **Prompt** — paste it verbatim into a session. It names
the step so the session can read the full context here rather than relying on
what fits in a chat message.

Two rules that apply to every step, and exist because this project has already
been burned by both:

1. **Every step has a KILL GATE — a number, fixed in advance, that decides
   whether the work ships.** The v2 touchdown-regression experiment raised the
   model's incremental signal 10–25% and moved the actual board by +0.003
   Spearman. It was correctly *not* shipped. Deciding the bar afterwards is how
   a tool accumulates changes that feel like progress and aren't.
2. **Nothing ships without the measurement describing the thing that ships.**
   `projection_parity.py` and `anchor_parity.py` exist because a port that
   quietly disagrees with the code it was validated against measures a fiction.
   Any new Python/JS duplication needs the same treatment.

---

## The two findings that drive the whole plan

**A. The projection is the weak link, and it ignores data already in the
database.** Measured on 2017–2025 (matched population, Spearman vs actual
season points):

| | QB | RB | TE | WR |
|---|---|---|---|---|
| Shipped model | 0.497 | 0.551 | 0.472 | 0.594 |
| Plain ADP | **0.648** | **0.652** | **0.535** | **0.650** |

The market beats the model at every position. And `projectPoints` reads
`player.proj` — the FantasyPros expert projection the pipeline downloads and
stores — **only in the rookie branch**. Every veteran is projected from their
own box scores while an expert forecast sits unused in the same row.

**B. The objective function is wrong.** Everything is a point estimate and the
implicit goal is "maximize expected season points". Championships are won by
maximizing **P(finish 1st)**, which is convex in outcomes — variance has option
value that a mean cannot express.

Phases 1 and 2 attack these. Everything else is downstream.

---

## Phase 0 — Cheap wins, days not weeks

### 0.1 Use the expert projection for veterans — DONE, shipped

The data is already in Postgres. Blend `player.proj` with the model's own
pace-based estimate and sweep the weight, exactly as the market anchor was
swept. Likely finding: the expert projection should dominate, with the model
contributing on players the experts don't cover.

**Kill gate**: matched-population Spearman must beat 0.497 / 0.551 / 0.472 /
0.594 at **every** position, AND the full-board merged number must beat the
current 0.7554 / 0.7364 / 0.7240 / 0.7564. If the expert projection only
duplicates what market anchoring already extracts, the merged number will not
move — and then this does not ship.

**RESULT.** Backtested 2019–2025 (`projection-backtest.yml` #32032864146).
Both halves of the gate cleared at every position:

| | matched (vs gate) | merged (vs gate) | best weight on our model |
|---|---|---|---|
| QB | 0.6358 vs 0.4970 **PASS** | 0.7858 vs 0.7554 **PASS** | 0.3 |
| RB | 0.6921 vs 0.5510 **PASS** | 0.7732 vs 0.7364 **PASS** | 0.2 |
| TE | 0.5606 vs 0.4720 **PASS** | 0.7680 vs 0.7240 **PASS** | 0.2 |
| WR | 0.6681 vs 0.5940 **PASS** | 0.7765 vs 0.7564 **PASS** | 0.4 |

Unlike the market anchor, the per-position optimum here is NOT flat across
positions (QB and WR sit more than a full weight-step apart), so this shipped
as four separate weights (`EXPERT_BLEND_W` in `engine-core.js`), not one
shared constant. Wired into `useBoard.ts`:
`projectAll -> blendExpertAll -> SOS -> marketAnchor -> finalizeBoard`.
Rookies are skipped (already used `player.proj` first, at higher priority).
`expert_blend_parity.py` holds the shipped JS to the backtested Python,
equality not tolerance — same treatment `anchor_parity.py` gives the anchor.

### 0.2 Collapse the overfit snake slot configs — DONE, collapsed

`DEFAULT_SNAKE_PARAMS.SLOTS` carries ~8 parameters for each of 10 draft slots,
grid-searched on five seasons. That is a lot of knobs for very little data, and
it is the same failure mode avoided when the market anchor used one weight
instead of four fitted ones.

**Kill gate**: leave-one-season-out, per-slot configs must beat a single shared
config. Keep per-slot tuning only for slots where it survives out of sample;
collapse the rest.

**RESULT.** The grid search behind those configs was never in this repo, so
they could not be re-run — `draft-sim.mjs` was built to test them out of sample
instead, replaying identical leagues and changing only the config:

| | drafts | mean diff | mean/SE |
|---|---|---|---|
| 2021–2025 (fitted) | 1,200 | **+10.67** | 4.24 — real |
| 2017–2020 (held out) | 960 | **+2.53** | 1.16 — noise |

Better exactly where tuned, indistinguishable elsewhere. `SLOTS` is now `{}`;
the lookup remains so a config that earns its place can return. Note this
step cost a week, not the "days" estimated above — the estimate assumed a
tuning harness that did not exist. That harness is Phase 3's, built early.

### 0.3 Injury-aware expected games

`InjuryBadge` reports status but valuation ignores it. Convert status into
expected games missed and apply it to the projection.

**Precondition, checked first**: `injury_probe.py` — does FantasyPros'
injuries endpoint even serve a real, DATED report for a past season, or just
today's live status regardless of `year`? The endpoint is a flat URL (year as
a query param, not in the path like projections/rankings), and the only place
this project called it before now always passed the current season — so this
was unverified, not assumed safe. **Result**: 6 of 7 tested seasons
(2019–2025) verdict "genuine dated report" — distinct fingerprint per season
(no staleness) and a positive games-missed gap (flagged players missed more
games that season than the field) at every single season tested, including
the one that missed the roster-match threshold. Precondition cleared.

**Kill gate**: per position, sweep `k` (scales `INJURY_GAMES_MISSED`, k=0 =
shipped/no discount). PASSES only if, at the best `k > 0`:
  - `spearman_total` improves by more than 0.002 over k=0 (the target that
    counts missed games — the point of the feature), **and**
  - `spearman_pace` does not drop by more than 0.002 from k=0 (per-game rate
    with availability removed — this must NOT move, or the discount is really
    just re-discovering `durabilityMult`, which already lives downstream of
    `pace`).
0.002 is noise-sized — the same order of magnitude already visible between
repeated runs elsewhere in this file — so smaller moves in either direction
don't count. Ships **per position**: a position that fails is left on
`durabilityMult` alone rather than given a discount that didn't earn it there.

**RESULT — DONE, shipped for QB/RB only.** Swept 2017–2025
(`projection-backtest.yml` #32046618135), k scales `INJURY_GAMES_MISSED`
(out=6, doubtful=2, questionable=0.5 games):

| pos | best k | total (vs k=0) | pace (vs k=0) | verdict |
|---|---|---|---|---|
| QB | 0.5 | 0.7046 vs 0.6950 (better) | 0.6560 vs 0.6572 (held) | **PASS** |
| RB | 0.5 | 0.6975 vs 0.6916 (better) | 0.7212 vs 0.7220 (held) | **PASS** |
| TE | — | 0.7113 vs 0.7113 (no k cleared) | 0.7172 vs 0.7172 | FAIL |
| WR | — | 0.7380 vs 0.7380 (no k cleared) | 0.7589 vs 0.7589 | FAIL |

At every k>0 tried, TE and WR's `spearman_pace` degraded past the 0.002 gate
before `spearman_total` improved past it — the discount there would have been
re-discovering `durabilityMult`, exactly the failure mode the gate was
written to catch. QB and RB clear both halves cleanly at k=0.5. Shipped as
`INJURY_K = { QB: 0.5, RB: 0.5, WR: 0, TE: 0, K: 0, DST: 0 }` in
`engine-core.js`, applied right after `projectAll()` (same pipeline stage
`durabilityMult` already occupies), before the expert blend / SOS / anchor.
`injury_discount_parity.py` holds the shipped JS to the backtested Python.

Precondition itself is worth restating: this only worked because
`injury_probe.py` was run FIRST, given the injuries endpoint's URL shape
(flat, year as a query param) gave real reason to suspect it might not serve
real historical data the way projections/rankings do. It did.

---

## Phase 1 — Rebuild the projection on opportunity

Points are volume × efficiency. Volume repeats; efficiency does not. The model
currently extrapolates *points*, which means it extrapolates last year's luck
along with last year's talent.

nflverse already serves what is needed and `projection_backtest.py` already
loads some of it: `targets`, `carries`, `attempts`, `target_share`,
`air_yards_share`, `wopr`, plus snap counts from a separate endpoint.

### 1.1 Carry opportunity through the pipeline — DONE
Extend `ingest_nflverse.py` and the `fantasy_players` schema (migration
required — `create_all` does not ALTER) to store volume alongside points.
Turned out no migration was needed — see the RESULT block below.

### 1.2 Two-stage projection — DONE, shipped for TE only
Project volume first, then apply a shrunk efficiency rate. The v2 experiment
already built the shrinkage machinery (`projection_v2.py`) — this reuses it at
the right level instead of patching touchdowns onto a points model.

### 1.3 Team context — DONE, shipped: team change, RB/WR only
Team change, quarterback change, coaching change, pace. **Evidence-driven
only**: measure each feature's incremental contribution before adding it. This
project's rule about not guessing undocumented mappings applies to features too.

**Data, each independently verified before use** (`data-pipeline/team_context.py`):
team via nflverse `recent_team`; starting QB as the attempts leader on a team
that season (min 20 attempts, spot-checked against known rosters — 2022 CLE ->
Brissett, 2023 CLE -> Flacco, 2023 HOU -> Stroud); head coach as the modal
`home_coach`/`away_coach` per team-season from `load_schedules` (0% null,
matched real coaching history 2015-2024); pace as (pass attempts + rush
carries + sacks suffered) / games from `load_team_stats` (55-71 plays/game, a
realistic band). Each of the four is swept and judged **INDEPENDENTLY** — the
roadmap's own instruction — as a discount/scale on the PURE model, same
solo/partial/merged treatment v2 and 1.1/1.2 get.

**RESULT — DONE, shipped for team_change, RB/WR only.** Swept 2017-2025,
measured TWO ways like 1.1/1.2 taught to:

| feature | pos | vs the pure model | vs the ACTUAL live board (injury discount + expert blend + anchor) |
|---|---|---|---|
| team_change | QB | partial +0.2841 (material), merged +0.0070 → **PASS** | merged +0.0016 → FAIL |
| team_change | RB | partial +0.3083 (material), merged +0.0037 → **PASS** | merged +0.0038 → **PASS** |
| team_change | WR | partial +0.2912 (material), merged +0.0055 → **PASS** | merged +0.0062 → **PASS** |
| team_change | TE | partial +0.4156 (material), merged +0.0028 → FAIL | — |
| qb_change | RB/WR/TE | material partial at all three, merged never beat +0.003 | — |
| coach_change | QB/RB/TE/WR | material partial at all four, merged never beat +0.003 | — |
| pace | QB/RB/TE/WR | material partial at all four, merged never beat +0.003 | — |

Only `team_change` cleared the merge bar against the pure model at all, and
only for QB/RB/WR. Re-baselined against the live board exactly the way
1.1/1.2 was — QB's gain nearly vanished (QB already carries an injury
discount at k=0.5 AND the highest-trust-after-WR expert-blend weight, 0.3,
so team_change's signal there was mostly what those two were already
extracting); RB (+0.0038) and WR (+0.0062) held up. qb_change, coach_change
and pace never beat the merge bar even against the easier pure-model
comparison, so a harder bar couldn't help them either — not run against the
live board at all.

A first pass at qb_change produced numbers **byte-identical** to team_change
at every RB/WR/TE k — not a coincidence: it compared team_now's QB using
ONLY season Y-1 data on both sides, which collapses to team_changed exactly
whenever team_prev == team_now (same lookup key). Fixed to compare the
player's own Y-1 QB against team_now's Y-season attempts leader (the same
"season Y's own outcome as a preseason-knowable proxy" reasoning
coach_change already uses) before it was measured for real — the corrected
qb_change still didn't clear the gate, so the fix changed the numbers but
not the verdict.

First shipped as `TEAM_CHANGE_K = { RB: 0.25, WR: 0.25 }` in
`frontend/src/engine/team-context.js`, wired into `useBoard.ts` right after
`applyOpportunityModel()` — before the injury discount, matching the order
the backtest measured (applied to the pure model's own estimate, before
injury/expert/anchor touch it). `ingest_nflverse.py` now carries `last.team`
(the team a player finished last season on) alongside the scoring
components — no migration needed, `last`/`last2` are already JSONB.
`team_change_parity.py` holds the shipped JS to the backtested Python on the
one number that matters, `valuePoints`.

> **Prompt** — "Let's move on to 1.3"

**FOLLOW-UP — RB re-tuned to 0.4; a destination-quality nuance tried and
killed.** Two questions after shipping: was k=0.25 an actual optimum, and
does WHERE a player landed (not just THAT he moved) carry independent
signal?

*Was 0.25 a peak?* No — it was the best value in a grid `[0.0 … 0.25]` that
was still climbing at its own top, not a found optimum (`TEAM_CHANGE_K`
never having been swept past its shipped value). Re-swept to `[0.0 … 0.5]`
against the live board:

| pos | k=0.25 (first shipped) | best in the wider sweep | verdict |
|---|---|---|---|
| RB | +0.0038 | **k=0.4: +0.0051**, and the numbers genuinely roll over past it | real peak found — **shipped** |
| WR | +0.0062 | k=0.5: +0.0108, still climbing at the grid's own top | no peak found — **stayed at 0.25** rather than jump to another unconfirmed edge |
| QB | +0.0016 (fail) | k=0.4/0.5 tie at +0.0019 | still fails the bar everywhere — confirmed |

Shipped as `TEAM_CHANGE_K = { RB: 0.4, WR: 0.25 }`. WR needs a further-out
sweep (past 0.5) before its number can move again — updating it to 0.5 now
would repeat the exact mistake ("ship the edge of the grid, not a peak")
that prompted this whole re-check.

*Does destination quality help?* Tested `apply_team_change_quality()`:
multiplier = `1 - k*(1 - quality_z)`, where `quality_z` is the new team's
offensive EPA/play (`(passing_epa + rushing_epa) / plays` from
`load_team_stats`, spot-checked against 2023's real offenses — SF/BUF/DAL/
MIA top the league, NYJ/CAR/NE bottom it, exactly matching that season's
actual reputations) z-scored against that season's league distribution,
read ONLY from the destination team's prior season (zero lookahead, same
discipline as `pace_ratio`). Identical to the flat discount at
`quality_z=0`, so it's a strict generalization, not a different feature.

**Result: it made things worse, not better.** Against the pure model, only
QB cleared the gate (RB/WR/TE all failed — WORSE than the flat version even
there). Against the bar that actually matters — does it beat the flat
discount already shipping — it failed everywhere; QB's own best k was 0.0
(literally no adjustment), which itself lost to the live board's existing
flat discount. Not shipped in any form. The binary "did you move" signal is
doing real work; blending in a continuous quality read diluted it rather
than sharpening it — at least for this construction of "quality."

`team_change_parity.py`/`team-context.selftest.mjs` updated to the new
constants (RB 0.4). Backtest run: `projection-backtest.yml` #32079414046.

> **Prompt** — "how did you land at .25? is there any reason to try to
> nuance this with information about the team they are joining?" ...
> "Yes, do both"

### 1.4 Rookie model on draft capital
Rookies currently get an ADP-curve fallback. NFL draft round and pick are far
stronger priors for opportunity.

**Kill gate for the phase**: partial correlation vs ADP must rise materially
above the current +0.036 QB / +0.047 RB / +0.107 TE / +0.098 WR, **and** the
merged full-board number must improve by more than the v2 attempt's +0.003.
Partial correlation alone is not enough — v2 raised it and still didn't matter.

**"Materially" fixed as a number, before running**: partial correlation must
clear baseline by **more than +0.03 absolute** (roughly doubling the QB/RB
floor, ~30% relative on TE/WR). "More than v2's +0.003" is taken literally —
merged Spearman must beat the shipped model's best market-merge by **more
than +0.003**, not merely match it. Both halves required; evaluated **per
position**, same as 0.1 and 0.3 — a position that fails stays on the shipped
model rather than getting a replacement that didn't earn it there.

**1.1/1.2 approach taken**: rather than committing to the Postgres schema
migration + `ingest_nflverse.py` production plumbing before knowing whether
any of this earns its place, the two-stage model (`projection_opportunity.py`)
was built and backtested first, reusing volume columns (`carries`, `targets`,
`attempts`) `projection_backtest.py` already loads for `projection_v2.py` —
no migration needed to MEASURE it. `target_share`/`air_yards_share`/`wopr`
(also named in this section) were not used this round — not verified
available in the pulled columns, so not claimed. The real DB/pipeline work
only happens if the gate passes, same "nothing ships without the measurement"
discipline 0.1 and 0.3 both followed.

**RESULT — DONE, shipped for TE only.** Swept 2017–2025, measured TWO ways:

| pos | vs the pure model (`projection-backtest.yml` #32048231675) | vs the ACTUAL live board — injury discount + expert blend already applied (#32058062329) |
|---|---|---|
| QB | partial +0.3038 (material), merged +0.0043 → **PASS** | merged +0.0001 → **FAIL** |
| RB | partial +0.2809 (material), merged +0.0023 → FAIL | merged +0.0000 → FAIL |
| TE | partial +0.4000 (material), merged +0.0071 → **PASS** | merged +0.0040 → **PASS** |
| WR | partial +0.3083 (material), merged +0.0034 → **PASS** | merged +0.0016 → **FAIL** |

The first measure is the same one every other gate in this file uses (v2, 0.1,
0.3): isolate the idea's own marginal contribution against the bare model.
QB/TE/WR all passed it. But that measure doesn't say whether a NEW idea helps
on top of what's ALREADY shipped — so it was re-run with `shipped_stack =
project_points -> injury discount -> expert blend -> anchor`, at the EXACT
weights live in `engine-core.js`, as the baseline instead. Against that
honest bar, QB and WR's gains nearly vanish: both are the positions
`EXPERT_BLEND_W` trusts the experts most (0.3, 0.4 — the two highest), so the
opportunity model's signal there turned out to be mostly what the expert
blend was already extracting, not something new. RB failed both measures,
landing within 0.0003 of v2's already-rejected RB result (+0.0020) each
time — three separate comparisons, same conclusion. TE — lowest expert-blend
trust (0.2), no injury discount at all — is the only position with genuine
room left, and it held up on the honest baseline too (+0.0040, still clears
the same +0.003 bar).

Shipped as `OPPORTUNITY_K = { TE: 2.0 }` (everyone else 0) in
`frontend/src/engine/projection-opportunity.js`, wired into `useBoard.ts`
right after `projectAll()` — before the injury discount / expert blend / SOS
/ anchor, matching the order the backtest actually measured:
`projectAll -> applyOpportunityModel -> applyInjuryDiscount -> blendExpertAll
-> SOS -> marketAnchor -> finalizeBoard`. A TE with no usable volume (a
rookie) falls straight through to the points-pace model, same coverage rule
0.1/0.3 use. `opportunity_parity.py` holds the shipped JS to the backtested
Python on the one number that matters, `proj`.

**The real 1.1 turned out to need no migration.** `fantasy_players.last`/
`last2` are already JSONB — `ingest_nflverse.py` now carries `carries`/
`targets`/`attempts` alongside the scoring components as plain extra keys
(`VOLUME` dict, mirroring `projection_backtest.py`'s own), and
`load_to_db.py` already writes `last`/`last2` through untouched
(`json.dumps(p.get("last"))::jsonb`, no fixed-column handling anywhere in
the chain — confirmed by reading it, not assumed). The client-side engine
pools league efficiency from whatever's on the current board (each TE's
`last`+`last2`) rather than the backtest's multi-season pool — a necessary,
documented difference in what data FEEDS the formula, not in the formula
itself, which is exactly what `opportunity_parity.py` isolates and checks.

> **Prompt** — "Start roadmap Phase 1: rebuild the projection on opportunity
> data rather than points. Do 1.1 and 1.2 first, backtest, and report against
> the phase kill gate before going near 1.3."

---

## Phase 2 — Distributions and the right objective

The largest conceptual change in this document. Do not start it before Phase 1
lands, because a distribution around a biased mean is a well-quantified wrong
answer.

### 2.1 Per-player outcome distributions
Replace the point estimate with a distribution. Fit empirically from historical
residuals by position, projected rank and age — not a parametric guess.

**Validation**: interval calibration. If the stated 80% interval contains the
actual outcome 80% of the time across held-out seasons, it is honest. That is a
falsifiable check and it must run before anything consumes the distributions.

### 2.2 Weekly-lineup-aware season simulator
Season totals are the wrong unit: you start ~9 of 15 players each week. Simulate
weeks, set lineups, score the lineup. This makes bench depth worth its true
option value and stops treating a bench player's points as if they counted.

**Validation**: simulated final standings must reproduce historical distributions
of points-for and win totals.

### 2.3 Championship probability
Simulate your roster against opponents' actual rosters to get P(title). This
becomes the objective every later phase optimizes.

**Kill gate**: P(title) must be *calibrated* — bucket predictions and check that
teams given 15% win about 15% of the time. An uncalibrated title probability is
worse than none, because every downstream decision inherits its bias.

> **Prompt** — "Start roadmap Phase 2, step 2.1 only: per-player outcome
> distributions with interval-calibration validation. Do not wire them into
> anything until the calibration check passes."

---

## Phase 3 — Draft-time optimization

Now the objective exists, the draft becomes a search problem. **This is where
snake and auction genuinely diverge.**

### 3.1 Snake: survival probability *(highest-value snake feature)*
Nothing in the engines computes P(player available at my next pick). This is the
snake question — not "who is best" but "who will not last". Derive it from ADP
and its dispersion, then choose to maximize ΔP(title) rather than raw value.

### 3.2 Snake: positional run detection
When three running backs go in five picks, the next five are likelier to be
running backs. Update survival probabilities live from the pick log.

### 3.3 Auction: budget-path optimization *(highest-value auction feature)*
The tool prices players independently. The real skill is allocation: given
remaining budget, remaining holes and expected prices, what roster is reachable?
That is a knapsack/DP problem over the roster, evaluated on P(title).

### 3.4 Auction: bid ceilings from opponent budgets
A price is set by the *second* bidder. If only two teams can afford $50, that is
the cap. `oppBudgets` is already tracked but only reduced to `richFrac` for
nomination timing.

**Kill gate for the phase**: head-to-head simulation. Run the new agent against
the current one across many simulated leagues and measure title share. Anything
that does not win more titles does not ship, however elegant.

> **Prompt** — "Do roadmap step 3.1: pick-survival probability for the snake
> recommender, plus the head-to-head simulation harness the phase kill gate
> needs." *(swap 3.1 for 3.3 if the auction league matters more this season)*

---

## Phase 4 — In-season

The draft is one day; the season is seventeen weeks, and most championships are
decided after the draft. Everything here reuses the Phase 2 objective.

- **4.1 Waiver/FAAB valuation** — price a claim in ΔP(title), which is what
  makes "how much of my budget for this player" answerable.
- **4.2 Start/sit optimizer** — uses distributions, not means. Correct answers
  here differ from "start the higher projection" when you need variance.
- **4.3 Trade evaluator** — ΔP(title) for both sides; a fair trade can raise
  both, and knowing which trades do is a real edge.
- **4.4 Playoff-aware construction** — as the season progresses the objective
  shifts from "make the playoffs" to "win them", and roster preferences shift
  with it.

> **Prompt** — "Start roadmap Phase 4, step 4.1: FAAB valuation in terms of
> championship probability."

---

## Sequencing, honestly

| Phase | Effort | Payoff | Risk |
|---|---|---|---|
| 0 | Days | Moderate, near-certain | Low — 0.1, 0.2 and 0.3 are all done; see their results above |
| 1 | Weeks | Real, but position-specific | Moderate — 1.1/1.2 done, TE only; 1.3 done, team_change RB/WR only (qb_change/coach_change/pace failed) |
| 2 | Weeks | Largest conceptual | **Highest** — calibration is hard and unglamorous |
| 3 | Weeks | Large, format-specific | Moderate — depends entirely on Phase 2 |
| 4 | Ongoing | Large over a season | Low technically, wide in scope |

**Do Phase 0 first regardless.** All three steps are done. It was cheap: 0.1
shipped a real gain (+0.02 to +0.04 Spearman merged, per position), 0.2
removed ~100 numbers nobody could show still earned their place, and 0.3
shipped a real, positionally-honest gain for QB/RB while correctly declining
to ship one for TE/WR.

**If time is short before a draft**, do Phase 0, then 3.1 (snake) or 3.3/3.4
(auction) using the *current* projection. Survival probability and budget paths
improve decisions even on a mediocre projection, because they attack timing and
allocation rather than valuation.

**Do not start Phase 2 casually.** An uncalibrated simulator that reports
confident title probabilities is worse than the current tool, which at least
knows it is only pricing players.

---

## What NOT to rebuild

Verified as already sound; reimplementing these costs weeks and buys nothing:

- **Playoff-weighted SOS** — already weights weeks 15–17, and the weight is
  deliberately *mild* because the tuning found playoff weeks are less
  predictable from last season than the full season (r 0.10 vs 0.27). That is
  evidence-based restraint.
- **Live auction inflation**, keeper rule engine and recommender, duplicate and
  nickname resolution, traded-pick draft board.
- **League-specific auction calibration** — including its leave-one-season-out
  persistence test, which is uncommon in fantasy tools.
- **The measurement culture**: parity checks, backtests scored on rank
  correlation, kill gates. This is the part hardest to copy and the reason the
  tool is not confidently wrong.

---

## Where this came from

An audit answering "if a competitor studied this tool, how would they beat it".
Findings were verified against the code, not assumed — one initial assumption
(that SOS ignored playoff weeks) was wrong and is corrected above. The two
measurement tables come from `projection_backtest.py` runs over 2017–2025.

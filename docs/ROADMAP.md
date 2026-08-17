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

**Kill gate**: must improve `spearman_total` (the target that counts missed
games) without degrading `spearman_pace`. If it only moves `pace`, it is
double-counting the durability multiplier.

> **Prompt** — "Do roadmap step 0.3: make injury status affect the projection
> via expected games missed. Check it against the kill gate."

---

## Phase 1 — Rebuild the projection on opportunity

Points are volume × efficiency. Volume repeats; efficiency does not. The model
currently extrapolates *points*, which means it extrapolates last year's luck
along with last year's talent.

nflverse already serves what is needed and `projection_backtest.py` already
loads some of it: `targets`, `carries`, `attempts`, `target_share`,
`air_yards_share`, `wopr`, plus snap counts from a separate endpoint.

### 1.1 Carry opportunity through the pipeline
Extend `ingest_nflverse.py` and the `fantasy_players` schema (migration
required — `create_all` does not ALTER) to store volume alongside points.

### 1.2 Two-stage projection
Project volume first, then apply a shrunk efficiency rate. The v2 experiment
already built the shrinkage machinery (`projection_v2.py`) — this reuses it at
the right level instead of patching touchdowns onto a points model.

### 1.3 Team context
Team change, quarterback change, coaching change, pace. **Evidence-driven
only**: measure each feature's incremental contribution before adding it. This
project's rule about not guessing undocumented mappings applies to features too.

### 1.4 Rookie model on draft capital
Rookies currently get an ADP-curve fallback. NFL draft round and pick are far
stronger priors for opportunity.

**Kill gate for the phase**: partial correlation vs ADP must rise materially
above the current +0.036 QB / +0.047 RB / +0.107 TE / +0.098 WR, **and** the
merged full-board number must improve by more than the v2 attempt's +0.003.
Partial correlation alone is not enough — v2 raised it and still didn't matter.

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
| 0 | Days | Moderate, near-certain | Low — 0.1 and 0.2 are done; see their results above |
| 1 | Weeks | Large | Moderate — could still fail its gate like v2 |
| 2 | Weeks | Largest conceptual | **Highest** — calibration is hard and unglamorous |
| 3 | Weeks | Large, format-specific | Moderate — depends entirely on Phase 2 |
| 4 | Ongoing | Large over a season | Low technically, wide in scope |

**Do Phase 0 first regardless.** 0.1 and 0.2 are done (0.3 — injury-aware
expected games — is the one step left); it was cheap and 0.1 shipped a real
gain (+0.02 to +0.04 Spearman merged, per position).

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

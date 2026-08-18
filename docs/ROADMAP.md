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

**1.1/1.2 approach taken**: rather than committing to the Postgres schema
migration + `ingest_nflverse.py` production plumbing before knowing whether
any of this earns its place, the two-stage model (`projection_opportunity.py`)
was built and backtested first, reusing volume columns (`carries`, `targets`,
`attempts`) `projection_backtest.py` already loads for `projection_v2.py` —
no migration needed to MEASURE it. `target_share`/`air_yards_share`/`wopr`
(also named above) were not used this round — not verified available in the
pulled columns, so not claimed. The real DB/pipeline work only happens if the
gate passes, same "nothing ships without the measurement" discipline 0.1 and
0.3 both followed.

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

**FOLLOW-UP — RB/WR re-tuned to found peaks (0.4 / 0.7); a destination-
quality nuance tried and killed.** Two questions after shipping: was
k=0.25 an actual optimum, and does WHERE a player landed (not just THAT
he moved) carry independent signal?

*Was 0.25 a peak?* No — it was the best value in a grid `[0.0 … 0.25]` that
was still climbing at its own top, not a found optimum (`TEAM_CHANGE_K`
never having been swept past its shipped value). Re-swept in two widening
passes against the live board — `[0.0 … 0.5]`, then `[0.0 … 0.9]` once WR
was still climbing at the first pass's top:

| pos | k=0.25 (first shipped) | pass 1 best (to 0.5) | pass 2 best (to 0.9) | verdict |
|---|---|---|---|---|
| RB | +0.0038 | **k=0.4: +0.0051**, rolls over past it | (unchanged — already found) | real peak — **shipped at 0.4** |
| WR | +0.0062 | k=0.5: +0.0108, still climbing | **k=0.7: +0.0115**, rolls over past it — the single largest effect measured anywhere in this phase | real peak — **shipped at 0.7** |
| QB | +0.0016 (fail) | k=0.4/0.5 tie at +0.0019 | still fails past 0.5 too | still fails the bar everywhere — confirmed |

Shipped as `TEAM_CHANGE_K = { RB: 0.4, WR: 0.7 }`. WR's 0.7 looks large,
but both numbers now decay smoothly and monotonically on either side of
their peak in the real backtest — found values, not the edge of whatever
grid happened to be tried, which is exactly what the first k=0.25 was.

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
constants (RB 0.4, WR 0.7). Backtest runs: `projection-backtest.yml`
#32079414046 (k to 0.5 — RB's peak + the quality nuance) and #32080618336
(k to 0.9 — WR's peak).

> **Prompt** — "how did you land at .25? is there any reason to try to
> nuance this with information about the team they are joining?" ...
> "Yes, do both"

**FOLLOW-UP #2 — O-line quality and contract commitment tried as nuances;
both killed too.** EPA-based destination quality (above) failed
comprehensively, but it's one specific construction of "quality" — two
more independent tier-1 proxies were tested before giving up on the idea:
O-line quality (does the runner/passer land behind good blocking?) and
contract commitment (does the size of the new deal signal the team's own
confidence in the player?). Motivating question: is the shipped WR
discount (70%) overly punitive for movers into a good spot that one of
these could differentiate?

Both reuse the exact same generalized shape as the EPA experiment —
`apply_team_change_nuance(..., signal_key, k)`, `multiplier = 1 - k*(1 -
z)`, identical to the flat `(1-k)` discount at `z=0` — so neither is a
competing feature, only a possible refinement of the one already shipped.

*Data, verified before use*: O-line — `nflreadpy.load_pfr_advstats`
(2018-2025 only; the call raises for the whole range if any requested
year is out of range, so years are pre-filtered rather than
try/excepted). RB signal = yards-before-contact per carry, credited to
blocking not the runner (confound disclosed: RPO/QB mobility also move
this number); QB/WR/TE signal = pressure rate allowed, sign-flipped
before z-scoring (lower is better). Spot-checked against 2023 reality.
Commitment — `nflreadpy.load_contracts()`, `apy_cap_pct` (contract value
as % of that year's cap — the one metric comparable across seasons
despite salary inflation), matched via `gsis_id`, position-scoped
z-scoring (`league_commitment_stats`, kept separate from the generic
z-score helper since dollar amounts aren't comparable across positions).
Spot-checked against three known real contracts (Kirk, Barkley,
Smith-Schuster).

**Result: both failed, at every position that mattered, against the bar
that matters.** Against the pure model, commitment actually looked
promising — QB/RB/TE/WR all cleared the merge bar (oline cleared only
QB) — but that measure doesn't ask whether a nuance beats what's ALREADY
shipping. Re-baselined against the live board **including the shipped
flat `team_change` discount itself** (RB=0.4, WR=0.7):

| feature | pos | best k | nuanced vs flat-shipped | verdict |
|---|---|---|---|---|
| team_change_oline | QB | 0.2 | +0.0007 | FAIL (below +0.003) |
| team_change_commitment | QB | 0.3 | -0.0004 | FAIL |
| team_change_commitment | RB | 0.4 | +0.0013 | FAIL (below +0.003) |
| team_change_commitment | TE | 0.5 | +0.0009 | FAIL (below +0.003) |
| team_change_commitment | WR | 0.5 | **-0.0013** | FAIL (worse than flat) |

Neither RB nor WR — the two positions with a live flat discount, and WR
specifically the motivating question — showed a nuance that beat the flat
version. WR's best commitment result at any k tried is still *worse* than
just applying the flat 70% to everyone who moved: a big new contract does
not reliably mark a WR the flat discount is overcharging. Same story as
the EPA attempt: the binary "did you move" signal is carrying real
information; none of the three quality-proxy constructions tried so far
(EPA, O-line, contract commitment) sharpen it. Not shipped in any form —
`TEAM_CHANGE_K = { RB: 0.4, WR: 0.7 }` unchanged. QB-quality proxy (tier-1
idea #2) was skipped as too correlated with the already-failed EPA
signal to be worth an independent test.

`team_context.py` gained the general-purpose O-line/commitment tables
(`team_run_block_by_season`, `team_dropbacks_by_season`,
`team_pass_pro_by_season`, `commitment_by_player_season`,
`league_commitment_stats`) and `apply_team_change_quality` was
generalized into `apply_team_change_nuance(..., signal_key, k)` so all
three nuance ideas share one implementation — kept in the codebase as
documented, fixture-tested (51 assertions) negative results, same as the
EPA attempt. Backtest run: `projection-backtest.yml` #32092900025.

> **Prompt** — "do we need to test other nuances in your tier 1?" ...
> "let's run 3 and 4 -- in part, I want to make sure we aren't overly
> discounting WRs if there is a more nuanced adjustment"

### 1.4 Rookie model on draft capital — DONE, NOT SHIPPED
Rookies currently get an ADP-curve fallback. NFL draft round and pick are far
stronger priors for opportunity than anything in a rookie's (nonexistent) NFL
box score.

> **Doc note**: this section previously carried the ORIGINAL, pre-Phase-0
> Phase-1 kill gate text (partial vs ADP baseline `+0.036 QB / +0.047 RB /
> +0.107 TE / +0.098 WR`) and, misplaced beneath it by an earlier commit's
> insertion anchor, the unrelated 1.1/1.2 RESULT block — moved to sit under
> 1.2 above, where it belongs. 1.4 itself had never actually been attempted.
> The kill gate below is freshly set, re-baselined against what's live today
> (1.1–1.3 already shipped), rather than reusing the stale pre-Phase-0 numbers.

**Kill gate, set before running**: same two-measure discipline as every other
step in this phase. (1) Partial correlation of the rookie model vs actual
outcome must clear the CURRENT ADP-fallback baseline by **more than +0.03
absolute** for that position (mirrors the "material" bar used everywhere
else in Phase 1). (2) Re-baselined against `shipped_stack` (project_points ->
opportunity model -> team-change discount -> injury discount -> expert blend
-> anchor, i.e. today's actual live board) restricted to the rookie
population, the merged full-board Spearman must improve by **more than
+0.003**, matching v2's own bar. Evaluated **per position** — a position that
fails stays on the ADP-curve fallback rather than getting a replacement that
didn't earn it there. Rookies are a small, high-variance population (no prior
NFL season to measure against), so both halves are required precisely because
a partial-correlation-only win (v2's own mistake) is easiest to manufacture
by accident on a small sample.

**RESULT — DONE, NOT SHIPPED. Draft capital does not beat the ADP/ECR curve
anywhere, at either measure.** Swept 2017-2025 (`projection-backtest.yml`
#32094460741), 1,633 drafted skill-position players on record, 1,296
rookie-season pace rows pooled to fit `rookie_capital_curve()` (bucketed by
round, leave-one-year-out, `MIN_ROUND_N=5`):

| pos | solo (capital vs baseline) | partial vs ADP (capital vs baseline) | merged, live board (capital vs baseline) | verdict |
|---|---|---|---|---|
| QB | 0.4882 vs 0.4985 (worse) | n=0 years (too few ADP-covered rookie QBs/season to clear `disagreement_signal`'s n≥15) | 0.7702 vs 0.7732 (worse) | FAIL |
| RB | 0.5159 vs 0.5176 (worse) | +0.3620 vs **+0.3620 — identical to 4 decimals** | 0.7318 vs 0.7326 (worse) | FAIL |
| TE | 0.2962 vs 0.2985 (worse) | n=0 years (same QB-sized coverage problem) | 0.6899 vs 0.6922 (worse) | FAIL |
| WR | 0.3982 vs 0.4056 (worse) | +0.3700 vs +0.3759 (worse) | 0.7269 vs 0.7277 (worse) | FAIL |

Every single comparison — solo, partial, and merged — reads WORSE for the
draft-capital model, at every position, not merely "not better by enough."
The RB result is the clearest tell: the partial correlation (which holds ADP
constant) came back numerically IDENTICAL between the two models. That is
not "draft capital adds nothing on the margin" in the usual noisy sense —
it means ADP's own consensus for a rookie is already substantially a
function of the player's draft slot. Fantasy ADP compilers already read
the draft the same way this model does; asking draft round to out-predict
ADP for the players ADP itself derives largely FROM the draft is close to
asking a proxy to beat its own source. QB/TE's zero-coverage partial result
is a separate, structural problem: most years don't have 15 ADP-ranked
rookie QBs or TEs to run the diagnostic on at all — the position is just
too thin for this specific diagnostic, regardless of the model's quality.

Not shipped in any form. `rookie_projection()` / `rookieProjection()`'s
ADP/ECR-curve fallback is unchanged. `rookie_capital.py` and its 15
fixture-test assertions stay in the repo as a documented negative result,
same treatment every other killed idea in this file gets — the measurement
infrastructure (leave-one-year-out curve fitting, the rookies-merged-with-
returning-players full-board anchor) is real and reusable if a future
attempt uses PICK rather than ROUND, or blends capital with ADP instead of
replacing it outright, rather than being thrown away.

---

## Phase 2 — Distributions and the right objective

The largest conceptual change in this document. Do not start it before Phase 1
lands, because a distribution around a biased mean is a well-quantified wrong
answer.

### 2.1 Per-player outcome distributions — DONE, not yet usable
Replace the point estimate with a distribution. Fit empirically from historical
residuals by position, projected rank and age — not a parametric guess.

**Validation**: interval calibration. If the stated 80% interval contains the
actual outcome 80% of the time across held-out seasons, it is honest. That is a
falsifiable check and it must run before anything consumes the distributions.

**Kill gate, made precise before running** (the section above fixes the SHAPE of
the bar, not numbers — these are the numbers, set in advance):

1. **Calibration.** Held-out empirical coverage of the nominal 80% interval must
   land in **[0.75, 0.85]** at every position. 50% and 90% intervals are reported
   alongside as shape checks — a model that hits 80% by being wrong in
   compensating directions at 50/90 is not actually calibrated.
2. **Sharpness, because calibration alone is trivially gameable.** A `[0, ∞)`
   interval covers 100% of outcomes and is worthless; the roadmap's stated bar
   cannot be the only one. Scored with **CRPS** (continuous ranked probability
   score — a proper scoring rule that rewards sharpness *conditional on*
   calibration), computed exactly against the empirical predictive sample.
3. **Every conditioning variable earns its place independently**, the same
   discipline 1.3 applied to team context: fit `pos` only, then `pos+rank`, then
   `pos+rank+age`, and require each added variable to improve held-out CRPS by
   **more than 1% relative**. A variable that doesn't clear that is dropped —
   the roadmap NAMING age is not evidence that age helps, exactly as it named
   `qb_change`/`coach_change`/`pace` in 1.3 and three of the four failed.

Evaluated **per position**. Nothing is wired into the frontend on this step
regardless of outcome — 2.1 produces a validated distribution or a documented
negative result, and 2.2 is what would consume it.

**RESULT — DONE, NOT YET USABLE. The method works; the left-tail treatment is
unresolved and that is a blocker for 2.2.** Backtest `projection-backtest.yml`
#32096610584, fit 2017-2025 on an expanding window (2017 has nothing prior and
is not evaluated), ~3,700-3,800 held-out player-seasons.

*Age is dead.* At **every position, in both populations**, adding age to the
conditioning failed the 1% CRPS bar — usually landing at ±0.5% and four times
actually making CRPS *worse* (RB -0.3%, TE -0.1/-0.2%, QB -0.6%). The roadmap
named position, rank AND age; only the first two survive contact with the data.
Rank earns its place at RB (+1.9%), WR (+1.5%) and TE (+1.3%) but not QB
(+0.5%), so the fitted models are `pos_rank` for RB/TE/WR and `pos` for QB.

*Calibration is close, but does not clear the gate at every position — and the
two populations miss in OPPOSITE directions:*

| pos | model | survivors cov80 | with_busts cov80 |
|---|---|---|---|
| QB | pos | **0.730** — too NARROW, FAIL | 0.760 — PASS |
| RB | pos_rank | 0.798 — PASS | **0.857** — too WIDE, FAIL |
| TE | pos_rank | 0.771 — PASS | 0.786 — PASS |
| WR | pos_rank | 0.785 — PASS | **0.874** — too WIDE, FAIL |

That opposition is the finding, and it is more useful than either column alone.
Adding back ~2.8% market-ranked players who produced no season-Y line drags the
10th percentile down far enough to over-widen RB and WR (the busts themselves
are still *misses* — at a 2.8% base rate the 10th percentile never reaches
zero — so the widening buys coverage on survivors it did not need), while it is
exactly what QB was missing. **Only TE is calibrated under both.** cov50 sits
at 0.47-0.53 and mean PIT at 0.49-0.54 essentially everywhere, so the centre and
the bias are fine; the problem is localised entirely in the tails.

The population is not a free parameter to pick after seeing which column looks
better — that is the exact move this document exists to prevent. It is a real
modelling decision (what fraction of drafted players produce nothing, and how
that mass should enter the fit) and it has to be settled on its own evidence
before any of this is trusted. **Not wired into anything**, per the rule above.

*Open, and the next thing to do here*: (a) settle the bust rate directly rather
than bracketing it — the ADP filter used here (season-Y ADP, prior history, no
season-Y line) is one defensible construction, not a measurement; (b) check
whether QB's too-narrow tails are the small-sample bias of an empirical
quantile — the expanding window fits QB's earliest evaluated years on very
little data, `MIN_CELL_N=40` puts the 10th percentile at the 4th order
statistic, and that under-estimates tail width — by reporting coverage per
year, which this run did not print.

**FOLLOW-UP (b) — the estimator bias was real, is now fixed, and does NOT
explain QB. Hypothesis rejected, and the per-year trend runs backwards.**
Backtest `projection-backtest.yml` #32126283470.

The bias is analytic, so the prediction was registered before running rather
than read off after. 2.1 shipped Hyndman-Fan **type7** (position `q(n-1)`),
whose nominal-80% interval spans `0.8(n-1)` of the `n+1` gaps a future
observation can land in — expected coverage `0.8(n-1)/(n+1)`, i.e. 0.761 at
n=40, 0.784 at n=100, 0.796 at n=450. **type6** (Weibull, `q(n+1)`) spans
`0.8(n+1)` of those same gaps and is exactly unbiased at every n. That property
*is* what an interval-calibration gate measures, so type6 is the correct
estimator here, not merely a different one — it is kept regardless of this
diagnostic. Predicted gain: `1.6/(n+1)`.

*The correction behaves as predicted, and the residual is informative:*

| pos | median cell n | observed type6−type7 | predicted 1.6/(n+1) |
|---|---|---|---|
| RB | 183 | +0.0095 | +0.0087 |
| TE | 120 | +0.0099 | +0.0132 |
| WR | 346 | +0.0085 | +0.0046 |
| QB | 230 | +0.0215 | +0.0069 |

RB and TE land essentially on the prediction. The prediction assumes the cell is
correctly specified and the sample iid from it, so *exceeding* it — QB by 3x — is
itself a mis-specification signal rather than a bonus.

*And QB is not rescued.* Survivors QB moves 0.730 → **0.743**, still under the
0.75 gate. The per-year breakdown then kills the hypothesis outright — coverage
gets **worse as the fit cell gets fatter** (with_busts QB, type6):

| fit year | cell n | cov80 |
|---|---|---|
| 2020 | 110 | 0.866 |
| 2021 | 170 | 0.754 |
| 2022 | 230 | 0.819 |
| 2023 | 298 | 0.768 |
| 2024 | 367 | **0.731** |
| 2025 | 433 | **0.731** |

Small-sample bias predicts the exact opposite — thin fits under-cover, fat fits
approach nominal. QB does the reverse and settles at 0.731 in the two most
recent years, its two largest fits. RB/TE/WR show no such trend (TE is flat
around 0.79; WR sits high throughout). **So QB's narrow tails are the model's
problem, not the estimator's** — which is what type6 moving it only 0.730 →
0.743 already established independently of this series.

*Confound, stated rather than glossed*: in an expanding window the fit size and
the evaluation year advance together, so this is either non-stationarity in the
QB ratio distribution (a pooled 8-year sample no longer describing recent QB
seasons) or year-specific dispersion in 2024-25. Distinguishing those needs its
own test — but it does not rescue (b), because both explanations are the model,
not the quantile estimator.

> **Superseded by (c), read this with the table above**: the declining series
> quoted here is `with_busts` only. Follow-up (c) separated the confound and
> found the `survivors` population — the one that actually fails the gate — has
> **no trend at all** (`rho = +0.00`). The "coverage falls as the fit fattens"
> reading was an artifact of the confound; the durable claim from (b) is the
> narrower one, that the estimator is not the cause. See (c) below.

Net gate after the fix — same shape as before, everything ~+0.01 wider:
survivors RB 0.812 / TE 0.780 / WR 0.797 PASS, QB 0.743 FAIL; with_busts QB
0.781 / TE 0.795 PASS, RB 0.866 / WR 0.882 too wide. **TE remains the only
position calibrated under both populations.** Still not wired into anything.

*Next, if this is pursued*: the QB trend points at non-stationarity, so the
natural hypothesis (c) is a recency-weighted or rolling-window fit rather than a
flat pool over all prior seasons — pre-registered separately, and tested on
whether it closes QB without breaking the positions that currently pass.

**FOLLOW-UP (c) — pre-registration, written before the code exists.**

*Hypothesis*: QB's ratio distribution is non-stationary, so a flat pool over
every prior season is too narrow for recent ones. Restricting the fit to a
rolling window of the most recent `W` seasons should widen QB toward nominal.

*Form*: a rolling window, not a smooth decay. It keeps the `type6` estimator
exactly as validated in (b) — weighted order statistics would change the
effective `n` that estimator's unbiasedness is derived for — and makes the
tradeoff explicit, since a shorter window is strictly less data. One parameter.
A smooth `RECENCY_DECAY` (as auction calibration already uses for pooling
seasons) is the natural refinement *if* the window works, not before.

*Held fixed*: the conditioning accepted in the flat-pool run (`pos` for QB,
`pos_rank` for RB/TE/WR). Sweeping conditioning and window together would be a
two-parameter search dressed up as one test.

*Gate, all four required*:
1. QB `cov80` enters [0.75, 0.85] on the **survivors** population — the case
   that fails today.
2. **No position that currently passes may leave the band.**
3. **CRPS must not degrade by more than 1% relative at any position.** A short
   window can "fix" coverage purely by widening intervals; that is the exact
   failure CRPS is in this gate to catch, and buying coverage with sharpness is
   not a fix.
4. **The mechanism must show up, not just the number**: QB's by-year coverage
   trend — which currently *falls* as the fit fattens — must visibly flatten.
   This is the real test, because it is a prediction about the SHAPE of the
   result rather than a number being optimised.

*One shared `W` for all positions*, unless the per-position curves are clearly
non-flat — the market anchor's single 0.3 rather than `EXPERT_BLEND_W`'s four
numbers, and for the same reason.

*Limitation, stated in advance rather than discovered later*: with 8 evaluation
years there is no held-out set left for a second-stage parameter choice, so any
`W` that clears this is a **hypothesis confirmed in direction, not a validated
tuned constant**. Shipping it would need confirmation on seasons not used to
pick it. Gate 4 exists precisely because a shape prediction is much harder to
satisfy by chance than a single optimised number.

**RESULT — (c) REJECTED, and it resolves (b)'s confound in the process.**
Backtest `projection-backtest.yml` #32128939543.

*Gate 1 — does QB enter the band on survivors?* Only at `W=3`, and only just:

| W | QB cov80 (survivors) | CRPS vs flat |
|---|---|---|
| flat pool | 0.743 out | — |
| 5 | 0.743 out | +0.1% |
| 4 | 0.739 out | +0.3% |
| **3** | **0.750 IN** | +0.3% |
| 2 | 0.743 out | +0.6% |

It lands exactly on the 0.750 boundary, and the curve is **non-monotone** (4 is
worse than both 5 and 3; 2 is worse than 3). That is the signature of noise, not
of an effect.

*Gate 3 — CRPS.* `W=3`, the only window that moves QB, costs **RB +2.4%** and
**TE +1.5%**, both breaching the pre-registered 1% tolerance. A shared `W=3`
therefore fails outright. Exactly the failure mode CRPS was put in this gate to
catch: the shorter window widens intervals, which buys coverage while making the
distributions worse.

*Gate 4 — the shape test, and the decisive one.* The decline does **not**
flatten. On `with_busts` QB, where the decline lives, `rho(cov80, year)` is
-0.74 flat, and -0.75 / -0.75 / -0.75 / -0.68 at W = 5 / 4 / 3 / 2 — unmoved.
Worse, the most recent seasons get *less* covered under short windows (2025:
0.731 flat → 0.687 at W=5 and W=3), the opposite of what non-stationarity
predicts.

**And the survivors population — the one that actually fails the gate — has no
trend at all: `rho = +0.00`**, with coverage bouncing 0.667 / 0.806 / 0.703 /
0.792 / 0.818 / 0.701 / 0.697 across 2019-2025.

*This resolves the confound (b) flagged, and corrects (b)'s reading.* (b) noted
that fit size and evaluation year advance together in an expanding window and
that the two could not be separated there. Varying `W` at a fixed evaluation
year separates them, and the answer is unambiguous: **changing the fit barely
moves anything, so QB's coverage is driven by the EVALUATION SEASON, not by how
the fit was built.** The "coverage falls as the fit fattens" pattern (b)
reported was a `with_busts`-only artifact of that confound; it does not hold in
`survivors`, and (b)'s conclusion should be read as the narrower, still-correct
claim that the *estimator* is not the cause.

**Consequence: no fit-side fix can rescue QB.** Window, recency decay, or simply
more history all change the same thing the sweep just showed to be nearly inert.
QB seasons genuinely differ in outcome dispersion year to year, and one pooled
ratio distribution — however fitted — cannot express that. The remaining honest
options are (i) accept QB as uncalibrated and exclude it from whatever 2.2
consumes, (ii) condition on something that predicts dispersion *ex ante* rather
than describing it after the fact — the obvious candidate being the
starter/backup bimodality that makes QB unlike the other three positions, since
a QB who loses the job goes to near-zero in a way an RB3 does not, or (iii)
inflate QB's intervals by a fitted factor, which is fudging the number rather
than modelling anything and should not be done.

Nothing shipped, nothing wired in. `FIT_WINDOWS` and `in_window()` stay in the
repo as the documented negative result, same as every other killed idea here.

**Known population caveat, measured rather than hand-waved**: every correlation
in this file is computed over players who APPEAR in season Y, so a player who
was drafted and then never played is excluded rather than counted as a zero.
That truncates the left tail, which is precisely the tail a downside
distribution exists to describe. Coverage is therefore reported twice — over the
usual population, and over one that adds back players the market ranked (they
have season-Y ADP, so drafters were really considering them) who then produced
no season-Y stats line, scored as an actual outcome of 0.

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
| 1 | Weeks | Real, but position-specific | Moderate — 1.1/1.2 done, TE only; 1.3 done, team_change RB/WR only (qb_change/coach_change/pace failed); 1.4 done, not shipped (draft capital ≈ what ADP already knows for rookies) |
| 2 | Weeks | Largest conceptual | **Highest** — calibration is hard and unglamorous; 2.1 confirmed it (method sound, tails unresolved, age dead) |
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

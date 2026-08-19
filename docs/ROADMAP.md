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

### 2.1 Per-player outcome distributions — DONE, USABLE (RB/WR/TE, `survivors`; QB excluded)
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

**FOLLOW-UP (d) — pre-registration, written before the code exists.**

*Hypothesis (user-proposed)*: the fitted models condition on OUR blended board
rank (`rank`/`tier`, off `RANK_TIERS` — 1-6/7-12/13-24/25-48/49+, one shared
layout across all four positions), and that number is already 30% pulled
toward market order by `marketAnchor()` before it ever reaches the tier cut.
A prior, cleaner question: does the empirical actual/projected ratio spread
degrade at a *uniform* rate with ADP depth, or does each position have its own
accuracy curve — and does the one shared `RANK_TIERS` layout happen to cut
where each position's curve actually bends, or does it miss?

*Form*: position-specific tier WIDTH, not a shared cutoff — QB/TE in chunks of
3 (≈12-20 spots covers nearly the entire startable position at either, so a
6-wide RB-style tier would be too coarse to say anything), RB/WR in chunks of
5 (twice the startable depth per team, so a QB-width tier would leave most
of the position too thin to fill `MIN_TIER_N`). Ranked by the market's OWN
order (`adp_rank`, added to `dist_rows` alongside the existing blended `rank`)
rather than the board's blended number, so this reads ADP's accuracy on its
own terms — independent of anything the model already does to it, including
the market anchor's own 30% pull.

*Implemented, not yet run*: `projection_backtest.py`, "2.1 FOLLOW-UP (d)",
printed for both `survivors` and `with_busts` populations, reporting each
tier's empirical 80%-interval width (`interval()`/`quantile()` from
`outcome_distribution.py`, `MIN_TIER_N = 20`) and the shallowest-vs-deepest
usable-tier ratio per position. Not yet run against real data — needs
`FANTASYPROS_API_KEY` + network, unavailable in the session that wrote it. Run
via the `projection-backtest.yml` workflow or locally with the key.

*What this would and would not settle*: this is a THIRD, independent lens on
2.1's open problems, not a re-run of (a)/(b)/(c) under a new name. It does not
touch QB's narrow tails — (c) already established those are an
evaluation-season effect, not a conditioning-granularity one — and it does not
settle the RB/WR bust-population question either (that is still follow-up (a)
on its own). What it CAN show: whether the single shared `RANK_TIERS` layout
is costing CRPS by cutting position-specific accuracy curves at the wrong
depth — e.g. a real cliff after WR30 that the shared 25-48 tier straddles
instead of isolating. If the per-position curves it produces track the shared
tiers closely, this is confirmatory and nothing changes. If they diverge, the
gate for shipping a position-specific `RANK_TIERS` is the same discipline the
three existing conditioning levels already clear: >1% relative CRPS
improvement, held-out, without pushing any currently-passing position's cov80
out of `[0.75, 0.85]`.

**RESULT — the widening intuition holds directionally at every position, but
the tier-level detail is too noisy on this sample to read as a precise cliff
location. QB is the one place the finding looks like an actual smoking gun.**
Backtest `projection-backtest.yml` #32135813303, 2017-2025, ~2,000 ADP-ranked
player-seasons.

*The headline holds everywhere.* Comparing the shallowest to the deepest
usable tier (floor of 20 raw ratios), the empirical 80%-width grows at every
position: QB 0.61 → 1.67 (2.7x), RB 1.04 → 1.35 (1.3x, survivors), TE 0.80 →
2.47 (3.1x), WR 0.74 → 1.91 (2.6x). ADP genuinely is more trustworthy near the
top of a position than at the bottom, at every position tested.

*But the tier-by-tier curve inside that range is not smooth* — e.g. QB's ADP
7-9 tier (width 0.531) is narrower than BOTH neighbors (4-6: 0.687, 10-12:
1.310). That is the same non-monotone signature (c) taught this file to read
as noise rather than structure at n≈20-40 per cell — reading a precise "cliff
point" off single-tier jumps here would repeat exactly the mistake (c)'s gate
1 existed to catch (W=3 landing on a boundary via a curve that wasn't actually
monotone).

*One signal survives that caution: QB's jump from ADP 7-9 (width 0.531) to
ADP 10-12 (width 1.310) — a ~2.5x jump inside a SINGLE existing `RANK_TIERS`
bucket (7-12)* — averaging a genuinely tight top-9 into the same cell as a
genuinely wide 10-12. That is a plausible reason `pos_rank` never earned its
1% CRPS bar for QB in the original 2.1 sweep: not that rank carries no signal
for QB, but that the shared tier boundary does not isolate wherever QB's real
cliff sits. RB/WR/TE's growth over the same range is comparatively gradual —
nothing resembling a single-tier discontinuity that size.

*Median ratio drifts DOWN with depth too, not just spread* — at every
position, not only QB. QB1-3 sits at median 0.98 (essentially unbiased);
QB28-33 sits at 0.71-0.73. RB1-5 sits at 0.87 (survivors); RB's deep tiers
fall to 0.64-0.72 there, lower once busts are folded back in. Same pattern at
WR/TE. This is a DIFFERENT claim than the width numbers: the live-board
projection (`dist_final` — post market-anchor, post expert-blend, post
injury-discount) is not just less PRECISE for deep picks, it is systematically
OPTIMISTIC there. That is a bias question, not the calibration-interval
question 2.1's kill gate measures, and none of (a)/(b)/(c) nor the original
gate looked at it directly.

*What this changes and doesn't.* Does not resolve RB/WR's `with_busts`
over-width — still follow-up (a)'s territory; the widening pattern found here
for RB/WR is gradual, consistent with the bust population being the driver
rather than a missed tier cliff. Does not, on its own, prove a finer QB split
would clear 2.1's gate — that needs an actual re-run of the CRPS-earns-its-
place test with a QB-specific boundary near ADP 9/10, not just this
descriptive read. *If pursued*: re-fit QB under a QB-only tier split and
re-run the existing 1% CRPS bar against the `pos`-only baseline QB currently
ships with — same discipline every other conditioning choice in this file
already clears, not a new standard invented for QB.

**FOLLOW-UP (e) — pre-registration, written before the code exists.**

*Hypothesis*: QB's `pos_rank` conditioning failed the 1% CRPS-earns-its-place
bar under the shared `RANK_TIERS` (1-6/7-12/13-24/25-48/49+) not because rank
carries no QB signal, but because the boundary between ranks 6 and 12
straddles QB's real cliff — (d) found a ~2.5x width jump between ADP 7-9 and
ADP 10-12, inside that single shared bucket. A QB-specific split placed at
that jump should let `pos_rank` earn its place for QB where the shared tiers
did not.

*Form*: minimal, ONE parameter — a single QB-specific split point, not a
multi-tier fitted curve. (d) found one defensible jump, not enough data to
trust a finer shape (its own tier-to-tier detail was noisy at n≈20-40/cell) —
same "don't fit more than the sample supports" discipline `MIN_CELL_N` and the
collapsed snake-slot configs (0.2) already follow. `RANK_TIERS_BY_POS =
{"QB": ((9, "1-9"), (inf, "10+"))}` in `outcome_distribution.py`; every other
position keeps the existing shared `RANK_TIERS` untouched, and `rank_tier()`
takes an optional `pos` to select it — default behaviour (no `pos` passed) is
unchanged, so nothing already fit for RB/WR/TE moves.

*Held fixed*: everything else about the fit — flat pool (`window=None`), both
populations, the same CRPS-earns-its-place mechanics, the same 1% bar. Only
QB's tiering changes, so this stays a one-parameter test.

*Gate, both required*:
1. `pos_rank` must beat `pos` by **more than 1% relative CRPS for QB** — the
   identical bar RB/WR/TE already cleared and QB failed under the shared
   tiers.
2. **If QB earns conditioning, its `cov80` must land in `[0.75, 0.85]` on at
   least one population** — clearing the CRPS bar is necessary, not
   sufficient; a conditioning variable can earn its keep on sharpness while
   still missing the calibration gate outright, and both have to be checked
   independently, the same as every position in the original 2.1 run.

*What a pass would NOT prove*: that ADP 9/10 is QB's TRUE cliff location — (d)
already flagged its own tier-by-tier reading as too noisy to locate one
precisely, only that a cliff exists somewhere in that neighborhood coarse
enough to matter. A finer or differently-placed split might do even better;
this tests the one hypothesis (d) actually supports, not a search over split
points chosen after seeing results — that would be the exact p-hacking move
this file's discipline exists to rule out.

**RESULT — (e) REJECTED on gate 1. The split moves coverage the right
direction but costs sharpness, the exact trade CRPS exists to catch.**
Backtest `projection-backtest.yml` #32137111681.

*Gate 1 fails on both populations*:

| population | `pos` CRPS (baseline) | `pos_rank` CRPS (QB split) | delta |
|---|---|---|---|
| survivors | 40.59 | 40.77 | **-0.4%, does not earn it** |
| with_busts | 41.19 | 41.51 | **-0.8%, does not earn it** |

The split makes QB's fit slightly WORSE on CRPS in both populations — the
opposite of what would be needed to accept it. Per the pre-registered gate,
QB stays on `pos`, unchanged from before (e) existed.

*And yet gate 2, on its own, looks like a win* — this is the informative part:

| population | `pos` cov80 (shipped) | `pos_rank` cov80 (QB split, rejected) |
|---|---|---|
| survivors | 0.743 (FAIL) | **0.770 (would be IN band)** |
| with_busts | 0.781 (already PASS) | 0.796 (also in band) |

On survivors — the population that actually fails the standing kill gate —
the QB-specific split would have moved coverage from 0.743 to 0.770, inside
`[0.75, 0.85]`, if coverage were the only bar. It is not. Widening a QB1-9
vs QB10+ split moves probability mass into the tails broadly enough to buy
calibration, but not narrowly enough to do it for free — which is precisely
the failure mode gate 1 was written to catch, and precisely what follow-up
(c) already caught once with a rolling window instead of a tier split. Two
different levers, same result: buying QB coverage by widening costs more in
sharpness than the calibration is worth under this file's stated bar.

**Consequence**: the split is not shipped; `RANK_TIERS_BY_POS` stays in the
repo as a working, tested mechanism (7 selftest assertions) but produces no
change to QB's fitted model, which remains `pos` — the same place (b)/(c)
left it. This closes the "wrong tier boundary" explanation for QB's narrow
tails almost as cleanly as (c) closed the "wrong window" one: two structurally
different fixes (a rolling window, a position-specific split) both move
coverage toward nominal only by paying more in sharpness than the gate
allows. The remaining honest options are still the three (c) named — exclude
QB from whatever 2.2 consumes, condition on something that predicts
dispersion ex ante (starter/backup status, not draft rank), or accept a wider
QB interval as a real cost of the position rather than a bug to keep chasing
with variations on "cut the population differently."

**DECISION — QB excluded from whatever 2.2 consumes.** Of the three options
above, exclusion is the one taken. Reasoning for skipping option (ii)
(condition on starter/backup status) rather than pursuing it: a QB who has
lost the starting job typically stops being meaningfully ADP-ranked at all,
or falls deep enough that the entry is noise regardless — the same scarcity
signal `marketAnchor()` already leans on elsewhere in this codebase. Building
a dedicated starter/backup feature would mostly be re-deriving what ADP rank
already encodes for this specific position. **Not independently tested** —
recorded as the stated reasoning for not pursuing (ii), not a validated
finding the way (a)-(e) above are.

**Practical effect, to be enforced when 2.2 exists**: whatever 2.2's design
consumes for per-player outcome sampling, QB gets a documented carve-out —
no distribution sampled for QB (point estimate only, or whatever placeholder
2.2's own design settles on), rather than sampling from a distribution known
to be mis-calibrated. Recording this now so 2.2's design doesn't re-litigate
it.

**2.1's remaining blocker before "usable" is RB/WR only.** TE is calibrated
under both populations already; QB is carved out by the decision above. The
`with_busts` over-width at RB/WR (follow-up (a) — settle the bust rate
directly rather than bracketing it) is the one open item left before 2.1 can
be called fully usable for the positions that remain in scope.

**FOLLOW-UP (a) — pre-registration, written before the code exists.**

*The original open item*: `with_busts` adds back every market-ranked player
with prior history who produced zero season-Y stats, scored as an actual
outcome of 0. That is one defensible construction, not a measurement, and it
conflates two different real outcomes: a player who was ACTIVE on an NFL
roster all season and genuinely produced nothing — season-ending injury after
final cuts, lost every snap of a committee, a healthy scratch all year, the
textbook fantasy bust a real drafter actually lived through — and a player who
never had a roster spot in season Y at all — cut before Week 1, retired, never
signed anywhere. Those are not the same risk, and the current construction
prices them identically.

*Hypothesis*: RB/WR's `with_busts` over-widening comes disproportionately from
the second group. Teams carry far more RB/WR camp bodies than QB/TE and cut
down harder before Week 1, so the RB/WR vanished-player pool should skew
toward "never rostered" more than QB/TE's does — which would explain the
position-specific over-widening (RB/WR fail `with_busts`, QB needed it,
TE passes either way) without inventing any position-specific tuning.

*Measurement, not a guess*: pull `nflreadpy.load_rosters(year)` — already used
in this file for `load_ages()` — and check, for every "vanished" player,
whether `(year, player_id)` appears on ANY team's roster that season,
independent of whether they ever recorded a stat. Report the rostered-vs-
never-rostered split by position BEFORE touching the fit, so the measurement
stands on its own regardless of what the fit does with it afterward.

*Form*: a THIRD population, `rostered_busts` — survivors plus only the subset
of vanished players who WERE rostered that season. Re-run the identical
CRPS-conditioning-earns-its-place + `cov80` kill-gate machinery already built
for `survivors`/`with_busts`, unchanged, against it.

*Held fixed*: flat pool, the conditioning sweep, the `type6` estimator, the
`COVERAGE_BAND`. Only which bust rows enter the population changes.

*Gate*: `rostered_busts` becomes 2.1's actual population — replacing the
survivors/with_busts bracket — only if its `cov80` lands in `[0.75, 0.85]`
for **both RB and WR**, the two positions failing today, **without pushing TE
out of band** (it passes both existing populations already). QB is reported
for completeness but is not a blocking condition either way — it is already
carved out of 2.2 by the decision above regardless of what this shows. CRPS
is reported per population for transparency, not as a formal cross-population
gate: the populations differ in composition, not just conditioning, so it is
not the apples-to-apples comparison it is inside the existing conditioning
sweep.

*What a pass would NOT prove*: that "never rostered" players carry zero
fantasy risk worth pricing in anywhere — only that folding them into the fit
as a hard zero specifically over-widens the left tail more than this gate
tolerates. A softer treatment (e.g. a non-zero floor for that group) is a
separate, un-pre-registered idea and out of scope here.

**RESULT — (a) REJECTED, and the reason it failed dissolves the whole
population question rather than just narrowing it.**
Backtest `projection-backtest.yml` #32139178653.

*The measurement first, standing on its own*: of market-ranked players who
produced no season-Y line, the rostered/never-rostered split by position —

| pos | n busts | rostered | never-rostered |
|---|---|---|---|
| QB | 14 | 71% | 29% |
| RB | 38 | 63% | **37%** |
| TE | 14 | 71% | 29% |
| WR | 42 | **76%** | 24% |

RB does have the highest never-rostered share, the direction the hypothesis
predicted. **WR does not — its never-rostered share is the LOWEST of the
four positions**, even below QB and TE, despite WR over-widening under
`with_busts` just as badly as RB. The hypothesis is already only half right
before the fit is touched.

*Gate fails outright*: `rostered_busts` moves RB/WR's `cov80` by a rounding
error, and in the wrong direction —

| pos | `with_busts` cov80 | `rostered_busts` cov80 |
|---|---|---|
| RB | 0.866 | 0.869 (worse) |
| WR | 0.882 | 0.883 (worse) |

*Why, and it's informative*: the never-rostered rows are a tiny share of the
FITTED population, not of the bust population. RB's evaluated fit population
is 846 rows under `with_busts`; excluding never-rostered busts removes only
11 of them (1.3%). Percentile-based intervals are sensitive to where extreme
values sit, not how many of them there are — and the 24 REMAINING rostered
RB busts (63% of 38) are still scored as a literal, undifferentiated actual
outcome of exactly 0, identical to the ones removed. Splitting the bust
population by whether the zero was "earned" on a roster changes which rows
enter the fit; it does not change what value those rows carry. The
over-widening was never about WHICH busts get counted — it is that EVERY
bust, however it happened, collapses to the same hard zero.

**Consequence, and the more useful one**: this closes "wrong bust
population" the same way (c)/(e) closed their hypotheses — cleanly, by a
pre-registered test that failed for a specific, checkable reason rather than
by degree. A real fix would have to change the VALUE a bust contributes
(a non-zero floor, or a separate bust-probability component blended in
rather than pooled as a literal ratio=0 sample) — a materially different,
un-pre-registered idea, out of scope here.

**But combined with the QB decision already made, this actually resolves
2.1's population question rather than leaving it stuck.** The original
tension was that `survivors` and `with_busts` fail in OPPOSITE directions —
QB needed `with_busts` to pass, RB/WR needed `survivors` to pass, TE passed
either way. QB is now excluded from 2.2 regardless of which population's
number describes it, so the one constituency that ever needed `with_busts`
no longer matters for what ships. Under `survivors` alone: **RB (0.812), TE
(0.780), and WR (0.797) all pass** — every position that remains in scope.
**2.1 ships on `survivors`, for RB/WR/TE.** No further population surgery is
needed; `rostered_busts` stays in the repo as a documented negative result,
same treatment as `RANK_TIERS_BY_POS`/`FIT_WINDOWS` before it.

### 2.2 Weekly-lineup-aware season simulator — CLOSED, no usable weekly distribution (2.2a base AND form-factor follow-up both rejected)
Season totals are the wrong unit: you start ~9 of 15 players each week. Simulate
weeks, set lineups, score the lineup. This makes bench depth worth its true
option value and stops treating a bench player's points as if they counted.

**Validation**: simulated final standings must reproduce historical distributions
of points-for and win totals.

**2.2a WEEKLY OUTCOME DISTRIBUTIONS — pre-registration, written before the code
exists.** 2.1 validated SEASON-total distributions. A weekly simulator needs
weekly points, and the decision taken here is to **fit weekly distributions
directly** rather than draw a season total and allocate it across weeks. The
alternative (season draw + fitted week shares) would inherit 2.1's calibration
for free, but the whole point of 2.2 is bench option value, and option value is
paid out of week-to-week volatility — allocating a season total across weeks
makes that volatility an artifact of the share model rather than something
measured. Fitting weekly directly means weekly calibration must be earned on its
own; 2.1's season gate does not transfer.

*Unit and ratio*: one row per player-week. Ratio = `actual_week_fp /
(live_board_season_projection / expected_games)`, i.e. the same live-board
number 2.1 used, put on a per-week basis. Same `MIN_PROJ_FOR_RATIO` guard,
same deliberate refusal to clip the tail.

*Byes vs inactives — the load-bearing distinction, and why it is not the 2.1
bust question again*: a **bye is deterministic and known ex ante**. It is not a
bad outcome that might happen; it is a week the player structurally cannot
score, visible on the schedule in August. Byes are therefore EXCLUDED from the
ratio fit and handled structurally in the simulator (no lineup slot, no draw).
An **inactive/injured week is stochastic** — you rostered him, he was
unavailable, you ate a zero or burned a bench slot covering it. Those weeks stay
IN, scored as a real 0. This is the opposite treatment from 2.1's rejected
`rostered_busts` split, and for a principled reason rather than a convenient
one: 2.1 was asking which *unknowable* outcomes belong in the fit, this is
separating *knowable schedule structure* from unknowable availability. Byes are
derivable today with no new data — `fantasy_schedule` carries one row per
(season, team, week) and `build_schedule()` only emits weeks a team actually
plays, so a bye is simply a missing week.

*Conditioning, swept in order*: `pos` → `pos_rank` → `pos_rank_opp`, where the
opponent term buckets the defense faced using `sos_engine.adjusted_defense_
ratings()` (already built, already opponent-adjusted, already per position).
**Opponent strength having been asked for is not evidence that it helps** — it
faces the identical bar every other conditioning variable in this file has
faced, >1% relative held-out CRPS, and it is dropped if it does not clear it.
Age failed that bar in 2.1; three of four named team-context signals failed it
in 1.3. The sweep is the point.

*Gate, all three required*:
1. **Weekly calibration**: `cov80` in `[0.75, 0.85]` for RB/WR/TE — the three
   positions 2.1 ships. cov50/cov90 and PIT reported alongside as shape checks.
   QB is excluded from distributions entirely (decision recorded above) and
   enters the simulator as a zero-variance point estimate, so it is not gated
   here.
2. **Sharpness**: each conditioning variable must improve held-out CRPS by >1%
   relative, or it is dropped.
3. **Season coherence — the check that catches the subtle failure.** Summing 17
   INDEPENDENT weekly draws produces a season total that concentrates toward the
   mean by the central limit theorem, so a weekly model that is perfectly
   calibrated week-by-week can still imply a season distribution far narrower
   than the one 2.1 validated. The implied season-total 80% width, simulated,
   must land within **±15%** of 2.1's fitted season width at the same position.
   If it does not, weekly draws are not conditionally independent given the
   projection and the model needs a player-season random effect (a "form"
   factor shared across that player's weeks) before the simulator is
   trustworthy. Pre-registering this because it is the failure that would
   otherwise pass every weekly check and quietly understate every roster's
   variance downstream.

*What 2.2a does NOT settle*: cross-player correlation (same-team stacking, game
script — a QB and his WR1 boom together). Out of scope for this step, documented
rather than silently assumed independent, and revisited only if the standings
validation in 2.2b shows too little spread in points-for.

**RESULT — REJECTED on gate 3, decisively, and it invalidates the whole
independent-weekly-draw construction rather than just missing a threshold.**
Backtest `projection-backtest.yml` #32154937836, 2016–2025, 63,071 player-weeks.

*Opponent strength never earned its place, at any position* — a clean
negative result, same shape as age in 2.1 and three of four signals in 1.3:

| pos | accepted | `pos_rank_opp` vs `pos` |
|---|---|---|
| QB | `pos_rank` (+1.8%) | -0.2%, does not earn it |
| RB | `pos` | -0.2%, does not earn it |
| TE | `pos` | -0.0%, does not earn it |
| WR | `pos` | -0.1%, does not earn it |

Being asked for was not evidence it would help, and it did not. `pos_rank`
itself only earned its keep for QB (which is not gated — already excluded
from distributions) — RB/TE/WR's weekly fit is `pos` alone.

*Gate 1+2 (weekly calibration): only WR clears it.*

| pos | cov80 | verdict |
|---|---|---|
| RB | 0.861 | FAIL — too wide |
| TE | 0.715 | FAIL — too narrow |
| WR | 0.807 | PASS |

*Gate 3 (season coherence) fails for every gated position, and not by a
little* — implied season width lands at **0.27x–0.31x** of 2.1's actual
fitted season width:

| pos | implied season width | 2.1's actual | ratio |
|---|---|---|---|
| RB | 0.445 | 1.603 | 0.28x |
| TE | 0.457 | 1.666 | 0.27x |
| WR | 0.456 | 1.477 | 0.31x |

Summing 17 independent weekly draws would understate every roster's true
season variance by roughly **3–4x** — precisely the failure this gate was
pre-registered to catch before it could quietly reach a simulator. WR passing
gates 1+2 does not save it: gate 3 fails for WR too, just as hard as RB/TE.

*Why, stated precisely rather than left as "weeks aren't independent"*: a
player who is having a good season tends to have MULTIPLE good weeks, not one
good week independently drawn 17 times — health, role, scheme fit and matchup
quality within a season are correlated with each other, and none of that is
in the projection the ratio is measured against. Consistent with this: **49.4%
of player-weeks (byes already excluded) score exactly 0** — real activity
that's this bimodal (played meaningfully, or produced nothing) is itself a
signal that a single pooled weekly distribution is averaging over at least two
different within-season states rather than describing one.

**Consequence: nothing from 2.2a is usable as built.** Per the pre-registered
"all three required" gate, this fails outright regardless of gates 1+2's mixed
result — a simulator built on these weekly draws would look calibrated
week-to-week and be badly wrong about anything that depends on a full season
(which is the entire point of 2.2). The fix named in the gate's own
pre-registration is the next step, not a surprise: a player-season **form
factor** — a per-player-season latent multiplier drawn once and applied to
every week of that player's season, so weeks stop being conditionally
independent given only the position/rank/opponent cell. This is a materially
different model (a hierarchical/mixed-effects structure, not another
conditioning variable to sweep) and is scoped as its own pre-registered step
before 2.2b is attempted. Nothing wired into the frontend; `week_rows`,
`fit_weekly_residuals`, `WEEKLY_CONDITIONINGS` stay in the repo as tested,
working infrastructure that a form-factor fit would build on directly.

**2.2a FOLLOW-UP — pre-registration, written before the code exists: the
player-season form factor.**

*Model*: decompose each weekly ratio as `ratio = form × residual`, where
`form` is drawn ONCE per player-season (a latent "how good was this player's
season, overall" multiplier) and `residual` is drawn independently week to
week (pure within-season noise — this week's matchup, health, game script,
none of it correlated with next week's). This is the standard random-effects
shape for exactly this problem: it puts the correlation gate 3 found missing
back where it empirically lives, between weeks of the SAME player-season,
without inventing a new source of information the earlier sweep didn't have.

*Construction stays empirical, not parametric — same discipline 2.1's whole
docstring is built around*: `form` for a player-season is the arithmetic mean
of that player-season's own weekly ratios; `residual` for a week is that
week's ratio divided by its own player-season's form. Both are pooled as raw
empirical values (own sorted lists, same `MIN_CELL_N`-gated fallback shape as
every other pool in this module) — no assumed shape for either distribution,
just resampling from what actually happened, the same way `predictive_sample`
already works for the season fit.

*A player-season needs `MIN_WEEKS_FOR_FORM = 6` played weeks (byes already
excluded) to enter EITHER pool.* Below that, a player-season's own mean is
mostly week-to-week noise pretending to be a season-level read — the same
"a small sample's tail is noise wearing a number's clothes" reasoning
`MIN_CELL_N` already states for season quantiles, applied here to the mean
instead of the tail. A player-season admitted with too few weeks would also
mechanically produce near-zero residuals around its own barely-sampled mean,
polluting the residual pool with fake precision.

*Conditioning is HELD FIXED at whatever 2.2a's own sweep already accepted*
(`pos` for RB/TE/WR — `pos_rank`/`pos_rank_opp` never earned their bar there)
rather than re-swept here. This keeps the follow-up a ONE-hypothesis test —
does splitting the ratio into two factors fix gate 3 — not a second search
dressed up as a fix, the same discipline (c) and (e) both followed by holding
their non-tested parameter fixed at the prior step's answer.

*Season composition is Monte Carlo, not closed-form*: for a player-season
under test, draw `form` once and one `residual` per actually-played week from
that player's real schedule (byes skipped, same as the base weekly fit),
multiply by that week's live-board per-week projection, sum across the season,
divide by the season's total projection to get a simulated SEASON ratio. Many
draws (2,000) build the simulated season's own empirical distribution,
comparable via the SAME `quantile`/`interval`/`covers` machinery 2.1 already
uses for its season fit.

*Gate, all required*:
1. **Primary — out-of-sample SEASON coverage.** Expanding window (fit on
   strictly prior seasons), for each held-out player-season with actual
   games played that year: simulate 2,000 season draws, build the 80%
   interval, check whether the REAL season total falls inside it. Aggregate
   `cov80` by position. Must land in `[0.75, 0.85]` for **RB, WR, AND TE** —
   this is the test gate 3 exists to be a proxy for, so the follow-up is not
   allowed to declare victory on the proxy (implied width) without the real
   thing (out-of-sample coverage) also passing.
2. **Reported, not gated: the variance split itself.** What fraction of total
   weekly-ratio variance is between-player-season (form) vs within (residual),
   by position — informative on its own regardless of what the gate decides,
   the same way follow-up (a)'s roster-presence measurement stood on its own
   before the fit touched it.
3. **Sharpness sanity check, not a hard bar**: CRPS of the simulated season
   distribution against real season totals, compared to 2.1's own DIRECT
   season fit's CRPS on the same held-out player-seasons. The point of this
   step is not to beat 2.1's season fit — it is to prove weekly building
   blocks can compose UP to something roughly as good, which is the actual
   prerequisite a lineup simulator needs. Materially worse (CRPS up more than
   ~20% vs the direct season fit) would mean the decomposition is throwing
   away real information even where it fixes the width, and is reported as a
   caveat rather than a silent pass.

*What a pass would NOT prove*: that game-script or matchup-specific weekly
correlation (this week's Broncos game plan, not this player's season-long
form) is captured — `residual` is still drawn independently week to week by
construction. If gate 3's collapse turns out to be driven mostly by THAT kind
of correlation rather than season-level form, this fix would still leave
weekly draws too tight, just less so. The out-of-sample coverage gate is what
would actually reveal that gap rather than assume it away.

**RESULT — REJECTED, decisively, and it answers the open question the gate's
own pre-registration flagged: the missing correlation is NOT mostly
season-level form.** Backtest `projection-backtest.yml` #32203391598,
2016–2025, 63,071 player-weeks (the same population 2.2a's rejected base
result used).

*Gate 1 (out-of-sample season `cov80` in `[0.75, 0.85]`, all three of RB/WR/TE
required) fails everywhere it could be measured, and not narrowly*:

| pos | n (held-out player-seasons) | season cov80 | CRPS (form-factor) | CRPS (2.1 season fit) | verdict |
|---|---|---|---|---|---|
| RB | 348 | **0.405** | 28.07 | 26.87 | FAIL — sharpness also worse (+4.5%) |
| WR | 730 | **0.419** | 22.95 | 23.37 | FAIL |
| TE | — | *no eligible held-out seasons* | — | — | FAIL — untestable at this sample size |

Coverage at 0.405 is not a near-miss the way QB's 2.1 follow-up (e) was
(0.743 vs a 0.75 floor) — it is roughly **half** the nominal 80%, on both
positions that could even be measured. TE's form/residual pools hold only 9
player-seasons total (see below), too few for the expanding-window fit to
ever produce a held-out player-season with 6+ prior-season peers to fit
from — TE fails the follow-up gate by being structurally untestable, not by
missing narrowly.

*Reported (not gated): the variance split explains why.* `form` — the
single scalar this fix adds — captures a small minority of total weekly-ratio
variance at every position:

| pos | Var(form) | Var(residual) | form share | n player-seasons |
|---|---|---|---|---|
| RB | 0.0638 | 0.6794 | **8.6%** | 63 |
| WR | 0.0520 | 0.7290 | **6.7%** | 72 |
| TE | 0.0804 | 0.6053 | **11.7%** | 9 |

A one-number-per-season multiplier that owns under 12% of the variance
everywhere cannot supply the correlation gate 3 measured missing — gate 3's
own numbers (implied season width at 0.27x–0.31x of 2.1's fitted width) imply
the within-season correlation needs to explain roughly **3–4x** more shared
variance than an 8.6% form share can provide, even before accounting for
`residual` still being drawn independently week to week by construction.

*This directly answers the "what a pass would NOT prove" clause above*: the
missing correlation was never mostly a season-level "how good was this
player's year" effect — if it were, form would own a large majority of the
variance, not under 12%. The gap is consistent with the game-script/
matchup-level correlation this step's own pre-registration named as the thing
`residual`'s independence assumption could not capture, now confirmed rather
than merely flagged as a risk.

**Consequence: nothing from 2.2a or its follow-up is usable, and no further
fit-side lever on THIS construction (window, recency weighting, a second
random effect layered onto the same ratio decomposition) is likely to close
an 8-to-1 variance gap.** Per the roadmap's own discipline (the same call made
for QB's season tails in 2.1 follow-up (c)), this is reported as a decisive
negative result rather than chased with more knobs on a model that has been
shown, not merely suspected, to be missing the dominant source of
correlation. `simulate_season_ratios()`, `fit_form_pool()`,
`fit_residual_pool()` stay in the repo as tested, documented infrastructure —
the code is correct, the empirical answer it returns is just that this
decomposition does not fix the problem. **2.2 (both the base weekly fit and
this follow-up) is CLOSED without a usable weekly outcome distribution.**
The 2.2b lineup optimizer built ahead of this result (`lineup-optimizer.js`,
27 selftests, fixture-only) stays as tested-but-unwired infrastructure per
its own pre-registration note — it consumes whatever weekly distribution is
handed to it and was never contingent on 2.2a passing to be correct code, only
to be *usable* code. Revisiting 2.2 needs a materially different construction
(e.g. an explicit game-script/matchup correlation term, or multi-week blocks
instead of single-week draws) — not a next-parameter sweep on this one — and
is not scoped here.

**BYE-WEEK STACKING IN THE DRAFT RECOMMENDER (separate, product-facing).**
Independent of the simulator: nothing in the recommender knows about byes today,
so it will happily hand you three starting RBs who all sit in week 9. Same
schedule derivation as above. Scoped as a recommender penalty plus a visible
surface, not a hard gate — a bye clash is a real cost but a small one next to
player quality, and over-weighting it would be worse than ignoring it.

**2.2b WEEKLY-LINEUP SEASON SIMULATOR — pre-registration, written before the code
exists.**

*Goal*: consume validated weekly outcome distributions (once 2.2a and form-factor
gates pass) to simulate full seasons week by week, setting optimal lineups each
week and scoring them. This surfaces the true value of bench depth via option
value — a backup player has zero probability of starting most weeks, but nonzero
probability in bad luck (injury/bye clash) weeks, and that optionality cannot be
valued on season totals alone.

*Architecture*:
  - **Lineup optimizer** (`optimizeLineup()`): given a roster, week, and weekly
    outcome draws, choose the best starting lineup subject to position limits and
    availability (byes, injuries). Returns starters (in position order), bench,
    and the predicted score for this lineup.
  - **Season simulator** (`simulateSeason()`): iterate through all weeks of a
    season, each time drawing from the weekly outcome distributions (form once
    per player-season, residual per week, composed per week's projection),
    optimizing lineups, recording week-by-week scores and final totals.
  - **Roster value decomposition** (byproduct): MVP analysis — which positions
    contributed most value, how much came from starters vs bench, how much
    optionality was actually exercised. Useful diagnostics once the simulator is
    live.

*Inputs*:
  - League settings (roster spots per position, bench depth, number of weeks).
  - Roster (player list with weekly outcome distributions fit by 2.2a/form-factor).
  - Schedule (byes, to exclude from draws — same as weekly fit excluded them).

*Gate, all three required*:
1. **Standings calibration**: simulated season points-for and win-total
   distributions must match historical empirical distributions (2017–2025 from
   league rosters + lineups). Specifically: for each percentile bucket (5th/25th/
   50th/75th/95th), the empirical quantile must land within ±1 SD of the
   simulated distribution's mean. A simulator that is sharp but biased would
   systematically over/understate every team's season outcome; this catches it.
2. **Bench value signal**: simulated value of the bench (cumulative points scored
   by non-starters across season) must be >5 points per bench slot on average.
   If it's <5, bench depth is mostly sitting idle and the simulator is not
   surfacing material optionality. If it's >20 (top quartile), the weekly draw
   is too volatile or the lineup optimizer is not tight enough.
3. **Lineup stability across draws**: for a fixed roster, running the simulator
   twice with different random seeds should give the same week-level lineup
   decisions at least 85% of the time for starters. If lineups are dancing around
   due to sampling noise, the optimization is picking signal that isn't there.
   Replicability matters.

*What 2.2b does NOT handle*: same-team correlation (stacking for salary cap or
upside), opponent roster contents (you're not playing against a roster yet, so
can't measure win probability per week — that is 2.3). This step measures
within-one-roster value, not head-to-head outcomes yet.

*Selftest strategy*: fixture rosters (real 2024 draft results) with real 2024
outcomes, run the simulator expecting it to recover actual 2024 weekly lineups
and season scores within noise tolerance. Does not require live distribution
validation — uses the form-factor code as-is and tests whether the lineup
optimization and compositing is correct.

### 2.3 Championship probability
Simulate your roster against opponents' actual rosters to get P(title). This
becomes the objective every later phase optimizes.

**Kill gate**: P(title) must be *calibrated* — bucket predictions and check that
teams given 15% win about 15% of the time. An uncalibrated title probability is
worse than none, because every downstream decision inherits its bias.

**NOT STARTED, and a feasibility probe comes first — see the restructure below.**
The gate above needs many independent team-seasons with known outcomes to
bucket. One real league-season produces one champion, and this project has no
corpus of historical leagues. Reconstructed leagues can supply arbitrary
volume but risk validating the simulator against its own assumptions. Whether
this gate is *measurable at acceptable cost* is itself an open question and is
settled BEFORE any simulator is written — the `injury_probe.py` precedent,
where the endpoint was verified genuine before 0.3 was built on it.

> **Prompt** — "Start roadmap Phase 2, step 2.1 only: per-player outcome
> distributions with interval-calibration validation. Do not wire them into
> anything until the calibration check passes."

---

## RESTRUCTURE — written after 2.2 closed, before Phase 3 began

Two assumptions that ordered the original plan have expired. Recorded here
rather than silently edited into the phases above, so the reasoning stays
auditable alongside the results that forced it.

**1. Finding A is no longer true. The model now beats the market.** The audit
that opened this document put projection work first because "the market beats
the model at every position." After Phase 0/1, on the same matched population:

| | model now | plain ADP | audit's model |
|---|---|---|---|
| QB | 0.6358 | 0.648 | 0.497 |
| RB | **0.6921** | 0.652 | 0.551 |
| TE | **0.5606** | 0.535 | 0.472 |
| WR | **0.6681** | 0.650 | 0.594 |

The model beats plain ADP at RB/TE/WR and is level at QB. Remaining Phase 1
ideas are chasing +0.003–0.01 against a baseline that has already caught the
market — real diminishing returns, and a reason not to keep mining there.

**2. Finding B is fully intact, but its decomposition was wrong.** The
objective really is still a point estimate everywhere, and that is still the
largest unexploited idea in the tool. 2.2's failure says nothing about the
goal and everything about the route. Two numbers from #32203391598:

- **form owns 6.7–11.7% of weekly-ratio variance** — the missing correlation
  is game-script/matchup-level, not season-level.
- **49.4% of player-weeks score exactly 0**, over ADP-ranked, live-board-
  projected players.

The second is the tell. A process that is half point-mass-at-zero and half
continuous is a **mixture**, and one pooled continuous distribution cannot
represent it — which predicts exactly the failure observed: position-dependent
misses in OPPOSITE directions (TE 0.715 too narrow, RB 0.861 too wide). 2.2
did not fail because the fit was tuned wrong. **It failed because the unit was
wrong.** (Caveat before anyone acts on the 49.4%: it pools all ADP depths and
deep players dominate the count; it needs a rank-conditioned breakdown before
it means what it appears to mean.)

**3. The plan was a tall serial tower, and it does not need to be.** 2.1 → 2.2
→ 2.3 → Phase 3 → Phase 4, each depending on the one below, which put the
highest-payoff lowest-risk work BEHIND the highest-risk work — and that layer
has now failed twice. But every Phase 3 step splits into a mechanism that is
Phase-2-free and an objective that is not:

| step | mechanism (independent) | objective (needs 2.3) |
|---|---|---|
| 3.1 survival probability | P(available at next pick) from ADP + dispersion | "maximize ΔP(title)" |
| 3.2 positional runs | live update from the pick log | — (rides on 3.1) |
| 3.3 auction budget path | knapsack/DP over reachable rosters | "evaluated on P(title)" |
| 3.4 bid ceilings | second-bidder cap from `oppBudgets` | **none — fully independent** |

The original text treats building mechanisms first as a time-pressure
compromise ("if time is short before a draft"). On the evidence it is simply
the better ordering: the mechanisms are near-certain, independent, and closest
to the moment the tool is actually used.

**Consequences, adopted:**

1. **Phase 3 mechanisms proceed now**, against the CURRENT objective, with the
   objective injected rather than inlined.
2. **2.3 gets a feasibility probe before any build** (recorded in 2.3 above).
3. **If Phase 2 resumes, the unit changes from player-weeks to team-weeks.** A
   team-week is a sum of ~9 starters; the zero-inflation that wrecked
   per-player fits largely washes out in the sum, and P(title) only ever
   consumes team totals. The cost is per-player weekly attribution — which
   forfeits start/sit (4.2) and bench option value, but NOT P(title).
4. **"Everything optimizes ΔP(title)" is no longer a prerequisite.** It is a
   target the objective seam can reach later.

**Two disciplines that make "swap the objective in later" a tweak rather than
a rewrite**, and they are commitments, not intentions:

- **The objective lives behind a seam.** Search takes an injected
  `valueOf(player, ctx) → number`. Today it returns VBD; later ΔP(title). If
  point-maximization gets inlined into a DP recurrence or the survival maths,
  swapping the objective means rewriting the search.
- **Do not fit constants under the interim objective.** This project has been
  burned twice by exactly that — 0.2's slot configs died out of sample, and
  1.3's signals evaporated when re-baselined against the live board. Anything
  tuned against points may not transfer to titles. Keep Phase 3 minimally
  parameterized and re-validate after any objective swap.

---

## Phase 3 — Draft-time optimization

The draft is a search problem. **This is where snake and auction genuinely
diverge.**

Per the restructure above, each step is built **mechanism-first against the
current objective**, with the value function injected so a later ΔP(title) can
replace it without touching the search.

### 3.1 Snake: survival probability *(highest-value snake feature)* — DONE, shipped SIMPLIFIED (deterministic margin, not the modeled probability that cleared the gate)
Nothing in the engines computes P(player available at my next pick). This is the
snake question — not "who is best" but "who will not last". Derive it from ADP
and its dispersion, then choose to maximize ΔP(title) rather than raw value.

**PRE-REGISTRATION, written before the code exists.**

*The quantity*: `pSurvive(i, N)` = P(player `i` is still on the board at my next
pick, overall pick `N`). Modelled as a draft position `D_i` centred on the
player's ADP with dispersion `σ`, truncated at 1 (nobody goes before the first
pick), so `pSurvive(i, N) = P(D_i > N)`.

*The dispersion problem, stated rather than papered over*: *no ADP dispersion
exists anywhere in this repo* (`fantasy_players` carries `ecr, adp, aav` — a
consensus mean with no spread; a grep for any dispersion field returns
nothing). σ therefore has to be modelled, and there is no data here to fit it
against.

*So σ is NOT fitted — it is swept, and the sweep is the result.* Rather than
guess a constant and quietly tune it (precisely what the restructure's second
discipline forbids), σ is swept across a wide range and the question asked is
whether **the gate outcome is sensitive to it**:
  - **Insensitive** → the parameter is not load-bearing; ship with a stated
    default and record the insensitivity as the evidence that it does not
    matter.
  - **Sensitive** → we have learned that real draft data is required before
    this can ship, which is a finding and not a failure. It would also mean any
    σ picked today is doing real work nobody measured — the exact thing 0.2's
    hundred slot configs turned out to be doing.

*Shape is held fixed at truncated-normal, and that is a documented limitation
rather than a validated choice.* Real draft position is right-skewed (a player
can fall much further than he can rise). Sweeping shape AND σ together would
make this a two-hypothesis search; (c) and (e) both stayed one-hypothesis by
holding everything but the tested parameter fixed, and this follows them.

*How it changes the pick — a 2-ply lookahead, not a re-ranking.* Today the
engine takes `argmax V(i)`. Survival-aware becomes
`argmax [ V(i) + E(best available to me at my next pick | i taken now) ]`,
where the expectation runs over `pSurvive` for everyone else. That second term
is the entire point: between two players of equal value it prefers the one who
will NOT last. Full DP over the remaining draft is exponential and unnecessary
— 2-ply is where the value is, and the extra plies are unvalidatable anyway
against ADP-bot opponents.

*The objective seam, as a commitment*: the search calls an injected
`valueOf(player, ctx) → number`, defaulting to VBD. ΔP(title) drops in there
later without touching the survival maths or the lookahead. Point-maximization
is not inlined anywhere in either.

*Gate*: paired head-to-head through `draft-sim.mjs`'s existing `pairedCompare`
— survival-aware agent against the current agent, identical pool, seed and
opponent behaviour (common random numbers), so the difference is attributable
to the change and nothing else. Required, both:
1. **Pooled `mean/SE ≥ 2`.** 0.2 established the scale on this exact harness:
   4.24 read as real, 1.16 as noise.
2. **Positive mean at a MAJORITY of draft slots.** A gain concentrated in one
   seat is the signature 0.2 found in the slot configs and is not shippable as
   a general mechanism.

*The threat to validity, named up front because it is severe*: `draft-sim.mjs`
opponents are ADP bots, and `pSurvive` is DERIVED from ADP. The model therefore
has privileged knowledge of exactly how these opponents behave, and beating
them is partly circular — the harness's own header already warns "a config that
only beats ADP bots has proved little." Mitigation, pre-registered: run the
gate across a range of bot `temperature` (how faithfully the room follows ADP)
and **report the edge as a function of room faithfulness**. If the advantage
exists only against faithful-ADP rooms and decays to nothing as the room gets
noisier, that is a much weaker claim than the headline number and gets reported
as such rather than buried.

*What a pass would NOT prove*: that the edge survives against opponents who
themselves reason about survival (the bots do not), or that σ is right (see
the sweep — a pass under insensitivity means σ did not matter, not that it was
correct).

**RESULT — the pre-registered gate CLEARED, then the mechanism was SIMPLIFIED
away from the model that cleared it. Both halves are recorded, because both
are true and the second does not erase the first.**

*Two runs of the gate, 15 minutes apart, same code and seeds, landed opposite
verdicts (+12.00pts/10-of-10-slots vs −2.20pts/2-of-10) before either number
meant anything.* Traced to the actual log, not inferred: `adp_probe.fetch_adp`
had no 429 retry — unlike every other FantasyPros loop in this pipeline,
which already solved this exact problem (`fantasypros._get_json`, 2s/4s/8s/16s
backoff) for `fetch_projections` and `fetch_injuries`. A rate-limited pull
silently returned `{}` for 2024/2025, and `pSurvive()`'s documented fallback
for missing ADP (`p=1`, "assume available") — sane for one missing player —
became a large, uniform, signal-free cost across an ENTIRE season with none.
Fixed at the root (`fetch_adp` now routed through `_get_json`, `export_
draft_seasons.py` paced like every other loop here) and belt-and-suspenders
(`survival-test.mjs` now excludes any season under 120 ADP-covered players
before it can enter a mean, loudly). This is a real, shipped fix independent
of everything below — `git log` on `adp_probe.py`/`export_draft_seasons.py`.

*With the fix in place, backtest via the borrowed 0.2 dispatch slot (run
`32210824536`, 9 seasons genuinely covered — 2024 at 223/464, 2025 at
215/479, both previously zero), the pre-registered gate CLEARS decisively*:

| bar | result | verdict |
|---|---|---|
| pooled `mean/SE ≥ 2` | **+15.00** | PASS |
| positive at majority of slots | **10/10** | PASS |

Circularity control also holds: the edge survives at every bot temperature
tried (2/4/8/16, all 10/10 slots), so it is not merely an artifact of the
bots' own ADP-following rule.

*But a check ADDED AFTER the rate-limit bug — not part of the original
pre-registration — complicates it.* Pooling 10,800 paired drafts as
independent is itself optimistic (seeds inside one season/slot share a
board), so the arm was also read clustered by season, the most conservative
lens and the one with fewest independent units:

| clustering | mean/SE | units positive |
|---|---|---|
| pooled | +15.00 | — |
| by slot | +11.61 | 10/10 |
| by season | **+1.59** | **7/9** |

Season-clustered does not clear the same bar of 2. One season (2024, +70.1)
carries an outsized share of the pooled effect, and 2024/2025 — even after
the fix — remain two of the four thinnest-ADP-coverage seasons (both under
50% of the board). Thinner coverage is the identical fallback mechanism that
caused the bug, just less extreme: more players defaulting to `p=1` inflates
the effect in exactly the seasons where it is largest.

*A correction, caught before it settled into this record rather than after:
an earlier draft of this section cited a "σ sweep found no sensitivity across
a 5x range, mean/SE 12.5–17.1" as a third finding.* That number is the
TEMPERATURE sweep (cv held fixed at 0.35, the workflow having been hardcoded
to a single cv value when restored after the diagnostic phase) — a real
result, but on the wrong axis, mistakenly cited as the cv sweep. The only run
that ever swept multiple `cv` values was the very first one (12 seeds,
possibly predating the ADP-fetch fix — no fingerprint exists for it to check),
and it showed mean/SE near zero at every value (0.01 to 0.24) — underpowered
and likely still exposed to the same rate-limit fragility everything else in
this investigation was, not the "insensitive, so σ doesn't matter" result
originally claimed. **σ's sensitivity is genuinely UNRESOLVED** — a proper
5-value sweep on the fixed, well-covered data was never actually run, and
this document is not going to assert a finding it does not have. The
simplification below does not depend on it; it rests on the two findings that
ARE solidly evidenced (the season-clustering ambiguity above, and the real
fragility the whole investigation surfaced) plus an independent architectural
point: `needMult`/`byeClash` already covered need and byes before 3.1 started,
so the only genuinely missing piece was a next-pick lookahead, and answering
THAT does not require modeling uncertainty at all — a capped deterministic
margin says the same directional thing with far less machinery, regardless of
whether σ would have turned out to matter.

**Consequence: replaced with a deterministic margin, per real-time user
steer that named the same conclusion independently** — `needMult` and
`byeClash` were already shipped and validated in `pickScore` before 3.1
started (bye-week roadmap item), so the only genuinely missing piece was a
next-pick lookahead, and that does not require modeling uncertainty at all.
`margin_rounds = (adpRank − nextPick) / teams`; a capped multiplier (±15%,
unfitted, same discipline as `byeClashStep/Max`) rather than the
opportunity-cost subtraction. No sigma, no distribution, no per-candidate
O(n log n) pass — `adpRank` and `nextPick` are both already-plumbed values.
`survival.js`'s probabilistic core (`pSurvive`/`sigmaFor`/`expectedBest`/
`survivalCosts`) stays in the repo as tested, documented infrastructure — not
because it was wrong, but because it did not clearly earn its complexity, the
same "parsimony decides it" call 0.2 made about the slot configs. Selftests
rewritten for the margin mechanism (46 snake-engine, 28 draft-sim, both
green); the sigma/temperature sweep harness (`survival-test.mjs`) stays as
the tested apparatus that produced the insensitivity finding, not deleted,
but the shipped mechanism no longer depends on running it.

### 3.2 Snake: positional run detection — DONE, shipped
When three running backs go in five picks, the next five are likelier to be
running backs. Update survival probabilities live from the pick log.

**PRE-REGISTRATION, written before the code exists.**

*The quantity*: per-position "hotness" in [0,1] — how far recent picks at a
position exceed its fair share of a one-round window. `MIN_RUN_COUNT = 3`
(the roadmap's own worked example, taken literally, not derived) gates out
noise; `baseline = 1/4` (four skill positions) is the fair-rotation share;
`windowSize = teams` (one full turn of the snake — structural, not fitted:
a run inside one round means something different from the same count spread
across the whole draft).

*What this does NOT attempt*: distinguishing a real run (the room reaching)
from a boring ADP-consistent stretch (round 1 is naturally RB/WR-heavy, so
three RBs in five early picks can be exactly what ADP predicted). Telling
those apart needs an expected-pace model, which is real work with its own
failure modes — 0.2's ten per-slot configs were exactly an attempt at
modelling per-slot expected behavior, and did not survive held-out data. This
ships the simpler, honestly-labeled version: a frequency read, not a
deviation-from-expectation read.

*Mechanism*: feeds 3.1's margin, not a new step. `marginRounds *= (1 -
runMarginDiscount * hot)`, applied before the existing capped-urgency check —
a run means the ADP-implied cushion was computed assuming normal pace, and
the room just demonstrated it isn't drafting at normal pace, so the trust
placed in that cushion shrinks rather than a new signal being invented.
`runMarginDiscount = 0.30`, same unfitted-constant discipline as
`byeClashStep/Max` and `survivalUrgencyMax`: capped so a run can shrink a
comfortable margin, never manufacture urgency out of a genuinely large one.

*No formal historical gate, and that is a deliberate proportionality call,
not a skipped step.* 3.1's own investigation cost real time chasing a
rate-limit bug and a season-clustering ambiguity to validate a mechanism that
was then simplified away — the lesson taken from that is not "always run the
full gate," it is "match the validation to what the mechanism claims." This
is a small, capped multiplier layered on an already-shipped, already-
validated margin, built to the exact same discipline `byeClash` already
shipped under without a historical backtest — that precedent's own words:
"not fitted; there is no held-out evidence behind them, and a bigger number
would need some." A bigger number here would need one too; 0.30 does not.
Validated instead by an end-to-end simulator test that constructs a REAL
emergent run (not a hand-fed hotness value) via `draft-sim.mjs` and confirms
it flips an actual pick — see RESULT.

*What a pass would NOT prove*: that 0.30 is the right cap, or that frequency-
based detection is what a deviation-from-ADP-expectation detector would have
found. Both are open if this is ever revisited with real weight behind it.

**RESULT.** Shipped as `positional-run.js` (`runHotness()`, 16 selftests) —
pure, stateless, takes a chronological position log and returns per-position
hotness. Wired into `pickScore` step 9 (46→53 snake-engine selftests) and
`draft-sim.mjs` (opt-in `cfg.positionalRun`, independent of `cfg.survival` so
paired comparisons can isolate either mechanism; 30 draft-sim selftests, +2
net).

*The load-bearing test is end-to-end, not a hand-fed hotness value.* A board
where the top 60 ADP ranks are entirely running backs guarantees — by
construction, not by seed luck, since bots only ever draw from the top-25-
by-rank of what remains — that all 9 picks before an agent at slot 10 are
real RBs. Without run-awareness the simulator takes a marginally-better-value
WR (133.6 > 130); with it, the SAME real 9-of-9 run the simulator itself
produced (`hot.RB` computed as 1.0 from the actual pick log, not asserted)
shrinks the RB's margin from 1.1 rounds to 0.77, crossing into urgency
(134.5 > 132.6), and the pick flips to the RB. Two real engineering
mistakes surfaced and were fixed getting there, both worth recording because
they're the kind of thing a hand-fed unit test would never catch: giving
every RB filler a high `vbd` (bots pick by rank only, but the AGENT scores
by vbd, so fillers meant only to attract BOTS were also outscoring the
actual test candidates) and not accounting for step 5's WR-era-premium
tiers, which apply by RANK, not raw `adp` (a WR placed at `adp: 200` still
landed inside a premium tier because only 61 total players existed on that
board — fixed by widening the filler pool until its rank genuinely cleared
72, not by asserting the premium away).

**A gap in 3.1 found and fixed along the way.** `pickScore`'s `nextPick`-
driven margin shipped fully tested in the engine and wired into
`draft-sim.mjs`, but was never actually wired into the real app —
`SnakeRoom.tsx`'s `live` object never set `nextPick`, so the mechanism was
live in the simulator that validated it and dead in the product the
validation was meant to justify shipping. Fixed here (`nextPick: nextMine`,
reusing the pick-clock value `SnakeRoom.tsx` already computes) alongside 3.2's
own wiring, since 3.2 modifies the same mechanism and building on top of an
unwired one would have made this step's own validation meaningless. Also
missing and fixed: `survivalUrgencyMax` was never added to `snake-engine.d.ts`
— TypeScript had no way to catch either gap because nothing exercised the
real code path. `npm run build` passed the whole time, which is exactly the
"build does not prove the UI renders" lesson this file already names, one
level removed: build passing proved the TYPES were internally consistent,
not that the feature was reachable.

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
| 2 | Weeks | Largest conceptual | **Highest** — 2.1 done (RB/WR/TE calibrated, QB excluded); 2.2 CLOSED, both attempts rejected; 2.3 not started, pending a feasibility probe |
| 3 | Weeks | Large, format-specific | Moderate — **no longer depends on Phase 2**; mechanisms build against the current objective behind a seam (see RESTRUCTURE) |
| 4 | Ongoing | Large over a season | Low technically, wide in scope |

**Do Phase 0 first regardless.** All three steps are done. It was cheap: 0.1
shipped a real gain (+0.02 to +0.04 Spearman merged, per position), 0.2
removed ~100 numbers nobody could show still earned their place, and 0.3
shipped a real, positionally-honest gain for QB/RB while correctly declining
to ship one for TE/WR.

**Build Phase 3 mechanisms on the current objective** — 3.1 (snake) or 3.3/3.4
(auction). Survival probability and budget paths improve decisions even on a
mediocre projection, because they attack timing and allocation rather than
valuation. Written originally as the "if time is short" fallback; promoted to
the default ordering by the RESTRUCTURE above, on the evidence that the
mechanisms are independent and near-certain while the objective above them has
already failed twice.

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

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

### 0.1b A second expert source: The Athletic — DONE, NOT shipped

**Prompted directly**: the user supplied The Athletic's downloadable
projections workbook (Jake's model) and asked to "consider ways to
incorporate this into the tool and algorithm," with an explicit
requirement — "the cheat sheet is regularly updated, so if we do
incorporate it we should make it fluid, not static." Presented as three
options (auction-value import, second expert-blend source, full
stat-level pipeline ingestion); the user chose the second, then supplied
2024 and 2025 copies of the SAME workbook — both now realized seasons —
"to use for validation," offering to go back further if needed.

**MECHANISM.** `data-pipeline/athletic_projections.py` parses the
workbook's `QB`/`RB`/`WR`/`TE` sheets into the same `proj` shape
FantasyPros already fills, columns located BY HEADER TEXT (not fixed
indices) so a future year's reordered columns don't silently break it.
K/DST are out of scope (matches `EXPERT_BLEND_W`'s own K/DST=1.0 policy).
**Fluid by construction**: the parser takes a file path at call time; no
copy of the workbook or its numbers is ever meant to live in the repo as
production data — same "just pasted this today" discipline the Yahoo and
FantasyPros-AAV paste importers already use, applied to a file upload
instead of pasted text.

**PRECONDITION CHECKED FIRST**: does a second, independently-built expert
source add anything our model doesn't already have? Measured with
`data-pipeline/athletic_blend_backtest.py` against REAL 2024/2025 outcomes,
using only nflverse data (no `FANTASYPROS_API_KEY` needed for this half):

1. **Disagreement signal** (`disagreement_vs_model`, the same
   partial-Spearman construction `disagreement_signal` uses for
   FantasyPros-vs-ADP, here controlling for OUR MODEL instead): strongly
   positive at every position, both seasons, consistent sign —

   | pos | 2024 | 2025 |
   |---|---|---|
   | QB | +0.660 | +0.363 |
   | RB | +0.413 | +0.397 |
   | WR | +0.430 | +0.338 |
   | TE | +0.308 | +0.377 |

2. **Matched-population solo accuracy** (Spearman vs actual season
   points): The Athletic beats our own model outright at every position,
   both seasons — 8 of 8:

   | pos | 2024 model | 2024 Athletic | 2025 model | 2025 Athletic |
   |---|---|---|---|---|
   | QB | 0.619 | **0.802** | 0.663 | **0.711** |
   | RB | 0.690 | **0.748** | 0.734 | **0.767** |
   | WR | 0.683 | **0.751** | 0.709 | **0.739** |
   | TE | 0.653 | **0.666** | 0.773 | **0.783** |

3. **Blend sweep** (pooled 2024+2025, `w` = weight on OUR model, same
   convention as `EXPERT_BLEND_W`): flat near the optimum, but
   consistently favors trusting The Athletic heavily —
   best mean w: QB≈0.1, RB≈0.2, WR≈0.2, TE≈0.4.

**NOT YET GATED THE SECOND WAY** every prior signal here required before
shipping: re-measured against the ACTUAL LIVE BOARD (model + injury
discount + FantasyPros expert blend + anchor already applied), not just
the pure model — the same check that caught the Opportunity model's
QB/WR result "nearly vanishing" in Phase 1 once FantasyPros was already
in the mix. A second expert-like source can easily be re-discovering what
the first already covers; solo-vs-model numbers alone cannot rule that
out. This needs real historical ADP + FantasyPros projections for
2024/2025 (`FANTASYPROS_API_KEY`) — unavailable in the sandbox that ran
the analysis above.

**Also a real, stated limitation**: two seasons is a thin base next to
`EXPERT_BLEND_W`'s own 7-season (2019-2025) fit. The user has explicitly
offered more seasons if the signal warrants extending the check —
worth taking up before finalizing a weight, not just before shipping one.

**Kill gate, once the full-stack data is available** (same bar as 0.1):
matched-population Spearman (now vs the FantasyPros-covered population,
not just vs ADP) must clear what's already shipped, AND the full-board
merged number (model → injury → FantasyPros blend → **Athletic blend** →
anchor) must beat the CURRENT live board — not the pre-0.1 one.

**RESULT: FAILED the full-stack check — NOT shipped.** Run 2026-08-25
(github.com/arimeltzer/fantasy-draft-tool/actions/runs/32911278467), real
FantasyPros historical projections (413/405 players matched, 2024/2025):

| pos | 2024 delta | 2025 delta | consistency |
|---|---|---|---|
| QB | +0.0093 | +0.0000 | **flips direction** |
| RB | +0.0021 | +0.0017 | consistent, but negligible |
| WR | +0.0002 | +0.0049 | consistent, but negligible |
| TE | +0.0053 | +0.0000 | **flips direction** |

(`delta` = best-achievable Spearman with Athletic blended on top of the
already-shipped FantasyPros blend, minus the FantasyPros-only number, on
the full population our model covers — the same construction 0.1's own
merged-number gate used.)

Once FantasyPros is already in the blend, Athletic adds essentially
nothing on top: every delta is under 0.01 — an order of magnitude below
the +0.020 to +0.044 merged gains that actually justified shipping
FantasyPros in 0.1 — and QB/TE flip sign entirely between the only two
seasons available. This does not clear the kill gate above by any
reading of it.

**Read together with the earlier solo-vs-model result, this is the SAME
lesson the Opportunity model's Phase 1 QB/WR result already taught**: a
second expert-like source can look strongly predictive in isolation
(disagreement signal +0.3 to +0.66, solo accuracy 8-for-8 vs our own
model) while turning out to be mostly REDISCOVERING what the first
expert source (FantasyPros) already knows, rather than contributing
genuinely new information. The strong "vs pure model" numbers were real
and not a measurement error — they just don't survive contact with the
board this app actually ships, which already has FantasyPros in it.

**NOT SHIPPED. No `EXPERT_BLEND`-style weight for The Athletic is wired
into `engine-core.js`, and none should be based on this result.** The
parser (`athletic_projections.py`) and backtest harness
(`athletic_blend_backtest.py`) stay in the repo — reusable if the user
takes up the standing offer of more historical seasons (two is thin
regardless of direction), or for the unrelated import paths (auction-
value override, roadmap 0.1b's option A) that were never contingent on
this blend question.

### 0.1c Second opinion display badge — DONE, shipped

**Asked directly as the natural follow-up**: "is there any other use we
should consider for the Athletic projections? Will it better predict how
opponents will act?" Two options were on the table — a rookie-only
re-test of 0.1b's model (untested: 0.1b's gate excluded rookies, and
`rookieProjection()`'s ADP/ECR-curve fallback is a different, already
roadmap-1.4-tested comparison) and a pure DISPLAY badge carrying no
valuation claim at all. User chose the display badge.

**No kill gate needed — the same reasoning 0.1b's own header note already
states about the unrelated auction-value-import path**: this is not a
predictive claim, so there is nothing to backtest. `backend/integrations/
athletic_upload.py` accepts a live workbook upload (multipart), matches it
through the shared `matching.py` index, and the frontend stores the raw
per-category stat line in `settings.athleticProjections` (keyed by player
id) — fluid by construction, same as the 0.1b parser and the AAV-paste
importer. `useBoard.ts` computes `athleticPoints`/`athleticRank` from it
using THIS league's own scoring, strictly AFTER `finalizeBoard` — a
selftest pins that `valuePoints`/`vbd` are byte-identical with or without
an upload present. Surfaced as a teal `AT{rank}` badge next to the name in
both rooms (same slot as the indigo FantasyPros `FP{n}` tier badge), whose
tooltip states outright that it is a second opinion not blended into
valuation, referencing this section. See CLAUDE.md "Second opinion
display" for the full shipped shape.

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

### 2.4 Deterministic bye-aware lineup value — GATE RUN, inconclusive at 432 drafts; larger run pending

**Proposed by the user while revisiting 2.3**: "a model that assumes the
maximum lineup each week of the season accounting for byes. That will
appropriately build in the need for bench depth without putting too much
weight on a single week."

**This is not 2.3 and should not be filed as it.** It produces no championship
probability and needs no calibration gate on a probability. It produces a
deterministic roster-quality number: for each week, the best startable lineup
given who is structurally available, summed over the season. Filed here rather
than under 3.6a because it is a season-level valuation, but it IS the honest
version of 3.6a's bye-coverage credit — computed over a real lineup instead of
as a per-candidate heuristic.

**Why 2.2's closure does not block it, quoted rather than argued.** 2.2a's own
pre-registration already drew exactly this line:

> a **bye is deterministic and known ex ante**. It is not a bad outcome that
> might happen; it is a week the player structurally cannot score, visible on
> the schedule in August. Byes are therefore EXCLUDED from the ratio fit and
> handled structurally in the simulator (no lineup slot, no draw).

2.2 died on the STOCHASTIC half — weekly draws understated season variance 3-4x
and the form factor explained under 12% of the gap. The bye half was never
distribution-dependent; the plan of record was always to handle it structurally
with **no draw at all**. So this step keeps the half that never needed a
distribution and discards the half that failed. Nothing measured in 2.2a or
2.2b argues against it.

**What it consumes, all of which already exists**: `engine/lineup-optimizer.js`
(built and selftested under 2.2b, currently UNWIRED — this is what it was for),
`bye-weeks.js byeByTeam` (shipped, schedule-derived), and the live board's own
season projections put on a per-week basis. No new data, no migration, no fit.

**What it deliberately does NOT capture, stated so it can't be oversold**:
1. **Injury-replacement value.** Nobody is ever unavailable except on a bye, so
   a bench player's only job here is bye coverage. That remains 3.6b, and
   remains gated on its own precondition check.
2. **Volatility option value** — "sometimes your WR3 outscores your WR1." That
   was 2.2's actual thesis ("option value is paid out of week-to-week
   volatility") and it stays closed. A deterministic model prices none of it.
3. **Streaming.** K/DST and deep bench are treated as fixed assets. `maxUseful`
   already caps K/DST depth, so this mostly cancels, but it means the model
   will slightly over-value a backup kicker if that cap is ever relaxed.

**Expected magnitude, estimated BEFORE building so the result can disappoint.**
Byes fall in roughly weeks 5-14, with ~4-6 of 32 NFL teams out per week, so
about 1-1.5 of ~9 starters are unavailable in a typical bye-season week.
Replacing a starter with the best bench body costs on the order of a few points.
Total bye cost is therefore ~40-60 points of ~1500 — but the number that matters
is not that, it is the DIFFERENCE between a well-constructed and a
badly-constructed bench, which is smaller: plausibly 10-25 points a season. That
is a real edge in a league decided weekly by single digits, and it is also small
enough that a null result is entirely possible. Recording the estimate up front
so "it only moved a little" cannot be retold afterwards as success.

**Kill gate, pre-registered — and the trap it has to avoid.** The obvious gate
(does the bye-aware agent score higher bye-aware lineup points?) is circular:
the agent optimizes that metric, so it wins by construction. The gate must score
REALIZED outcomes, not projected ones:

> Over N simulated drafts replayed on historical seasons with common random
> numbers, an agent whose bench valuation uses bye-aware lineup value must beat
> the current agent on **realized** weekly-lineup points — lineups set week by
> week from the ACTUAL bye schedule and scored from ACTUAL per-week results
> (`fantasy_player_logs` already carries `(season, player_id, week, fp)`) — by a
> margin exceeding 2 standard errors. Ship nothing on a within-noise result.

This is measurable with what is in the repo today: `draft-sim.mjs` supplies the
replay harness and common random numbers, `fantasy_player_logs` supplies the
realized weekly scores, and the schedule supplies the real byes. Unlike 2.3's
gate — which needs many independent league-seasons with known champions and may
not be measurable at acceptable cost at all — this one needs only per-week
player scores the database already holds.

**Built, and a real harness bug found along the way.** `bye-lineup-value.js`
implements the deterministic model (`seasonLineupValue`, `marginalLineupValue`,
`byeLineupMult`); `draft-sim.mjs simulateDraft` gained a `byeByTeam` parameter
and `realizedWeeklyPoints` (lineups set by projection, scored on reality —
the harness that avoids the circularity trap). Building the gate surfaced
that `simulateDraft` had NEVER passed a bye schedule to `pickScore`, so the
SHIPPED `byeClash` penalty had never fired in any simulation this repo had
run — every prior "shipped agent" result in this document was quietly a
bye-blind agent. Fixed as part of this step; see CLAUDE.md's live-draft-sync
section for the full note.

**First gate run — 9 seasons (2017-2025), 4 slots, 12 seeds, 432 drafts per
arm:**

| arm | mean | SE | mean/SE | verdict |
|---|---|---|---|---|
| deployment (2.4 vs shipped `byeClash`) | +4.55 pts | 3.49 | 1.30 | NOT significant |
| isolation (bye-aware vs bye-blind) | +7.46 pts | 2.95 | 2.53 | significant |

**Reading this honestly, not favorably.** The isolation arm says there IS a
real bye-schedule signal — a bye-aware agent beats an otherwise-identical
bye-blind one by a margin distinguishable from noise. But the number that
decides whether to SHIP (deployment, vs. what the app actually runs today)
did not clear the pre-registered bar. Per that bar, as written, this ships
nothing yet. The two means are not actually far apart (4.55 vs 7.46) — this
reads as underpowered rather than as a clean null, which is a real,
non-circular distinction the isolation arm's significance supports.

**User's call on how to proceed, having seen this exact result: run a bigger
gate before deciding**, rather than ship early on a promising-but-not-yet-
significant number or discard a real isolation-arm signal. Kill gate stated
as UNCHANGED going in: still mean/SE > 2 on the deployment arm, still scored
on realized weekly points, still nothing shipped on a result inside that bar
even if the new run reads as "closer."

**Second gate run — 9 seasons, 5 slots (1,3,5,7,9), 40 seeds, 1,800 drafts
per arm (~4.2x the first run's sample):**

| arm | mean | SE | mean/SE | verdict |
|---|---|---|---|---|
| deployment (2.4 vs shipped `byeClash`) | +4.67 pts | 1.65 | **2.83** | significant |
| isolation (bye-aware vs bye-blind) | +5.95 pts | 1.41 | **4.23** | significant |

**CLEARS THE PRE-REGISTERED BAR on both arms**, and the pattern that made the
first run read as underpowered rather than null held up: the point estimates
(4.67, 5.95) landed close to the first run's (4.55, 7.46) — this was always a
real, modest-sized effect, and the first run simply didn't have enough drafts
to separate it from noise. Per-season signs are also consistent across both
runs (2017/2021 strongly positive both times, 2019/2020/2022/2023 negative or
flat both times) — the same underlying effect, not a different one appearing
under more samples.

**Shipped**: `snake-engine.js pickScore` step 8 now uses
`bye-lineup-value.js`'s `byeLineupMult` as the DEFAULT bye treatment,
replacing `byeClash` — this is the literal thing the gate measured, so no
further extrapolation is needed to ship it here. `byeClash` itself is kept
(still exported, still tested) as the fallback when `byeByTeam` data isn't
available, and as the documented prior baseline.

**NOT extended to the auction `$Max` ceiling in the same commit — a
deliberate boundary, not an oversight.** The gate validated a SNAKE drafting
decision (which player `pickScore` picks next, replayed to realized weekly
points). It did not test `byeLineupMult` as a DOLLAR multiplier inside
`bidCeiling`/`ceilingFor` — a different selection mechanism (competitive
bidding under a budget, not greedy sequential picking). Reusing the same
validated VALUE FUNCTION as a price multiplier there is a smaller
extrapolation than inventing a new model (same category of reuse as 3.6c's
`maxUseful` and 3.6e's `firstBackupBoost` in a second consumer) — but it is
still an extrapolation past what this specific gate measured, worth a
separate explicit decision rather than folding it in silently alongside a
result that WAS directly measured.

> **Prompt** — "Wire `byeLineupMult` into the auction `$Max` ceiling
> (`AuctionRoom.tsx ceilingFor`) as a bench-phase multiplier on `market`,
> the same pattern `firstBackupBoost` already uses — reusing the
> gate-cleared value function in a second consumer, not a new kill gate."

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

### 3.3 Auction: budget-path optimization *(highest-value auction feature)* — DONE, shipped as PRIMARY (kill gate run via 3.5, CLEAN cleared)
The tool prices players independently. The real skill is allocation: given
remaining budget, remaining holes and expected prices, what roster is reachable?
That is a knapsack/DP problem over the roster, evaluated on P(title).

**PRE-REGISTRATION, written before the code exists.**

*The gap this closes, stated concretely.* `maxBid()` today is
`budget − (openSpots − 1) × $1`: it reserves ONE DOLLAR for every remaining
slot. That is the most pessimistic possible reserve and it is why the tool
"prices players independently" — with a $1 reserve, almost any bid looks
affordable, so affordability never actually constrains anything. The real
question is not "can I still fill the roster with $1 scrubs" but "what is the
best roster still reachable after this purchase".

*The quantity*: `reachableRoster({ slots, budget, pool, valueOf })` — the
DP-optimal total value of the best roster still fillable, given remaining
slots, remaining budget, and each available player's EXPECTED PRICE. Exact
DP over (slot index × dollars spent), not a greedy approximation, because
greedy is wrong here in a way that matters: spending down to the last dollar
on the best available player at each slot in turn is exactly the failure this
step exists to prevent.

*The decision surface*: `bidCeiling(player, ...)` — the highest price at
which buying this player leaves you **no worse off than skipping him**:
the largest `p` where `valueOf(player) + reachable(slots−1, budget−p)`
is still `>= reachable(slots, budget)`. That is the opportunity-cost-correct
ceiling, and it is the number that answers "the real skill is allocation"
directly rather than via a separate planning view.

*The objective is injected, per the restructure's standing commitment*:
everything takes `valueOf(player) → number`. Today callers pass VBD. Nothing
in the DP knows or cares what value means.

*Two approximations, stated up front rather than discovered later*:
  1. **Bench slots are treated as $1 filler and excluded from the DP.** Real
     auction benches largely ARE minimum-bid filler, and including them
     would multiply the state space to model a decision nobody agonizes
     over. Starters are where allocation is decided.
  2. **Candidate pruning is top-K per position** (K stated in code). The DP
     is exact over what it is given; it is not given every deep-bench body,
     because the 300th-ranked WR cannot enter an optimal starting lineup and
     paying to consider him would be pure cost.

*Gate — and an honest statement of what CANNOT be gated here.* The phase kill
gate is head-to-head title share, and **there is no auction simulator in this
repo** (`draft-sim.mjs` is snake-only; nothing else simulates bidding). So the
phase gate is not runnable for 3.3 today, and this step does not pretend
otherwise. What IS gated, and is the load-bearing test:
  1. **DP optimality verified against brute force.** On small cases where
     exhaustive enumeration is tractable, the DP's answer must equal the true
     optimum EXACTLY, over randomized pools — same treatment `survival.js`'s
     prefix-sum shortcut got against its own O(n²) definition, and for the
     same reason: an optimizer that is subtly not optimal is worse than none,
     because every downstream number inherits the error silently.
  2. **`bidCeiling` monotonicity and bounds**: never exceeds `maxBid`'s hard
     cash limit, never negative, and rises with the player's own value.

*What shipping without the phase gate does and does not claim.* It claims the
allocation arithmetic is correct and strictly more informative than a $1
reserve. It does NOT claim a measured title-share edge over the current
independent-pricing behavior — that needs an auction simulator, which is
scoped as its own follow-up below rather than hand-waved as done. Until then
this ships as a SURFACE (a number shown next to the existing bid suggestion),
not as a silent override of `suggestBid` — a mechanism nobody has measured
should not quietly change what the tool tells you to bid.

**RESULT — shipped as a surface at the time; the phase gate has since run
(3.5) and cleared, and the ceiling is now the PRIMARY suggested bid in
`AuctionRoom.tsx`, not just a surface alongside `suggestBid()`. See 3.5.**
`budget-path.js`: `reachableRoster()` (exact DP), `bidCeiling()` (binary
search over the DP, exact because the predicate is monotone in price), and
`remainingStartingSlots()`. 28 selftests.

*The load-bearing test held, and was itself verified by mutation.* The DP
matches exhaustive brute force on 240 randomized cases spanning six slot
shapes including one- and two-FLEX. Rather than trust a clean first pass,
three deliberate mutations were injected: iterating the count dimension
ascending (which would let one player fill two slots) — **caught**, 51
mismatches; restricting FLEX to RB only — **caught**, 21 mismatches; and
flipping a tie-break comparison — **not caught, correctly**, because that
mutation is genuinely semantics-preserving (it changes which of two
equal-value picks is reconstructed, not the optimum). The suite also guards
itself: it asserts the randomized cases actually produced infeasible and
budget-limited instances, since a suite where the budget never bound would
pass trivially.

*The gap it closes is large.* On a realistic 300-player board with a $200
budget and a full starting lineup open, `maxBid`'s $1-reserve says a player
is affordable up to **$186**; the allocation ceiling says **$34**. Mid-draft
with two starters owned and $60 left, the ceiling correctly tightens to
~$19–20. Cost is ~44ms for the four ceilings the panel shows, which is why
`bidCeiling` is documented as per-player and must not be mapped across a
full board.

*Wired into the product, and proven wired.* Shown in `NominationPanel` as
`max $N` beside the existing `bid $N`, never replacing it. `AuctionRoom.test.tsx`
asserts the number reaches the DOM — that assertion exists specifically
because 3.1's margin was fully engine-tested, simulator-wired, and still
DEAD in the product for an entire step while every test and the build passed.
The fixture board (4 players, 7 open slots) legitimately yields `$0` for
every ceiling, so the render test checks reachability and the arithmetic is
checked exhaustively in the engine selftest — the split is deliberate, not a
weakened assertion.

**A real pre-existing bug found and fixed en route.** `AuctionRoom`'s
`rosterSize` summed `r.K` and `r.DST` with no fallback (only `SF` was
defensive). Any league whose roster config omits a kicker or defense — common
— made `rosterSize` `NaN`, which flowed into `dollarValues`' `leagueAvail`
and surfaced as a literal **`bid $NaN`** in the nomination panel. It
reproduces on the pre-change commit, so it is not something 3.3 introduced;
it was found only because 3.3 put a second number next to it and the fixture
happened to have no K/DST. Fixed with `?? 0` on every term, plus a
regression test asserting no suggested bid renders as NaN. Worth noting as a
category: this is the same failure shape as the roadmap's own `npm run build`
lesson — nothing was broken loudly, a real league would just have seen
nonsense where a bid should be.

*Still open, and deliberately not claimed as done*: the Phase 3 kill gate
(head-to-head title share) has NOT been run for 3.3, because no auction
simulator exists. Building one is its own step — and its own hazard: bots
bidding at `marketPrice` while the agent derives ceilings from `marketPrice`
would be circular in exactly the way 3.1's ADP-bot harness was, so the
honest version compares allocation-aware against independent-pricing agents
under identical bot behavior rather than measuring either against a strawman.

### 3.4 Auction: bid ceilings from opponent budgets — DONE, shipped as PRIMARY (kill gate run via 3.5, CLEAN cleared)
A price is set by the *second* bidder. If only two teams can afford $50, that is
the cap. `oppBudgets` is already tracked but only reduced to `richFrac` for
nomination timing.

**PRE-REGISTRATION, written before the code exists.**

*The quantity, and why raw budget is the wrong one.* An opponent holding $180
with fifteen roster spots still to fill cannot bid $180 on anything — they
must keep a dollar for every remaining slot. Their real capacity is
`maxBid(budget, openSpots)`, the function `auction-engine.js` already exports
and already applies to ME. 3.4 is, at its core, applying it to everyone else
too. Raw `oppBudgets` would systematically overstate what the room can pay,
worst exactly when it matters most (mid-draft, deep rosters).

*The ceiling*: nobody can be outbid by money that does not exist. If the
richest opponent's capacity is `C`, then no player sells for more than
`C + minBid` — I win at one increment above the best anyone else can go. So
`priceCeiling = max over opponents of maxBid(budget_i, openSpots_i) + minBid`,
and the expected price for a player becomes `min(market, priceCeiling)`.

*This is a CAPACITY bound, not a willingness prediction, and the distinction
is the whole honesty of the step.* It says what the room CAN pay, never what
it WANTS to pay. An opponent with $90 free who needs no running back will not
bid on your running back, and this will still count their $90. So:
  - As an **upper bound it is hard** — the arithmetic cannot be beaten, money
    that isn't there can't be bid.
  - As a **point estimate it is biased high**, and increasingly so as
    opponents fill their needs.
It therefore ships as a CAP on the expected price (`min(market, ceiling)`),
never as a replacement for market — capping can only ever move a price down
to something genuinely unpayable, which is the safe direction. The unsafe
direction (predicting a player will go cheap because nobody *wants* him) is
not attempted.

*Composition with 3.3, which is the point of doing them adjacently.* 3.3
answers "what can I afford given my own roster"; 3.4 answers "what will the
room force me to pay". The actionable number is `min(allocationCeiling,
contestedCeiling)` — the binding constraint, whichever it is. Reporting
which one binds is more useful than the number alone, so the surface names
it.

*Gate.* Same position as 3.3, for the same reason: the Phase 3 kill gate
needs an auction simulator that does not exist. What is gated:
  1. **Capacity arithmetic against `maxBid`**, the function that already
     defines this for my own side — an opponent's capacity must equal what
     `maxBid` would say for a manager in that seat. Any divergence means two
     places in the codebase disagree about what a budget can buy.
  2. **Monotonicity**: the ceiling falls as budgets drain and as opponents
     fill spots, never rises. Late-draft it must approach `minBid`.
  3. **A full opponent contributes nothing.** A team with no open spots
     cannot bid at any budget, and must not prop the ceiling up.

*What a pass does NOT prove*: that any opponent actually wants the player, so
a bound that is loose early in a draft (everyone rich, everyone needy) is
expected and is not a defect.

**RESULT — shipped, composed with 3.3.** `opponent-capacity.js`:
`opponentCapacities()`, `priceCeiling()`, `cappedPrice()`, and
`bindingCeiling()` (the 3.3 + 3.4 composition). 23 selftests, all three
pre-registered gates met.

*Gate 1 held by construction, deliberately.* Capacity routes through the
shipped `maxBid()` rather than reimplementing the reserve arithmetic, and the
selftest checks agreement across 464 budget × spot combinations. Mutating it
to use raw budget — the exact overstatement this step exists to prevent —
diverges on 420 of them.

*Gates 2 and 3 held.* The ceiling falls monotonically as budgets drain AND as
opponents' remaining spots grow, bottoms out at `minBid` in a broke room, and
a full roster contributes nothing at any budget. Over a realistic ten-team
draft arc the ceiling tightens monotonically and ends well under a full
budget, so the bound is informative late rather than vacuous.

*Mutation-tested, and one mutation exposed a real test gap rather than a code
bug.* Using raw budget: caught. Letting a full roster bid: caught. Deleting
the `alloc <= 0` guard in `bindingCeiling`: **NOT caught** — and
investigation showed why. Since `priceCeiling` floors at `minBid >= 1`,
`0 <= roomCeiling` always holds and the general branch returns the identical
result, so the guard is genuinely redundant *for zero*. It is load-bearing
only for negative input. Rather than delete a guard that documents a real
contract or leave it untested, a test was added for the case it actually
defends — defensive code nothing tests is indistinguishable from dead code.
Re-running the mutation now catches it.

*Composition is the payoff, and the surface names which constraint binds.*
3.3 answers "what can I afford given what I still have to fill"; 3.4 answers
"what will the room force me to pay". `NominationPanel` shows the binding
one, in a different colour with a `*` when it is the room's money rather than
my roster — the difference between "I can't afford him" and "I don't have to
pay that much". Verified end-to-end through a mounted room: with opponents
flush the ceiling reads `max $29` (allocation binding); with two opponents
each having blown $197 of $200 the same player reads `max $2*` — you never
pay above $2 for a $29 player when nobody can bid.

*That test needed a deeper board than the shared fixture, and the reason is
itself worth recording*: with the 4-player fixture no roster is reachable at
all, so 3.3 correctly returns `$0` and binds first, and 3.4 can never be
observed. A test using the shared fixture would have passed while proving
nothing about 3.4.

*Same gate status as 3.3*: the Phase 3 head-to-head kill gate is still NOT
run, because no auction simulator exists. This ships as a bound and a
surface, not as a measured edge.

**3.4a FOLLOW-UP — positional demand — DONE, shipped. PRE-REGISTRATION, written before the
code exists.**

*The gap.* 3.4 as shipped is position-blind: every opponent with money is
treated as a potential bidder on every player. But a team that has filled
every running-back slot it will plausibly use is not going to bid on your
running back, whatever its balance says. The ceiling is therefore loose in
exactly the common case — one rich team with no need at the position holding
the whole estimate up.

*The model, and the two variables it is built from* (both named by the user's
own framing: we cannot know how any opponent VALUES players, so the model
uses only what is observable — how many bodies they still need at each
position, and how much money they have):
  - `opponentDemand(pos, leagueRoster, theirCounts)` — how many more at that
    position a team would plausibly roster. An opponent with zero demand at a
    position contributes **nothing** to that player's ceiling.
  - Capacity, unchanged, is still `maxBid(budget, openSpots)`.
  - `priceCeilingFor(pos, ...)` = one increment above the richest opponent
    **who still needs that position**.

*The demand cap is explicit, stated, and NOT reused from `maxUseful`.* That
function returns `starters + FLEX + max(2, BENCH)` for RB/WR — nine backs in
a standard league — because its job is to avoid BLOCKING a defensible sixth
RB on my own roster. Borrowing it here would gate almost nothing. Opponent
demand needs its own tighter caps, and per the user's instruction **K and DST
are capped at one apiece** — nobody rosters a second kicker, and letting the
model think they might would keep a filled team alive as a phantom bidder.
Caps are stated constants, unfitted, same discipline as `byeClashStep` and
`survivalUrgencyMax`.

*THE CLAIM WEAKENS, AND THAT IS THE IMPORTANT PART.* Shipped 3.4 is pure
arithmetic: money that does not exist cannot be bid, so the bound cannot be
beaten. Demand gating is a **behavioral assumption** — if an opponent takes a
fourth tight end, the gated ceiling is simply WRONG in the unsafe direction
(it told you the price would be low, and it was not). So:
  - The arithmetic ceiling is **retained, not replaced**. Both are computed.
  - The demand-gated number is the estimate; the arithmetic one remains the
    guarantee. Where they disagree the surface can say so.
  - Being wrong here costs a player you wanted, which is worse than the
    reverse, so the gating must be conservative: when in doubt, assume
    demand exists.

*Gate*:
  1. **Demand monotonicity**: filling a position never increases demand there;
     a team at its cap has zero.
  2. **K/DST capped at one**, regardless of league roster settings claiming
     otherwise.
  3. **Gated ceiling is never above the arithmetic ceiling** — gating may only
     ever tighten. If it can loosen, the two disagree about what money exists.
  4. **A team with no demand at a position cannot set that position's
     ceiling**, however rich.

*What a pass does NOT prove*: that the demand caps are right. They are
judgement, not measurement, and no auction simulator exists to score them.

**RESULT — shipped.** `opponentDemand()`, `priceCeilingFor()`, and
`opponentCountsFromPicks()` added to `opponent-capacity.js`. 49 selftests
(was 23), all four pre-registered gates met.

*The caps.* `OPP_BENCH_ALLOWANCE = { QB 1, RB 3, WR 3, TE 1, K 0, DST 0 }`
on top of starters plus FLEX for the flex-eligible positions, with K and DST
hard-capped at one apiece regardless of what the league settings claim.
Deliberately generous: gating a position OFF wrongly is the expensive error
(it says a player will go cheap and then he does not), so when in doubt the
model assumes demand exists.

*Mutation-tested, three for three.* Dropping the K/DST singleton cap in
favour of the league setting — caught. Ignoring demand entirely so gating
never bites — caught, 6 failures. Letting gating LOOSEN rather than only
tighten — caught, including the pre-registered gate-3 sweep across every
position.

*One design correction found while wiring, worth recording because it would
have silently disabled the whole step.* `bindingCeiling` re-derives the
ceiling from a raw per-opponent capacity list. Handing it the ungated list
after computing a gated ceiling would have thrown the gating away and left
3.4a inert while every engine test still passed. The composition now passes
a single synthetic capacity representing the already-gated ceiling, with a
comment saying why.

*The derivation moved into the engine, and that was a test-quality decision
rather than tidiness.* Per-opponent positional counts were first written
inline in `AuctionRoom`, where proving they worked meant constructing a
fixture in which the top-surplus target sat at a position both opponents
were sated at while staying rich, available, and on a fillable roster. Four
attempts each failed for a different incidental reason — the top target kept
landing at a position other than the one being stacked, then the stacking
consumed the very players the target list drew from. That is fixture
gymnastics proving very little. `opponentCountsFromPicks()` is now an engine
export tested directly (mine-vs-opponent, null player, out-of-range teamId,
Map or plain-object lookup) plus an assertion that counts from a pick log
actually move the gated ceiling — the same extraction, for the same reason,
that `remainingStartingSlots()` got in 3.3.

*Standing caveat, unchanged and important.* The arithmetic ceiling is still
computed and returned alongside as `arithmetic`. It is the guarantee; the
gated number is the estimate. **Update: the Phase 3 head-to-head kill gate
HAS since run (3.5, auction-sim.mjs) and CLEAN cleared it** — the demand
caps' judgement is no longer un-scored, though the gate measured 3.3+3.4+3.4a
together (the treatment bid always composes all three), not 3.4a in
isolation, so the specific marginal contribution of the demand caps alone
is still unmeasured. See 3.5 for the numbers.

### 3.5 The auction simulator — the harness 3.3/3.4/3.4a have been waiting on

**PRE-REGISTRATION, written before the code exists.** This harness decides
whether three shipped-but-unmeasured steps earned their place, so its own
design decisions are what make those verdicts mean anything — or not.

*What it simulates.* An open (English) auction reduced to its outcome: for
each nominated player every team forms a willingness-to-pay, the highest WTP
wins, and the price is **one increment above the second-highest** — which is
what an ascending auction converges to and is exactly the mechanic 3.4 is
built on. Budgets and roster slots are enforced throughout; a team that
cannot legally add a player cannot bid.

*The arms.* Both face identical bots.
  - **Control**: `suggestBid()` — the shipped independent-pricing behaviour.
  - **Treatment**: bid up to `min(allocationCeiling, roomCeiling)` — 3.3's
    opportunity-cost ceiling composed with 3.4/3.4a's room cap.
Nomination is held FIXED and identical across arms, so the comparison
isolates bidding. Nomination strategy is therefore explicitly NOT tested
here; that is scope, stated rather than discovered later.

*THE CIRCULARITY HAZARD, AND WHY IT IS DIFFERENT FROM 3.1's.* In 3.1 the
agent's `pSurvive` came from ADP and the bots drafted by ADP, so the agent had
privileged knowledge of the room and beating it proved little. Here the
structure genuinely differs: **both arms use the same market prices**, so any
privileged knowledge is shared and cancels — what the comparison isolates is
allocation strategy alone. The residual hazard is narrower and specific:
  - 3.4a's demand caps could be validated by construction if the BOTS use the
    same positional-need model the agent assumes. So the bots get their OWN
    need rule with a different shape and their own parameters, never
    `opponentDemand()`.
  - A perfectly market-priced room makes the auction trivially predictable and
    would flatter an optimizer. So bot pricing carries noise, and **the noise
    level is swept** — the same mitigation shape as 3.1's `temperature`,
    reporting the edge as a function of how disciplined the room is rather
    than at one convenient setting.

*What is scored, and what that does NOT satisfy.* Best legal starting lineup
on ACTUAL season points, via `bestLineupPoints()` — the identical measure
`draft-sim.mjs` already uses, reused deliberately so the auction and snake
sides are not judged on different yardsticks. **This is not title share.** The
phase gate as literally written asks for titles, and title share needs 2.3,
which is CLOSED. Points are the substitute the snake side has used since 0.2;
using it here is consistency, not a fresh dodge, and the distinction stays on
the record.

*Paired, with common random numbers*, like `pairedCompare` — same board, same
seed, same nomination order and bot draws until the arms actually diverge.
Once one arm buys a different player the rooms genuinely differ; that is
inherent to sequential drafting and is the same limitation the snake harness
carries.

*The harness is verified BEFORE it is allowed to produce a number.* Precedent
is `draft-sim.mjs`, whose workflow runs its selftest first because it decides
whether 100 tuned parameters stay in the engine. Required of this one:
  1. **Budget and roster invariants hold** — no team ever overspends, exceeds
     its roster, or bids on a slot it cannot fill.
  2. **Second-price mechanics are exact** on hand-computed cases, including
     the one-bidder case (sells at the minimum) and ties.
  3. **Identical arms produce EXACTLY zero difference on every seed** — if two
     copies of the same agent diverge, the pairing is broken and every number
     the harness reports afterwards is noise. This is `draft-sim.selftest`'s
     own load-bearing assertion and it transfers directly.
  4. **A deliberately crippled agent loses** — so the comparison is wired the
     right way round.

*What a result here will and will not settle.* It can show whether
allocation-aware bidding beats independent pricing against these bots on
points. It cannot show it beats human rooms, cannot rank nomination
strategies, and cannot speak to title share.

**BUILT.** `frontend/src/engine/auction-sim.mjs` implements the design above;
`auction-sim.selftest.mjs` (46 assertions) clears all four pre-registered
requirements — confirmed with three deliberate mutations (pay-full-price
instead of second-price, drop the K/DST singleton cap, and a `Math.random`
leak in place of the seeded RNG), each one caught by the selftest and
reverted before commit, the same discipline earlier engine files in this
phase used. One bug surfaced along the way and is worth recording: the first
draft mapped "no open starting slots" to an allocation ceiling of **0**,
which is wrong — `bindingCeiling` (and the shipped `AuctionRoom.tsx`, which
passes `null` for exactly this case) treats it as **unconstrained**, deferring
entirely to the room ceiling, because a full starting lineup does not mean
a bench spot is worthless. The bug was visible immediately: the treatment
arm's simulated roster came in at 9/15 slots filled against control's 15/15
on a debug board. Fixed to match the shipped semantics; rosters normalized.
`auction-sim-test.mjs` + `.github/workflows/auction-sim-test.yml` run the
actual gate (treatment vs. control, swept bot-pricing noise, 2017–2025).

**FIRST RUN (workflow run 32285769569, 2017-2025, real ADP): treatment beat
control at every noise level, RAW — but the raw number overclaims, and the
gate was rebuilt before that number gets used for anything.** The raw effect
was enormous by this document's standards — +783 to +966 pts/draft averaged
over 900 auctions per noise level, mean/SE in the 90s-160s — an order of
magnitude past any other measured effect in this file. That size was the
tell. A local diagnostic (real 2023 skill-position data, synthetic market
coverage to control the mechanism) found the concrete driver: `suggestBid()`
carries a real, previously undocumented weakness — its `qbMarketCap` throttle
caps a QB bid at ~90% of MARKET price, and when the market has no ADP for
that season's elite QBs (`marketPrice()` floors an uncovered player at
`minBid`), control can end the draft having **never rostered a starting
QB at all**. Historical ADP coverage genuinely runs this thin — the same
export logged 36-62% of the board uncovered across 2017-2025 — so this
is not an edge case. One reproduced instance: 62% synthetic coverage, one
seed, control finished 0/1 QB at 1555.9 pts vs. treatment's 2/1 QB at
1800.9 — a ~245pt swing on ONE team from a single unfilled starting slot,
the kind of gap that dominates an average once it recurs across seasons
and slots. That is a correctness-adjacent bug in the CONTROL arm, not
evidence that 3.3/3.4/3.4a's allocation logic is smarter — a raw points
gap cannot tell the two apart, and reporting it as "ship the DP as
default" off that number alone would be exactly the kind of unmeasured
overclaim this document exists to prevent.

**The harness was corrected, not the finding suppressed.** `pairedCompareAuction`
now also runs `remainingStartingSlots` on each arm's FINAL roster and reports
`controlEmptySlotRate` / `treatmentEmptySlotRate` plus a `cleanMeanDiff` —
the mean restricted to drafts where control filled every starting slot,
which isolates the allocation-logic question 3.3 was actually built to
answer. `simulateAuction` also gained a `controlParams` seam (bid-shaping
params only, e.g. `qbMarketCap`, threaded to control's own `suggestBid()`
call — the shared market/dollar-value numbers both arms see stay canonical
and un-overridable) so this exact mechanism can be swept directly in a
follow-up rather than only inferred from the empty-slot rate. 3 new
selftest assertions (49 total) pin the diagnostic itself: a passive bidder
must always show `treatmentEmptySlotRate === 1` (positive control on the
metric), and identical arms must report identical empty-slot rates and a
zero clean mean.

**RE-RUN RESULT (workflow run 32288720778, corrected harness, same 2017-2025
real ADP): the empty-slot hypothesis was WRONG, and CLEAN clears the gate.**
Control's actual empty-starting-slot rate turned out low — 0% most
seasons, peaking at 8% in 2022 (the thinnest-ADP season measured), not the
near-total failure the one-seed local diagnostic suggested. More
importantly, **filtering those drafts out barely moves the number**: CLEAN
mean/SE is statistically indistinguishable from RAW at every noise level
(noise 0.05: +966.08 clean vs +965.71 raw; 0.15: +870.95 vs +870.12; 0.30:
+784.60 vs +783.34 — all mean/SE in the 90s-130s, treatment winning
887-891 of 888-891 clean drafts, effectively 100%). The empty-slot bug is
real and worth fixing on its own terms, but it is NOT what the raw gate
number was measuring — ruling it out, rather than confirming it, is the
actual value the diagnostic delivered.

**The real mechanism, evidenced directly:** the earlier local debug (real
2023 board, one seed) showed CONTROL spending only $30-46 of a $200
budget while still fielding a full 15-man roster — not an empty slot, a
CHEAP one at nearly every slot. `suggestBid()`'s bid-shaping
(`fairShare = surplus * (dv / remainingDvSum)`, `ratioScale` clamped to
`[0.5, 1.4]` of a market-relative ratio) is calibrated for a market that
prices most of the board. Real historical ADP coverage does not: the same
export logged 36-62% of the board uncovered every season 2017-2025, and
`marketPrice()` floors an uncovered player at `minBid` for EVERY bidder —
bots included, since `botWTPMultiplier` also scales off `market`. When
roughly half the field is anchored near $1 by construction, the room as a
whole underspends, and the one bidder whose ceiling is NOT market-relative
(treatment's `bidCeiling`/`bindingCeiling`, bounded by opportunity cost and
actual budget, never by a ratio to a possibly-absent market price) buys the
real value nearly uncontested. That is a genuine, mechanistically
understood edge, not an artifact — but it is specific to auctions where a
large share of the board lacks a price signal, which is exactly what these
historical seasons have and plausibly overstates the edge in a live room
using current-season FantasyPros ADP with materially better coverage than
a multi-year nflverse-archive backtest can reconstruct.

**Verdict: CLEAN passes the pre-registered bar (mean>0, t>2) at every swept
noise level — 3.3+3.4+3.4a's allocation logic beats independent pricing,
and the win is not explained by a control bug.** Recommended next step is
narrower than "flip the shipped default": wire the allocation-aware ceiling
as the PRIMARY suggested bid in `AuctionRoom.tsx` (currently shown
alongside `suggestBid()`'s number, not replacing it — see 3.3/3.4's own
headers) for QB/RB/WR/TE where the DP applies, with K/DST unchanged. Not
done in this session — changing what number a live, deployed tool tells its
user to bid is an outward-facing behavior change to someone's actual
draft-day tool, worth a confirm rather than a silent flip, especially given
how large and clean this specific measured edge is (900/900 and near-900/900
wins is unusually total for any effect in this document and deserves a
second season's data or a live-inflation-aware follow-up before being
trusted at face value for magnitude, even though DIRECTION is robust across
every season and noise level tested, raw and clean alike).

**SHIPPED.** The allocation-aware ceiling (3.3+3.4+3.4a composed) is now the
PRIMARY "bid $" in `AuctionRoom.tsx`'s value-targets panel, for QB/RB/WR/TE —
K/DST unchanged, staying on `suggestBid()`, matching the DP's own scope
(`bidCeiling` never covers them; see 3.3's header). `suggestBid()`'s own
number is NOT hidden — it stays visible as a secondary "model $X" / "model
pass" badge, since two methods disagreeing is informative, not noise.
"pass" on the primary number now means what it should for a ceiling: your
own allocation says he doesn't improve your reachable roster at any price
(`ceiling <= 0`, or allocation-bound and under market) — a room-bound
ceiling under market is the OPPOSITE of a pass signal (nobody there can
outbid you), so it is no longer conflated with one. `AuctionRoom.test.tsx`'s
roadmap-3.3 suite was rewritten for the swap rather than left describing
the old default (a stale test masking a real behavior change is worse than
no test) — the K/DST-NaN regression check was also broadened, since a $0
allocation ceiling now legitimately renders "pass" instead of a "$" amount,
which had made the old text-pattern assertion vacuously pass on an empty
match set. 58/58 vitest, full selftest, and build all green.

**FOLLOW-UP FIX: a "target" that says "pass" is a contradiction, caught by
the user immediately after shipping.** `valueTargets`' top-4 was selected by
`surplus` (our `dollarValue` vs. market) alone, computed BEFORE the ceiling
— so a player could rank #1 on "the market undervalues him" and still
legitimately be a `pass` from the ceiling ("doesn't help YOUR roster right
now," e.g. already full at his position). Surplus answers a market question;
the panel's own heading ("your targets") promises a roster-fit answer. Fixed
by widening the candidate pool (top 10 by surplus, still capped well short
of the whole board — `bidCeiling` is a DP and stays off the full board per
its own header), computing the ceiling for all 10, filtering out every
`pass`, THEN taking the top 4. A board where nothing clears the bar now
correctly shows zero targets, not four contradictory ones.

**Also added: the same suggestion on the MAIN BOARD**, not just the fixed
4-row panel — the moment it actually matters in a live draft is when someone
nominates a player and you search his name, which is a different place from
"your targets." First version was gated on an active search narrowing the
visible list to `<= 8` rows before computing anything, guarding the DP cost
`bidCeiling`'s own header warns about. `ceilingFor()` was extracted out of
`valueTargets` into a shared callback so the panel and the board lookup
cannot drift about what "the suggested bid" means.

**UNGATED after a user asked for it as a real column, and a real benchmark
said the gate was overcautious.** The warning in `bidCeiling`'s header was
written before anything measured the actual cost. It came in far cheaper
than that caution implied: the full DP over a 300-player undrafted
QB/RB/WR/TE pool — the entire board a live draft would ever show —
completes in **under 90ms total (~0.3ms/player)**, and `ceilingByPlayer` is
memoized on draft-state (`availDollar`), not on search/filter, so that cost
is paid once per PICK, not once per keystroke or render. Cheap enough to
show for every row unconditionally, which is what "the draft board... should
also display the allocation ceiling for each player" actually asked for.
Shipped as a proper `$Max` column (sm+ screens) next to `$Live`, with the
same `bid $X` / `pass` / room-bound `*` semantics as the panel; mobile keeps
a compact inline badge in the name's subtext line, since the dedicated
column has nowhere to go at that width. Tests updated to match: the old
"does NOT show when the search is broad" reachability check inverted into
"populates for the WHOLE board, not gated on search" (61/61 vitest still).

**Two more polish items from the same round of feedback:**
- **A "target" that said "pass" was contradicting its own panel heading**
  (see the FOLLOW-UP FIX above) — while fixing the display, the secondary
  `suggestBid()` comparison ("model $X") was also crowding the player name
  off the row on narrow panels; moved to its own indented line under the
  primary bid rather than sharing the name's line.
- **A clear (×) button in the board search box** (`BoardControls.tsx`,
  shared by both rooms) — appears only when the query is non-empty, clears
  just the text and leaves the position filter untouched, matching what was
  asked for exactly rather than a broader "reset all filters" that would
  have discarded a deliberately chosen position filter too.

**CORRECTION: "pass" was still conflating two different things, and it took
a second round of feedback to see it.** `pass` fired on `ceiling <= 0` OR
`(binding === "allocation" && ceiling < market)` — the second clause hid a
real, positive, computed number any time the ceiling fell short of the
modeled market price, on an unstated "if you probably won't win, don't show
a price" theory. Flagged directly: *"There must be some price that would be
worth paying for the top players in the league. Even if I don't ultimately
get them, why not display a price?"* — exactly right, and exactly the
players most likely to trip that clause (an elite player's market price is
high, so a real, positive, below-market ceiling was common for the players
where showing the number mattered most). Fixed: `pass` is now `ceiling <=
0` ONLY — the one case where there is truly no price worth paying. A
positive ceiling below market gets a new `belowMarket` flag instead of
suppression: still shown as a real `$X`, marked `~` (distinct from the
room-bound `*`) and explained in the tooltip as "your walk-away point, not
a price you're favored to win at." This also loosened `valueTargets`'
`!pass` filter for free — a below-market player who was previously excluded
from "your targets" entirely can now appear there, which is correct: he may
still be your best available target if the room goes cold. One new
regression test locks in the fix directly (P7 on the DEEP_BOARD fixture is
a known belowMarket case): asserts a real `$X~` renders and that `"pass"`
does not appear for it. 62/62 vitest.

**FOLLOW-UP: real current-season FantasyPros AAV data refines the mechanism,
and the refined version is a MORE fundamental problem with `suggestBid()`
than ADP coverage.** The user supplied a real FantasyPros auction-values
cheat sheet (a website page, not an API response — confirmed against
`fetch_aav()`'s own docstring, which documents the public v2 API as having no
auction-shaped endpoint at all; see the new `fantasypros_aav_paste.py`
importer below). It prices 258 skill-position players, 167 of them with a
real nonzero $ — 65% coverage, meaningfully better than a typical historical
season's ADP coverage (36-62% uncovered per the gate's own export log). The
natural next question: does feeding this INTO the market (`marketPrice()`
already prefers `aav` when present) close control's chronic underspending?

**It does not — spend went DOWN, not up** (a quick diagnostic script, real
player pool + real AAV, FantasyPros' own projected-points column standing in
for `vbd` since true VBD needs the full `valueBoard` replacement-level
pipeline this ad hoc check didn't run — stated so the exact numbers below are
read as illustrative, not a re-measurement of the validated gate): control's
spend went from $30/$200 (no AAV, modeled curve) to **$24/$200 with full real
AAV**, while treatment's went from $29 to **$153**. Inspecting one player
directly explains why: Jahmyr Gibbs, RANK 1 OVERALL, real AAV $63 — and
`suggestBid()` offered **$2**. Not because the market was thin (`aav` was
right there, `marketPrice()` used it, `market = 63`); because `fairShare`
scales with the app's OWN `dollarValue` (`$20` for Gibbs under the proxy
vbd), and `ratioScale` only ever adjusts that by `[0.5, 1.4]`× — a `dv` that
undershoots what the market says a player is worth caps the bid near that
undershoot almost regardless of how much higher `market` runs. That is
BY DESIGN (`auction-engine.js`'s own header: "our own estimate of what he is
WORTH must stay independent of [the market/calibration] ... the gap between
the two is the entire bargain signal") — but a bargain signal that only ever
gates the bid DOWN, never meaningfully up past `dv`, is a real, structural,
coverage-independent reason `suggestBid()` leaves elite, market-priced value
on the table, distinct from and more fundamental than the ADP-coverage
mechanism above. Treatment's ceiling is not anchored to `dollarValue` the
same way, which is the more precise reason it captures that value.

**Shipped from this follow-up: a real AAV data path, independent of whether
3.3/3.4/3.4a's own default-bidding recommendation above is acted on.**
`backend/integrations/fantasypros_aav_paste.py` parses the cheat-sheet text
(fixture-tested on real pasted rows in `integrations/selftest.py`, all 318
rows of the actual sheet parse cleanly with zero skips) into `NormPlayer`s
fed through the SAME `matching.py` index/matcher ESPN and Yahoo import
already use — no second name-matching path. `POST
/api/admin/fantasypros/aav-paste` (admin-gated, `dry_run` default true since
`fantasy_players.aav` is shared season-wide data, not a per-league setting)
writes the matched values. `data-pipeline/apply_aav_paste.py` is the thin
client — reads the pasted sheet from a file rather than a shell argument,
since a 300-line sheet full of `$` and apostrophes is genuinely painful to
hand-quote for curl. No frontend UI: matches this repo's existing precedent
for admin data operations (`/api/admin/reload-sos`, `/api/admin/refresh`)
being operated directly rather than through a UI surface that doesn't exist
yet for any admin function.

**REDESIGNED after the user actually tried to use it and couldn't find it.**
Admin-only + global was the wrong shape for what this is. A user went
looking for the paste box in the app and it wasn't there — the "no frontend
UI, matches admin-tooling precedent" call above was reasonable by analogy to
`reload-sos`, but wrong for THIS feature: the user's own framing was "the
cheat sheet differs by league [so] it should be available to any user" and
"updatable to reflect changing conditions," which is a per-league override,
not a shared admin-gated baseline. `fantasy_players.aav` genuinely IS
shared season-wide data (many leagues read it), so the admin route stays for
refreshing that baseline — but a value one user pastes for their own draft
has no business overwriting what every OTHER league on the season sees, and
requiring an admin account to use it at all was the direct cause of the
confusion. Added a second, non-admin path instead of replacing the first:
`POST /api/integrations/fantasypros/aav-paste-candidates` (any signed-in
user, `get_current_user` only, no write) returns a match report; the
frontend merges it into `settings.aavOverrides` via the existing
`PATCH /api/leagues/{id}` — the same "candidates now, caller decides what to
do with them" shape `yahoo_paste_candidates` already uses, reused rather
than inventing a new pattern. `marketPrice()` in `AuctionRoom.tsx` prefers
`settings.aavOverrides?.[id]` over the board's own `p.aav`. `_match_aav_rows`
factors the actual parse-and-match loop out of both endpoints so the
admin and per-league routes cannot drift about how a name resolves to a
player id. `AavPasteImport.tsx` is the UI: a "Values" button in
`AuctionRoom`'s header (badge shows the active override count), a paste
box, a preview-then-apply flow, and a clear button — "updatable to reflect
changing conditions" means removing a stale paste has to be as easy as
adding one.

### 3.6 Auction: bench-slot value beyond market price — bye coverage + injury-replacement credit

**Motivation, from a real user observation, not a roadmap-invented itch.** After
the 3.3/3.4 ceiling fix (`allocationCeiling = market` once starters fill — see
CLAUDE.md's "`$Max` once starters are filled"), a user flagged directly: "bench
slots are important too — they will be starters in bye weeks and replace
injured players." Independently confirmed in the same conversation: starter-
phase recommendations were good all draft; the gap is specifically bench-filling.

**Scope is deliberately two SEPARATE, independently-testable credits, not one
model** — they have different risk profiles and should not share a kill gate.

1. **Bye coverage** — deterministic, known in August, reuses ALREADY-SHIPPED,
   ALREADY-VALIDATED machinery (`bye-weeks.js byeClash`, currently a COLLISION
   PENALTY in the snake recommender only). Low risk: turning an existing
   penalty into a matching credit for a second consumer.
2. **Injury-replacement** — genuinely probabilistic, and nothing in this
   codebase currently prices it. The harder half.

**Why this does NOT reuse Phase 2's outcome distributions, stated explicitly
rather than left implicit.** The textbook-correct way to price "how much does
bench depth reduce my downside" is exactly what Phase 2 exists for — but 2.1's
season distributions are wired into nothing (QB fails its own gate), and 2.2's
WEEKLY distributions — the actual prerequisite a per-week insurance value
needs — are **CLOSED**: both the base fit and the player-season form-factor
follow-up were REJECTED. Weekly draws understated season variance by 3-4x, and
the fix explained under 12% of the missing variance at every position — the
correlation gap is mostly game-script/matchup-level, not season-level, so no
form factor built on that construction was ever going to close it. Building
bench-insurance value on top of that closed door would either wait indefinitely
or quietly reinvent the same rejected model. This step is scoped to not need it.

**3.6a Bye coverage credit — the low-risk half, PRE-REGISTRATION.**

*What changes*: once starters are full (the `market`-ceiling regime above), a
bench candidate whose bye week is NOT already covered by another rostered
player at that position gets a ceiling bump over plain `market`; a candidate
who'd be the Nth body stacked on an already-covered bye does not. This is
`byeClash`'s existing collision arithmetic read in the OPPOSITE direction — a
position with zero coverage for a given week is a real gap `byeReport` already
surfaces; filling it has value in the SAME units `byeClash`'s `mult` already
uses elsewhere on the snake side.

*Precondition*: none needed. `byeByTeam`/`byeClash`/`byeReport` are shipped,
tested (32 assertions, `bye-weeks.selftest.mjs`), fed by real schedule data
with no gaps. This wires a validated signal into a second consumer — it is not
new modeling.

*Kill gate*: not fully set yet — one design decision has to resolve first, not
guessed at. Unlike 0.1-1.3's "beats ADP on rank correlation," bye-coverage
value has no obvious existing backtest population. The natural harness is 3.5's
auction simulator (`draft-sim.mjs`'s auction side), scored on realized
BYE-WEEK lineup completeness specifically — not season points overall, which
would dilute a signal that only pays off in specific weeks. Whether 3.5's
simulator can even score that granularity needs checking before a number goes
in this gate; if it can't yet, that's the actual next step, not the credit
itself.

**SUPERSEDED IN APPROACH by 2.4.** The open question above — what harness can
score bye-specific lineup completeness — is answered there: score REALIZED
weekly lineups from `fantasy_player_logs` against the real bye schedule.
2.4 also replaces this step's per-candidate heuristic bump with an actual
season-long lineup calculation, which is the same signal computed properly.
Build 2.4; if it clears its gate, 3.6a is delivered by it rather than
separately.

**3.6b Injury-replacement credit — the hard half, precondition not yet checked.**

*The real question, stated precisely*: across many realized rosters, how much
value did a team's bench ACTUALLY salvage via spot starts forced by a starter's
injury/inactive week, relative to that bench player's draft-time price? A
DIRECT empirical question — "what happened," not "what does a fitted
distribution imply" — which is exactly how it sidesteps 2.2's closed weekly
machinery: it needs a historical accounting, not a predictive distribution.

*Precondition, to check FIRST — same discipline `injury_probe.py` established
for 0.3, and genuinely unanswered, not assumed*: does nflverse's weekly data
reliably distinguish "started" from "inactive/did not play" at the PLAYER
level (not just team box scores), for enough seasons to build a real sample?
`injury_probe.py` verified the INJURIES endpoint carries real dated status — a
different, already-answered question from "did player X's own team start him
or a bench replacement in week W."

*If the precondition holds*, the measurement: for each rostered-but-bench
player-week (drafted, not a starter per ADP/positional depth at draft time),
was the starter ahead of him inactive that week, and if so what did the bench
player score relative to replacement level? Aggregated by position, this
yields an empirical bench-insurance value in points — the same unit
`valueOf`/VBD already uses — without any predictive distribution, closed or
otherwise.

*Kill gate*: deliberately not set. A number invented before the precondition
is checked is a guess wearing a kill gate's clothes, the exact failure mode
this file's discipline exists to prevent. Set once the precondition confirms
real data exists, and a first pass at the measurement shows its natural scale
(how many points bench insurance is typically worth, by position).

**3.6c Roster-slot-priority policy — DONE, shipped. A user's own explicit
goal statement redirected this whole step, and it turned out not to need
3.6a/3.6b's caution at all.** Mid-scoping, the user stated the actual policy
they wanted directly: "once the starting positions are filled... you need at
least one backup at each position (including QB) and then you want to focus
on maximizing value of WR/RB. There is little value to carrying more than 2
QB or TE or more than one D or K." That is not an insurance-value question —
it is a roster-slot-ALLOCATION-PRIORITY question, and this codebase already
had validated machinery for almost exactly it: `maxUseful(pos, roster,
superflex)`, shipped for the SNAKE recommender off the same real-draft bug
shape ("Roster discipline in the snake recommender" above) — QB `starters+1`
(`+2` superflex), TE `starters+1`, K/DST `starters` only, RB/WR uncapped.
That maps onto the user's stated policy almost verbatim.

Ported into the AUCTION ceiling (`AuctionRoom.tsx ceilingFor`): once starters
are full, a position in `{QB, TE, K, DST}` that has already reached
`maxUseful` gets its allocation ceiling floored to $1 (still biddable if truly
nothing else is left, never "pass") instead of the plain `market` value the
3.3/3.4 fix above shipped; RB/WR are excluded from the check entirely (their
own `maxUseful` is bench-bounded, i.e. effectively uncapped, matching "focus
on maximizing value of WR and RB"). No new kill gate needed — this is not a
new statistical claim being tested, it's reusing an ALREADY-validated policy
(proven via the real mock draft that surfaced the snake-side bug in the first
place) in a second consumer. `AuctionRoom.test.tsx` pins both directions on a
fixture with starters filled and a 2nd bench QB already rostered: a 3rd QB
shows `$1~`, a same-position-tier RB still shows its real market-based number.

This also reframes the OPEN half of this step: 3.6a/3.6b's bye-coverage and
injury-replacement credit are still real, still un-started, but they were
never actually blocking the user's stated goal — the depth CAP (stop
over-valuing a 3rd QB/TE) was the load-bearing piece, and it shipped without
needing either.

**3.6d Real-time bye-collision flag — DONE, shipped. A second explicit user
redirect away from 3.6a's valuation-model framing, in the SAME direction as
3.6c: a policy/display fix, not a new statistical model.** Immediately after
3.6c shipped: "I don't want to overdo the bye week adjustments - as the model
found, it's only one week. Can we make the model bye week aware so it will
flag for me when I have another player at the same position with the same
bye week? I can then make the decision in real time." That is explicitly
NOT 3.6a (a priced insurance-credit multiplier) — it is a display-only flag,
and deliberately looser than the existing `byeClash` penalty: it fires on
every same-position/same-week pairing against the user's own roster, even
one `byeClash` scores as `mult: 1` (no cost yet) because enough OTHER bodies
already cover the week.

Shipped as `bye-weeks.js byeCollisions(pos, bye, roster)` — pure, unpriced,
roster: `[{pos, bye, name}]` in, matching subset out. Wired into both rooms:
`AuctionRoom.tsx` and `SnakeRoom.tsx` each derive a `byeWarnByPlayer` map
(candidate id -> `{week, names}`) from the board + the user's own rostered
players' byes (`useByeWeeks`, the same schedule-derived hook `RosterPanel`
already uses), excluding a candidate's match against himself. Rendered as a
small amber `CalendarX` icon next to the player's name — same slot/style as
the existing injury and risk badges — with a tooltip naming the week and the
colliding teammate(s), explicitly stating "Not priced in — your call." Does
not touch `valuePoints`, `pickScore`, or the auction `$Max` ceiling in any
way; a dedicated test in both `AuctionRoom.test.tsx` and `SnakeRoom.test.tsx`
pins that the flagged row's other numbers are unchanged. `bye-weeks
.selftest.mjs` covers `byeCollisions` directly, including the explicit case
where `byeClash` reports no cost for a pairing `byeCollisions` still flags.

No kill gate needed — same reasoning as 3.6c: this is not a new predictive
claim being tested, it is exposing data the app already derives (`byeByTeam`)
in a new, unpriced way the user asked for directly.

**3.6e "One strong backup" ceiling boost — DONE, shipped. The mirror case
3.6c never covered.** Raised while revisiting $Max: "For $Max, when we get
to bench points is it still trying to maximize my value? I would prioritize:
(1) points over the season ... (2) having one strong backup at QB, RB, and
WR." 3.6c's `maxUseful` floor stops over-DEPTH (a 3rd QB priced at $1 instead
of competing with real RB/WR value) — but nothing stopped UNDER-depth: a
team's FIRST bench body at a position was priced identically to its fourth,
plain `market` value either way. Priority #2 above names exactly that gap,
ranked explicitly BELOW priority #1 (points/value) — a nudge, not an
override, which shaped the fix as small and reversible rather than a new
valuation layer.

Shipped as `budget-path.js firstBackupBoost(pos, have, roster)`: returns
`BACKUP_BOOST_MULT` (1.15 — the SAME constant `needMult()` already uses on
the snake side for "below a starter slot," reused rather than a fresh
unfitted number) exactly when `have === starters` for that position — zero
bench bodies yet. Scoped to QB/RB/WR only, per the user's own list; TE/K/DST
are excluded because `maxUseful` already owns their depth policy (3.6c) and a
boost there would fight it rather than complement it. A real edge case a
selftest caught during review: the naive formula `max(0, have - starters) ===
0` is ALSO true when `have < starters` (roster not even filled yet), which
would have fired the boost before starters exist at all — fixed to exact
equality, `starters > 0 && have === starters`, so the function is correct
standalone rather than relying on the caller to only invoke it post-starters.

Wired into `AuctionRoom.tsx ceilingFor`: `allocationCeiling = atCap ? 1 :
market * firstBackupBoost(...)` once starters are full — mutually exclusive
with 3.6c's floor by construction (QB's boost fires only at `have ===
starters`, `atCap` only at `have >= starters + 1`; RB/WR are never `atCap` at
all). Still composed through `bindingCeiling` exactly as before, so the
wallet cap (roadmap "\$Max never exceeds your own remaining money") and the
room cap still apply on top — the boost raises the ASK, it does not bypass
what you can actually pay. A `↑` marker (teal) shows only when the boost is
actually what's binding the number, same discipline `belowMarket`'s `~`
already uses; surfaced on the main board (both densities) and in the "your
targets" panel.

No kill gate needed, same reasoning as 3.6c and 3.6d: this reuses an
already-tuned constant (`needMult`'s 1.15) in a second consumer and encodes a
roster-construction PREFERENCE the user stated directly, rather than testing
a new predictive claim.

**3.6f Diminishing RB/WR bench depth — GATE RUN, FAILED, REVERTED.** Raised live after a real mid-draft moment 3.6c/3.6e
didn't cover: `$Max` pricing a 6th RB with a real, budget-capped number
while sitting at ZERO QB and WR — 3.6c's "always value RB/WR depth" call is
flat all the way down, never actually diminishing. The user's own
refinement, kept as the spec: "build a bench that is diverse and not
overloaded at one position. With the flex position, 3 RBs or 3 WRs can
start at once. A fourth player creates depth. A 5th and down has
diminishing returns — especially at the expense of a 3rd WR/RB [the other
position]."

`budget-path.js benchDepthMult(pos, have, roster, siblingHave)`:
`capacity(pos) = roster[pos] + roster.FLEX` (most bodies at one position
ever startable at once); full value through `capacity + 1` (the stated
"4th player creates depth"); geometric decay (`BENCH_DEPTH_DECAY = 0.85`)
per body past that; an EXTRA one-time discount
(`BENCH_DEPTH_IMBALANCE_MULT = 0.85`) stacked on while the FLEX-sibling
position (`FLEX_SIBLING`: RB↔WR) hasn't reached its own capacity yet — the
exact "at the expense of the other position" case. TE excluded — it already
has its own hard `maxUseful` cap and isn't symmetrically part of the RB↔WR
FLEX relationship this reasons about.

Was composed into `ceilingFor`'s bench-phase branch as a fourth multiplier
(`market * backupBoost * byeMult * depthMult`); a `depthCapped` flag (same
"only claim it when it's actually binding" discipline as `backupBoosted`)
drove a `↓` marker on the main board and in "targets to consider." **Now
reverted** — see RESULT below — `ceilingFor` is back to
`market * backupBoost * byeMult`, and the `depthCapped`/`↓` marker is gone
from both `AuctionRoom.tsx` and `NominationPanel.tsx`.

**Initial call ("no kill gate needed, same reasoning as 3.6c/3.6e") was
WRONG, and corrected on direct question ("do we need to do a deeper test on
this, or are you comfortable with it?").** The 3.6c/3.6e precedent only
applies to REUSING an already-tuned constant in a second consumer
(`maxUseful`'s caps, `needMult`'s 1.15 — both validated elsewhere first).
`BENCH_DEPTH_DECAY = 0.85` and `BENCH_DEPTH_IMBALANCE_MULT = 0.85` are BRAND
NEW numbers, never measured against anything — that puts this in 2.4/3.9's
category (a new claim needing a real gate), not 3.6c/3.6e's. The *shape*
(decay + imbalance penalty) is stood behind; the *magnitude* was a guess.
Shipped ahead of the gate (a real process gap versus 2.4/3.9, which waited
for a clean result before wiring into the room) — this run is retroactive
validation of an already-live default, not a pre-ship check, and a failing
result reverts the shipped default rather than leaving it live unvalidated.

**Mechanism gated behind `auction-sim.mjs`'s `"treatment-depth"` mode**,
identical shape to `"treatment-bye"` (3.9): `"treatment"` is the pre-3.6f
baseline (`depthMult` forced to 1) so the comparison isolates this one
change, not a moving target. `auction-sim.selftest.mjs` pins that
`"treatment-depth"` tracks plain `"treatment"` in ordinary play (the depth
discount rarely engages when bots aren't grossly stacking one position) and
diverges in the exact reported 5-RB/0-WR shape.

**Kill gate, same discipline and stratification as 3.7/3.8/3.9.** Agent A:
`"treatment"`. Agent B: `"treatment-depth"`. Scoring: `realizedWeeklyPoints`.
Stratified calm / early-overspend. Bar: mean/SE > 2 on realized points, IN
EACH BUCKET separately — same bar every gate in this phase uses, for
comparability. Script: `auction-depth-mult-test.mjs`. Workflow:
`.github/workflows/auction-depth-mult-test.yml`.

**RESULT: FAILED both buckets — reverted.** Run 2026-08-23
(github.com/arimeltzer/fantasy-draft-tool/actions/runs/32643430602), 10
seeds x 4 slots x 9 seasons x 2 scenarios = 3,600 paired auctions:

| bucket | mean diff | SE | mean/SE | wins |
|---|---|---|---|---|
| calm | -0.02 pts | 0.19 | **-0.08** | 7/360 |
| early-overspend | -0.03 pts | 0.08 | **-0.33** | 6/360 |

Both buckets landed near zero and NEGATIVE — not just short of the >2 bar,
essentially indistinguishable from flipping a coin (7/360 and 6/360 wins).
`benchDepthMult`'s shape (decay + imbalance penalty) does not measurably
improve realized-season outcomes over the flat bench ceiling at these
magnitudes. Per the pre-registered commitment above, the shipped default
was reverted the same day the result came in: `AuctionRoom.tsx ceilingFor`
no longer applies `depthMult`, and the `depthCapped`/`↓` marker is removed
from both rooms' UI. `benchDepthMult` itself, `FLEX_SIBLING`, and
`auction-sim.mjs`'s `"treatment-depth"` mode are left in place (dead code,
not deleted) since the snake-side port (3.6f-snake, below) reuses the same
function under its own gate, and a future re-tuned magnitude could reuse
this harness without rebuilding it.

**Status: 3.6c, 3.6d, and 3.6e SHIPPED (no gate needed — reused constants).
3.6f GATE FAILED, REVERTED — not shipped. 3.6a/3.6b SCOPED, NOT STARTED** —
real follow-up work, now lower priority three times over: 3.6c removed the
over-depth problem, 3.6d gave a lighter-weight answer to the bye-specific
half, and 3.6e covers the under-depth half priority #2 asked for directly.
Priority #1 from the same message — bye-sensitive SEASON points — is
tracked separately as roadmap 2.4, whose second gate CLEARED the bar
(deployment mean/SE 2.83) and shipped as the default in the SNAKE room —
but deliberately NOT wired into auction `$Max`, since the gate validated a
greedy-pick selection mechanism, not competitive bidding; see 2.4's own
status for the reasoning. 3.6a is buildable with no precondition risk;
3.6b needs its precondition checked before any kill-gate number is set.
Neither is blocking anything the user has actually asked for at this point.

**3.6f-snake — porting the same concept to the SNAKE recommender — GATE
RUN, FAILED DECISIVELY, NOT WIRED.** Requested in the same message that authorized the
3.6f auction gate ("we will also want to transfer a same roster
construction concept to snake drafts"). Built CORRECTLY from the start,
unlike the auction side: opt-in and gated BEFORE any wiring into
`SnakeRoom.tsx`, not after — the auction side's premature ship was the
whole reason this process exists.

MECHANISM. `snake-engine.js needMult(pos, have, roster, needs,
flexEligible, superflex, depthAware, siblingHave)` gained two new trailing
parameters. Past the "still useful bench depth" branch (the tuned 0.88 for
RB/WR), an opt-in final step multiplies by `budget-path.js
benchDepthMult(pos, have, roster, siblingHave)` — the SAME function 3.6f
used, reused rather than reimplemented, since the underlying claim (a
startable 4th is full value, a 5th+ decays, doubly so while the FLEX
sibling hasn't caught up) is position-construction logic independent of
whether the mechanism pricing it is a dollar ceiling or a pick-priority
score. `depthAware` defaults falsy — every existing call site, and
`pickScore` itself, is byte-identical to pre-3.6f-snake behavior unless a
caller explicitly sets `liveState.benchDepthAware = true`. `draft-sim.mjs`
threads a matching `cfg.benchDepth` opt-in flag onto `live.benchDepthAware`
for isolated paired comparisons, mirroring `cfg.byeLineup`'s existing
shape exactly. `snake-engine.selftest.mjs` pins the opt-in contract
(absent/false is a no-op regression check) and the mechanism (a 5th RB
with zero WR scores below the flag-off baseline; the same 5th RB scores
higher, though still below baseline, once WR has caught up to its own
capacity; QB/TE are untouched since `FLEX_SIBLING` only maps RB↔WR).
**NOT wired into `SnakeRoom.tsx`** — `live.benchDepthAware` is never set
by the shipped room, so this has zero effect on any real draft today.

**A REAL prior against this clearing the bar.** 3.6f's auction gate (same
underlying concept, same `benchDepthMult` function, same magnitude
constants) came back mean/SE -0.08 (calm) and -0.33 (early-overspend) —
indistinguishable from noise, slightly negative, 3,600 paired auctions.
The snake port uses a different SELECTION mechanism (which player gets
picked next, not what price is paid), so it is not guaranteed to fail the
same way — but it is testing materially the same claim about diminishing
RB/WR bench value with the same untuned decay/imbalance constants, so a
second null result would not be a surprise. Gating it for real rather than
asserting a pattern from one data point either way.

KILL GATE. `snake-bench-depth-test.mjs` (mirrors `bye-lineup-test.mjs`'s
structure): paired comparison, common random numbers — `cfg.benchDepth`
on vs off, otherwise identical league/seed/opponents. Scoring:
`realizedWeeklyPoints` (real weekly outcomes replayed against real bye
schedules), same yardstick every gate in this phase uses — never the
projection-based hindsight score `draft-sim.mjs` uses elsewhere, which
would let the treatment arm's own projection-shaped incentive grade its
own homework. Stratified over `temperature` (the bot-noise knob
`simulateDraft` already exposes — low = disciplined near-ADP bots, high =
noisier ones), the snake-side analogue of the auction gate's calm/
early-overspend split, since a real draft room's discipline varies the
same way a real auction room's does. **Bar: mean/SE > 2 per bucket, same
as every gate in this phase.** Workflow:
`.github/workflows/snake-bench-depth-test.yml`.

**RESULT: FAILED both buckets — WORSE than shipped, not merely null.** Run
2026-08-23 (github.com/arimeltzer/fantasy-draft-tool/actions/runs/32644154646),
12 seeds x 4 slots x 9 seasons x 2 scenarios = 864 paired drafts:

| bucket | mean diff | SE | mean/SE | wins |
|---|---|---|---|---|
| calm | -29.14 pts | 2.87 | **-10.14** | 12/432 |
| chaotic | -18.65 pts | 2.74 | **-6.80** | 13/432 |

This is a materially DIFFERENT result from the auction side's near-zero
null — a large, confidently negative effect (only 12-13 of 432 drafts won
in each bucket), every one of the 18 season/scenario cells individually
negative. **The likely mechanism, not separately isolated but consistent
with how the two engines consume the same multiplier differently:** in
the auction, `benchDepthMult` only discounts the PRICE ceiling — a
discounted player can still be WON, just for less money, so a wrong
discount mostly reallocates spend rather than roster quality. In
`needMult`, the identical discount lands on the SELECTION SCORE that
decides which player gets drafted next — a real, still-valuable 5th RB
can score below a clearly worse alternative at another position and get
skipped outright, directly corrupting roster construction rather than
just shifting cash. Consistent with the direction (not the auction's
"basically inert"): suppressing a used-for-DRAFTING score is a much
sharper lever than suppressing a price. Not wired into `SnakeRoom.tsx`,
and per this result, never should be with these constants — `needMult`'s
`depthAware`/`siblingHave` parameters and `benchDepthMult` itself stay in
the codebase (the auction side, `3.6f-injury-check` below, and any future
re-tuned attempt all still use the shared function), but the opt-in flag
is never set by the shipped room.

**3.6f-injury-check — a design-issue objection to BOTH 3.6f gates above,
raised directly and confirmed correct.** Quoted in full because the
diagnosis is exactly right: "bench players by definition won't move the
needle much [in the harness], but [bench depth] provides the injury
protection we skipped. If you randomized injuries to starters, I'll bet we
would see a different result."

**THE GAP, confirmed by reading the scorer.** `realizedWeeklyPoints` (every
3.6f-family gate's scoring function, and 2.4/3.9's before it) sets each
week's `avail` roster as `byeOf(p) !== week` — the ONLY unavailability
modeled is a BYE. The lineup itself is chosen by static SEASON projection,
never by anything week-specific beyond that. So a bench player can be
started for exactly one reason: a same-position starter is on a bye THAT
week. He can never be started because a starter got hurt, benched, or
otherwise missed a game — that path simply does not exist in the harness.
Since bye coverage is ALREADY priced separately (`byeLineupMult`/
`byeClash`), the marginal contribution `benchDepthMult` is being tested
against is close to zero BY CONSTRUCTION, independent of whether the
real-world effect it claims (injury insurance) exists. The function's own
docstring already flagged half of this — "the only unavailability modelled
is a BYE... understates the value of bench depth... but applies identically
to both arms, so it does not bias the comparison, only its magnitude" — but
that framing undersells it for THIS specific comparison: it's not simply
smaller in magnitude, the harness cannot express the effect at all, so a
null here is not evidence the real-world effect is absent.

**PRECONDITION CHECKED FIRST, not assumed** (same discipline `injury_probe.py`
established for roadmap 0.3, and exactly what roadmap 3.6b already named as
its own blocking precondition: "does nflverse distinguish started vs
inactive at the player level"). Checked directly against `nflreadpy
.load_player_stats()`, 2019-2024, REG season only: for the STARTABLE pool
per position per season (top 20 QB, top 40 RB, top 50 WR, top 20 TE by
season PPR points — roughly a 10-team league's startable depth), a player
counted as "missed" a week if his team did NOT have a bye and he recorded
ZERO stat lines that week (can't separate injury from a healthy scratch
from this data alone — both are "the bench had to cover him," which is all
that matters here). Real, measured weekly OUT rates:

| position | weekly OUT rate | player-weeks (n) |
|---|---|---|
| QB | 5.2% | 1,983 |
| RB | 10.1% | 3,967 |
| WR | 7.7% | 4,980 |
| TE | 8.5% | 1,984 |

Matches known NFL injury patterns (RBs miss the most, QBs the fewest) —
not asserted blind, sanity-checked against that prior.

**THE FIX.** `draft-sim.mjs realizedWeeklyPoints` gained an optional 7th
argument, `injuryOracle` — absent by default, so every existing call site
(2.4, 3.9, both plain 3.6f gates above) is byte-identical to before.
`makeInjuryOracle(seed, missRateByPos, weeks)` returns a deterministic
`(id, pos, week) => out?` function; `INJURY_MISS_RATE` holds the real rates
above (K/DST default 0 — not in the startable-pool pull, not asserted
safe). Built ONE oracle per gate run and shared across every roster
scored in that run — load-bearing for the pairing to stay valid: the same
real player must draw the SAME weekly pattern whichever arm's roster he
lands on, or the injury draws themselves would inject noise unrelated to
the treatment under test (the exact common-random-numbers discipline this
whole file is built around). `draft-sim.selftest.mjs` pins the contract:
absent/null-oracle regression safety, a hand-rolled oracle correctly
benches a targeted player and starts whoever's left, and a realistic-rate
run lands strictly between the all-starter and all-backup bounds.
`pairedCompareAuction` (auction-sim.mjs) threads the same oracle through
to its own `realizedWeeklyPoints` call.

**TWO re-test scripts, NOT new pre-registered gates in their own right —
robustness checks on the two comparisons already decided above, same bar
(mean/SE > 2 per bucket) for comparability:**
- `auction-depth-mult-injury-test.mjs` — re-runs 3.6f's exact comparison
  (`"treatment"` vs `"treatment-depth"`, the mode kept as dead code in
  `auction-sim.mjs` specifically so this could run without re-adding
  anything to `AuctionRoom.tsx`) with the injury oracle applied.
- `snake-bench-depth-injury-test.mjs` — re-runs 3.6f-snake's exact
  comparison (`benchDepth` on/off) the same way.

Workflow: `.github/workflows/bench-depth-injury-check.yml` (runs both).

**RESULT: BOTH sides confirm their plain-harness verdicts — the design
gap was real, but it is not where either effect's absence (auction) or
harm (snake) comes from.** Run 2026-08-23
(github.com/arimeltzer/fantasy-draft-tool/actions/runs/32644871827), same
seeds/slots as each plain gate, real per-position injury rates applied:

| | bucket | plain-harness mean/SE | injury-aware mean/SE |
|---|---|---|---|
| auction | calm | -0.08 | **+0.83** |
| auction | early-overspend | -0.33 | **-0.31** |
| snake | calm | -10.14 | **-10.29** |
| snake | chaotic | -6.80 | **-7.00** |

**Auction: still indistinguishable from noise** — even flipping sign in
the calm bucket (+0.83), nowhere close to the >2 bar in either. Randomizing
starter unavailability gave bench depth many real chances to be needed
(QB 5.2%/RB 10.1%/WR 7.7%/TE 8.5% weekly, over 3,600 injury-aware paired
auctions) and the discount's price impact still didn't move realized
outcomes. **Snake: still decisively WORSE, at essentially the same
magnitude as the plain-harness result** (calm -10.29 vs -10.14, chaotic
-7.00 vs -6.80) — injuries didn't rescue it even slightly, consistent
with the mechanism theory above: the harm comes from suppressing a
SELECTION score and causing worse picks outright, a failure mode that
giving bench players more chances to play does nothing to fix, because
the roster was already built wrong by the time any week is scored.

**The user's hypothesis was worth testing and the reasoning behind it was
correct — the harness genuinely could not see injury-insurance value
before this fix — but the empirical answer is that neither 3.6f result
was actually caused by that gap.** Both stay unshipped: `AuctionRoom.tsx`
remains reverted to its pre-3.6f pricing (already done), and
`benchDepthAware` remains unset by `SnakeRoom.tsx` (never was set). The
`injuryOracle` mechanism itself is a real, validated addition to the
harness — kept in `draft-sim.mjs` for any future gate that needs it,
independent of this particular result.

> **Prompt** — "do we have a design issue in the testing? bench players by
> definition won't move the needle much. but this provides the injury
> protection we skipped. if you randomized injuries to starters, I'll bet
> we would see a different result."

**3.6g Unpriced position-stack flag — SHIPPED, both rooms.** Asked
directly after 3.6f/3.6f-snake/3.6f-injury-check all closed: "how else
should we adjust to avoid a bench full of RBs? there has to be some
diminishing return here." Two options were offered — an unpriced
real-time flag (no gate needed, ships immediately) or a smarter,
opportunity-cost-aware scoring attempt (real engineering, needs its own
gate given 0-for-2 so far) — user chose both; this is the first.

`budget-path.js benchStackWarning(pos, have, roster, siblingHave)`
answers the identical question `benchDepthMult` tried to answer with a
SCORE/PRICE penalty, but as information instead of a valuation change:
reuses `benchDepthMult`'s exact threshold (`capacity + 1`, the startable
depth slot) and `FLEX_SIBLING`, returning non-null exactly when drafting
this candidate would push a RB/WR PAST that depth slot while the FLEX
sibling hasn't reached its own capacity — the precise "stacking one
position at the expense of the other" case a user reported live and that
originally motivated 3.6f. Deliberately unpriced for the same reason
`byeCollisions` already is: baking this judgment into `valuePoints` or
`pickScore` was tried twice and REJECTED both times (3.6f: no measurable
auction benefit; 3.6f-snake: measurably worse, because a blind discount
fires even when no real alternative sits on the board). A flag carries
the same information with none of that risk — the user decides in the
moment, the same "flag it, I'll decide live" pattern already established
for bye collisions.

Wired into both rooms' main board (not the auction "targets" panel,
matching where `byeWarnByPlayer` already stops) as a stone-gray `Layers`
icon next to the player name, tooltip naming the exact counts
(`"You already have N RBs and no backup WR yet (0/3)..."`). No gate
needed — pure display, doesn't touch `valuePoints`, `$Max`, or
`pickScore`, same reasoning that exempted `byeCollisions`.
`budget-path.selftest.mjs` pins the threshold (silent through the depth
slot, fires past it, clears once the sibling catches up, symmetric for
WR, every other position untouched).

**3.6h Opportunity-cost-aware bench pricing — GATE BUILT, RESULT PENDING.**
The second half of the same answer. Diagnosis of WHY 3.6f-snake failed so
badly (not just null, -10 to -29 pts): `benchDepthMult` discounts a
candidate purely by the drafter's OWN roster count, with zero awareness
of what's actually available on the board. If the best player left really
is a 5th RB, the flat discount still fires and can push the recommender
toward a genuinely worse pick — there is no "safety valve" position for
it to redirect into once QB/TE are already capped by `maxUseful`. The fix
under test: only discount a deep position's candidate when a comparably-
valued alternative is ACTUALLY AVAILABLE right now at the thin sibling
position, not merely by count.

MECHANISM. `budget-path.js opportunityBenchMult(pos, have, roster,
siblingHave, candidateVbd, siblingBestVbd)` — a NEW function, `benchDepthMult`
itself untouched. Shares its two existing preconditions exactly (past the
depth slot `capacity + 1`; sibling not yet at ITS OWN capacity), adds a
THIRD: `siblingBestVbd` — the best AVAILABLE (undrafted) player's VBD at
the sibling position right now — must be a real positive value or the
function is a no-op, full stop, no matter how deep `pos` already is. When
it is real, the discount scales with how comparable the alternative is
(`ratio = min(1, siblingBestVbd / candidateVbd)`), bounded to
`[1 - OPPORTUNITY_BENCH_K, 1]` (`OPPORTUNITY_BENCH_K = 0.35`, an untuned
placeholder pending this gate) so it can never overrule a genuinely
much-better candidate.

`snake-engine.js needMult()` gained three more trailing params —
`opportunityAware, candidateVbd, siblingBestVbd` — a THIRD branch alongside
the untouched, still-rejected `depthAware` one, calling
`opportunityBenchMult` when `opportunityAware` is set. `pickScore` computes
`siblingBestVbd` from a new `liveState.bestVbdByPos` field (best available
VBD per position — absent from every pre-3.6h caller, so `pickScore` is
byte-identical unless a caller explicitly supplies both `bestVbdByPos` and
sets `opportunityBenchAware`). `draft-sim.mjs` computes `bestVbdByPos`
unconditionally (cheap) and threads a `cfg.opportunityBench` opt-in flag
onto `live.opportunityBenchAware`, mirroring `cfg.benchDepth`'s shape.
`SnakeRoom.tsx`'s `live` builder also now computes `bestVbdByPos` (from the
same sorted per-position lists `cliffById` already builds) so the plumbing
is ready — but does NOT set `opportunityBenchAware`, so this has zero
effect on any real draft today, pending this gate.
`budget-path.selftest.mjs` (9 new assertions) and `snake-engine.selftest.mjs`
(7 new assertions) pin the defining property: a no-op whenever
`siblingBestVbd` shows nothing real, discounting only when it does.

KILL GATE. `snake-opportunity-bench-test.mjs`, structurally identical to
3.6f-snake's own gate (paired comparison, common random numbers,
`realizedWeeklyPoints`, stratified over `temperature` calm/chaotic) — the
ONLY change from that gate is which flag is opt-in
(`opportunityBench` vs `benchDepth`). **Bar: mean/SE > 2 per bucket, same
as every gate in this phase.** Workflow:
`.github/workflows/snake-opportunity-bench-test.yml`.

**RESULT: NULL, but a qualitatively DIFFERENT null from 3.6f-snake — the
discount almost never fires at all.** Run 2026-08-23
(github.com/arimeltzer/fantasy-draft-tool/actions/runs/32651250720), 12
seeds x 4 slots x 9 seasons x 2 scenarios = 864 paired drafts:

| bucket | mean diff | SE | mean/SE | wins |
|---|---|---|---|---|
| calm | +0.00 pts | 0.00 | **0.00** | 0/432 |
| chaotic | +0.22 pts | 0.55 | **0.39** | 2/432 |

The calm bucket is not merely "not significant" — it is EXACTLY zero
across all 432 paired drafts (0 wins, 0 losses, 0 draws with any
difference at all): the two arms produced byte-identical rosters every
single time. Chaotic differs in only 2 of 18 season/scenario cells (2017:
-2.0 pts, 2023: +3.9 pts), the rest all exactly 0.0. The mechanism is not
"weakly helpful" — it is almost entirely INERT under these conditions.

**Diagnosis, reasoned from the mechanism rather than re-probed empirically
(the two facts below are both already true by construction elsewhere in
this codebase):** the third precondition (`siblingBestVbd` must be real
and positive) is very rarely satisfied at the same time as the first two
(past the depth slot, sibling thin), for two compounding reasons:
(1) VBD is points ABOVE REPLACEMENT — by definition, a large share of the
draftable pool sits at or below replacement (`posRemaining` itself already
filters to `vbd>0`, i.e. the engine already treats a large chunk of the
board as VBD-zero-or-negative), and that pool skews toward exactly the
deep bench tier this mechanism is evaluating; (2) even before this
mechanism runs, `needMult`'s existing `belowStarter` bonus (1.15-1.30x)
already actively steers a well-behaved agent away from letting one
FLEX-eligible position get 5 deep while its sibling has zero starters —
so the imbalanced states 3.6h is built to catch are themselves rare for
an agent that isn't already broken. Put together: whenever the discount's
first two gates DO fire, the third (a real, positive-VBD alternative)
usually does not — the exact opposite failure mode from `benchDepthMult`,
which had NO third gate and fired constantly, including in states that
turned out to be harmless or even correct, which is the likely source of
3.6f-snake's -10 to -29 pt harm. `opportunityBenchAware` avoided repeating
that harm, but overcorrected into near-total inertness.

**Not shipped, and NOT further tuned in this pass.** `OPPORTUNITY_BENCH_K`
was never load-bearing here — the gate never engaged the constant often
enough for its value to matter. A future attempt, if pursued, would need a
different "is there a real alternative" signal than raw VBD (e.g. a
points- or floor-adjusted measure that stays meaningfully positive at
bench tier) to actually activate in the regime this whole thread is about
— but that is a fourth, NOT-YET-SCOPED attempt, not a tuning pass on this
one. `opportunityBenchAware`/`bestVbdByPos` are left in place (harmless,
opt-in, unused by any shipped room) for exactly that future attempt to
reuse, the same "kept as reachable infrastructure" treatment
`benchDepthAware` itself got after ITS rejection.

> **Prompt** — "how else should we adjust to avoid a bench full of RBs?
> there has to be some diminishing return here."

> **Prompt** — "Check whether draft-sim.mjs's auction simulator can score
> bye-week-specific lineup completeness (3.6a), and separately run
> injury_probe-style verification of nflverse's player-level started/inactive
> data before touching 3.6b at all."

### 3.7 Auction: value-weighted bench reservation (tried — NOT shipped)

**The question, asked directly, and it's a real gap 3.3 named on its own
first day rather than a newly-discovered one.** "How much weight is `$Max`
placing on saving money for bench players, and how does it decide whether to
spend more to acquire a starter?" Traced to the code: **a flat $1 per
remaining bench/K/DST slot, in both phases** — `remainingStartingSlots`'
`reserveSpots` during the starter-filling DP, and `maxMax`'s identical
arithmetic once bench-shopping starts. `budget-path.js`'s own header calls
this out as a stated approximation, not an oversight: "Bench slots are $1
filler and are NOT in the DP... modelling them would multiply the state
space to agonize over a decision nobody agonizes over." That was a
reasonable call when it was made — **but it assumed bench slots ARE roughly
interchangeable filler, and 3.6e and 2.4 have since established that they
are not**: a first backup at QB/RB/WR is worth 1.15x market (3.6e); a
bye-covering body can be worth real credit above market (2.4, snake-only
today). Once bench value is differentiated, reserving for it as if it
weren't is the mismatch.

**The two-phase structure is NOT what changes, confirmed against the user's
own framing.** "It seems like we still have a two phase question. initially
- how much to reserve to build the bench we want. then we still would
switch to bench mode once starter spots are full." Correct, and this step
does not touch the phase switch itself — `openStartSlots.length === 0`
still flips from `bidCeiling`'s DP to the market-priced bench branch exactly
as it does today. What changes is only the SIZE of the number
`reserveSpots` subtracts per remaining bench slot during the starter phase,
from a flat $1 to something that reflects what a WORTHWHILE bench slot
actually costs.

**Scoped as a smarter SCALAR reserve, deliberately NOT a DP extension.**
Adding bench slots as DP dimensions is the exact expansion `budget-path.js`'s
header already declined for state-space cost, and that cost hasn't changed —
rejected again here rather than silently reconsidered. A per-slot reserve
that distinguishes MEANINGFUL bench slots (a first backup at QB/RB/WR — up
to 3 of them, reusing `maxUseful`'s own cap to know which slots still lack
one) from FILLER slots (K/DST, 2nd+ QB/TE) captures the same differentiated-
value insight at a fraction of the cost. That much is unchanged from the
first pass at this scoping.

**What DID change: what price anchors a "meaningful" slot's reserve — caught
by a user before any code was written, not after a bad result.** The first
pass anchored it to `marketPrice()`'s CURRENT, live number. That has a real,
predictable bias, and the user's own framing states it precisely: "most
bidders overspend early... the price for a decent bench player falls
quickly. I wouldn't want to hold back on a starter in early rounds based on
bench values that will tank." Live market price early in a draft has no
information yet about whether THIS room's people are early-round
overspenders — `applyInflation`'s own factor is mathematically neutral at
draft start, by construction, precisely because no evidence has accumulated
yet. Anchoring the reserve to it would systematically OVER-protect budget
early (against a bench cost that's going to evaporate on its own) and
underbid on starters that deserved the aggression. **Rejected, recorded so
it isn't silently reproposed**: reserve = live `market(pos)` for a
meaningful slot.

**Replacement design: anchor the reserve to THIS ROOM's own historical
bench-tier price, not today's live number** — the same instinct behind
`auction-calibration.js`'s positional shares, extended to price TIMING
rather than just position SPLIT. Checked, not assumed, that the data
supports it: `picksFromKeeperImport`'s `draftPicks` currently keeps only
`{pos, price, season}` — no sequence — but its SOURCE, ESPN's
`parse_draft_picks`, appends in the array order of `draftDetail.picks`,
which is real chronological nomination order (the same array
`parse_live_draft` reads `overallPickNumber` from). That order is not
currently threaded through to the frontend cache; it would need to be.

*Mechanism*: for QB/RB/WR, find the pick(s) at that position landing near
rank `starters[pos] + 1` (a small WINDOW of 2-3 ranks around the
first-backup threshold, not the single point — see sample-size guard below)
in each of the room's stored historical drafts, in nomination order. Pool
their RAW prices (not a ratio to historical par) across seasons, with the
same `RECENCY_DECAY` weighting `auction-calibration.js` already uses. Use
that pooled number as the reserve for a meaningful slot instead of live
`market()`; filler slots stay $1 exactly as today.

*Raw price, not a par-ratio — a stated simplification, not an oversight.*
Normalizing to a ratio (this room's bench-tier price relative to that
SEASON's own par value) would be more transferable across years where the
player pool shifts, and is how `auction-calibration.js` itself treats
positional shares. It was considered and set aside here: computing a
historical PAR value needs that season's own player-level VBD, which the
client does not carry for any season but the current one — the historical
cache literally does not have per-season `teams`/`budget` recorded either,
so even a budget-only normalization isn't available today. Raw historical
price is used instead, under a stated assumption: the room's total budget
has not changed across the pooled seasons. Most leagues are stable on this,
but a league that changed its budget mid-history would get a skewed number
— a real, accepted limitation, not a hidden one. A ratio-based version
stays a documented follow-on, not this step.

*The sample-size problem this signal has, that positional-share calibration
does not.* `auction-calibration.js` pools ~20-30 priced picks per position
per SEASON. This pools roughly 2-3 (the rank window) per position per
SEASON — an order of magnitude sparser. `SHRINK_K0`/`MIN_PICKS` as tuned for
the existing calibration do not transfer numerically; this needs its OWN
minimum-seasons threshold, sized for how few observations a season
contributes, with heavy shrinkage toward the $1 fallback below it. Stated
plainly so a null result on a specific league isn't later misread as the
idea failing: **most leagues import only 1-2 seasons of history today**
(`history_seasons` was raised to 15 for one user who specifically wanted
10 years; that is not the typical case), so this will likely be INERT —
correctly falling back to $1 — for most users in practice. That is the
correct, honest behaviour under "missing data skips the effect," not a
defect to design around.

**Precondition — CHECKED, PASSED.** Same discipline `injury_probe.py`/
`adp_probe.py` established: don't rely on the parser's own assumption about
`draftDetail.picks`' array order without confirming it against a REAL
captured multi-season pull. `data-pipeline/espn_draft_order_probe.py`
(run via `.github/workflows/espn-draft-order-probe.yml`, since this
sandbox's own proxy blocks ESPN outright — same GitHub-Actions-for-real-
egress pattern the 2.4 gate used) checks ESPN's own `overallPickNumber`
field for strict monotonicity against array position — self-contained, no
external ground truth needed. Run against a real private league (cookies
supplied as masked `ESPN_S2`/`ESPN_SWID` repo secrets, never typed
anywhere readable back) across 4 seasons on the `current` (non-history)
path: **2024 (196 picks), 2023 (196), 2022 (224), 2021 (192) — all 4
PASS**, every pick in every season carrying a present, strictly increasing
`overallPickNumber`. Array order IS real nomination order, at least on the
`current` league-API path. The `leagueHistory` fallback host (older
seasons that 404 on `current`) was NOT separately verified — same
`current`-path-only scope this check was honest about needing up front —
so a room whose usable history reaches back far enough to hit that
fallback should re-check before leaning on it; most rooms' 1-2 seasons of
typical history won't reach it. Precondition cleared for the common case;
modeling has not started.

**Kill gate, pre-registered on the half that's measurable today — the
AVAILABLE gate can only validate HALF of what motivated this, stated up
front, not discovered after a misleading result — and now STRATIFIED
rather than a single pooled number, since the design change itself demands
it.** A single aggregate mean/SE could hide exactly the failure
mode under discussion: if the historical-anchor version helps in calm
rooms and hurts in early-overspend rooms, or vice versa, those could
average out to a result that looks fine while being wrong in the specific
scenario this whole step exists for. So the gate reports at least two
scenario buckets, using `auction-sim.mjs`'s existing `botWTPMultiplier`/
`botNoise` knobs to construct them, not new machinery:
  - **calm** — bots priced close to `botWTPMultiplier`'s baseline, low noise.
  - **early-overspend** — bots weighted toward front-loaded aggression, the
    scenario the user named directly.

Paired auction simulation, common random numbers, `auction-sim.mjs`'s
scorer upgraded to `realizedWeeklyPoints` (real byes, real per-week
outcomes — the same upgrade 2.4 already proved out, applied to the auction
side for the first time; today's `bestLineupPoints` is season-total
hindsight, blind to byes entirely). Per `realizedWeeklyPoints`' own stated
limitation, an injured/inactive starter is still started and scores his
real 0 — the lineup is never re-optimized around real-time injury status.
So this gate, as buildable today, measures the BYE-COVERAGE half of "is it
worth reserving more for bench" and is BLIND to the INJURY-INSURANCE half —
precisely the half the user named as priority: "having at least one
backup... solves for byes and the unpredictability of injuries." A result
from this gate should be read as a LOWER BOUND on the value of smarter
reservation, not the whole answer. Closing that gap needs the same
precondition 3.6b already flagged and left unchecked — does nflverse
distinguish started vs. inactive at the player level — so this step and
3.6b now share a dependency, not by coincidence.

Agent A uses today's flat-$1 `reserveSpots`; Agent B uses the
historical-anchor reserve. Bar: mean/SE > 2 on realized points IN EACH
BUCKET separately, same discipline every other gate in this document uses
— a result inside that bar in either bucket ships nothing FOR THAT
SCENARIO, and the two buckets are reported side by side rather than
collapsed into one number that could hide a real early-overspend-specific
loss.

**RESULT: BUILT AND RUN — REJECTED IN BOTH BUCKETS, decisively.**
`historicalBenchReserve()`/`benchReserveDollars()` shipped in
`budget-path.js` (44 selftest assertions), `auction-sim.mjs` gained the
`"treatment-hist"` agent mode and a presence-gated `realizedWeeklyPoints`
scorer, and `auction-bench-test.mjs` ran the full pre-registered gate on
real 2017-2025 data (`export_draft_seasons.py`, FantasyPros ADP,
GitHub Actions run
[32572522356](https://github.com/arimeltzer/fantasy-draft-tool/actions/runs/32572522356)),
8 seeds × slots {1,4,7,10} × up to 5 pooled prior in-dataset seasons per
reserve:

| bucket | n | mean diff | SE | mean/SE | wins |
|---|---|---|---|---|---|
| calm | 256 | **-31.65 pts** | 7.08 | **-4.47** | 70/256 |
| early-overspend | 256 | **-41.03 pts** | 8.48 | **-4.84** | 87/256 |

Both clear the pre-registered `|mean/SE| > 2` bar for significance —
**in the WORSE direction**, in both scenarios, not just one. This is not
the "inside the bar, ships nothing" outcome the pre-registration
anticipated as the null case; it is a confident, measured loss.

**Why, read from the run's own diagnostics.** The reserve engaged
substantially — QB stayed near $1-2 (its threshold, `teams × 1`, rarely
sees a well-populated ranks-11-13 window even pooling 5 seasons of
simulated history), but RB/WR reserves ran **$4-8**, a real multiple of the
$1 baseline, across nearly every eval season. That is exactly the
differentiated signal the mechanism was built to produce. The problem is
what spending it costs: pulling $4-8 away from the starter-phase DP at
RB/WR — the two positions with the deepest starter demand and the most
competitive bidding — measurably starved bids on STARTERS to protect
bench dollars that, per 3.6c/3.6e/2.4, were never worth that much relative
to a stud. This is the **same failure mode already caught and rejected for
the live-market-anchor design** (over-protecting budget against a bench
cost), just surviving under a different anchor source: sourcing the
reserve from history instead of a live price didn't fix the underlying
issue — a non-trivial reserve pulled from DP budget during the starter
phase is a bad trade at the dollar amounts this room's historical data
actually produced, not merely at the live-price amounts the first design
would have used.

**Not shipped in any form.** `remainingStartingSlots`'s flat $1/slot
reserve is unchanged and remains the default; `historicalBenchReserve`/
`benchReserveDollars`/`"treatment-hist"` stay in the repo, selftested, as
a documented negative result — the same treatment 1.4's rookie draft
capital and 2.2's weekly-distribution model got. Nothing was wired into
`AuctionRoom.tsx`, League Settings, or the league import page; the
question the user raised ("build this into the league import page and
then league settings, not Keepers") is moot for this specific mechanism —
there is no calibration result worth surfacing to a user once the gate
rejects it. A future differently-shaped attempt (e.g. a smaller reserve,
or one applied only to the SPECIFIC missing-backup slot's own price rather
than uniformly to QB/RB/WR) would need its own pre-registration and gate,
not a reuse of this one's numbers.

### 3.8 Auction: joint valuation of the last starter + first bench slot (tried — NOT shipped)

**The idea, proposed directly after 3.7's rejection, and importantly a
DIFFERENT mechanism from it, not a retry.** "Don't account for the bench
when drafting the first player at a position but take it into account for
subsequent ones. So if RB2 is $34 but I have multiple options for $32 that
would get a strong bench RB as well, pass on the player costing $34." RB1
is bid exactly as today, zero bench-awareness. RB2 — a SECOND starter at a
position, still inside 3.3's DP scope — should be chosen by the COMBINED
value of (RB2 + the bench RB that choice leaves affordable), not RB2 alone.

**Why this does not repeat 3.7's failure, traced precisely.** 3.7's
`benchReserveDollars` fired whenever `have[pos] === starters[pos]` and
subtracted a flat dollar amount from the SHARED starter-phase `dpBudget` —
which, because `openStartSlots` spans every position at once, quietly
taxed bids on OTHER positions' still-open starters (QB, WR) too, any time
ANY position reached "at cap, no backup yet" while other starters were
still being fought over. That was a blind subtraction, unconditional on
whether the trade was actually good, and the gate confirmed it cost real
points at both scenario buckets (mean/SE -4.47 calm, -4.84
early-overspend — see 3.7 above). This idea is not a subtraction at all:
it adds a real, position-locked SLOT to the SAME DP that already prices
every open starter, competing for the identical shared budget. The DP can
only prefer the cheaper RB2 when the JOINT value of (RB2 + bench RB)
actually beats the alternative — never blindly, because `reachableRoster`
is an exact knapsack over real value, not an off-budget reservation.

**Mechanism, and it needs almost no new code.** `budget-path.js`'s DP
already treats multiple slots of the same position symmetrically (the
count-dimension knapsack, `want[pos]`) — so "jointly optimize RB2 + a
bonus bench RB" is just `slots` carrying `"RB"` TWICE instead of once,
which `reachableRoster` already knows how to solve exactly. New,
narrowly-scoped helper: `bonusBackupPositions(roster)` returns positions
with `roster[pos] >= 2` (2+-starter positions only — a 1-starter position
like QB has no "last starter" state distinct from its very next pick,
which is already the backup and already governed by
`firstBackupBoost`/the flat-market bench branch, so it is out of scope
here by construction, not by omission). `withBonusBackupSlots(slots,
roster, myPlayers)` appends one bonus slot for each qualifying position
where `have[pos] === 1` exactly (drafted the FIRST player, not yet the
second — `have[pos] === 0` is deliberately untouched, matching "don't
account for the bench on the first pick"; `have[pos] >= roster[pos]`
means starters are already full and the real bench-shopping phase
governs instead, unchanged). `AuctionRoom.tsx`'s `ceilingFor` would pass
this augmented array to `bidCeiling` in place of the true
`openStartSlots` — while `openStartSlots.length` itself (unaugmented)
keeps deciding the DP-vs-bench-market phase switch, so nothing here moves
that boundary.

**The one real risk, checked by reasoning about the DP's own mechanics
before building, same as 3.7's live-anchor risk was checked before
building.** Does treating the bonus slot as a HARD requirement (the exact-k
knapsack format) force the DP to overpay elsewhere to guarantee affording
it, even when a good bench RB isn't actually available? Reasoned to be
close to costless in practice: `TOP_K_PER_POS`'s candidate pool always
includes near-$1 fillers at RB/WR (positions rarely exhausted), so
"satisfying" the bonus slot's hard requirement is nearly free UNLESS a
genuinely valuable cheap option exists — in which case correctly
recognizing that combined value is the entire point. Reasoning alone is
exactly what made 3.7's design look safe before the gate caught the real
cross-position leak, so this is checked by the GATE below, not assumed
from this paragraph.

**Kill gate, same discipline as 3.7 — stratified into the same calm /
early-overspend buckets** (not because a directional bias is specifically
predicted here the way it was for 3.7, but for consistency with the
sibling step and because the harness already supports it at no extra
cost). Scoring: `realizedWeeklyPoints`, the same bye-coverage-only
yardstick every gate in this phase now uses. Agent A: `"treatment"`,
today's shipped DP (unaugmented `openStartSlots`). Agent B:
`"treatment-bonus"`, identical except `bidCeiling` receives
`withBonusBackupSlots(openStartSlots, roster, myPlayers)`. Bar: mean/SE
> 2 on realized points, IN EACH BUCKET separately — a result inside that
bar in either bucket ships nothing for that scenario, exactly 3.7's bar.

**RESULT: BUILT AND RUN — a clean NULL, not a reject like 3.7.**
`bonusBackupPositions()`/`withBonusBackupSlots()` shipped in
`budget-path.js` (57 selftest assertions total), `auction-sim.mjs` gained
`"treatment-bonus"`, and `auction-bonus-slot-test.mjs` ran the full
pre-registered gate on real 2017-2025 data (GitHub Actions run
[32586944362](https://github.com/arimeltzer/fantasy-draft-tool/actions/runs/32586944362)),
10 seeds × slots {1,4,7,10}:

| bucket | n | mean diff | SE | mean/SE |
|---|---|---|---|---|
| calm | 360 | +1.13 pts | 8.01 | 0.14 |
| early-overspend | 360 | -7.04 pts | 10.11 | -0.70 |

Both land well inside the `|mean/SE| > 2` bar — indistinguishable from
noise, in EITHER direction, in both scenarios. Per-season numbers swing
enormously (+131.3 in 2023 calm to -231.4 in 2021 early-overspend) but
average out close to zero across seasons, which reads as genuine noise
rather than a real effect being masked by pooling.

**A synthetic-fixture smoke test run before this, on toy data, had shown a
strong, consistent NEGATIVE effect (mean/SE as low as -20)** — checked
first because it was cheap, and reasoned through as plausibly real (a
theory that requiring the bonus slot to be filled SIMULTANEOUSLY with the
last starter forces a premature commitment a real draft could defer).
The real-data gate did not confirm that theory: the effect vanished
entirely rather than surviving at a smaller size. Read in hindsight, the
toy fixture's thin player pool (dozens, not hundreds, of RB/WR candidates)
most likely made the "find 2 good RBs" requirement bite artificially hard
in a way a real ~500-player pool does not — a concrete illustration of why
this document does not treat a synthetic smoke test as a verdict, only as
a harness-correctness check, and why the real GitHub Actions data pull is
run regardless of how confident a toy result looks.

**Not shipped — but for a different reason than 3.7.** 3.7 was a
confident, measured LOSS; this is a confident NULL. The mechanism itself
is not wrong in the way 3.7's was (no cross-position budget leak was
found or is expected, since nothing is subtracted from any budget here) —
it simply does not move realized points either way at the population
level this gate can measure. `bonusBackupPositions`/`withBonusBackupSlots`/
`"treatment-bonus"` stay in the repo, selftested, as a documented null
result. Nothing wired into `AuctionRoom.tsx`. A plausible reason a real,
if present, effect could still be masked here: `realizedWeeklyPoints`
scores the WHOLE roster's season, and a joint RB2+bench-RB decision made
once, early-to-mid draft, is a small fraction of the ~15 total roster
decisions that determine a season's realized points — the same
signal-dilution risk any single-decision auction mechanism faces under
this scorer. Not itself grounds to retry without a sharper measurement
(e.g., isolating just the RB/WR position groups' own realized value,
mirroring 2.4's deployment/isolation split) — left as a stated limitation,
not a reason to reopen this specific result.

> **Prompt** — "Roadmap 3.8 is CLOSED — null result, not shipped, see
> docs/ROADMAP.md 3.8. Do not rebuild the same mechanism; a sharper
> position-scoped measurement would be a genuinely new pre-registration,
> not a rerun of this one."

### 3.9 Auction: `byeLineupMult` as a bench-phase `$Max` multiplier — SHIPPED

**The idea, and it is not a new one — it is 2.4's own stated next step,
finally picked up.** 2.4's own record (above) explicitly declined to fold
this into the snake-only ship: "Reusing the same validated VALUE FUNCTION
as a price multiplier [in `bidCeiling`/`ceilingFor`] is a smaller
extrapolation than inventing a new model... but it is still an
extrapolation past what this specific gate measured, worth a separate
explicit decision." That decision is this step. Proposed directly after
3.7 and 3.8 (a rejected mechanism and a null one) as the next candidate,
and deliberately checked FIRST by testing rather than trusting the "smaller
extrapolation" reasoning — the same reasoning category that made 3.7's
design look safe before its gate caught a real cross-position leak, and
that mis-predicted 3.8's synthetic-fixture result. Explicitly requested to
be gated, not wired in on the strength of 2.4's own already-cleared bar
alone: "would we test your first suggestion before implementing? worth a
shot."

**Mechanism — no new model, a second consumer of an already-validated
one.** `bye-lineup-value.js byeLineupMult(candidate, roster, opts)` is
already gate-cleared (2.4: deployment mean/SE 2.83, isolation 4.23, 1,800
drafts). `AuctionRoom.tsx ceilingFor`'s bench-phase branch — once starters
are full — already multiplies `market` by `firstBackupBoost` (3.6e); this
adds `byeLineupMult` as a second multiplier in the SAME composition:
`Math.round(market * backupBoost * byeMult)`, called exactly the way
`SnakeRoom.tsx` already calls it (`pointsOf: q.valuePoints ?? q.vbd ?? 0`,
`byeOf` from the team's bye week, `rosterCfg: settings.roster`) so the two
consumers cannot silently disagree about units. `atCap` (the 3.6e/`maxUseful`
depth gate) is checked first and unchanged — a position already at its
useful-depth cap still floors to $1 regardless of bye value, matching the
existing precedence.

**A REAL harness gap found while scoping this, fixed before the gate runs
— the same "the simulator must match the shipped app" discipline 2.4's own
`byeByTeam`-never-passed bug established.** `auction-sim.mjs`'s bench-phase
branch has NEVER modeled 3.6c's `atCap`/3.6e's `firstBackupBoost` at all —
it returns `undefined` (unconstrained, room-ceiling-only) the moment
starters fill, which is not what `AuctionRoom.tsx` actually does and never
was. `auction-sim.mjs`'s own header already names K/DST-outside-DP as a
known, stated scope limit; this bench-phase gap was not previously named
and is a different, unstated one. Fixed as part of this step, for EVERY
mode (not just the new one) — the simulator's `"treatment"` bench-phase
ceiling now matches `ceilingFor`'s real composition
(`atCap ? 1 : market * backupBoost`), so the control arm this gate compares
against is the ACTUAL shipped behavior, not a simplified stand-in. This
changes what `"treatment"` computes in the bench phase for ALL modes on any
FUTURE rerun of 3.5/3.7/3.8's scripts (their own recorded, already-CLOSED
results are unaffected — they concerned the starter phase, which this fix
does not touch) — noted here rather than silently, per this document's own
standing rule.

**Kill gate, same discipline and same stratification as 3.7/3.8.** Agent A:
`"treatment"` (now bench-accurate, per the fix above). Agent B:
`"treatment-bye"`, identical except the bench-phase ceiling gets the extra
`* byeMult` factor. Scoring: `realizedWeeklyPoints`. Stratified calm /
early-overspend. Bar: mean/SE > 2 on realized points, IN EACH BUCKET
separately.

**RESULT: BUILT AND RUN — first pass UNDERPOWERED, same signature 2.4's
own first run showed, not a clean null like 3.8.** `auction-sim.mjs`'s
bench-phase branch was fixed to match `ceilingFor` for every mode (see
above), `"treatment-bye"` was added, and `auction-bye-mult-test.mjs` ran
on real 2017-2025 data (GitHub Actions run
[32610990821](https://github.com/arimeltzer/fantasy-draft-tool/actions/runs/32610990821)),
10 seeds × slots {1,4,7,10}:

| bucket | n | mean diff | SE | mean/SE |
|---|---|---|---|---|
| calm | 360 | +1.09 pts | 0.77 | 1.43 |
| early-overspend | 360 | +1.89 pts | 1.03 | 1.83 |

Neither clears `|mean/SE| > 2`, so per the pre-registered bar this ships
nothing YET — but unlike 3.8's result (huge season-to-season swings in
both directions, -231 to +131, a clean null), this one shows a SMALL,
CONSISTENT, mostly-POSITIVE effect: 7 of 9 seasons positive in BOTH
buckets (2017 +6.0/+2.8, 2018 +10.2/+1.2, 2019 +0.2/+2.7, 2020 -10.1/-0.6,
2021 +0.9/+0.5, 2022 -0.8/+7.8, 2023 +0.9/-0.5, 2024 +0.8/+1.6, 2025
+1.7/+1.5 — calm/early-overspend respectively). That pattern — small
effect, tight-ish SE, consistent sign, close to but under the bar — is the
literal signature 2.4's FIRST run had (mean/SE 1.30) before a 4x-larger
run confirmed a real, modest effect (mean/SE 2.83). Read as underpowered,
not null.

**User's call, same fork 2.4 faced and the same choice made: run bigger
rather than ship early or discard the signal.** "would we test your first
suggestion before implementing? worth a shot" (requesting the gate in the
first place) followed by choosing the bigger-run option when offered it
directly.

**BIGGER RUN — CLEARS THE BAR, DECISIVELY, IN BOTH BUCKETS.** 35 seeds ×
slots {1,3,5,7,9} (a ~4.4x scale-up, the same ratio 2.4's own second run
used), GitHub Actions run
[32611678338](https://github.com/arimeltzer/fantasy-draft-tool/actions/runs/32611678338):

| bucket | n | mean diff | SE | mean/SE |
|---|---|---|---|---|
| calm | 1,575 | +1.70 pts | 0.37 | **4.55** |
| early-overspend | 1,575 | +1.79 pts | 0.46 | **3.88** |

Point estimates (1.70, 1.79) landed close to the first run's (1.09, 1.89)
— the same real, modest effect, not a different one appearing under more
samples, exactly the pattern that confirmed 2.4's own underpowered first
run. Both buckets clear `|mean/SE| > 2` comfortably.

**SHIPPED.** `AuctionRoom.tsx ceilingFor`'s bench-phase branch now computes
`byeMult` via `byeLineupMult(p, minePlayers, { pointsOf, byeOf, rosterCfg })`
— identical call shape to `SnakeRoom.tsx`'s — and multiplies it into the
ceiling alongside `firstBackupBoost`: `atCap ? 1 : Math.round(market *
backupBoost * byeMult)`. Presence-gated on `byeByTeam` (the schedule may
still be loading, or a room may not have it available at all) exactly like
every other bye-aware field in this codebase — absent, `byeMult` is 1 and
the ceiling is exactly what it was before 3.9. Full test suite (node
selftests, `npm run build`, and `npm test`'s 87 vitest assertions
including `AuctionRoom.test.tsx`'s own budget-path coverage) passes clean
with the change in place.

### 3.10 Snake: backtest the QB/TE round gates (`QB_MIN`/`teMinRound`) — PRE-REGISTERED

**Asked directly, in the course of explaining `pickScore`'s hard round
gates**: are `QB_MIN`/`QB2_MIN`/`teMinRound`/`te2MinRound` (`snake-engine.js
DEFAULT_SNAKE_PARAMS`) something this repo fit, or an inherited number? Git
history answers it precisely: `SLOT_DEFAULT`'s `QB_MIN: 8, QB2_MIN: 9` is
literally slot 2/3's config from the original ten-slot grid search roadmap
0.2 collapsed, and `teMinRound`/`te2MinRound`/the risk-gate constants were
added in that same initial commit, under the same "ported from the offline
research model" comment. **0.2 never tested whether these VALUES are right
— it only tested whether TEN different values (one per slot) beat ONE
shared value.** The shared value itself has never been fit or validated in
this repo, same unverifiable-but-trusted status the per-slot configs were
in before 0.2 ran.

**Mechanism — no new harness, a new consumer of `draft-sim.mjs`'s
`simulateDraft`/`realizedWeeklyPoints`**, the same pair every gate since 2.4
has used (avoids the circularity of scoring an agent on the metric it
optimizes — both arms draft off PROJECTIONS, both are scored on REALIZED
weekly points against the real schedule). `round-gate-test.mjs` sweeps
candidate rounds for one mode at a time (`--mode QB` touches
`SLOT_DEFAULT.QB_MIN`/`QB2_MIN`, keeping the shipped gap of +1 between
them; `--mode TE` touches `teMinRound`/`te2MinRound`, keeping the shipped
gap of +3) against the real shipped `DEFAULT_SNAKE_PARAMS` (`SLOTS`
stripped, matching production), paired per season/slot/seed.

**The overfitting guard, because this step exists specifically to avoid
repeating 0.2's own root problem.** If WE fit a value on every available
season and report the in-sample winner, that is the exact sin that got the
original per-slot configs collapsed — an overfit sweep always looks good on
its own fit data. Seasons up to `--fitUpto` (default 2021) are the FIT
split; the rest are HELD OUT. Unlike 0.2's split — fixed by when the
original, unreproducible grid search happened to run, not chosen for
validation quality — this one is chosen deliberately: fit on the OLDER
seasons, validate on the more RECENT ones, the direction that actually
matters for a tool drafting in 2026.

**Search range, per the user's explicit instruction not to artificially
narrow it around the current default**: "assuming we would go back further
(earlier rounds) if we clear the kill gates, this makes sense." Default
sweep is `--values 5,6,7,8,9,10,11` for QB (shipped: 8) and `--values
1,2,3,4,5,6,7` for TE (shipped: 4) — spanning genuinely earlier rounds, not
a narrow band hugging the inherited value, and re-runnable with a wider
range in either direction if a boundary value wins.

**Kill gate**: a candidate round only replaces the shipped default if it
beats it by `mean/SE > 2` on the HELD-OUT split. An in-sample win alone is
not evidence, same bar every gate in this document uses.

**FIRST-PASS RESULT (12 seeds × slots {1,4,7,10}, GitHub Actions runs
[QB](https://github.com/arimeltzer/fantasy-draft-tool/actions/runs/33803752719)/
[TE](https://github.com/arimeltzer/fantasy-draft-tool/actions/runs/33803760583))
— **TE confirms the shipped default; QB surfaces a real signal that needs a
bigger run before it ships.**

TE (shipped `teMinRound=4`): every candidate tested is worse than or
indistinguishable from shipped on the held-out split — round 4 is not just
untested, it is the best value in the tested range:

| round | fit | held |
|---|---|---|
| 1 | -4.4 ± 7.4 (t=-0.60) | -23.4 ± 6.9 (t=**-3.39**) |
| 2 | -15.7 ± 7.8 (t=-2.01) | -21.8 ± 6.9 (t=**-3.16**) |
| 3 | -12.2 ± 5.7 (t=-2.15) | -14.4 ± 6.5 (t=**-2.21**) |
| 4 (shipped) | 0 | 0 |
| 5 | -5.2 ± 6.2 (t=-0.84) | -8.6 ± 6.1 (t=-1.42) |
| 6 | -10.4 ± 7.4 (t=-1.40) | -15.9 ± 7.6 (t=**-2.10**) |
| 7 | -12.5 ± 7.7 (t=-1.61) | -33.5 ± 7.3 (t=**-4.59**) |

**No change to `teMinRound`.**

QB (shipped `QB_MIN=8`) is messier, and reading it honestly needs more than
the script's own mechanical "best held mean that clears the bar" pick
(round 6) — that pick ignores whether a candidate's FIT and HELD signs
agree, which is exactly the kind of consistency check the fit/held split
exists to provide:

| round | fit | held |
|---|---|---|
| 5 | -49.8 ± 8.8 (t=**-5.62**) | +24.4 ± 8.3 (t=**2.94**) — **sign flip** |
| 6 | -19.5 ± 7.0 (t=**-2.77**) | +26.7 ± 5.9 (t=**4.49**) — **sign flip** |
| 7 | +26.1 ± 4.9 (t=**5.27**) | +16.0 ± 4.7 (t=**3.39**) — **consistent** |
| 8 (shipped) | 0 | 0 |
| 9 | -42.1 ± 6.1 (t=-6.87) | -23.9 ± 4.8 (t=-4.97) |
| 10 | -63.5 ± 7.5 (t=-8.49) | -48.0 ± 6.6 (t=-7.29) |
| 11 | -53.7 ± 7.3 (t=-7.35) | -45.0 ± 7.5 (t=-5.96) |

Rounds 5 and 6 both clear `|t|>2` held-out, but their FIT-split sign is the
OPPOSITE of their held-out sign — moving QB_MIN to 5 or 6 measurably HURT on
2017-2021 and measurably HELPED on 2022-2025. That is the specific pattern
the fit/held split exists to catch: a value that only looks good on the
seasons it wasn't checked against is a candidate for "this happens to fit
recent seasons' quirks," not a structural improvement, however large its
held-out t-value. **Round 7 is different** — the ONLY candidate with the
SAME sign, both clearing significance, in BOTH splits (+26.1 fit, +16.0
held) — a real, consistent, one-round-earlier signal. Rounds 9-11
(later than shipped) are uniformly and heavily worse in both splits,
confirming the gate direction matters, not just its exact value.

**Not shipped yet.** Round 7's effect size (+16 to +26 pts) is larger than
most gates that DID ship in this document (2.4's own confirmed effect was
+4.67 pts), but it rests on the same n (192-240 paired drafts) that made
2.4's and 3.9's own FIRST passes read as "underpowered, not null" before a
~4x larger run confirmed them — and a ROUND GATE is a binary block, a
bigger behavioral lever than either of those multipliers, so getting it
wrong costs more than getting a multiplier wrong. Recommendation: run a
bigger confirmatory sweep centered on rounds 6-8 (more seeds, more slots)
before changing `QB_MIN`, same fork 2.4 and 3.9 both faced — user's call.

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
  makes "how much of my budget for this player" answerable. **SCOPED, see
  below; split three ways, only one part is buildable today.**
- **4.2 Start/sit optimizer** — uses distributions, not means. Correct answers
  here differ from "start the higher projection" when you need variance.
  **Note: 2.2's closure already forfeited this** — the RESTRUCTURE's adopted
  consequence #3 moves the Phase 2 unit from player-weeks to team-weeks, and
  says so explicitly: that "forfeits start/sit (4.2) and bench option value,
  but NOT P(title)." 4.2 is therefore blocked on a route Phase 2 has already
  abandoned, not merely un-started.
- **4.3 Trade evaluator** — ΔP(title) for both sides; a fair trade can raise
  both, and knowing which trades do is a real edge.
- **4.4 Playoff-aware construction** — as the season progresses the objective
  shifts from "make the playoffs" to "win them", and roster preferences shift
  with it.

### 4.1 Waiver/FAAB valuation — SCOPED, split three ways

**The step as written cannot be built, and the blocker is this file's own
recorded state, not a new discovery.** "Price a claim in ΔP(title)" needs
2.3, which is **NOT STARTED** and, per the RESTRUCTURE's adopted consequence
#2, does not get built until a feasibility probe settles whether its
calibration gate is measurable at acceptable cost at all. Under that sits
2.2, **CLOSED**, both attempts rejected. Writing 4.1 against ΔP(title) today
means either waiting on that chain or quietly inventing an uncalibrated
title probability — the exact thing 2.3's own gate text calls "worse than
none, because every downstream decision inherits its bias."

So 4.1 splits the same way RESTRUCTURE split every Phase 3 step: a
**mechanism** that is Phase-2-free, and an **objective** that is not. Doing
that here turns up a genuine asymmetry — one part has its precondition
already cleared by code that ships today, one part is an infrastructure
project wearing a modeling project's clothes, and one is blocked.

**Two precondition findings, verified by reading the code, not assumed:**

1. **This league's own FAAB history is ALREADY parsed and pullable.**
   `espn.all_waivers()` returns `playerId -> winning FAAB bid`, merging two
   independently-discovered sources: the league ACTIVITY feed
   (`kona_league_communication` topics, `messageTypeId` 180, where `from` is
   the winning bid) and the `transactions` array's `bidAmount`. Yahoo's
   adapter carries the same via `faab_bid`. Both are fixture-tested and in
   production today — they feed the keeper price basis. Better still,
   `fetch_draft_history`'s `leagueHistory` fallback already pulls *many*
   seasons (cap raised to 15), so multi-season waiver history is reachable
   through machinery that exists. **Precondition CLEARED** for a
   history-calibrated model.
2. **There is no in-season state in this application at all.** Verified by
   search: no `current_week`, no rest-of-season projection path, no FAAB
   budget field, and — the load-bearing one — `DraftPick` rows are
   **draft-day only** and are never updated for adds or drops. `projectPoints`
   projects a FULL season from prior-season totals; nothing anywhere
   re-projects from partial in-season data. **Precondition FAILS** for
   anything that needs to know what your roster is in week 9.

**4.1a League FAAB spend calibration — the buildable part, PRE-REGISTRATION.**

*What it is*: learn what THIS room actually pays for waiver adds, from its own
history. Deliberately the direct analogue of `auction-calibration.js`, which
solved the identical problem one phase earlier — a generic curve is wrong for
a specific room, and the room's own history is the correction. That prior art
is not a loose resemblance; it is the same shape of data (per-transaction
prices, pooled across seasons), so it should reuse the same guards that were
already argued for and tested there: shrink toward neutral by sample size,
refuse below a minimum sample, renormalize to spend-neutral, weight older
seasons by `RECENCY_DECAY ** age` so a departed set of managers cannot
outvote the current one, and — critically — `assessStability`'s leave-one-
season-out persistence test, **per category, not globally**, since a
selftest already caught exactly the bug where a global pass hands confidence
to a category that has not earned it.

*What it must NOT do*: contaminate what a player is WORTH with what the room
will PAY. `auction-calibration.js` enforces this by taking no calibration
argument in `dollarValues` at all, with a selftest asserting it — the same
separation applies here and for the same reason (collapsing the two destroys
the bargain signal, which is the entire product).

*Kill gate, pre-registered*: the same test `auction-calibration.js` already
passes — leave-one-season-out, per category. Predicting each season's FAAB
spend distribution from the OTHER seasons must beat a generic/flat baseline
on held-out seasons, per category, or that category is shrunk to neutral
rather than shipped. A room with one season of history yields stability
`null` = UNKNOWN, not fine. **This gate is measurable today**, which is
precisely why 4.1a is the part that is buildable.

*What 4.1a does NOT answer*: whether a given claim is worth making. It prices
the MARKET, not the player — the waiver equivalent of `marketPrice()`, not of
`dollarValues()`. That is a real limitation and is the honest boundary of
what today's data supports.

**4.1b Rest-of-season marginal value — an INFRASTRUCTURE step, mis-scoped as
a modeling one.**

*The actual question*: what is this claim worth in points above the player he
would displace in your lineup, over the remaining weeks? That is a marginal-
starter calculation over a rest-of-season projection — conceptually
straightforward and Phase-2-free.

*Why it is not startable*: it needs, at minimum, (a) the current week, (b)
your CURRENT roster rather than your drafted one, and (c) a rest-of-season
projection. Finding #2 above says none of the three exist. Recognizing this
as an infrastructure build is the point of writing it down: it is several
schema and pipeline changes (in-season roster sync, a weekly refresh, a
partial-season projection path) with a modest model on top, and estimating it
as a modeling step would badly understate it.

*Kill gate*: deliberately NOT set — the 3.6b precedent. A number invented
before the infrastructure exists is a guess wearing a kill gate's clothes.

*A specific, already-measured hazard to carry into any future 4.1b work.*
Waiver claims are drawn overwhelmingly from the DEEP end of the player pool,
which is exactly the population where this project's own measurement found
**49.4% of player-weeks score exactly 0** (#32203391598). The RESTRUCTURE
already flags the caveat that this figure "pools all ADP depths and deep
players dominate the count" — meaning for the waiver population specifically
the zero-inflation is likely WORSE than 49.4%, not better. A point estimate
for a streaming DST or an unstarted handcuff inherits that directly, and a
mixture (point-mass-at-zero plus a continuous part) is what 2.2 already
proved one pooled distribution cannot represent. The rank-conditioned
breakdown RESTRUCTURE says is needed before that 49.4% "means what it appears
to mean" is therefore not optional background reading for 4.1b — it is a
prerequisite diagnostic, and running it would also settle an open question
Phase 2 left behind.

**4.1c ΔP(title) pricing — BLOCKED, and correctly so.**

The roadmap's literal ask. Blocked on 2.3, which is blocked on its own
feasibility probe. Kept in this document as the target the objective seam
reaches later — per RESTRUCTURE's adopted consequence #4, "everything
optimizes ΔP(title)" is no longer a prerequisite, it is a destination. When
4.1a and/or 4.1b exist, they should take the objective as an injected
`valueOf(...)`, exactly as Phase 3's mechanisms do, so 4.1c is a swap and not
a rewrite.

**Status: 4.1 SCOPED, NOT STARTED. 4.1a is buildable now** (precondition
cleared, gate measurable, strong prior art to reuse). **4.1b is an
infrastructure project** that should be planned as one. **4.1c is blocked.**

> **Prompt** — "Build roadmap 4.1a only: league FAAB spend calibration from
> the league's own waiver history, reusing `auction-calibration.js`'s shrink /
> recency-decay / per-category leave-one-season-out structure. Do not price
> individual claims (that is 4.1b) and do not touch ΔP(title) (that is 4.1c)."

> **Prompt (alternative, if in-season features are the real goal)** — "Scope
> the in-season infrastructure 4.1b needs — current week, live roster sync
> beyond draft day, rest-of-season projections — as its own step with its own
> gates, before any waiver model is written on top of it."

---

## Sequencing, honestly

| Phase | Effort | Payoff | Risk |
|---|---|---|---|
| 0 | Days | Moderate, near-certain | Low — 0.1, 0.2 and 0.3 are all done; see their results above |
| 1 | Weeks | Real, but position-specific | Moderate — 1.1/1.2 done, TE only; 1.3 done, team_change RB/WR only (qb_change/coach_change/pace failed); 1.4 done, not shipped (draft capital ≈ what ADP already knows for rookies) |
| 2 | Weeks | Largest conceptual | **Highest — except 2.4** — 2.1 done (RB/WR/TE calibrated, QB excluded); 2.2 CLOSED, both attempts rejected; 2.3 not started, pending a feasibility probe; **2.4 scoped and LOW risk** (deterministic, no distribution, every component already built) |
| 3 | Weeks | Large, format-specific | Moderate — **no longer depends on Phase 2**; mechanisms build against the current objective behind a seam (see RESTRUCTURE) |
| 4 | Ongoing | Large over a season | **Re-rated — "low technically" was wrong.** 4.1 scoped: 4.1a buildable now (FAAB history already parsed, gate measurable); 4.1b is an INFRASTRUCTURE build (no in-season state exists anywhere in the app); 4.1c blocked on 2.3; 4.2 blocked on a route 2.2's closure abandoned |

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

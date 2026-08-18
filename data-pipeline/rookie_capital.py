"""
rookie_capital.py — draft-capital-based rookie projection (roadmap 1.4)
=========================================================================
Rookies with no FantasyPros projection currently fall back to an ADP/ECR
decaying curve (`rookieProjection()` in engine-core.js / `rookie_projection()`
in projection_model.py — market rank on a log curve from a positional
ceiling). NFL draft round and pick are known before a single NFL snap is
played and are a far stronger prior on rookie-year opportunity than a market
rank built mostly on college hype and beat-writer chatter, which is exactly
the roadmap's own framing for 1.4.

DATA SOURCE, verified before use: `nflreadpy.load_draft_picks()` — PFR-
sourced, one row per pick, covers 1980-present. Spot-checked against 2023's
real draft: pick 1 Bryce Young (QB), pick 2 C.J. Stroud (QB), pick 4 Anthony
Richardson (QB), pick 8 Bijan Robinson (RB), pick 12 Jahmyr Gibbs (RB) — all
correct — with `gsis_id` populated for 100% of the 2023 skill-position
sample (80 picks checked). `gsis_id` is the SAME id scheme
`load_player_stats`/`load_contracts` already use elsewhere in this pipeline
(confirmed working via `team_context.py`'s commitment matching), so no extra
name-matching layer is needed.

MODEL: bucket by ROUND, not a continuous pick-based curve — the "don't fit
more parameters than the data supports" discipline that collapsed the
per-slot snake configs (roadmap 0.2) and kept the team-change nuance
constructions to one number apiece. For each position, the expected
rookie-season pace (points/gp * 17, same unit `projectPoints()` blends on)
is the empirical mean pace of every OTHER rookie drafted in that round,
pooled across seasons the CALLER has already restricted to strictly before
the one being predicted — zero lookahead, the same discipline `pace_ratio`/
`quality_z`/`oline_z`/`commitment_z` in `team_context.py` use. A round with
too few historical rookies at a position (`MIN_ROUND_N`) falls back to that
position's overall mean across all rounds — never a bare guess, never
silently zero-effect, the same coverage rule every other stage in this
pipeline follows.
"""

MIN_ROUND_N = 5  # a (position, round) bucket needs at least this many prior
                  # rookies pooled before its own mean is trusted; otherwise
                  # fall back to the position-wide mean across all rounds.


def draft_capital_by_player(rows) -> dict:
    """rows: iterable of (gsis_id, round, pick). Returns
    {gsis_id: (round, pick)}. A player has exactly one NFL draft — the first
    row wins on an accidental duplicate rather than the last, so a
    re-fetch/re-ordering can't silently change an answer already computed."""
    out: dict = {}
    for gsis_id, rnd, pick in rows:
        if not gsis_id or rnd is None:
            continue
        out.setdefault(gsis_id, (int(rnd), int(pick) if pick is not None else None))
    return out


def rookie_capital_curve(rows) -> dict:
    """rows: iterable of (pos, round, pace) for historical rookie seasons —
    the caller is responsible for restricting these to seasons strictly
    before the one being predicted (no lookahead).

    Returns {(pos, round): mean_pace} for buckets with >= MIN_ROUND_N
    rookies, plus {("_ALL_", pos): mean_pace} as the per-position fallback
    for thin buckets (a round with 1-2 sampled rookies at a position would
    otherwise hand back a noisy, overconfident mean)."""
    by_bucket: dict = {}
    by_pos: dict = {}
    for pos, rnd, pace in rows:
        if pos is None or rnd is None or pace is None:
            continue
        by_bucket.setdefault((pos, rnd), []).append(pace)
        by_pos.setdefault(pos, []).append(pace)

    curve: dict = {}
    for key, vals in by_bucket.items():
        if len(vals) >= MIN_ROUND_N:
            curve[key] = sum(vals) / len(vals)
    for pos, vals in by_pos.items():
        if vals:
            curve[("_ALL_", pos)] = sum(vals) / len(vals)
    return curve


def rookie_capital_projection(pos: str, round_, curve: dict):
    """Expected rookie-season pace for (pos, round) — falls back to the
    position-wide mean for a thin/unseen round, returns None only when the
    position itself has no history in `curve` at all (caller falls back to
    the pre-existing ADP/ECR-curve model, same as an undrafted rookie with
    no `round_` at all)."""
    if round_ is None:
        return None
    v = curve.get((pos, round_))
    if v is not None:
        return v
    return curve.get(("_ALL_", pos))

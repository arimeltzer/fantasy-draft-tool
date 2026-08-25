#!/usr/bin/env python3
"""
athletic_blend_backtest.py — is The Athletic's projection a second expert
worth blending in, and at what weight?
=========================================================================
Same question roadmap 0.1 asked of FantasyPros, asked of a second,
independent source: The Athletic's downloadable stat-level projection
workbook (Jake's model — see athletic_projections.py). Same discipline:
measure the INCREMENTAL signal before touching any weight, on REAL
realized seasons, using the shipped scorer.

THE CORE QUESTION, in order:
  1. DISAGREEMENT SIGNAL. Controlling for our own model's ranking, does
     The Athletic's disagreement with it predict anything about what
     actually happened? If not, no blend weight can help — the same
     `disagreement_signal()` logic 0.1 used for FantasyPros, adapted to
     control for OUR MODEL instead of ADP (there is no ADP dependency in
     this half of the analysis at all — no FANTASYPROS_API_KEY needed).
  2. MATCHED-POPULATION ACCURACY. On the population The Athletic actually
     projects, does it beat our own model solo? (Still no API key needed.)
  3. BLEND WEIGHT SWEEP. blend_expert(model, athletic, w) — same POINTS-
     space blend engine-core.js already ships for FantasyPros — swept
     0.0-1.0, scored on realized season points AND pace, per position,
     per season AND pooled across both.
  4. FULL-STACK MERGE, ONLY IF FANTASYPROS_API_KEY IS SET: does adding
     The Athletic ON TOP OF the ALREADY-SHIPPED expert blend (model ->
     FantasyPros blend at EXPERT_BLEND_W, exactly what roadmap 0.1 put
     into production) still help, or does it just re-discover what
     FantasyPros already covers? Deliberately scoped to the expert-blend
     stage specifically (not also injury discount / market anchor,
     which don't interact with THIS redundancy question) — needs real
     historical FantasyPros projections, same precondition every other
     "vs the live board" check in this pipeline already has.

CAVEAT stated up front: only two seasons of this workbook exist right now
(2024, 2025) vs the 7 seasons (2019-2025) EXPERT_BLEND_W was fit on. Any
weight found here should be read as a first pass, not a final number —
more seasons (offered directly) would meaningfully firm this up.

  pip install nflreadpy pandas scipy numpy pyarrow openpyxl
  python athletic_blend_backtest.py \
    --season 2024:2024FFBProjections.xlsx --season 2025:2025FFBProjections.xlsx
"""
from __future__ import annotations

import argparse
import math
import os

import pandas as pd
from scipy import stats

from athletic_projections import load_parsed_json, norm as athletic_norm, parse_workbook
from projection_backtest import (
    _partial_spearman, build_players, load_ages, load_seasons, score, season_line,
)
from projection_model import DEFAULT_PARAMS, default_scoring, points, project_points

W_GRID = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
POSITIONS = ["QB", "RB", "WR", "TE"]

# Must match EXPERT_BLEND_W in engine-core.js exactly — the ALREADY-SHIPPED
# weights roadmap 0.1 justified. The full-stack check below reproduces that
# shipped blend first, then asks whether Athletic adds anything ON TOP of it.
EXPERT_BLEND_W = {"QB": 0.3, "RB": 0.2, "TE": 0.2, "WR": 0.4}


def blend_expert(model_pts, expert_pts, w):
    """Identical arithmetic to projection_backtest.blend_expert /
    engine-core.js blendExpert — reproduced here (not imported) only to
    avoid a private-name import; keep in sync if that function's contract
    ever changes."""
    return [
        w * m + (1 - w) * e if (e is not None and e > 0) else m
        for m, e in zip(model_pts, expert_pts)
    ]


def disagreement_vs_model(pop, model_pts, athletic_by_idx, sc):
    """Does ATHLETIC's disagreement with OUR MODEL predict the actual
    finish, controlling for our model? Adapted from
    projection_backtest.disagreement_signal, which asks the same question
    of FantasyPros controlling for ADP — here the baseline being
    controlled for is our own model, not the market, and the "new" ranking
    under test is The Athletic's, not our model's. No ADP/API-key
    dependency: matched population is defined by Athletic coverage alone.
    """
    by_pos = {}
    for i, p in enumerate(pop):
        if i in athletic_by_idx:
            by_pos.setdefault(p["pos"], []).append(i)

    out = {}
    for pos, idxs in by_pos.items():
        if len(idxs) < 15:
            continue
        # Actual points reuse the SAME season_line/points machinery as
        # score() — recomputed directly here for the partial-correlation
        # ranks rather than round-tripped through score()'s dataframe.
        act_pts = {i: points(season_line(pop[i]["_actual"]), sc) for i in idxs}

        mdl = {i: r for r, i in enumerate(sorted(idxs, key=lambda i: -model_pts[i]))}
        ath = {i: r for r, i in enumerate(sorted(idxs, key=lambda i: -athletic_by_idx[i]))}
        act = {i: r for r, i in enumerate(sorted(idxs, key=lambda i: -act_pts[i]))}

        X = [-ath[i] for i in idxs]   # Athletic's rank (negated: higher = better)
        Y = [-act[i] for i in idxs]   # actual finish
        Z = [-mdl[i] for i in idxs]   # our model's rank (the control)

        res = {
            "n": len(idxs),
            "partial_athletic": round(_partial_spearman(X, Y, Z), 4),
            "rho_model": round(float(stats.spearmanr(Z, Y).statistic), 4),
            "rho_athletic": round(float(stats.spearmanr(X, Y).statistic), 4),
            "rho_athletic_model": round(float(stats.spearmanr(X, Z).statistic), 4),
        }
        out[pos] = res
    return out


def full_stack_check(players, model_pts, fp_pts_by_idx, athletic_pts_by_idx, sc):
    """THE decisive check: does Athletic still help ON TOP OF the
    ALREADY-SHIPPED FantasyPros blend (EXPERT_BLEND_W), or does it just
    re-discover what FantasyPros already covers?

    `shipped` reproduces exactly what roadmap 0.1 put into production —
    model blended with FantasyPros at the shipped per-position weight.
    `candidate(w)` blends Athletic on top of THAT (not on top of the pure
    model), at a swept weight. Both are scored against real outcomes over
    the FULL population our model covers (the same "all" population 0.1's
    own merged-number gate used) — blend_expert() already no-ops for any
    player either expert source doesn't cover, so this is safe to run
    over everyone rather than a matched subset.

    Refuses outright on thin FantasyPros coverage rather than silently
    scoring "shipped == pure model" as if it meant something — a fetch
    that 403s or partially fails must not quietly stand in for FantasyPros
    actually being blended in (the exact ADP-429 failure mode
    adp_probe.fetch_adp's own docstring already documents once).
    """
    if len(fp_pts_by_idx) < 30:
        raise RuntimeError(
            f"only {len(fp_pts_by_idx)} players matched to a FantasyPros projection — "
            "the fetch almost certainly failed. Refusing to run the full-stack check on "
            "what would silently be 'shipped == pure model' instead of the real blend."
        )
    shipped = []
    for i, p in enumerate(players):
        w = EXPERT_BLEND_W.get(p["pos"])
        fp = fp_pts_by_idx.get(i)
        shipped.append(blend_expert([model_pts[i]], [fp], w)[0] if w is not None else model_pts[i])

    shipped_scores = score(players, shipped, sc)

    print("\n  FULL-STACK CHECK (model -> FantasyPros-blend[SHIPPED] -> +Athletic[CANDIDATE]):")
    best_by_pos = {}
    for pos in POSITIONS:
        if pos not in shipped_scores:
            continue
        shipped_rho = shipped_scores[pos]["spearman_total"]
        best_w, best_rho = 1.0, shipped_rho    # w=1.0 on `shipped` == no Athletic at all
        for w in W_GRID:
            candidate = [blend_expert([shipped[i]], [athletic_pts_by_idx.get(i)], w)[0]
                         for i in range(len(players))]
            res = score(players, candidate, sc)
            rho = res.get(pos, {}).get("spearman_total")
            if rho is not None and rho > best_rho:
                best_w, best_rho = w, rho
        delta = best_rho - shipped_rho
        best_by_pos[pos] = {"shipped_rho": shipped_rho, "best_w": best_w,
                             "best_rho": best_rho, "delta": delta}
        verdict = ("HELPS beyond FantasyPros" if delta > 0.005
                    else "no meaningful gain beyond FantasyPros" if delta > -0.005
                    else "WORSE than FantasyPros alone")
        print(f"    {pos}: shipped(FantasyPros-only)={shipped_rho:+.4f}  "
              f"best-with-Athletic(w={best_w})={best_rho:+.4f}  "
              f"delta={delta:+.4f}  -> {verdict}")
    return best_by_pos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", action="append", required=True,
                     help="YEAR:path — repeatable, one per test season. Path may be the "
                          "raw .xlsx workbook (local runs) or a --out JSON export from "
                          "athletic_projections.py (CI, no raw workbook committed)")
    args = ap.parse_args()

    season_files = {}
    for s in args.season:
        yr, path = s.split(":", 1)
        season_files[int(yr)] = path

    years = sorted(season_files)
    load_years = sorted({y for yr in years for y in (yr - 2, yr - 1, yr)})
    print(f"Loading nflverse actuals for {load_years}…")
    data = load_seasons(load_years)
    ages = load_ages(load_years)
    sc = default_scoring(0.5)

    pooled_rows = []          # for the pooled-across-seasons sweep
    all_disagreement = {}
    all_full_stack = {}

    for year in years:
        print(f"\n{'=' * 60}\n{year}\n{'=' * 60}")
        players = build_players(data, ages, year)
        model_pts = [project_points(p, sc)["proj"] for p in players]

        path = season_files[year]
        athletic_raw = load_parsed_json(path) if path.endswith(".json") else parse_workbook(path)
        # Match by (normalized name, position). Team is available in both
        # sides for a tie-break but isn't needed here — collisions on
        # (name, position) across 30+ teams are vanishingly rare for
        # real skill-position players, and any mismatch just drops the
        # player from the matched population rather than mis-scoring them.
        athletic_pts = {}
        for i, p in enumerate(players):
            key = (athletic_norm(p["name"]), p["pos"])
            rec = athletic_raw.get(key)
            if rec is None:
                continue
            e = points(rec, sc)
            if e > 0:
                athletic_pts[i] = e

        print(f"  {len(players)} players in the app's real draft-time population, "
              f"{len(athletic_pts)} matched to an Athletic projection")

        # ── 1. disagreement signal ──────────────────────────────────────
        dis = disagreement_vs_model(players, model_pts, athletic_pts, sc)
        for pos, res in dis.items():
            all_disagreement.setdefault(pos, []).append((year, res))
        print("\n  DISAGREEMENT SIGNAL (partial Spearman, controlling for our model):")
        for pos, res in sorted(dis.items()):
            print(f"    {pos}: partial={res['partial_athletic']:+.3f}  "
                  f"n={res['n']}  rho(athletic,actual)={res['rho_athletic']:+.3f}  "
                  f"rho(model,actual)={res['rho_model']:+.3f}  "
                  f"rho(athletic,model)={res['rho_athletic_model']:+.3f}")

        # ── 2/3. matched-population accuracy + weight sweep ─────────────
        matched_idx = sorted(athletic_pts)
        matched_players = [players[i] for i in matched_idx]
        matched_model = [model_pts[i] for i in matched_idx]
        matched_athletic = [athletic_pts[i] for i in matched_idx]

        model_solo = score(matched_players, matched_model, sc)
        athletic_solo = score(matched_players, matched_athletic, sc)
        print("\n  MATCHED-POPULATION SOLO ACCURACY (spearman vs actual TOTAL points):")
        for pos in POSITIONS:
            if pos in model_solo and pos in athletic_solo:
                print(f"    {pos}: model={model_solo[pos]['spearman_total']:+.3f}  "
                      f"athletic={athletic_solo[pos]['spearman_total']:+.3f}  "
                      f"(n={model_solo[pos]['n']})")

        print("\n  BLEND SWEEP (w = weight on OUR MODEL; w=1.0 pure model, w=0.0 pure Athletic):")
        for pos in POSITIONS:
            pos_idx = [k for k, p in enumerate(matched_players) if p["pos"] == pos]
            if len(pos_idx) < 10:
                continue
            best_w, best_rho = None, -2
            for w in W_GRID:
                blended = blend_expert(matched_model, matched_athletic, w)
                pos_players = [matched_players[k] for k in pos_idx]
                pos_blend = [blended[k] for k in pos_idx]
                res = score(pos_players, pos_blend, sc)
                rho = res.get(pos, {}).get("spearman_total")
                if rho is not None and rho > best_rho:
                    best_w, best_rho = w, rho
                pooled_rows.append({"year": year, "pos": pos, "w": w, "spearman_total": rho})
            print(f"    {pos}: best w={best_w} (spearman={best_rho:+.3f}, n={len(pos_idx)})")

        # ── 4. full-stack check: does this help beyond FantasyPros? ─────
        if os.getenv("FANTASYPROS_API_KEY"):
            from fantasypros import fetch_projections
            print(f"\n  Fetching FantasyPros {year} projections (4 calls, paced)…")
            fp_raw = fetch_projections(year, scoring="HALF")
            fp_pts_by_idx = {}
            for i, p in enumerate(players):
                rec = fp_raw.get((athletic_norm(p["name"]), p["pos"]))
                if rec is None:
                    continue
                e = points(rec, sc)
                if e > 0:
                    fp_pts_by_idx[i] = e
            print(f"  {len(fp_pts_by_idx)} players matched to a FantasyPros projection")
            try:
                fsc = full_stack_check(players, model_pts, fp_pts_by_idx, athletic_pts, sc)
                for pos, res in fsc.items():
                    all_full_stack.setdefault(pos, []).append((year, res))
            except RuntimeError as e:
                print(f"  ! full-stack check SKIPPED for {year}: {e}")

    # ── pooled sweep across both seasons ────────────────────────────────
    print(f"\n{'=' * 60}\nPOOLED ACROSS {years}\n{'=' * 60}")
    df = pd.DataFrame(pooled_rows).dropna(subset=["spearman_total"])
    for pos in POSITIONS:
        sub = df[df["pos"] == pos]
        if sub.empty:
            continue
        by_w = sub.groupby("w")["spearman_total"].mean().sort_values(ascending=False)
        best_w = by_w.index[0]
        print(f"  {pos}: mean spearman by w -> " +
              ", ".join(f"w={w:.1f}:{v:+.3f}" for w, v in by_w.sort_index().items()))
        print(f"       best mean w = {best_w} ({by_w.iloc[0]:+.3f})")

    print(f"\n{'=' * 60}\nDISAGREEMENT SIGNAL ACROSS SEASONS (consistency check)\n{'=' * 60}")
    for pos, entries in sorted(all_disagreement.items()):
        parts = ", ".join(f"{yr}:{r['partial_athletic']:+.3f}" for yr, r in entries)
        signs = {1 if r["partial_athletic"] > 0 else -1 for _, r in entries}
        consistent = "consistent sign" if len(signs) == 1 else "SIGN FLIPS between seasons"
        print(f"  {pos}: {parts}  ({consistent})")

    if os.getenv("FANTASYPROS_API_KEY"):
        print(f"\n{'=' * 60}\nFULL-STACK CHECK ACROSS SEASONS (consistency check)\n{'=' * 60}")
        print("Does Athletic still help ON TOP OF the already-shipped FantasyPros blend?")
        for pos, entries in sorted(all_full_stack.items()):
            parts = ", ".join(f"{yr}:{r['delta']:+.4f}(w={r['best_w']})" for yr, r in entries)
            signs = {1 if r["delta"] > 0 else -1 for _, r in entries}
            consistent = "consistent direction" if len(signs) == 1 else "DIRECTION FLIPS between seasons"
            print(f"  {pos}: {parts}  ({consistent})")
    else:
        print("\nNOTE: FANTASYPROS_API_KEY not set — skipped the full-stack merge check "
              "(vs the ALREADY-SHIPPED model+FantasyPros-blend board).")


if __name__ == "__main__":
    main()

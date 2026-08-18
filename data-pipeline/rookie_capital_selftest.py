"""Fixture tests for rookie_capital.py — run with: python3 rookie_capital_selftest.py"""
from rookie_capital import (
    MIN_ROUND_N,
    draft_capital_by_player,
    rookie_capital_curve,
    rookie_capital_projection,
)

checks = []


def check(label, cond):
    checks.append((label, bool(cond)))


# ── draft_capital_by_player ──────────────────────────────────────────
d = draft_capital_by_player([("00-001", 1, 8), ("00-002", 3, 74), ("00-003", None, 5)])
check("round 1 pick 8 recorded", d["00-001"] == (1, 8))
check("round/pick both carried through", d["00-002"] == (3, 74))
check("a row with no round (undrafted marker) is skipped", "00-003" not in d)

d2 = draft_capital_by_player([("00-001", 1, 8), ("00-001", 2, 40)])
check("first row wins on an accidental duplicate", d2["00-001"] == (1, 8))

d3 = draft_capital_by_player([(None, 1, 8), ("", 1, 9)])
check("a missing/blank gsis_id is skipped", len(d3) == 0)

# ── rookie_capital_curve ─────────────────────────────────────────────
# 6 RB round-1 rookies (>= MIN_ROUND_N=5) with a clean, known mean.
r1 = [("RB", 1, v) for v in (200, 210, 190, 205, 195, 220)]
c = rookie_capital_curve(r1)
check("round-1 RB bucket meets MIN_ROUND_N and gets its own mean",
      abs(c[("RB", 1)] - sum(v for _, _, v in r1) / len(r1)) < 1e-9)

# A thin bucket (fewer than MIN_ROUND_N) must NOT get its own entry.
thin = [("QB", 6, 40), ("QB", 6, 60)]
c2 = rookie_capital_curve(thin)
check("a bucket below MIN_ROUND_N is NOT trusted on its own",
      ("QB", 6) not in c2)
check("but the position-wide fallback still exists", ("_ALL_", "QB") in c2)

# A worse-drafted position should read a lower mean than a well-drafted one.
mix = ([("WR", 1, v) for v in (150, 160, 155, 165, 158, 152)] +
       [("WR", 7, v) for v in (20, 25, 18, 22, 30, 15)])
c3 = rookie_capital_curve(mix)
check("round 1 WRs project higher than round 7 WRs",
      c3[("WR", 1)] > c3[("WR", 7)])

# A None pos/round/pace row is ignored, not crashed on.
c4 = rookie_capital_curve([(None, 1, 100), ("RB", None, 100), ("RB", 1, None)] + r1)
check("None pos/round/pace rows are skipped without crashing",
      abs(c4[("RB", 1)] - sum(v for _, _, v in r1) / len(r1)) < 1e-9)

check("MIN_ROUND_N is the documented value", MIN_ROUND_N == 5)

# ── rookie_capital_projection ────────────────────────────────────────
curve = rookie_capital_curve(mix)
check("a well-sampled bucket returns its own mean",
      rookie_capital_projection("WR", 1, curve) == curve[("WR", 1)])
check("round_=None (undrafted / unknown) returns None, not a guess",
      rookie_capital_projection("WR", None, curve) is None)
check("an unseen round for a KNOWN position falls back to the position mean",
      rookie_capital_projection("WR", 4, curve) == curve[("_ALL_", "WR")])
check("a position with no history at all returns None",
      rookie_capital_projection("TE", 1, curve) is None)


failed = [label for label, ok in checks if not ok]
for label, ok in checks:
    print(f"  {'ok' if ok else 'FAIL'}    {label}")
if failed:
    raise SystemExit(f"\n{len(failed)}/{len(checks)} checks FAILED: {failed}")
print(f"\nrookie_capital_selftest: all {len(checks)} checks passed")

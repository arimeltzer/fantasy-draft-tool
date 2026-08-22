#!/usr/bin/env python3
"""
espn_draft_order_probe.py — is draftDetail.picks' array order real nomination order?
======================================================================================
Roadmap 3.7 (auction bench reservation, historical-price anchor) needs to pool
each of a room's historical drafts' picks near rank `starters[pos] + 1` IN
NOMINATION ORDER, so the "first backup" price can actually be identified.
`parse_draft_picks` builds `DraftPickRow` lists by walking `draftDetail.picks`
in array order, on the ASSUMPTION that array position IS nomination order —
read from the payload's shape, never independently checked against a real
draft the way every other "verified against real data" claim in this project
was (injury_probe.py, adp_probe.py, projection_probe.py). This is that check,
run before any 3.7 modeling code is written on top of the assumption.

THE TEST, OBJECTIVE AND SELF-CONTAINED — no external ground truth needed.
ESPN's live-draft payload carries an explicit `overallPickNumber` field on
each pick, which `parse_live_draft` already reads; the COMPLETED-draft parser
(`parse_draft_picks`) has never looked at it, only at `roundId`. If the array
order really is nomination order, `overallPickNumber` (where the field is
present at all) must increase strictly as the array is walked. That is a
property of ESPN's OWN payload, checkable without knowing who actually picked
what — the same kind of internal-consistency check `parse_live_draft`'s
`meta["raw_pick_slots"]` fix already used successfully on a related bug.

THREE POSSIBLE OUTCOMES, all informative, none of them a crash:
  PASS         — overallPickNumber is present and strictly increasing.
                 The precondition holds; 3.7 can rely on array order.
  FAIL         — overallPickNumber is present but NOT increasing with array
                 order. The precondition does NOT hold; 3.7's mechanism needs
                 a different foundation (sort by overallPickNumber explicitly
                 rather than trusting array position).
  INCONCLUSIVE — the field is absent from this payload entirely (older/
                 leagueHistory-path seasons are the likeliest case, per the
                 module docstring's own note that the history host "was not
                 built with sequence-preservation as a goal"). Says nothing
                 either way; 3.7 would need a per-season fallback for these.

No FANTASYPROS_API_KEY needed — this only talks to ESPN. Run somewhere with
real internet egress (this sandbox's own proxy blocks ESPN outright, so this
does not run locally in an agent session — GitHub Actions does):
    python espn_draft_order_probe.py --league-id 672996 --seasons 2024 2023 2022

Cookies for a PRIVATE league: pass --espn-s2/--swid, or set ESPN_S2/ESPN_SWID
in the environment (e.g. as GitHub Actions secrets, which are masked in logs
and never need to be typed anywhere this script's caller can read them back).
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import httpx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from integrations.espn import league_url, history_league_url  # noqa: E402


def fetch(url: str, cookies: dict, timeout: float = 20) -> tuple[int, dict | list | None]:
    """GET with a light retry on transient/rate-limit failures — this is a
    one-off diagnostic, not a production path, so no need for the app's own
    backoff machinery, just enough to not choke on a blip."""
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    for attempt in range(3):
        try:
            r = httpx.get(url, headers=headers, cookies=cookies, timeout=timeout, follow_redirects=True)
        except Exception as e:  # noqa: BLE001 — report, don't crash the whole probe
            print(f"    request error ({type(e).__name__}): {e}")
            time.sleep(2 ** attempt)
            continue
        if r.status_code == 200:
            return r.status_code, r.json()
        if r.status_code == 429:
            time.sleep(2 ** (attempt + 1))
            continue
        return r.status_code, None
    return 0, None


def check_season(league_id: str, season: int, cookies: dict) -> str:
    """Returns one of PASS / FAIL / INCONCLUSIVE / ERROR, for the summary."""
    print(f"\n{season}:")
    status, data = fetch(league_url(league_id, season), cookies)
    source = "current"
    if status != 200:
        status, data = fetch(history_league_url(league_id, season), cookies)
        source = "history"

    if status != 200 or data is None:
        reason = " — private league; needs --espn-s2/--swid" if status in (401, 403) else ""
        print(f"  ERROR — HTTP {status} ({source} path){reason}")
        return "ERROR"

    if isinstance(data, list):  # ESPN sometimes wraps a single league in a list
        data = data[0] if data else {}

    picks = (data.get("draftDetail", {}) or {}).get("picks", []) or []
    if not picks:
        print(f"  ERROR — {source} path returned 200 but draftDetail.picks is empty")
        return "ERROR"

    seq = [p.get("overallPickNumber") for p in picks if p.get("overallPickNumber") is not None]
    print(f"  {len(picks)} picks total, {len(seq)} carry overallPickNumber ({source} path)")

    if not seq:
        print("  INCONCLUSIVE — no overallPickNumber field in this payload to check against.")
        return "INCONCLUSIVE"

    monotonic = all(seq[i] < seq[i + 1] for i in range(len(seq) - 1))
    if monotonic:
        print(f"  PASS — overallPickNumber increases strictly with array position "
              f"(1..{seq[-1]}). Array order IS real nomination order for this season.")
        return "PASS"

    bad = next(i for i in range(len(seq) - 1) if seq[i] >= seq[i + 1])
    print(f"  FAIL — array order does NOT track overallPickNumber "
          f"(breaks at index {bad}: {seq[bad]} -> {seq[bad + 1]}).")
    return "FAIL"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--league-id", required=True)
    ap.add_argument("--seasons", nargs="+", type=int, required=True)
    ap.add_argument("--espn-s2", default=os.getenv("ESPN_S2", ""))
    ap.add_argument("--swid", default=os.getenv("ESPN_SWID", ""))
    args = ap.parse_args()

    cookies = {}
    if args.espn_s2 and args.swid:
        swid = args.swid if args.swid.startswith("{") else "{" + args.swid + "}"
        cookies = {"espn_s2": args.espn_s2, "SWID": swid}
        print("Using provided espn_s2/SWID cookies.")
    else:
        print("No cookies provided — trying as a public league first.")

    results = {season: check_season(args.league_id, season, cookies) for season in args.seasons}

    print("\n=== SUMMARY (roadmap 3.7 precondition) ===")
    for season, verdict in results.items():
        print(f"  {season}: {verdict}")

    passes = sum(1 for v in results.values() if v == "PASS")
    fails = sum(1 for v in results.values() if v == "FAIL")
    inconclusive = sum(1 for v in results.values() if v == "INCONCLUSIVE")
    errors = sum(1 for v in results.values() if v == "ERROR")

    print()
    if fails:
        print(f"PRECONDITION FAILS for {fails} season(s) — the array-order assumption is WRONG "
              "there. 3.7 needs to sort explicitly by overallPickNumber rather than trust "
              "array position, at minimum for the seasons that failed.")
    elif passes and not inconclusive and not errors:
        print(f"PRECONDITION HOLDS for all {passes} checked season(s) — array order is real "
              "nomination order. Safe to build 3.7's historical-anchor mechanism on it.")
    elif passes:
        print(f"PARTIAL: {passes} season(s) PASS, {inconclusive} INCONCLUSIVE (no field to "
              f"check), {errors} ERROR (unreachable). Safe to rely on array order only for "
              "seasons that reach the `current` path with the field present; treat older/"
              "leagueHistory-path seasons as needing a fallback until checked separately.")
    else:
        print("NO season could be verified PASS — do not build on the array-order assumption "
              "yet. Reachability/data issues need resolving first.")


if __name__ == "__main__":
    main()

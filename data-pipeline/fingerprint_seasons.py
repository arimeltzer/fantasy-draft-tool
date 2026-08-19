#!/usr/bin/env python3
"""
fingerprint_seasons.py — is the exported draft board data actually stable
across two separate exports, or does FantasyPros serve something that moves?

Built to diagnose a real anomaly: roadmap 3.1's survival gate flipped from
+12.00 pts (10/10 slots positive) to -2.20 pts (2/10 positive) between two
runs 15 minutes apart, same code, same --seeds, same season range. The
downstream engine (projectAll/marketAnchor) has no RNG in it, so if the RAW
export is stable the flip has to be a bug in the simulation; if the export
ITSELF differs run to run, the "historical" ADP this pulls for recent/current
seasons may not actually be a frozen snapshot.

This is deliberately fast (no simulation) so two runs cost ~10s each instead
of ~15min, and prints a stable fingerprint (row count, ADP coverage, sum of
ADP ranks, sum of actual points, a hash of the sorted (name,pos,adp) tuples)
per season -- comparable by eye across two CI runs' logs.
"""
import argparse
import hashlib
import json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="results/draft_seasons.json")
    args = ap.parse_args()

    with open(args.data, encoding="utf-8") as fh:
        raw = json.load(fh)

    for year in sorted(raw.keys(), key=int):
        v = raw[year]
        players = v["players"]
        actual = v["actual"]
        n = len(players)
        with_adp = sum(1 for p in players if p.get("adp"))
        sum_adp = sum(p["adp"] for p in players if p.get("adp"))
        sum_actual = sum(actual.values())

        # Stable across key ordering: sort by (name, pos) before hashing.
        rows = sorted(
            (p["name"], p["pos"], p.get("adp"), actual.get(str(p["id"])))
            for p in players
        )
        h = hashlib.sha256(repr(rows).encode()).hexdigest()[:12]

        print(
            f"  {year}: n={n:4d}  withADP={with_adp:4d}  sumADP={sum_adp:8.0f}  "
            f"sumActual={sum_actual:9.1f}  hash={h}"
        )


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
name_parity.py — the two nickname tables must not drift
=======================================================
The given-name alias table exists twice: once in TypeScript, for the board the
browser builds (`frontend/src/lib/playerName.ts`), and once in Python, for the
importer and the pipeline (`backend/integrations/name_aliases.py`).

Drift between them is silent and asymmetric, which is what makes it worth a
check. Add "gabe -> gabriel" to the pipeline only and the database stops
producing a duplicate, so nothing looks wrong — until a board built from an
older load still shows two rows and no one can reproduce it. The failure has no
error and no obvious owner; the tables simply disagree.

This parses the object literal out of the TypeScript rather than executing it,
so it needs no node, and compares the pairs both ways.

  python name_parity.py
"""
from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from integrations.name_aliases import GIVEN_NAME_ALIASES as PY  # noqa: E402

TS_PATH = os.path.join(ROOT, "frontend", "src", "lib", "playerName.ts")


def parse_ts_table(src: str) -> dict[str, str]:
    m = re.search(r"GIVEN_NAME_ALIASES:\s*Record<string,\s*string>\s*=\s*\{(.*?)\n\};",
                  src, re.S)
    if not m:
        raise SystemExit("could not find GIVEN_NAME_ALIASES in playerName.ts — "
                         "the parity check cannot verify anything, so it fails loudly")
    body = re.sub(r"//[^\n]*", "", m.group(1))          # drop comments
    return {k: v for k, v in re.findall(r'(\w+)\s*:\s*"([^"]+)"', body)}


def main() -> None:
    with open(TS_PATH, encoding="utf-8") as fh:
        ts = parse_ts_table(fh.read())

    if not ts:
        raise SystemExit("parsed 0 entries from playerName.ts — refusing to pass")

    only_ts = {k: v for k, v in ts.items() if k not in PY}
    only_py = {k: v for k, v in PY.items() if k not in ts}
    differ = {k: (ts[k], PY[k]) for k in ts if k in PY and ts[k] != PY[k]}

    for label, d in (("only in playerName.ts", only_ts),
                     ("only in name_aliases.py", only_py)):
        for k, v in sorted(d.items()):
            print(f"  {label}: {k} -> {v}")
    for k, (a, b) in sorted(differ.items()):
        print(f"  disagree: {k} -> ts={a} py={b}")

    if only_ts or only_py or differ:
        raise SystemExit(
            f"name parity FAILED: {len(only_ts)} ts-only, {len(only_py)} py-only, "
            f"{len(differ)} conflicting")

    # A shared table is necessary but not sufficient — the folding rule has to
    # agree too. Only the first token may change, and a lone token is untouched.
    from integrations.name_aliases import alias_name
    checks = [
        ("josh palmer", "joshua palmer"),
        ("joshua palmer", "joshua palmer"),   # already canonical: idempotent
        ("hollywood brown", "marquise brown"),
        ("mike thomas", "michael thomas"),
        ("thomas mike", "thomas mike"),       # surname position is never folded
        ("josh", "josh"),                     # single token: left alone
        ("", ""),
    ]
    for src, want in checks:
        got = alias_name(src)
        if got != want:
            raise SystemExit(f"name parity FAILED: alias_name({src!r}) = {got!r}, want {want!r}")

    print(f"name parity: {len(ts)} alias pairs identical, folding rule agrees")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
apply_aav_paste.py — push a copied FantasyPros auction-values sheet into the
live backend's `fantasy_players.aav` column.

The parsing/matching logic lives in `backend/integrations/fantasypros_aav_paste.py`
and is fixture-tested there (`python -m integrations.selftest`, from `backend/`).
This script is just the thin client for `POST /api/admin/fantasypros/aav-paste`
— a large pasted sheet is full of `$` and apostrophes that make it painful to
hand-quote for a raw curl command, so this reads it from a file instead.

Run (dry run — nothing is written, just a match report):
    python apply_aav_paste.py --file aav.txt

Run for real:
    python apply_aav_paste.py --file aav.txt --apply

Needs ADMIN_EMAIL / ADMIN_PASSWORD (the same admin account the backend
auto-creates on startup) and BACKEND_URL (defaults to the deployed Railway
backend from CLAUDE.md).
"""
from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BACKEND = "https://fantasy-draft-production-43ab.up.railway.app"


def _post(url: str, *, data: bytes | None, headers: dict, form: bool = False) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise SystemExit(f"HTTP {e.code} from {url}: {body[:500]}")


def login(base: str, email: str, password: str) -> str:
    body = f"username={urllib.parse.quote(email)}&password={urllib.parse.quote(password)}".encode()
    resp = _post(f"{base}/api/auth/login", data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"})
    return resp["access_token"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True, help="path to the pasted cheat-sheet text")
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument("--backend", default=os.getenv("BACKEND_URL", DEFAULT_BACKEND))
    args = ap.parse_args()

    email = os.getenv("ADMIN_EMAIL")
    password = os.getenv("ADMIN_PASSWORD")
    if not email or not password:
        raise SystemExit("Set ADMIN_EMAIL / ADMIN_PASSWORD (the backend's admin account).")

    text = open(args.file, encoding="utf-8").read()
    if not text.strip():
        raise SystemExit(f"{args.file} is empty.")

    token = login(args.backend, email, password)
    payload = json.dumps({"text": text, "season": args.season, "dry_run": not args.apply}).encode()
    resp = _post(f"{args.backend}/api/admin/fantasypros/aav-paste", data=payload,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})

    print(f"season {resp['season']}: parsed {resp['parsed']} rows "
        f"({resp['skipped_lines']} unparseable lines skipped)")
    print(f"matched {resp['matched']}, unmatched {resp['unmatched']}")
    if resp["unmatched_names"]:
        print("unmatched (first 40):", ", ".join(resp["unmatched_names"]))
    print("sample updates:", json.dumps(resp["sample"], indent=2))
    if resp["dry_run"]:
        print("\nDRY RUN — nothing written. Re-run with --apply to write.")
    else:
        print(f"\nWROTE {resp['matched']} aav values for season {resp['season']}.")


if __name__ == "__main__":
    main()

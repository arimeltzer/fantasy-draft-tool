#!/usr/bin/env python3
"""
check_db.py — quick health check on the fantasy_players table.

Run after a pipeline load to sanity-check what actually landed:
  $env:DATABASE_URL = "postgresql://...(DATABASE_PUBLIC_URL from Railway)..."
  python check_db.py [--season 2026]
"""
import argparse, os, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    args = ap.parse_args()

    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        sys.exit("ERROR: DATABASE_URL not set (use the Railway DATABASE_PUBLIC_URL).")
    db_url = db_url.replace("postgresql+asyncpg://", "postgresql://").replace("postgres://", "postgresql://")

    import psycopg2
    conn = psycopg2.connect(db_url)
    cur = conn.cursor()
    s = args.season

    cur.execute("SELECT count(*) FROM fantasy_players WHERE season=%s", (s,))
    total = cur.fetchone()[0]
    print(f"season {s}: {total} players")

    cur.execute("""SELECT count(*) FROM fantasy_players
                   WHERE season=%s AND (name IS NULL OR btrim(name)='' OR lower(name) IN ('nan','none'))""", (s,))
    print(f"  blank/NaN names : {cur.fetchone()[0]}")

    cur.execute("""SELECT count(*) FROM fantasy_players
                   WHERE season=%s AND (team IS NULL OR btrim(team)='')""", (s,))
    print(f"  blank teams     : {cur.fetchone()[0]}")

    cur.execute("""SELECT name, count(*) FROM fantasy_players WHERE season=%s
                   GROUP BY name HAVING count(*) > 1 ORDER BY count(*) DESC LIMIT 5""", (s,))
    dups = cur.fetchall()
    print(f"  duplicated names: {len(dups)} (top: {dups[:3] if dups else 'none'})")

    cur.execute("""SELECT count(*), min(aav), max(aav) FROM fantasy_players
                   WHERE season=%s AND aav IS NOT NULL""", (s,))
    n_aav, mn, mx = cur.fetchone()
    print(f"  aav set on      : {n_aav} players (min {mn}, max {mx})")

    cur.execute("""SELECT name, pos, team, ecr, adp, aav FROM fantasy_players
                   WHERE season=%s ORDER BY aav DESC NULLS LAST LIMIT 8""", (s,))
    print("  top rows by aav:")
    for r in cur.fetchall():
        print(f"    {r}")

    cur.close(); conn.close()

if __name__ == "__main__":
    main()

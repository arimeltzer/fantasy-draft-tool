#!/usr/bin/env python3
"""
run_migration.py — apply a .sql migration file to the Railway database.

Uses the SAME connection setup as load_to_db.py, so if that script works for
you, this one will too. Safe to re-run (our migrations use IF NOT EXISTS).

USAGE (from the data-pipeline folder):
  # 1) set the DB url in THIS terminal (copy DATABASE_PUBLIC_URL from
  #    Railway -> Postgres service -> Variables tab):
  #      PowerShell:  $env:DATABASE_URL = "postgresql://...paste here..."
  # 2) run it:
  python run_migration.py
  #    (or point at a specific file)
  python run_migration.py ../backend/migrations/001_add_last2_and_team_id.sql
"""
import os, sys
from pathlib import Path

DEFAULT_SQL = Path(__file__).resolve().parent.parent / "backend" / "migrations" / "001_add_last2_and_team_id.sql"

def main():
    sql_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SQL
    if not sql_path.exists():
        sys.exit(f"ERROR: SQL file not found: {sql_path}")

    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        sys.exit("ERROR: DATABASE_URL is not set in this terminal.\n"
                 "Copy DATABASE_PUBLIC_URL from Railway -> Postgres -> Variables, then run:\n"
                 '  $env:DATABASE_URL = "postgresql://...paste here..."')
    # psycopg2 wants postgresql://, not postgres:// or postgresql+asyncpg://
    db_url = db_url.replace("postgresql+asyncpg://", "postgresql://").replace("postgres://", "postgresql://")

    try:
        import psycopg2
    except ImportError:
        sys.exit("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")

    sql = sql_path.read_text()
    print(f"Applying {sql_path.name} ...")
    conn = psycopg2.connect(db_url)
    cur = conn.cursor()
    cur.execute(sql)
    conn.commit()

    # Confirm the two new columns now exist.
    cur.execute("""
        SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'fantasy_players'     AND column_name = 'last2')
           OR (table_name = 'fantasy_draft_picks' AND column_name = 'team_id')
        ORDER BY table_name, column_name
    """)
    rows = cur.fetchall()
    cur.close(); conn.close()

    print("  OK - migration applied. Confirmed columns:")
    for t, c in rows:
        print(f"     {t}.{c}")
    if len(rows) < 2:
        print("  ! Expected 2 columns but found fewer - check the output above.")
    else:
        print("Done. Safe to deploy the backend now.")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
load_to_db.py — load pipeline JSON into the Railway PostgreSQL database

USAGE
  Set DATABASE_URL in your environment (copy from Railway Variables tab), then:

  python load_to_db.py --data ./data --season 2026

Reads four files from --data:
  players_base.json      → fantasy_players table
  schedule_2026.json     → fantasy_schedule table
  player_logs_2025.json  → fantasy_player_logs table
  sos_logs.json          → computes SOS multipliers → fantasy_sos table

All inserts are upserts (safe to re-run).
"""
import argparse, json, os, sys
from pathlib import Path

# ── SOS math: Python port of strength-of-schedule.js ─────────────────────────

_P = dict(iterations=12, yoyRetention=0.35, sosWeight=0.5, cap=0.06,
          playoffWeeks={15, 16, 17}, playoffWeight=1.5)

def _mean(vals):
    return sum(vals) / len(vals) if vals else 0.0

def _adjusted_defense_ratings(logs):
    positions = list({l["pos"] for l in logs})
    teams     = list({t for l in logs for t in (l["off"], l["def"])})
    out = {"def": {}, "leagueAvg": {}}
    for pos in positions:
        rows = [l for l in logs if l["pos"] == pos]
        lg   = _mean([r["fp"] for r in rows])
        off  = {t: 0.0 for t in teams}
        defn = {t: 0.0 for t in teams}
        for _ in range(_P["iterations"]):
            nO, nD = {}, {}
            for t in teams:
                og = [r for r in rows if r["off"] == t]
                nO[t] = _mean([r["fp"] - lg - defn[r["def"]] for r in og]) if og else 0.0
                dg = [r for r in rows if r["def"] == t]
                nD[t] = _mean([r["fp"] - lg - off[r["off"]]  for r in dg]) if dg else 0.0
            mO = _mean(list(nO.values()));  mD = _mean(list(nD.values()))
            off  = {t: nO[t] - mO for t in teams}
            defn = {t: nD[t] - mD for t in teams}
        out["def"][pos]      = defn
        out["leagueAvg"][pos] = round(lg, 2)
    return out

def _regress_yoy(ratings):
    ret = _P["yoyRetention"]
    return {"def": {pos: {t: round(v * ret, 3) for t, v in defn.items()}
                    for pos, defn in ratings["def"].items()},
            "leagueAvg": ratings["leagueAvg"]}

def _build_sos_multipliers(schedule, est):
    out = {}
    for team, games in schedule.items():
        out[team] = {}
        for pos, defn in est["def"].items():
            acc = w = 0.0
            for g in games:
                wt = _P["playoffWeight"] if g["week"] in _P["playoffWeeks"] else 1.0
                acc += wt * defn.get(g["opp"], 0.0)
                w   += wt
            score = acc / w if w else 0.0
            lg    = est["leagueAvg"].get(pos) or 1.0
            m     = 1.0 + (score / lg) * _P["sosWeight"]
            m     = min(1 + _P["cap"], max(1 - _P["cap"], m))
            out[team][pos] = round(m, 3)
    return out

# ── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data",       default="./data",  help="folder with pipeline JSON files")
    ap.add_argument("--season",     type=int, default=2026, help="upcoming draft season")
    ap.add_argument("--log-season", type=int, default=2025, help="completed season for player logs")
    args = ap.parse_args()

    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        sys.exit("ERROR: DATABASE_URL environment variable is not set.\n"
                 "Copy it from Railway → your backend service → Variables tab.")
    # psycopg2 needs postgresql://, not postgres:// or postgresql+asyncpg://
    db_url = db_url.replace("postgresql+asyncpg://", "postgresql://") \
                   .replace("postgres://", "postgresql://")

    try:
        import psycopg2
        import psycopg2.extras
    except ImportError:
        sys.exit("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")

    data = Path(args.data)
    for fname in ("players_base.json", "schedule_2026.json",
                  "player_logs_2025.json", "sos_logs.json"):
        if not (data / fname).exists():
            sys.exit(f"ERROR: {data / fname} not found. Run ingest_nflverse.py first.")

    print(f"Connecting to database…")
    conn = psycopg2.connect(db_url)
    cur  = conn.cursor()

    # ── 1. Players ────────────────────────────────────────────────────────────
    print("Loading players…")
    players = json.load(open(data / "players_base.json"))
    id_map  = {}   # nflverse gsis_id -> db integer id
    n = 0
    for p in players:
        pos = p.get("pos", "")
        if pos not in ("QB", "RB", "WR", "TE", "K", "DST"):
            continue
        cur.execute("""
            INSERT INTO fantasy_players (season, name, pos, team, age, proj, last, last2, ecr, adp, aav)
            VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s, %s)
            ON CONFLICT (season, name, pos, team) DO UPDATE SET
                age   = EXCLUDED.age,
                proj  = EXCLUDED.proj,
                last  = EXCLUDED.last,
                last2 = EXCLUDED.last2,
                ecr   = EXCLUDED.ecr,
                adp   = EXCLUDED.adp,
                aav   = EXCLUDED.aav
            RETURNING id
        """, (args.season, p["name"], pos, (p.get("team") or "")[:5],
              int(p["age"]) if p.get("age") else None,
              json.dumps(p.get("proj")), json.dumps(p.get("last")),
              json.dumps(p.get("last2")), p.get("ecr"), p.get("adp"), p.get("aav")))
        db_id = cur.fetchone()[0]
        if p.get("id"):
            id_map[str(p["id"])] = db_id
        n += 1
    conn.commit()
    print(f"  ✓ {n} players upserted")

    # ── 2. Schedule ───────────────────────────────────────────────────────────
    print("Loading schedule…")
    schedule = json.load(open(data / "schedule_2026.json"))
    n = 0
    for team, games in schedule.items():
        for g in games:
            cur.execute("""
                INSERT INTO fantasy_schedule (season, team, week, opp)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (season, team, week) DO UPDATE SET opp = EXCLUDED.opp
            """, (args.season, team[:5], g["week"], g["opp"][:5]))
            n += 1
    conn.commit()
    print(f"  ✓ {n} schedule rows upserted")

    # ── 3. Player logs ────────────────────────────────────────────────────────
    print("Loading player logs…")
    logs_raw = json.load(open(data / "player_logs_2025.json"))
    n = skipped = 0
    for p in logs_raw:
        db_id = id_map.get(str(p.get("player_id", "")))
        if db_id is None:
            skipped += 1
            continue
        for g in p.get("games", []):
            cur.execute("""
                INSERT INTO fantasy_player_logs (season, player_id, week, opp, fp)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (season, player_id, week) DO UPDATE SET fp = EXCLUDED.fp
            """, (args.log_season, db_id, g["week"], g["opp"][:5], g["fp"]))
            n += 1
    conn.commit()
    print(f"  ✓ {n} player-log rows upserted  ({skipped} players skipped — not on 2026 roster)")

    # ── 4. SOS multipliers ────────────────────────────────────────────────────
    print("Computing SOS multipliers…")
    sos_logs = json.load(open(data / "sos_logs.json"))
    ratings  = _adjusted_defense_ratings(sos_logs)
    est      = _regress_yoy(ratings)
    sos      = _build_sos_multipliers(schedule, est)
    n = 0
    for team, pos_map in sos.items():
        for pos, mult in pos_map.items():
            cur.execute("""
                INSERT INTO fantasy_sos (season, team, pos, mult)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (season, team, pos) DO UPDATE SET mult = EXCLUDED.mult
            """, (args.season, team[:5], pos, mult))
            n += 1
    conn.commit()
    print(f"  ✓ {n} SOS multiplier rows upserted")

    cur.close()
    conn.close()
    print("\nDone! Your database is populated. Refresh the app to see players.")

if __name__ == "__main__":
    main()

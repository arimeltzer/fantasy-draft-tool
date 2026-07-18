#!/usr/bin/env python3
"""
projections.py — give players_base.json real forecasts
======================================================
nflverse's FREE fantasy data publishes RANKINGS (FantasyPros ECR), not
stat-line projections. So this adapter does two things:

  1. Auto-pulls ECR (expert consensus rank) for every player  -> player["ecr"]
     Current, free, real. Your market baseline for spotting value vs reaches.

  2. If you pass --proj-csv (a FantasyPros / any projections export), it maps
     the component columns into player["proj"]  -> true, scoring-aware forecasts.

Without --proj-csv the pipeline still runs on whatever `proj` is already there
(e.g. the ingest baseline), now annotated with real consensus ranks.

INSTALL  pip install nflreadpy pandas pyarrow
RUN
  python projections.py --base data/players_base.json --out data/players_base.json
  python projections.py --base data/players_base.json --out data/players_base.json --proj-csv fp_2026.csv
"""
import argparse, csv, json, os, re
import nflreadpy as nfl

FANTASY_POS = {"QB", "RB", "WR", "TE"}
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b\.?", re.I)

def norm(n):
    n = (n or "").lower()
    n = re.sub(r"[.'`’]", "", n)
    n = SUFFIX.sub("", n)
    n = re.sub(r"[^a-z ]", " ", n)
    return re.sub(r"\s+", " ", n).strip()

def _pd(df):
    return df.to_pandas() if hasattr(df, "to_pandas") else df

def _col(df, *names):
    for n in names:
        if n in df.columns:
            return n
    return None

# projection-CSV header synonyms -> engine `proj` fields (lowercased match)
PROJ_SYN = {
    "passYd": ["pass_yds", "passing_yards", "pass_yards", "payds", "pass yds"],
    "passTD": ["pass_tds", "passing_tds", "pass_td", "patd", "pass tds"],
    "int":    ["int", "ints", "interceptions"],
    "rushYd": ["rush_yds", "rushing_yards", "ruyds", "rush yds"],
    "rushTD": ["rush_tds", "rushing_tds", "rutd", "rush tds"],
    "rec":    ["rec", "receptions", "rec_rec"],
    "recYd":  ["rec_yds", "receiving_yards", "reyds", "rec yds"],
    "recTD":  ["rec_tds", "receiving_tds", "retd", "rec tds"],
}

def load_ecr():
    """{(norm_name, pos): best_ecr} from FantasyPros consensus ranks."""
    try:
        df = _pd(nfl.load_ff_rankings())
    except Exception as e:
        print(f"  ! load_ff_rankings unavailable ({e}); skipping ECR")
        return {}
    name, pos = _col(df, "player", "player_name"), _col(df, "pos", "position")
    if not (name and pos and "ecr" in df.columns):
        print("  ! ECR columns not found; skipping")
        return {}
    sub = df[df[pos].isin(FANTASY_POS)][[name, pos, "ecr"]].dropna()
    out = {}
    for nm, ps, ecr in zip(sub[name], sub[pos], sub["ecr"]):
        k = (norm(nm), ps)
        ecr = float(ecr)
        if k not in out or ecr < out[k]:   # best (overall) ranking per player
            out[k] = ecr
    return out

def load_proj_csv(path):
    """{(norm_name, pos): {engine proj components}} from a projections export."""
    with open(path, newline="") as f:
        rdr = csv.DictReader(f)
        headers = {h.lower().strip(): h for h in (rdr.fieldnames or [])}
        fmap = {}
        for eng, syns in PROJ_SYN.items():
            for s in syns:
                if s in headers:
                    fmap[eng] = headers[s]; break
        nmcol = next((headers[h] for h in ["player", "name", "player name"] if h in headers), None)
        poscol = next((headers[h] for h in ["pos", "position"] if h in headers), None)
        if not nmcol:
            print("  ! projections CSV has no player/name column; skipping")
            return {}
        out = {}
        for row in rdr:
            nm = row.get(nmcol, "")
            ps = re.sub(r"[^A-Z]", "", (row.get(poscol, "") or "").upper()) if poscol else ""
            def num(eng):
                c = fmap.get(eng)
                v = (row.get(c, "") or "").replace(",", "") if c else ""
                try: return float(v)
                except ValueError: return 0.0
            out[(norm(nm), ps)] = {eng: num(eng) for eng in PROJ_SYN}
        print(f"  mapped projection columns: {sorted(fmap.keys()) or 'NONE — check headers'}")
        return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--proj-csv", default=None)
    ap.add_argument("--season", type=int, default=2026, help="season for the FantasyPros API")
    ap.add_argument("--scoring", default="HALF", help="STD | HALF | PPR (FantasyPros API)")
    ap.add_argument("--fp-api", action="store_true",
                    help="force the FantasyPros API (otherwise auto-on when FANTASYPROS_API_KEY is set)")
    ap.add_argument("--no-fp-proj", action="store_true",
                    help="skip FantasyPros API projections (keep the baseline `proj`)")
    args = ap.parse_args()

    players = json.load(open(args.base))
    print(f"Loaded {len(players)} players from {args.base}")

    # FantasyPros API when a key is present (or --fp-api), else free nflverse.
    use_api = bool(args.fp_api or os.getenv("FANTASYPROS_API_KEY"))
    fp_mod = None
    if use_api:
        try:
            import fantasypros as fp_mod
        except Exception as e:
            print(f"  ! could not import fantasypros ({e})")

    # --- ECR / ADP ---
    ecr: dict = {}
    adp: dict = {}
    source = "nflverse load_ff_rankings"
    if fp_mod:
        try:
            fp = fp_mod.fetch_rankings(args.season, args.scoring)
            ecr = {k: v["ecr"] for k, v in fp.items() if v.get("ecr") is not None}
            adp = {k: v["adp"] for k, v in fp.items() if v.get("adp") is not None}
            source = f"FantasyPros API ({args.scoring}, {args.season})"
            print(f"Pulling ECR/ADP from {source}…  {len(ecr)} ranked players")
        except Exception as e:
            print(f"  ! FantasyPros rankings failed ({e}); falling back to nflverse ECR")
    if not ecr:
        print("Pulling FantasyPros ECR from nflverse…")
        ecr = load_ecr()

    # --- projections (proj) --- explicit CSV wins; else the API; else baseline.
    proj: dict = {}
    proj_source = "baseline (unchanged)"
    if args.proj_csv:
        proj = load_proj_csv(args.proj_csv)
        proj_source = args.proj_csv
    elif fp_mod and not args.no_fp_proj:
        try:
            proj = fp_mod.fetch_projections(args.season, args.scoring)
            proj_source = f"FantasyPros API projections ({args.scoring}, {args.season})"
            print(f"Pulling projections from {proj_source}…  {len(proj)} players")
        except Exception as e:
            print(f"  ! FantasyPros projections failed ({e}); proj left as baseline")

    # --- AAV (auction average value) --- FantasyPros API only, no free fallback.
    aav: dict = {}
    if fp_mod:
        try:
            aav = fp_mod.fetch_aav(args.season, args.scoring)
            print(f"Pulling AAV from FantasyPros API ({args.scoring}, {args.season})…  {len(aav)} players")
        except Exception as e:
            print(f"  ! FantasyPros AAV failed ({e}); leaving `aav` unset")

    n_ecr = n_adp = n_proj = n_aav = 0
    for p in players:
        k = (norm(p.get("name")), p.get("pos"))
        if k in ecr:
            p["ecr"] = round(ecr[k], 1); n_ecr += 1
        if k in adp:
            p["adp"] = round(adp[k], 1); n_adp += 1
        if k in proj:
            p["proj"] = proj[k]; n_proj += 1
        if k in aav:
            p["aav"] = aav[k]; n_aav += 1

    json.dump(players, open(args.out, "w"), indent=2)
    print(f"  ✓ ECR matched: {n_ecr}/{len(players)}  (source: {source})")
    if n_adp:
        print(f"  ✓ ADP matched: {n_adp}/{len(players)}")
    if proj:
        print(f"  ✓ projections matched: {n_proj}/{len(players)}  (source: {proj_source})")
    else:
        print("  • projections: none applied; `proj` left as baseline "
              "(set FANTASYPROS_API_KEY, or pass --proj-csv, for real forecasts)")
    if aav:
        print(f"  ✓ AAV matched: {n_aav}/{len(players)}")
    else:
        print("  • AAV: none applied (needs FANTASYPROS_API_KEY); marketPrice() falls back to the modeled curve")
    print(f"Wrote {args.out}")

if __name__ == "__main__":
    main()

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
from teams import normalize_team
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

def load_years_exp(season) -> tuple[dict, dict]:
    """(by_key, by_name) from nflverse rosters — 0 for the current draft
    class, confirmed real against a live pull (no nulls). by_key is
    {(norm_name, pos): years_exp}, the primary lookup; by_name is the same
    thing keyed on norm_name ALONE, for the "added" block's fallback below.

    WHY: the "added" block below used to hardcode `rookie: True` for every
    player missing from the nflverse-stats base, which conflates a TRUE
    rookie with a returning VETERAN who has no last-season stat line for
    some other reason (season-ending injury, suspension, ...) — exactly the
    population that's missing from the base and thus flows through here.
    Reported live: "is there a way to distinguish rookies from players who
    did not play for other reasons last year?" This is that distinction,
    from ground truth rather than an inferred absence of stats.

    WHY by_name too: the "added" block's own key comes from FantasyPros'
    rankings payload, not this roster pull — the one name-STRING-keyed join
    in an otherwise ID-keyed feature (ingest_nflverse.py's own years_exp
    fill, above, joins on gsis_id and can't have this problem). Reported
    live: Jonathon Brooks (a real case for this feature — drafted 2024,
    tore his ACL that preseason, zero games logged in 2024 OR 2025, so he
    correctly has no last/last2 and would otherwise read as a fresh rookie)
    still showed under the rookies-only filter after years_exp shipped.
    Confirmed via a live nflverse pull he's on the current roster with
    years_exp=2, not missing — so the exact (name, pos) join is the
    remaining suspect: FantasyPros' own position tag for a player who
    hasn't taken a snap in two seasons is a plausible place for it to be
    blank or stale, which a POSITION-scoped key can't recover from. Kept
    UNAMBIGUOUS on purpose — dropped from by_name entirely (not merged
    arbitrarily) whenever two same-named roster entries disagree on years of
    experience, so this can't silently attribute one player's tenure to a
    different one who happens to share a name.
    """
    try:
        ros = _pd(nfl.load_rosters(season))
    except Exception as e:
        print(f"  ! load_rosters({season}) unavailable ({e}); years_exp left blank")
        return {}, {}
    name_col = _col(ros, "full_name", "player_name")
    pos_col = _col(ros, "position")
    exp_col = _col(ros, "years_exp")
    if not (name_col and pos_col and exp_col):
        return {}, {}
    by_key, by_name, ambiguous = {}, {}, set()
    for r in ros.itertuples():
        pos = getattr(r, pos_col, None)
        exp = getattr(r, exp_col, None)
        if pos is None or exp is None or exp != exp:   # NaN guard
            continue
        nm, exp = norm(getattr(r, name_col, None)), int(exp)
        by_key[(nm, pos)] = exp
        if nm in by_name and by_name[nm] != exp:
            ambiguous.add(nm)
        else:
            by_name[nm] = exp
    for nm in ambiguous:
        by_name.pop(nm, None)
    return by_key, by_name

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
    fp_tier: dict = {}
    source = "nflverse load_ff_rankings"
    fp_rank: dict = {}
    if fp_mod:
        try:
            fp = fp_mod.fetch_rankings(args.season, args.scoring)
            fp_rank = fp
            ecr = {k: v["ecr"] for k, v in fp.items() if v.get("ecr") is not None}
            adp = {k: v["adp"] for k, v in fp.items() if v.get("adp") is not None}
            # FantasyPros' own consensus tier (parse_rankings already extracts
            # it; it just went unused until now) — surfaced alongside the
            # app's own computed VBD-gap tier (engine-core.js finalizeBoard),
            # never blended into it. Two different things: FP's tier reflects
            # the panel's judgment of drop-offs, ours is a mechanical 18-pt
            # VBD gap. Showing both lets a user see where they agree/disagree
            # rather than picking one silently.
            fp_tier = {k: v["tier"] for k, v in fp.items() if v.get("tier") is not None}
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

    # --- AAV --- not offered by the public API (see fantasypros.fetch_aav).
    aav: dict = {}

    # --- injuries --- so the board can flag a hurt player before you draft him.
    injuries: dict = {}
    if fp_mod:
        try:
            injuries = fp_mod.fetch_injuries(args.season)
            print(f"Pulling injuries from FantasyPros API ({args.season})…  {len(injuries)} flagged")
        except Exception as e:
            print(f"  ! FantasyPros injuries failed ({e}); no injury flags this run")

    # --- years of NFL experience --- distinguishes a TRUE rookie from a
    # returning veteran with no last-season stats for some other reason
    # (injury, suspension, ...). See load_years_exp's own docstring.
    years_exp, years_exp_by_name = load_years_exp(args.season)
    if years_exp:
        print(f"Pulling years of experience from nflverse rosters ({args.season})…  {len(years_exp)} players")

    n_ecr = n_adp = n_proj = n_aav = n_fp_tier = 0
    seen = set()
    for p in players:
        k = (norm(p.get("name")), p.get("pos"))
        seen.add(k)
        if k in ecr:
            p["ecr"] = round(ecr[k], 1); n_ecr += 1
        if k in adp:
            p["adp"] = round(adp[k], 1); n_adp += 1
        if k in proj:
            p["proj"] = proj[k]; n_proj += 1
        if k in aav:
            p["aav"] = aav[k]; n_aav += 1
        if k in fp_tier:
            p["fpTier"] = fp_tier[k]; n_fp_tier += 1
        # Fill the gap only — ingest_nflverse.py's own roster pull already
        # sets this for most matched players; this backfills anyone it
        # missed (a failed/partial roster fetch that run) rather than
        # overwriting a real value with a possibly-stale second pull.
        if p.get("yearsExp") is None:
            if k in years_exp:
                p["yearsExp"] = years_exp[k]
            elif k[0] in years_exp_by_name:
                p["yearsExp"] = years_exp_by_name[k[0]]
        p["injury"] = injuries.get(k)

    # --- players the base doesn't have at all -------------------------------
    # The base is built from LAST season's stats, so anyone with zero games
    # last season isn't in it — every incoming rookie, AND a veteran who
    # missed the whole season (injury, suspension, ...). Enriching only
    # existing rows meant a ranked player like this silently didn't exist on
    # the draft board, which is worse than a bad projection: you can't
    # draft, or plan around, a player the tool never shows. Add anyone
    # FantasyPros ranks that we're missing.
    #
    # `rookie` here used to be hardcoded True for every one of these —
    # correct for the true rookies, WRONG for the returning-veteran case,
    # and this exact code path is where that population enters the board
    # (see load_years_exp's docstring). Note this key is presently dead
    # weight past this file (load_to_db.py has no `rookie` column — the
    # live signal the frontend actually reads is computed at runtime by
    # engine-core.js projectPoints() from last/last2 presence) — computed
    # correctly anyway rather than left knowingly wrong, in case a future
    # consumer starts reading it.
    added = 0
    if fp_rank:
        for k, meta in fp_rank.items():
            if k in seen or not meta.get("name"):
                continue
            name, pos = meta["name"], k[1]
            # This is the one name-STRING-keyed join in the years_exp flow
            # (k comes from FantasyPros' rankings, not nflverse) — fall back
            # to the unambiguous name-only index when the position tag
            # doesn't line up (see load_years_exp's docstring: caught via a
            # real returning-injury case, Jonathon Brooks, whose exact
            # (name, pos) key missed despite years_exp=2 being right there
            # in the roster pull).
            exp = years_exp.get(k)
            if exp is None:
                exp = years_exp_by_name.get(k[0])
            players.append({
                "id": None,
                "name": name,
                "pos": pos,
                "team": normalize_team(meta.get("team")),
                "age": None,
                "yearsExp": exp,
                # No NFL history — the engine already handles this (it leans on
                # market rank when `last` is absent, and the board labels it
                # "no '25").
                "last": None, "last2": None,
                "proj": proj.get(k),
                "ecr": round(ecr[k], 1) if k in ecr else None,
                "adp": round(adp[k], 1) if k in adp else None,
                "aav": aav.get(k),
                "fpTier": fp_tier.get(k),
                "injury": injuries.get(k),
                "rookie": exp is None or exp == 0,
            })
            seen.add(k)
            added += 1
        if added:
            print(f"  + added {added} ranked player(s) missing from the nflverse base "
                  f"(rookies / no prior-season stats)")

    json.dump(players, open(args.out, "w"), indent=2)
    print(f"  ✓ ECR matched: {n_ecr}/{len(players)}  (source: {source})")
    if n_adp:
        print(f"  ✓ ADP matched: {n_adp}/{len(players)}")
    if n_fp_tier:
        print(f"  ✓ FantasyPros tier matched: {n_fp_tier}/{len(players)}")
    if proj:
        print(f"  ✓ projections matched: {n_proj}/{len(players)}  (source: {proj_source})")
    else:
        print("  • projections: none applied; `proj` left as baseline "
              "(set FANTASYPROS_API_KEY, or pass --proj-csv, for real forecasts)")
    if injuries:
        hit = sum(1 for p in players if p.get("injury"))
        out_now = sum(1 for p in players if (p.get("injury") or {}).get("severity") == "out")
        print(f"  ✓ injuries matched: {hit}/{len(players)}  ({out_now} out/IR)")
    print("  • AAV: not offered by the FantasyPros public API; marketPrice() uses the modeled curve")
    print(f"Wrote {args.out}  ({len(players)} players)")

if __name__ == "__main__":
    main()

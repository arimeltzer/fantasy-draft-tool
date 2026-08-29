import asyncio
import logging
import os
import secrets
from datetime import datetime, timedelta
from typing import Any, Literal, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
import bcrypt as _bcrypt
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, delete, update
from sqlalchemy.ext.asyncio import AsyncSession

from database import db_dep, create_all_tables
from models import (
    DraftPick, League, LeagueFormat, Player, PlayerLog,
    Schedule, SosMult, User,
)
from integrations import espn as espn_provider, yahoo as yahoo_provider, yahoo_paste
from integrations import fantasypros_aav_paste as aav_paste
from integrations import athletic_upload
from integrations import scoring_paste
from integrations.base import NormPlayer, opponent_team_ids, resolve_opponent_index
from integrations.matching import build_index, match_player, keeper_candidates
import live_ws_registry

load_dotenv()
logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

JWT_SECRET    = os.getenv("JWT_SECRET", "changeme")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "43200"))  # 30d
ADMIN_EMAIL   = os.getenv("ADMIN_EMAIL", "")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")

REGISTRATION_OPEN = os.getenv("REGISTRATION_OPEN", "false").lower() == "true"

if JWT_SECRET == "changeme" and os.getenv("RAILWAY_ENVIRONMENT"):
    raise RuntimeError("JWT_SECRET is unset; set it in Railway env vars before deploying.")

# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(title="Fantasy Draft API", version="1.0.0")

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
# The live-ingest bookmarklet (see live_ws_registry.py "Browser-side ingest")
# runs its fetch() call FROM the ESPN draft-room page's own origin, not ours —
# that request needs CORS clearance too, or the browser drops the response
# before our JS ever sees it. Fixed, known origins, not user-configurable, so
# hardcoded rather than pulled from an env var like the app's own origin is.
ALLOWED_ORIGINS = ALLOWED_ORIGINS + ["https://fantasy.espn.com", "https://fantasydraft.espn.com"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Auth helpers ──────────────────────────────────────────────────────────────

oauth2 = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def hash_password(pw: str) -> str:
    return _bcrypt.hashpw(pw.encode(), _bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    return _bcrypt.checkpw(pw.encode(), hashed.encode())


def create_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode["exp"] = expire
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


async def get_current_user(
    token: str = Depends(oauth2),
    db: AsyncSession = Depends(db_dep),
) -> User:
    creds_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        email: str | None = payload.get("sub")
        if not email:
            raise creds_exc
    except JWTError:
        raise creds_exc
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if not user or user.is_active is False:
        raise creds_exc
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin required")
    return user


# ── Startup ───────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def on_startup():
    await create_all_tables()
    if ADMIN_EMAIL and ADMIN_PASSWORD:
        from database import SessionLocal
        async with SessionLocal() as db:
            result = await db.execute(select(User).where(User.email == ADMIN_EMAIL))
            if not result.scalar_one_or_none():
                db.add(User(
                    email=ADMIN_EMAIL,
                    display_name="Admin",
                    password_hash=hash_password(ADMIN_PASSWORD),
                    is_admin=True,
                ))
                await db.commit()
                log.info("Admin user created: %s", ADMIN_EMAIL)


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserCreate(BaseModel):
    email: EmailStr
    password: str
    display_name: Optional[str] = None


class UserOut(BaseModel):
    id: int
    email: str
    display_name: Optional[str]
    is_admin: bool

    model_config = {"from_attributes": True}


class LeagueCreate(BaseModel):
    name: str
    format: LeagueFormat
    settings: dict[str, Any] = {}


class LeaguePatch(BaseModel):
    name: Optional[str] = None
    settings: Optional[dict[str, Any]] = None


class LeagueOut(BaseModel):
    id: int
    name: str
    format: str
    settings: dict[str, Any]
    created_at: datetime

    model_config = {"from_attributes": True}


class PickCreate(BaseModel):
    player_id: Optional[int] = None
    mine: bool
    team_id: Optional[int] = None
    price: Optional[int] = None
    slot: Optional[str] = None


class PickUpdate(BaseModel):
    """Partial pick edit — only fields present in the request body are applied,
    so an explicit null clears a value (e.g. team_id when a pick becomes mine)."""
    player_id: Optional[int] = None
    mine: Optional[bool] = None
    team_id: Optional[int] = None
    price: Optional[int] = None
    slot: Optional[str] = None


class PickOut(BaseModel):
    id: int
    league_id: int
    player_id: Optional[int]
    overall_pick: int
    mine: bool
    team_id: Optional[int]
    price: Optional[int]
    slot: Optional[str]
    ts: datetime

    model_config = {"from_attributes": True}


class PlayerOut(BaseModel):
    id: int
    season: int
    name: str
    pos: str
    team: str
    age: Optional[int]
    proj: Optional[dict]
    last: Optional[dict]
    last2: Optional[dict]
    ecr: Optional[float]
    adp: Optional[float]
    aav: Optional[float]
    fp_tier: Optional[int]
    injury: Optional[dict]

    model_config = {"from_attributes": True}


# ── Auth routes ───────────────────────────────────────────────────────────────

@app.post("/api/auth/login", response_model=Token)
async def login(
    form: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(db_dep),
):
    result = await db.execute(select(User).where(User.email == form.username))
    user = result.scalar_one_or_none()
    if not user or not verify_password(form.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    if user.is_active is False:
        raise HTTPException(status_code=403, detail="Account disabled")
    user.last_login = datetime.utcnow()
    await db.commit()
    token = create_token({"sub": user.email})
    return Token(access_token=token)


@app.post("/api/auth/register", response_model=UserOut, status_code=201)
async def register(data: UserCreate, db: AsyncSession = Depends(db_dep)):
    if not REGISTRATION_OPEN:
        raise HTTPException(status_code=403, detail="Registration is invite-only")
    result = await db.execute(select(User).where(User.email == data.email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")
    user = User(
        email=data.email,
        display_name=data.display_name,
        password_hash=hash_password(data.password),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@app.get("/api/auth/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)):
    return user


# ── Admin: user management ────────────────────────────────────────────────────

@app.get("/api/admin/users", response_model=list[UserOut])
async def list_users(_: User = Depends(require_admin), db: AsyncSession = Depends(db_dep)):
    result = await db.execute(select(User).order_by(User.id))
    return list(result.scalars())


@app.post("/api/admin/users", response_model=UserOut, status_code=201)
async def create_user(
    data: UserCreate,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(db_dep),
):
    result = await db.execute(select(User).where(User.email == data.email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")
    user = User(
        email=data.email,
        display_name=data.display_name,
        password_hash=hash_password(data.password),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@app.delete("/api/admin/users/{user_id}", status_code=204)
async def delete_user(
    user_id: int,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(db_dep),
):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    await db.execute(delete(User).where(User.id == user_id))
    await db.commit()


# ── Data endpoints ────────────────────────────────────────────────────────────

@app.get("/api/players", response_model=list[PlayerOut])
async def get_players(
    season: int = 2026,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
):
    result = await db.execute(
        select(Player).where(Player.season == season).order_by(Player.id)
    )
    return list(result.scalars())


@app.get("/api/sos")
async def get_sos(
    season: int = 2026,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
) -> dict:
    result = await db.execute(select(SosMult).where(SosMult.season == season))
    rows = list(result.scalars())
    out: dict[str, dict[str, float]] = {}
    for r in rows:
        out.setdefault(r.team, {})[r.pos] = r.mult
    return out


@app.get("/api/schedule")
async def get_schedule(
    season: int = 2026,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
) -> dict:
    result = await db.execute(
        select(Schedule).where(Schedule.season == season).order_by(Schedule.week)
    )
    rows = list(result.scalars())
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r.team, []).append({"week": r.week, "opp": r.opp})
    return out


@app.get("/api/players/{player_id}/common-opponents")
async def common_opponents(
    player_id: int,
    season: int = 2026,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
) -> dict:
    player_result = await db.execute(select(Player).where(Player.id == player_id))
    player = player_result.scalar_one_or_none()
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")

    logs_result = await db.execute(
        select(PlayerLog).where(
            PlayerLog.player_id == player_id,
            PlayerLog.season == season - 1,
        )
    )
    logs = list(logs_result.scalars())

    schedule_result = await db.execute(
        select(Schedule).where(
            Schedule.season == season,
            Schedule.team == player.team,
        )
    )
    schedule = list(schedule_result.scalars())

    future_opps = {g.opp for g in schedule}
    common = [
        {"opp": l.opp, "fp2025": l.fp, "week": l.week}
        for l in logs if l.opp in future_opps
    ]
    avg_fp = sum(g["fp2025"] for g in common) / len(common) if common else 0.0
    return {"count": len(common), "avgFp": round(avg_fp, 1), "games": sorted(common, key=lambda g: -g["fp2025"])}


# ── League CRUD ───────────────────────────────────────────────────────────────

@app.get("/api/leagues", response_model=list[LeagueOut])
async def list_leagues(user: User = Depends(get_current_user), db: AsyncSession = Depends(db_dep)):
    result = await db.execute(
        select(League).where(League.user_id == user.id).order_by(League.created_at.desc())
    )
    return list(result.scalars())


@app.post("/api/leagues", response_model=LeagueOut, status_code=201)
async def create_league(
    data: LeagueCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
):
    league = League(user_id=user.id, name=data.name, format=data.format, settings=data.settings)
    db.add(league)
    await db.commit()
    await db.refresh(league)
    return league


@app.get("/api/leagues/{league_id}", response_model=LeagueOut)
async def get_league(
    league_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
):
    league = await _get_league_owned(league_id, user.id, db)
    return league


@app.patch("/api/leagues/{league_id}", response_model=LeagueOut)
async def patch_league(
    league_id: int,
    data: LeaguePatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
):
    league = await _get_league_owned(league_id, user.id, db)
    if data.name is not None:
        league.name = data.name
    if data.settings is not None:
        league.settings = data.settings
    await db.commit()
    await db.refresh(league)
    return league


@app.delete("/api/leagues/{league_id}", status_code=204)
async def delete_league(
    league_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
):
    league = await _get_league_owned(league_id, user.id, db)
    await db.delete(league)
    await db.commit()


# ── League import (ESPN / Yahoo) ───────────────────────────────────────────────

class ImportRequest(BaseModel):
    provider: Literal["espn", "yahoo"]
    ext_id: str                       # ESPN leagueId or Yahoo league_key (nfl.l.123)
    season: int = 2026                # player pool to match against / ESPN league season
    name: Optional[str] = None        # optional override for the league name
    # ESPN private leagues
    espn_s2: Optional[str] = None
    swid: Optional[str] = None
    my_team: Optional[str] = None     # ESPN team id or name to flag as "mine"
    # Extra COMPLETED seasons to pull draft prices from, purely to calibrate
    # auction prices. One draft cannot tell a league's habits from one year's
    # accidents; several can, and can test whether the habits persist at all.
    # Keepers are unaffected — those still come from `season` alone.
    history_seasons: int = 0
    # Yahoo (token obtained via the OAuth helper routes below)
    access_token: Optional[str] = None
    my_guid: Optional[str] = None     # Yahoo manager guid to flag as "mine"
    seed_rosters: bool = False         # also log every rostered player as a drafted
                                       # pick (for an in-progress draft). Off by
                                       # default so keeper setups start with a clean pool.


@app.post("/api/leagues/import", response_model=dict, status_code=201)
async def import_league(
    data: ImportRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
):
    """Create a league from an ESPN or Yahoo league: settings + rosters mapped
    onto our player pool. Returns the new league plus a mapping report."""
    # 1. Pull a normalized league from the provider.
    try:
        if data.provider == "espn":
            norm = await espn_provider.fetch_league(
                data.ext_id, data.season,
                espn_s2=data.espn_s2, swid=data.swid, my_team=data.my_team)
        else:
            if not data.access_token:
                raise HTTPException(status_code=400, detail="Yahoo import needs an access_token (connect Yahoo first).")
            norm = await yahoo_provider.fetch_league(data.ext_id, data.access_token, my_guid=data.my_guid)
    except yahoo_provider.FantasyScopeError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — surface provider errors cleanly
        raise HTTPException(status_code=502, detail=f"{data.provider} fetch failed: {e}")

    # 2. Build the player index for the matching season.
    rows = (await db.execute(
        select(Player.id, Player.name, Player.pos, Player.team).where(Player.season == data.season)
    )).all()
    if not rows:
        raise HTTPException(status_code=409, detail=f"No players loaded for season {data.season}; import needs the player pool.")
    index = build_index([{"id": r.id, "name": r.name, "pos": r.pos, "team": r.team} for r in rows])

    # 3. Create the league. Remember the source league so the keeper planner can
    #    auto-pull the prior season's draft (ESPN ids are stable across seasons).
    #    Opponent labels are the REAL team names from the platform (index =
    #    DraftPick.team_id below), not generic "Team 2" placeholders.
    opponent_names, team_id_by_name, opponent_ext_ids = opponent_team_ids(norm.teams)

    settings = {**norm.settings, "source": {"provider": norm.provider, "extId": norm.ext_id}}
    if opponent_names:
        settings["opponents"] = opponent_names
        # The platform's own team id per opponent (index-aligned) — the
        # STABLE key live-draft sync (`sync_draft`) matches on first, since
        # it survives a rename that even tiered name matching cannot always
        # recover from. `None` for every entry (a provider/import path with
        # no platform id) is worth skipping rather than storing dead weight.
        if any(opponent_ext_ids):
            settings["opponentIds"] = opponent_ext_ids
    league = League(user_id=user.id, name=data.name or norm.name,
                    format=LeagueFormat(norm.fmt), settings=settings)
    db.add(league)
    await db.flush()

    # 4. Map each rostered player (for the report), and — only when seeding an
    #    in-progress draft — log each as a drafted pick. Keeper setups skip this
    #    so the pool stays clean and the keeper planner drives it instead.
    #    Opponent picks carry team_id so budget tracking/labels attach to the
    #    right real team immediately, not an "Unassigned" bucket.
    overall = matched = 0
    unmatched: list[str] = []
    for team in norm.teams:
        team_id = None if team.is_mine else team_id_by_name.get(team.name)
        for np in team.players:
            if not np.name:
                continue
            pid = match_player(index, np)
            if pid is None:
                unmatched.append(f"{np.name} ({np.pos or '?'}{'/' + np.team if np.team else ''})")
                continue
            matched += 1
            if data.seed_rosters:
                overall += 1
                db.add(DraftPick(league_id=league.id, player_id=pid, overall_pick=overall,
                                 mine=team.is_mine, team_id=team_id, price=np.bid, slot=None))
    await db.commit()
    await db.refresh(league)

    scoring_meta = norm.meta.get("scoring") or {}
    rule_count = scoring_meta.get("raw_rule_count")
    scoring_note = (
        f"Detected point-per-reception ({norm.settings.get('ppr')}) only"
        + (f" — {rule_count} other scoring rules exist on {data.provider.upper()} but aren't auto-mapped"
           if rule_count else "")
        + ". Passing/rushing/receiving TD & yardage values, INTs, and fumbles default to standard "
          "(4pt pass TD, -2 INT, 6pt rush/rec TD, 0.04/0.1 pt per pass/rush-rec yard) until you set them "
          "in League Settings → Scoring."
    )

    return {
        "league": LeagueOut.model_validate(league).model_dump(mode="json"),
        "report": {
            "provider": norm.provider,
            "format": norm.fmt,
            "teams": len(norm.teams),
            "team_names": opponent_names,
            "players_matched": matched,
            "players_unmatched": len(unmatched),
            "unmatched_sample": unmatched[:30],
            "mine_found": any(t.is_mine for t in norm.teams),
            "seeded": data.seed_rosters,
            "scoring_note": scoring_note,
        },
    }


class YahooPasteLeagueRequest(BaseModel):
    """Create a league from Yahoo pages pasted as text — the no-credential path
    for leagues where Yahoo won't grant Fantasy Sports API access."""
    name: str = "Yahoo League"
    draft_text: str = ""
    rosters_text: str = ""
    my_team: Optional[str] = None


@app.post("/api/leagues/import-yahoo-paste", response_model=dict, status_code=201)
async def import_yahoo_paste(
    data: YahooPasteLeagueRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
):
    """Create a league from the pasted Draft Results / Starting Rosters pages.

    Yahoo's OAuth path 401s whenever the Fantasy Sports scope isn't granted, so
    this is the equivalent entry point that needs no credential. It sets what
    the pages actually prove — team count, real opponent names, and (from round
    one) your draft slot — and leaves roster shape and scoring at defaults,
    since neither page carries them. No picks are seeded: the keeper planner
    drives that, same as a keeper-mode ESPN import."""
    if not data.rosters_text.strip():
        raise HTTPException(status_code=400,
                            detail="Paste the Starting Rosters page — it defines the teams.")
    try:
        norm, report = yahoo_paste.build_league(
            data.draft_text, data.rosters_text,
            league_name=data.name, my_team=data.my_team)
    except Exception as e:  # noqa: BLE001 — parsing is best-effort on pasted text
        raise HTTPException(status_code=422, detail=f"Could not parse the pasted pages: {e}")
    if not norm.teams:
        raise HTTPException(status_code=422,
                            detail="No teams found — check that the Starting Rosters paste "
                                   "includes the 'Pos / Player' header for each team.")

    opponent_names, _, opponent_ext_ids = opponent_team_ids(norm.teams)
    settings = {**norm.settings}
    if opponent_names:
        settings["opponents"] = opponent_names
        if any(opponent_ext_ids):  # paste import never has one; no-op today
            settings["opponentIds"] = opponent_ext_ids
    # Round one of the pasted draft gives every team's slot, not just yours.
    # Persist the whole map: opponent keeper predictions price a rival's
    # forfeited pick from THEIR slot, so importing the names without the order
    # would leave that math on a mid-round guess the paste already disproves.
    if report.get("draft_slots"):
        settings["teamSlots"] = dict(report["draft_slots"])

    league = League(user_id=user.id, name=data.name or norm.name,
                    format=LeagueFormat(norm.fmt), settings=settings)
    db.add(league)
    await db.commit()
    await db.refresh(league)

    return {
        "league": LeagueOut.model_validate(league).model_dump(mode="json"),
        "report": {**report, "provider": "yahoo-paste", "seeded": False},
    }


class KeeperCandidatesRequest(BaseModel):
    ext_id: str                       # ESPN leagueId (must be a keeper league)
    season: int = 2025                # prior season whose draft holds the costs
    match_season: int = 2026          # current player pool to map candidates onto
    espn_s2: Optional[str] = None
    swid: Optional[str] = None
    my_team: Optional[str] = None     # ESPN team id or name to flag as "mine"
    # Extra COMPLETED seasons to pull draft prices from, purely to calibrate
    # auction prices. One draft cannot tell a league's habits from one year's
    # accidents; several can, and can test whether the habits persist at all.
    # Keepers are unaffected — those still come from `season` alone.
    history_seasons: int = 0


@app.post("/api/integrations/espn/keeper-candidates")
async def espn_keeper_candidates(
    data: KeeperCandidatesRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
) -> dict:
    """Pull a prior-season ESPN league's rosters + draft results and return
    keeper candidates (matched to the current player pool) with each player's
    auction bid and/or draft round. The client applies the league's keeper rule
    to turn those into this-year costs and pre-fill the keeper planner."""
    try:
        norm = await espn_provider.fetch_league(
            data.ext_id, data.season,
            espn_s2=data.espn_s2, swid=data.swid, my_team=data.my_team)
    except PermissionError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except LookupError as e:
        # No such league/season — already phrased for a human by fetch_league.
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:  # noqa: BLE001 — surface provider errors cleanly
        raise HTTPException(status_code=502, detail=f"espn fetch failed: {e}")

    rows = (await db.execute(
        select(Player.id, Player.name, Player.pos, Player.team).where(Player.season == data.match_season)
    )).all()
    if not rows:
        raise HTTPException(status_code=409, detail=f"No players loaded for season {data.match_season}.")
    index = build_index([{"id": r.id, "name": r.name, "pos": r.pos, "team": r.team} for r in rows])

    # Older drafts, for calibration only. Best-effort per season and never
    # fatal: a league that predates ESPN's history, or a season it declines to
    # serve, simply contributes nothing.
    all_drafts = [(data.season, norm.draft_picks)]
    history_meta: dict = {}
    if data.history_seasons > 0:
        want = [data.season - i for i in range(1, min(data.history_seasons, 15) + 1)]
        try:
            hist = await espn_provider.fetch_draft_history(
                data.ext_id, want, espn_s2=data.espn_s2, swid=data.swid)
            all_drafts += sorted(hist["by_season"].items(), reverse=True)
            history_meta = {"history": hist["diag"]}
        except Exception as e:  # noqa: BLE001 — history is an enhancement
            history_meta = {"history_error": f"{type(e).__name__}: {e}"}

    cands = keeper_candidates(norm, index)
    matched = sum(1 for c in cands if c["matched"])
    return {
        "fmt": norm.fmt,
        "season": data.season,
        "candidates": cands,
        # The FULL prior draft, including players since dropped. `candidates`
        # above is built from end-of-season rosters, which is right for keeper
        # eligibility and a survivorship-biased sample of what the room PAID —
        # the thing auction price calibration learns from. Sent separately so
        # each question is answered from the data that fits it.
        "draft_picks": [
            {"ext_id": p.ext_id, "name": p.name, "pos": p.pos, "team": p.team,
             "bid": p.bid, "round": p.round, "overall": p.overall, "owner": p.owner,
             "resolved": p.resolved, "season": season}
            for season, rows in all_drafts
            for p in rows
        ],
        "draft_meta": {**norm.meta.get("draft", {}), **history_meta},
        "matched": matched,
        "unmatched": len(cands) - matched,
        # How the waiver/FAAB pull went — surfaced in the UI so a league with no
        # transaction data is obvious instead of silently costing draft-only.
        "waivers": {
            "players": sum(1 for c in cands if c.get("waiver")),
            **(norm.meta.get("transactions") or {}),
        },
    }


class YahooPasteRequest(BaseModel):
    draft_text: str = ""              # copied Yahoo "Draft Results" page
    rosters_text: str = ""            # copied Yahoo "Starting Rosters" page
    match_season: int = 2026          # current player pool to map candidates onto
    my_team: Optional[str] = None     # exact team name to flag as "mine"


@app.post("/api/integrations/yahoo/paste-candidates")
async def yahoo_paste_candidates(
    data: YahooPasteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
) -> dict:
    """Yahoo keeper candidates with NO API access — parsed from the Draft
    Results / Starting Rosters pages the user copied out of Yahoo's web UI.

    Returns the same candidate shape as the ESPN endpoint so the keeper planner
    and recommender consume it unchanged, plus a report of everything that
    should be eyeballed rather than trusted (keeper badges are derived from
    whitespace the copy leaves behind; team names are truncated in the draft
    view; traded picks break serpentine order)."""
    if not data.rosters_text.strip():
        raise HTTPException(status_code=400,
                            detail="Paste the Starting Rosters page — it defines who can be kept.")
    try:
        norm, report = yahoo_paste.build_league(
            data.draft_text, data.rosters_text, my_team=data.my_team)
    except Exception as e:  # noqa: BLE001 — parsing is best-effort on pasted text
        raise HTTPException(status_code=422, detail=f"Could not parse the pasted pages: {e}")

    rows = (await db.execute(
        select(Player.id, Player.name, Player.pos, Player.team).where(Player.season == data.match_season)
    )).all()
    if not rows:
        raise HTTPException(status_code=409, detail=f"No players loaded for season {data.match_season}.")
    index = build_index([{"id": r.id, "name": r.name, "pos": r.pos, "team": r.team} for r in rows])

    cands = keeper_candidates(norm, index)
    matched = sum(1 for c in cands if c["matched"])
    return {
        "fmt": norm.fmt,
        "season": 0,
        "candidates": cands,
        "matched": matched,
        "unmatched": len(cands) - matched,
        "paste": report,
    }


def _match_aav_rows(report, rows) -> tuple[list[dict], list[str]]:
    """Shared by both AAV-paste endpoints: parsed rows -> (matched, unmatched
    names). Kept as one function so the admin (global) and per-league
    (candidates) routes cannot drift about how a name resolves to a player id.
    """
    index = build_index([{"id": r.id, "name": r.name, "pos": r.pos, "team": r.team} for r in rows])
    norm_players = aav_paste.to_norm_players(report)
    matched, unmatched = [], []
    for np, avr in zip(norm_players, report.rows):
        pid = match_player(index, np)
        if pid is None:
            unmatched.append(avr.name)
            continue
        matched.append({"id": pid, "name": avr.name, "pos": avr.pos, "team": avr.team, "aav": avr.aav})
    return matched, unmatched


class AavPasteCandidatesRequest(BaseModel):
    text: str = ""             # copied FantasyPros auction values cheat sheet
    season: int = 2026


@app.post("/api/integrations/fantasypros/aav-paste-candidates")
async def fantasypros_aav_paste_candidates(
    data: AavPasteCandidatesRequest,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
) -> dict:
    """Match report ONLY — no write, no admin gate. `fantasy_players.aav` is
    shared season-wide data (see the admin route below); auction values
    genuinely differ by WHO copied the sheet and WHEN (injury news, a
    league's own consensus, a source other than FantasyPros), and a value
    someone pastes should land in their own league, not overwrite the shared
    baseline for every league on the season. So this returns matched
    {id, name, pos, team, aav} rows for the CALLER to merge into their own
    `league.settings.aavOverrides` via the existing `PATCH /api/leagues/{id}`
    — same shape as `yahoo_paste_candidates`, which hands its result to the
    caller rather than writing anything itself.
    """
    if not data.text.strip():
        raise HTTPException(status_code=400,
                            detail="Paste the FantasyPros auction values cheat sheet.")
    report = aav_paste.parse_aav_sheet(data.text)
    if not report.rows:
        raise HTTPException(status_code=422,
                            detail="Could not parse any rows from the pasted text.")

    rows = (await db.execute(
        select(Player.id, Player.name, Player.pos, Player.team).where(Player.season == data.season)
    )).all()
    if not rows:
        raise HTTPException(status_code=409, detail=f"No players loaded for season {data.season}.")
    matched, unmatched = _match_aav_rows(report, rows)

    return {
        "season": data.season,
        "parsed": len(report.rows),
        "skipped_lines": len(report.skipped),
        "candidates": matched,
        "matched": len(matched),
        "unmatched": len(unmatched),
        "unmatched_names": unmatched[:40],
    }


class ScoringPasteRequest(BaseModel):
    text: str = ""   # the platform's own Scoring settings page, copied as text


def _scoring_paste_response(report: "scoring_paste.ScoringPasteReport") -> dict:
    return {
        "scoring": report.scoring,
        "ppr": report.ppr,
        "matched": report.matched,
        "unmapped": report.unmapped,
        "warnings": report.warnings,
    }


@app.post("/api/integrations/yahoo/scoring-paste-candidates")
async def yahoo_scoring_paste_candidates(
    data: ScoringPasteRequest,
    _: User = Depends(get_current_user),
) -> dict:
    """Match report ONLY — no write, no admin gate, no player pool needed at
    all (this is league-wide scoring RULES, not per-player values). Yahoo's
    API only labels a scoring rule by a numeric `stat_id` this app has no
    verified mapping for beyond receptions (see `yahoo.raw_stat_modifiers`);
    Yahoo's own Scoring settings PAGE labels every rule in plain English, so
    pasting it needs no guessing. Reported live: "my Yahoo import only
    imported PPR, 42 other scoring rules not auto-mapped." The caller merges
    `scoring` (+ `ppr`, if the page named a reception value) into their OWN
    league's `settings.scoring`/`settings.ppr` via the existing
    `PATCH /api/leagues/{id}` — same hand-off shape as `aavPasteCandidates`.
    """
    if not data.text.strip():
        raise HTTPException(status_code=400,
                            detail="Paste the League Settings -> Scoring page from Yahoo.")
    report = scoring_paste.parse_yahoo_scoring_page(data.text)
    if not report.matched and not report.unmapped:
        raise HTTPException(status_code=422,
                            detail="Could not parse any scoring rules from the pasted text.")
    return _scoring_paste_response(report)


@app.post("/api/integrations/espn/scoring-paste-candidates")
async def espn_scoring_paste_candidates(
    data: ScoringPasteRequest,
    _: User = Depends(get_current_user),
) -> dict:
    """ESPN counterpart of the route above — see `scoring_paste
    .parse_espn_scoring_page` for the page shape this expects."""
    if not data.text.strip():
        raise HTTPException(status_code=400,
                            detail="Paste the League Settings -> Scoring Settings page from ESPN.")
    report = scoring_paste.parse_espn_scoring_page(data.text)
    if not report.matched and not report.unmapped:
        raise HTTPException(status_code=422,
                            detail="Could not parse any scoring rules from the pasted text.")
    return _scoring_paste_response(report)


@app.post("/api/integrations/athletic/upload-candidates")
async def athletic_upload_candidates(
    file: UploadFile = File(...),
    season: int = 2026,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
) -> dict:
    """Match report for an uploaded copy of The Athletic's projections
    workbook — no write, no admin gate, and NOT a valuation input (roadmap
    0.1b tried and failed the full-stack kill gate for that — see
    CLAUDE.md). This is a SECOND-OPINION DISPLAY source only: the caller
    merges `candidates` into their own league's `settings.athleticProjections`
    via the existing `PATCH /api/leagues/{id}`, same shape as
    `aav-paste-candidates` above. The raw workbook is parsed in memory and
    discarded — never persisted to disk, never written to `fantasy_players`.
    """
    if not file.filename or not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=400,
                             detail="Upload The Athletic's projections workbook as a .xlsx file.")
    try:
        report = athletic_upload.parse_workbook(file.file)
    except Exception as e:  # noqa: BLE001 — an unreadable/unexpected workbook shape
        raise HTTPException(status_code=422, detail=f"Could not parse the uploaded workbook: {e}")
    if not report.rows:
        raise HTTPException(
            status_code=422,
            detail="No player rows found — expected QB/RB/WR/TE sheets with Player/Tm columns.")

    rows = (await db.execute(
        select(Player.id, Player.name, Player.pos, Player.team).where(Player.season == season)
    )).all()
    if not rows:
        raise HTTPException(status_code=409, detail=f"No players loaded for season {season}.")
    index = build_index([{"id": r.id, "name": r.name, "pos": r.pos, "team": r.team} for r in rows])

    norm_players = athletic_upload.to_norm_players(report)
    matched, unmatched = [], []
    for np, ar in zip(norm_players, report.rows):
        pid = match_player(index, np)
        if pid is None:
            unmatched.append(ar.name)
            continue
        matched.append({"id": pid, "name": ar.name, "pos": ar.pos, "team": ar.team, "proj": ar.proj})

    return {
        "season": season,
        "sheets_found": report.sheets_found,
        "parsed": len(report.rows),
        "candidates": matched,
        "matched": len(matched),
        "unmatched": len(unmatched),
        "unmatched_names": unmatched[:40],
    }


class AavPasteRequest(BaseModel):
    text: str = ""             # copied FantasyPros auction values cheat sheet
    season: int = 2026
    dry_run: bool = True


@app.post("/api/admin/fantasypros/aav-paste")
async def fantasypros_aav_paste(
    data: AavPasteRequest,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(db_dep),
) -> dict:
    """Real auction dollar values with NO API access — `fetch_aav()` in the
    pipeline is a documented no-op (the public FantasyPros API has no auction
    endpoint), but the website's cheat sheet can be copied out as text, same
    shape of fix as the Yahoo paste importer.

    Writes `fantasy_players.aav` for `season`, which `marketPrice()` already
    prefers over its modeled log curve whenever present — this REPLACES the
    modeled fallback everyone gets by default. For a value that should only
    apply to ONE league (a league-specific consensus, an update mid-draft),
    use `/api/integrations/fantasypros/aav-paste-candidates` instead and
    merge into that league's `settings.aavOverrides` — this route is for
    refreshing the season-wide baseline every league falls back to, which is
    why it stays admin-gated and defaults to `dry_run=true`.
    """
    if not data.text.strip():
        raise HTTPException(status_code=400,
                            detail="Paste the FantasyPros auction values cheat sheet.")
    report = aav_paste.parse_aav_sheet(data.text)
    if not report.rows:
        raise HTTPException(status_code=422,
                            detail="Could not parse any rows from the pasted text.")

    rows = (await db.execute(
        select(Player.id, Player.name, Player.pos, Player.team, Player.aav)
        .where(Player.season == data.season)
    )).all()
    if not rows:
        raise HTTPException(status_code=409, detail=f"No players loaded for season {data.season}.")
    index = build_index([{"id": r.id, "name": r.name, "pos": r.pos, "team": r.team} for r in rows])
    current_aav = {r.id: r.aav for r in rows}

    norm_players = aav_paste.to_norm_players(report)
    updates, unmatched = [], []
    for np, avr in zip(norm_players, report.rows):
        pid = match_player(index, np)
        if pid is None:
            unmatched.append(avr.name)
            continue
        updates.append({"id": pid, "name": avr.name, "old": current_aav.get(pid), "new": avr.aav})

    result = {
        "season": data.season,
        "parsed": len(report.rows),
        "skipped_lines": len(report.skipped),
        "matched": len(updates),
        "unmatched": len(unmatched),
        # Capped so a long tail of deep-bench misses doesn't blow up the
        # response; the count above is what actually matters for the badge.
        "unmatched_names": unmatched[:40],
        "sample": updates[:10],
        "dry_run": data.dry_run,
        "written": False,
    }
    if data.dry_run:
        return result

    for u in updates:
        await db.execute(update(Player).where(Player.id == u["id"]).values(aav=u["new"]))
    await db.commit()
    result["written"] = True
    log.info("aav-paste: updated %d players for season %s (%d unmatched)",
              len(updates), data.season, len(unmatched))
    return result


@app.post("/api/integrations/espn/probe-activity")
async def espn_probe_activity(
    data: KeeperCandidatesRequest,
    _: User = Depends(get_current_user),
) -> dict:
    """Diagnostic: report what ESPN returns for each plausible transaction /
    activity URL, so waiver-history support can be fixed from evidence rather
    than guessed. Read-only, no data stored."""
    try:
        probes = await espn_provider.probe_activity(
            data.ext_id, data.season, espn_s2=data.espn_s2, swid=data.swid)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"probe failed: {e}")
    return {"season": data.season, "probes": probes}


@app.get("/api/integrations/yahoo/auth-url")
async def yahoo_auth_url(_: User = Depends(get_current_user)) -> dict:
    """Return the Yahoo OAuth consent URL to open in the browser."""
    try:
        return {"url": yahoo_provider.authorize_url(state="import")}
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


class YahooExchange(BaseModel):
    code: str


@app.post("/api/integrations/yahoo/exchange")
async def yahoo_exchange(body: YahooExchange, _: User = Depends(get_current_user)) -> dict:
    """Exchange a Yahoo auth code for an access token (+ manager guid)."""
    try:
        tok = await yahoo_provider.exchange_code(body.code)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Yahoo token exchange failed: {e}")
    return {
        "access_token": tok.get("access_token"),
        "refresh_token": tok.get("refresh_token"),
        "guid": tok.get("xoauth_yahoo_guid"),
        "expires_in": tok.get("expires_in"),
    }


class YahooRefresh(BaseModel):
    refresh_token: str


@app.post("/api/integrations/yahoo/refresh")
async def yahoo_refresh(body: YahooRefresh, _: User = Depends(get_current_user)) -> dict:
    """Trade a refresh token for a fresh access token.

    Yahoo access tokens expire in about an hour. Without this, a draft session
    that outlasts the token forces the whole consent dance again mid-draft —
    and the keeper planner, which runs long after the import, would never have
    a usable token at all."""
    try:
        tok = await yahoo_provider.refresh_token(body.refresh_token)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=401, detail=f"Yahoo token refresh failed: {e}")
    return {
        "access_token": tok.get("access_token"),
        # Yahoo rotates the refresh token on some grants; keep whichever came back.
        "refresh_token": tok.get("refresh_token") or body.refresh_token,
        "guid": tok.get("xoauth_yahoo_guid"),
        "expires_in": tok.get("expires_in"),
    }


class YahooKeeperRequest(BaseModel):
    league_key: str                   # PRIOR season's league key, e.g. "449.l.82486"
    access_token: str
    match_season: int = 2026          # current player pool to map candidates onto
    my_guid: Optional[str] = None     # manager guid, to flag your own roster


@app.post("/api/integrations/yahoo/keeper-candidates")
async def yahoo_keeper_candidates(
    data: YahooKeeperRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
) -> dict:
    """Yahoo's equivalent of the ESPN keeper pull: a prior season's rosters plus
    what each player cost (draft result, and top FAAB claim where available),
    mapped onto the current player pool. Same response shape as the ESPN route,
    so the planner consumes either without special-casing."""
    try:
        norm = await yahoo_provider.fetch_keeper_league(
            data.league_key, data.access_token, my_guid=data.my_guid)
    except yahoo_provider.FantasyScopeError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:  # noqa: BLE001 — surface provider errors cleanly
        raise HTTPException(status_code=502, detail=f"yahoo fetch failed: {e}")

    rows = (await db.execute(
        select(Player.id, Player.name, Player.pos, Player.team).where(Player.season == data.match_season)
    )).all()
    if not rows:
        raise HTTPException(status_code=409, detail=f"No players loaded for season {data.match_season}.")
    index = build_index([{"id": r.id, "name": r.name, "pos": r.pos, "team": r.team} for r in rows])

    cands = keeper_candidates(norm, index)
    matched = sum(1 for c in cands if c["matched"])
    return {
        "fmt": norm.fmt,
        "season": data.match_season,
        "candidates": cands,
        "matched": matched,
        "unmatched": len(cands) - matched,
        "waivers": {
            "players": sum(1 for c in cands if c.get("waiver")),
            **(norm.meta.get("transactions") or {}),
        },
        "draft": norm.meta.get("draft") or {},
        # Yahoo's own "was kept" flag — shown for confirmation, not trusted
        # silently (same treatment as the pasted keeper badge).
        "kept_detected": norm.meta.get("kept_detected") or [],
    }


class YahooToken(BaseModel):
    access_token: str


@app.post("/api/integrations/yahoo/leagues")
async def yahoo_leagues(body: YahooToken, _: User = Depends(get_current_user)) -> dict:
    """List all NFL leagues (every season) for the connected Yahoo account, so the
    user can pick the exact league key — including unrenewed/past-season leagues."""
    try:
        leagues = await yahoo_provider.fetch_my_leagues(body.access_token)
    except yahoo_provider.FantasyScopeError as e:
        # 403, not 502: the request was fine, the GRANT is wrong. The client
        # uses this status to offer "disconnect and re-authorize".
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Yahoo leagues fetch failed: {e}")
    return {"leagues": leagues}


@app.get("/api/integrations/yahoo/config")
async def yahoo_config(_: User = Depends(get_current_user)) -> dict:
    """What the backend is actually configured with — no secret values, just
    whether each piece is present, plus the scope and redirect being sent.
    A scope/redirect mismatch is the usual cause of a Yahoo failure and is
    otherwise invisible from the browser."""
    cid, secret, redirect = yahoo_provider._cfg()
    scope = os.getenv("YAHOO_SCOPE", yahoo_provider.DEFAULT_SCOPE) or yahoo_provider.DEFAULT_SCOPE
    return {
        "client_id_set": bool(cid),
        "client_secret_set": bool(secret),
        # Yahoo's console shows THREE identifiers and only one belongs here.
        # The Client ID (Consumer Key) is long and ends in "--"; the App ID is
        # a short handle. Pasting the App ID here is an easy mistake that fails
        # in a way that looks like a scope problem, so report the shape (never
        # the value) to make it self-diagnosable.
        "client_id_shape": {
            "length": len(cid),
            "ends_with_dashes": cid.endswith("--"),
            "looks_like_app_id": bool(cid) and len(cid) < 32 and not cid.endswith("--"),
        },
        "redirect_uri": redirect,
        "scope_sent": None if scope == "-" else scope,
        "scope_from_env": bool(os.getenv("YAHOO_SCOPE")),
    }


# ── Live draft sync ───────────────────────────────────────────────────────────

class LiveDraftRequest(BaseModel):
    """Poll a draft that is happening right now and log any new picks.

    Neither platform exposes its draft-room socket, so this is polling: the
    client calls it on an interval while the draft runs."""
    provider: Literal["espn", "yahoo"]
    ext_id: str                       # ESPN leagueId, or Yahoo league_key
    season: int = 2026
    match_season: int = 2026          # player pool the picks map onto
    access_token: Optional[str] = None    # yahoo
    my_guid: Optional[str] = None         # yahoo
    espn_s2: Optional[str] = None
    swid: Optional[str] = None
    my_team: Optional[str] = None         # espn team id/name to flag as yours
    apply: bool = True                # False = preview only, log nothing
    # OFF by default — confirmed live that just ATTEMPTING this connection
    # (never mind succeeding) can trip ESPN's multi-location login check and
    # kick the user's own browser session. Worse under polling: a poll that
    # hits its connect_timeout (5s) doesn't retry the same connection, it
    # lets the NEXT poll's ensure_watcher() start a brand new attempt — so
    # with auto-poll on, this was retrying every 5-30s, repeatedly hitting
    # ESPN's check rather than tripping it once. The bookmarklet ingest path
    # (live-ingest-token / live-ingest below) doesn't have this problem at
    # all and is preferred automatically once it has data; this flag exists
    # for anyone who wants to try the backend-owned path anyway.
    enable_backend_ws: bool = False
    # One-shot: also pull ESPN's REST draftDetail.picks (roster-join +
    # kona_player_info top-up, same as the no-ingest fallback path) and merge
    # whatever it resolves in alongside the live-ingest picks. For picks made
    # BEFORE the bookmarklet/userscript connected — e.g. joining an
    # already-in-progress draft late — there's no live event to replay (the
    # WebSocket's one-time INIT backfill blob is deliberately left undecoded,
    # see espn_draft_ws.py), but ESPN's roster view usually DOES catch up for
    # picks that are no longer brand new, just not for ones seconds old —
    # this is exactly the case that's stale enough to have caught up. Off by
    # default and not run every poll: it's the same roster-lag-prone REST
    # path documented as a live-picks dead end, only useful as an occasional
    # one-shot catch-up, not a replacement for the live path.
    backfill: bool = False


@app.post("/api/leagues/{league_id}/stop-live-watcher")
async def stop_live_watcher(
    league_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
) -> dict:
    """Kills the backend-owned WebSocket watcher for this league right now,
    if one is running. Closing the LiveDraftPanel does NOT stop it by design
    (see its docstring) — this is the explicit override for when that
    watcher turns out to be actively harmful (ESPN's multi-location kick),
    not just unproductive."""
    await _get_league_owned(league_id, user.id, db)  # ownership check only
    stopped = live_ws_registry.stop_watcher(league_id)
    return {"stopped": stopped}


@app.post("/api/leagues/{league_id}/live-ingest-token")
async def get_live_ingest_token(
    league_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
) -> dict:
    """Get-or-create the per-league secret this league's bookmarklet
    authenticates with (see live_ws_registry.py "Browser-side ingest"). The
    bookmarklet runs on ESPN's own origin, not ours, so it can't carry our
    normal JWT bearer (no access to this site's localStorage from there) —
    high-entropy token in the request body instead, same trust model as a
    webhook secret. Stable across calls: regenerating would silently break
    a bookmarklet already dragged into someone's bookmarks bar."""
    league = await _get_league_owned(league_id, user.id, db)
    settings = league.settings or {}
    token = settings.get("liveIngestToken")
    if not token:
        token = secrets.token_urlsafe(24)
        league.settings = {**settings, "liveIngestToken": token}
        await db.commit()
    return {"token": token}


class LiveIngestEvent(BaseModel):
    """SOLD line(s), pushed from the browser bookmarklet/userscript. Not
    JWT-authed — see get_live_ingest_token's docstring — `token` is the
    whole trust boundary here, so treat a mismatch exactly like a bad
    password, not a generic validation error.

    `events` (plural) is the current shape: the hook resends its FULL
    locally-captured list on every send, not just the newest line — a
    single dropped fire-and-forget POST used to permanently lose that pick
    with no retry (confirmed live: a real gap between what ESPN's room
    showed and what this app had, growing every time a request failed to
    land). See `live_ws_registry.ingest_sold_events` for why resending the
    full list on every call is safe. The singular fields below are kept
    ONLY for a userscript downloaded before this change that hasn't been
    re-fetched yet — new downloads always send `events`."""
    token: str
    ext_id: str
    season: int = 2026
    espn_s2: Optional[str] = None
    swid: Optional[str] = None
    my_team: Optional[str] = None
    start_overall: int = 1
    events: Optional[list[dict]] = None
    # The player currently up for auction, tracked off BID (not NOMINATION
    # — see LiveDraftWatcher.current_nomination_id's docstring for why).
    # None if nobody's currently up (between lots, or a userscript that
    # predates this feature and never sends it).
    current_nomination_id: Optional[int] = None
    # Legacy single-event shape — back-compat only, see docstring above.
    nominating_team_id: Optional[int] = None
    player_id: Optional[int] = None
    winning_team_id: Optional[int] = None
    price: Optional[int] = None


@app.post("/api/leagues/{league_id}/live-ingest")
async def live_ingest(league_id: int, data: LiveIngestEvent, db: AsyncSession = Depends(db_dep)) -> dict:
    """Receives SOLD event(s) from the bookmarklet/userscript running on the
    ESPN draft page. No JWT — see LiveIngestEvent's docstring — league is
    looked up by id alone and the token is checked against what
    get_live_ingest_token handed out. Deliberately narrow: this route can
    only feed one league's accumulator, nothing else a normal authenticated
    call could do."""
    result = await db.execute(select(League).where(League.id == league_id))
    league = result.scalar_one_or_none()
    if not league:
        raise HTTPException(status_code=404, detail="League not found")
    expected = (league.settings or {}).get("liveIngestToken")
    if not expected or not secrets.compare_digest(data.token, expected):
        raise HTTPException(status_code=401, detail="Invalid live-ingest token")

    # `data.start_overall` is baked into the userscript/bookmarklet at
    # DOWNLOAD time and never updates after that — if the hook connects long
    # after download (Tampermonkey install friction, troubleshooting, or
    # picks logged via backfill in between), that value is stale. The
    # ingest watcher's OWN numbering only matters for cosmetic ordering
    # (DraftLogModal re-sorts by it; nothing else depends on it being
    # accurate — see live_ws_registry.py), but a stale start_overall still
    # produces confusing numbers, so compute it fresh from the DB instead
    # of trusting the client-supplied one. Only matters the moment a NEW
    # watcher is created (ingest_sold_events ignores it on later calls).
    existing_count = len((await db.execute(
        select(DraftPick.player_id).where(DraftPick.league_id == league_id)
    )).scalars().all())

    if data.events:
        watcher = await live_ws_registry.ingest_sold_events(
            league_id, data.ext_id, data.season, data.my_team, data.espn_s2, data.swid,
            existing_count + 1, data.events, current_nomination_id=data.current_nomination_id,
        )
    elif data.player_id is not None:
        watcher = await live_ws_registry.ingest_sold_event(
            league_id, data.ext_id, data.season, data.my_team, data.espn_s2, data.swid,
            existing_count + 1, data.nominating_team_id or 0, data.player_id,
            data.winning_team_id or 0, data.price or 0,
        )
    else:
        raise HTTPException(status_code=400, detail="No event data in request.")
    return {"ok": True, "drafted": len(watcher.events)}


@app.post("/api/leagues/{league_id}/sync-draft")
async def sync_draft(
    league_id: int,
    data: LiveDraftRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
) -> dict:
    """Fetch the live draft board and add picks we don't already have.

    Idempotent by PLAYER, not by pick number: a player is drafted exactly once,
    so re-polling can never duplicate a pick, and keepers already logged are
    left alone instead of being re-added when the platform lists them among the
    draft results. The platform's own overall pick number is preserved, so the
    draft log reads in true draft order.
    """
    league = await _get_league_owned(league_id, user.id, db)

    existing = (await db.execute(
        select(DraftPick.player_id).where(DraftPick.league_id == league_id)
    )).scalars().all()
    have = {pid for pid in existing if pid is not None}

    try:
        if data.provider == "yahoo":
            if not data.access_token:
                raise HTTPException(status_code=400, detail="Yahoo access token required.")
            state = await yahoo_provider.fetch_live_draft(
                data.ext_id, data.access_token, my_guid=data.my_guid)
        elif live_ws_registry.get_ingest_watcher(league_id) is not None:
            # Browser-bookmarklet ingest path (see live_ws_registry.py
            # "Browser-side ingest"): the bookmarklet on the ESPN draft page
            # itself has posted at least one SOLD event for this league. That
            # data is strictly better than anything the backend-owned
            # WebSocket path below could get — it doesn't trigger ESPN's
            # multi-location kick at all, since nothing new logs in — so once
            # it exists, prefer it outright rather than trying to merge two
            # sources of the same picks.
            state = live_ws_registry.get_ingest_watcher(league_id).state()
        elif data.enable_backend_ws and data.espn_s2 and data.swid:
            # Live WebSocket path: draftDetail.picks (REST) is a static
            # skeleton until the draft finalizes and can never carry live
            # picks — see CLAUDE.md "Live draft sync". The WebSocket watcher
            # is the real mechanism; ensure_watcher is idempotent per league,
            # so every poll just reads whatever it's accumulated so far.
            # Best-effort: any failure here (bad cookies, ESPN closing the
            # connection, a team-id mismatch) falls back to the REST path
            # rather than breaking the poll outright.
            #
            # **Confirmed live: even attempting this connection can trigger
            # ESPN's multi-location login protection and kick the user's own
            # browser session, independent of whether it ever connects.** The
            # bookmarklet path above is the one that doesn't have this
            # problem; this path is kept as the automatic first-poll
            # behavior (nothing to install) but a poll that also has ingest
            # data will always prefer that instead, from the branch above.
            #
            # start_overall seeds new picks past whatever's already logged —
            # the watcher is forward-only (no INIT backfill decoded, see
            # espn_draft_ws.py), so picks already made before the watcher
            # connects are NOT recovered by this path; only NEW ones from
            # here forward are. len(existing) is only read at watcher-START
            # (ensure_watcher no-ops on later polls), so it won't drift once
            # the watcher is running and `existing` naturally grows.
            handle = await live_ws_registry.ensure_watcher(
                league_id, data.ext_id, data.season, data.my_team, data.espn_s2, data.swid,
                start_overall=len(existing) + 1)
            if handle.watcher is not None:
                # Give the watcher task a moment to start before reading its state.
                # The task is scheduled asynchronously, so we need a small yield
                # to let it begin executing (set started=True).
                await asyncio.sleep(0.001)
                state = handle.watcher.state()
                state.meta["ws_start_error"] = handle.start_error
            else:
                state = await espn_provider.fetch_and_resolve_live_draft(
                    data.ext_id, data.season, espn_s2=data.espn_s2, swid=data.swid, my_team=data.my_team)
                state.meta["ws_start_error"] = handle.start_error
        else:
            state = await espn_provider.fetch_and_resolve_live_draft(
                data.ext_id, data.season, espn_s2=data.espn_s2, swid=data.swid, my_team=data.my_team)
    except yahoo_provider.FantasyScopeError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — surface provider errors cleanly
        raise HTTPException(status_code=502, detail=f"{data.provider} draft fetch failed: {e}")

    if data.backfill and data.provider == "espn" and data.espn_s2 and data.swid:
        # See LiveDraftRequest.backfill's docstring. Best-effort and additive
        # only — merged into `state.picks` BEFORE the per-player dedup loop
        # below, so a pick this resolves that's already logged (or already
        # present from the live path) is silently skipped there, same as any
        # other duplicate. A failure here degrades to "no backfill this
        # round", never to breaking the live picks the poll already had.
        try:
            backfill_state = await espn_provider.fetch_and_resolve_live_draft(
                data.ext_id, data.season, espn_s2=data.espn_s2, swid=data.swid, my_team=data.my_team)
            state.picks = list(backfill_state.picks) + list(state.picks)
            state.meta["backfill_resolved"] = backfill_state.meta.get("resolved")
        except Exception as exc:  # noqa: BLE001 — reported, not raised
            state.meta["backfill_error"] = f"{type(exc).__name__}: {exc}"

    rows = (await db.execute(
        select(Player.id, Player.name, Player.pos, Player.team).where(Player.season == data.match_season)
    )).all()
    if not rows:
        raise HTTPException(status_code=409, detail=f"No players loaded for season {data.match_season}.")
    index = build_index([{"id": r.id, "name": r.name, "pos": r.pos, "team": r.team} for r in rows])

    settings = league.settings or {}
    opponents = settings.get("opponents") or []
    # `opponentIds` is each opponent's PLATFORM team id (ESPN teamId / Yahoo
    # team_key), captured at import time by `opponent_team_ids` and
    # index-aligned with `opponents` — the STABLE key `resolve_opponent_index`
    # below prefers over matching by name, since it survives a team rename of
    # ANY size, not just what tiered name-folding happens to catch. Missing or
    # mismatched-length (an older league imported before this was captured)
    # degrades to name-only, same as before.
    opponent_ids = settings.get("opponentIds") or []
    if len(opponent_ids) != len(opponents):
        opponent_ids = [None] * len(opponents)
    opponent_pairs = list(zip(opponent_ids, opponents))

    # The player currently up for auction (see LiveDraftWatcher
    # .current_nomination_id's docstring) — resolved to OUR internal player
    # id the same way a drafted pick is, so the frontend can pin them to
    # the top of the board without doing its own name matching.
    current_nomination = None
    cn = state.meta.get("current_nomination")
    if cn and cn.get("name"):
        cn_pid = match_player(index, NormPlayer(name=cn["name"], pos=cn.get("pos", ""), team=cn.get("team", "")))
        if cn_pid is not None:
            current_nomination = {"player_id": cn_pid, "name": cn["name"],
                                  "pos": cn.get("pos", ""), "team": cn.get("team", "")}

    added, unmatched, skipped = [], [], 0
    for lp in state.picks:
        pid = match_player(index, NormPlayer(name=lp.name, pos=lp.pos, team=lp.team))
        if pid is None:
            unmatched.append(f"{lp.name} ({lp.pos or '?'})")
            continue
        if pid in have:
            skipped += 1
            continue
        # NOT lp.overall — see on_the_clock's comment above for why any one
        # source's own numbering can drift: the live-ingest path in
        # particular is fire-and-forget over HTTP (liveBookmarklet.ts posts
        # each SOLD event best-effort, "retried never" on a dropped
        # request), so a single missed POST — a backgrounded tab throttling
        # timers, a momentary network blip — permanently undercounts that
        # source's own arrival-index from then on, with no way for it to
        # self-heal. `len(have) + 1` has no such failure mode: it's derived
        # from what's ACTUALLY confirmed persisted, so a dropped event just
        # means a gap in NAMES (visible as a missing pick to add manually),
        # never a growing, silently-wrong number on every pick after it.
        overall = len(have) + 1
        if data.apply:
            db.add(DraftPick(
                league_id=league_id, player_id=pid, overall_pick=overall,
                mine=lp.is_mine,
                team_id=None if lp.is_mine else resolve_opponent_index(
                    opponent_pairs, lp.owner_ext_id, lp.owner),
                price=lp.bid, slot=None,
            ))
        have.add(pid)
        added.append({"overall": overall, "name": lp.name, "pos": lp.pos,
                      "owner": "Me" if lp.is_mine else lp.owner, "price": lp.bid})
    if data.apply and added:
        await db.commit()

    return {
        "provider": data.provider,
        "fmt": state.fmt,
        # NOT state.complete_through — that's derived from whichever source's
        # OWN overall-pick numbering happened to produce `state.picks`, which
        # for the live-ingest path is arrival-order counting from whatever
        # start_overall the watcher had at creation (stale/approximate, see
        # live_ingest's docstring) — disconnected from what's actually
        # logged once backfill or an earlier source added picks the watcher
        # never itself witnessed. `len(have)` is the TRUE total distinct
        # drafted players known to this league after this poll (every branch
        # above feeds through the same per-player dedup loop), which is
        # exactly what "how far has the draft progressed" means in any
        # normal draft — one pick, one player, no gaps.
        "on_the_clock": len(have) + 1,
        "added": added,
        "added_count": len(added),
        "already_had": skipped,
        # Names the pool doesn't contain (rookies not yet loaded, DST naming, …).
        # Reported, never silently dropped — an unlogged pick would corrupt the
        # board's idea of who is still available.
        "unmatched": unmatched,
        # The player currently up for auction, resolved to OUR internal
        # player id — None if nobody's currently up, the provider doesn't
        # support this (Yahoo/REST paths never set state.meta's version),
        # or the name didn't match our pool. Separate from the raw
        # ESPN-side version still visible in meta.current_nomination for
        # the debug view — this is the one the board should actually use.
        "current_nomination": current_nomination,
        "meta": state.meta,
        "applied": data.apply,
    }


# ── Draft picks ───────────────────────────────────────────────────────────────

@app.get("/api/leagues/{league_id}/picks", response_model=list[PickOut])
async def list_picks(
    league_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
):
    await _get_league_owned(league_id, user.id, db)
    result = await db.execute(
        select(DraftPick)
        .where(DraftPick.league_id == league_id)
        .order_by(DraftPick.overall_pick)
    )
    return list(result.scalars())


@app.post("/api/leagues/{league_id}/picks", response_model=PickOut, status_code=201)
async def add_pick(
    league_id: int,
    data: PickCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
):
    await _get_league_owned(league_id, user.id, db)
    count_result = await db.execute(
        select(DraftPick).where(DraftPick.league_id == league_id)
    )
    overall = len(list(count_result.scalars())) + 1
    pick = DraftPick(
        league_id=league_id,
        player_id=data.player_id,
        overall_pick=overall,
        mine=data.mine,
        team_id=data.team_id,
        price=data.price,
        slot=data.slot,
    )
    db.add(pick)
    await db.commit()
    await db.refresh(pick)
    return pick


@app.patch("/api/leagues/{league_id}/picks/{pick_id}", response_model=PickOut)
async def update_pick(
    league_id: int,
    pick_id: int,
    data: PickUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
):
    await _get_league_owned(league_id, user.id, db)
    result = await db.execute(
        select(DraftPick).where(DraftPick.id == pick_id, DraftPick.league_id == league_id)
    )
    pick = result.scalar_one_or_none()
    if not pick:
        raise HTTPException(status_code=404, detail="Pick not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(pick, field, value)
    await db.commit()
    await db.refresh(pick)
    return pick


@app.delete("/api/leagues/{league_id}/picks/{pick_id}", status_code=204)
async def delete_pick(
    league_id: int,
    pick_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_dep),
):
    await _get_league_owned(league_id, user.id, db)
    result = await db.execute(
        select(DraftPick).where(DraftPick.id == pick_id, DraftPick.league_id == league_id)
    )
    pick = result.scalar_one_or_none()
    if not pick:
        raise HTTPException(status_code=404, detail="Pick not found")
    await db.delete(pick)
    await db.commit()


# ── Admin: data refresh ───────────────────────────────────────────────────────

@app.post("/api/admin/refresh", status_code=202)
async def trigger_refresh(_: User = Depends(require_admin)):
    """Trigger the nflverse pipeline scripts. Runs sync; wire to a task queue for prod."""
    import subprocess, asyncio
    pipeline_dir = os.path.join(os.path.dirname(__file__), "..", "data-pipeline")
    if not os.path.isdir(pipeline_dir):
        raise HTTPException(status_code=404, detail="data-pipeline directory not found")
    await asyncio.to_thread(
        subprocess.run,
        ["python", "ingest_nflverse.py", "--last", "2025", "--upcoming", "2026", "--out", "./data", "--baseline-proj"],
        cwd=pipeline_dir, check=True,
    )
    return {"status": "pipeline triggered"}


@app.post("/api/admin/reload-sos")
async def reload_sos(
    season: int = 2026,
    log_season: int | None = None,
    dry_run: bool = False,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(db_dep),
) -> dict:
    """Re-apply the tuned SOS parameters to fantasy_sos for `season`.

    Self-contained: fetches the prior season's weekly stats from the public
    nflverse data release over HTTPS, rebuilds league-wide position-vs-defense
    logs, recomputes multipliers with sos.DEFAULT_SOS_PARAMS (kept in sync with
    the JS engine), and upserts. No local pipeline run required.

    Pass `dry_run=true` to preview the changes (max/mean shift, samples) without
    writing anything.
    """
    import asyncio
    import sos as sos_engine

    log_season = log_season or (season - 1)

    # 1. schedule for the target season (must already be loaded)
    sched_rows = list((await db.execute(
        select(Schedule).where(Schedule.season == season)
    )).scalars())
    if not sched_rows:
        raise HTTPException(
            status_code=400,
            detail=f"No schedule rows for season {season}; load the schedule first.",
        )
    schedule: dict[str, list[dict]] = {}
    for r in sched_rows:
        schedule.setdefault(r.team, []).append({"week": r.week, "opp": r.opp})

    # 2. fetch prior-season logs + recompute (network + CPU off the event loop).
    #    Falls back to an earlier season if the requested one isn't published.
    try:
        logs, log_season = await sos_engine.fetch_sos_logs(log_season)
    except Exception as e:  # noqa: BLE001 — surface a clean error to the admin
        raise HTTPException(status_code=502, detail=f"nflverse fetch failed: {e}")
    new_mult = await asyncio.to_thread(sos_engine.recompute, schedule, logs)

    # 3. diff against what's live now
    current = {(r.team, r.pos): r.mult for r in (await db.execute(
        select(SosMult).where(SosMult.season == season)
    )).scalars()}
    new_rows = [(t, p, m) for t, pm in new_mult.items() for p, m in pm.items()]
    diffs = [abs(m - current.get((t, p), 1.0)) for t, p, m in new_rows]
    changed = sum(1 for d in diffs if d > 1e-6)
    samples = sorted(new_rows, key=lambda r: -abs(r[2] - current.get((r[0], r[1]), 1.0)))[:8]
    summary = {
        "season": season,
        "log_season": log_season,
        "params": {**sos_engine.DEFAULT_SOS_PARAMS,
                   "playoffWeeks": sorted(sos_engine.DEFAULT_SOS_PARAMS["playoffWeeks"])},
        "rows": len(new_rows),
        "rows_changed": changed,
        "max_shift": round(max(diffs), 4) if diffs else 0.0,
        "mean_shift": round(sum(diffs) / len(diffs), 4) if diffs else 0.0,
        "largest_changes": [
            {"team": t, "pos": p, "old": round(current.get((t, p), 1.0), 3),
             "new": round(m, 3)} for t, p, m in samples
        ],
        "dry_run": dry_run,
        "written": False,
    }
    if dry_run:
        return summary

    # 4. upsert (replace the season's rows)
    await db.execute(delete(SosMult).where(SosMult.season == season))
    db.add_all([SosMult(season=season, team=t, pos=p, mult=m) for t, p, m in new_rows])
    await db.commit()
    summary["written"] = True
    log.info("reload-sos: wrote %d rows for season %s (%d changed)", len(new_rows), season, changed)
    return summary


@app.get("/api/health")
async def health():
    return {"status": "ok"}


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _get_league_owned(league_id: int, user_id: int, db: AsyncSession) -> League:
    result = await db.execute(
        select(League).where(League.id == league_id, League.user_id == user_id)
    )
    league = result.scalar_one_or_none()
    if not league:
        raise HTTPException(status_code=404, detail="League not found")
    return league

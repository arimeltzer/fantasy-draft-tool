import logging
import os
from datetime import datetime, timedelta
from typing import Any, Literal, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
import bcrypt as _bcrypt
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from database import db_dep, create_all_tables
from models import (
    DraftPick, League, LeagueFormat, Player, PlayerLog,
    Schedule, SosMult, User,
)
from integrations import espn as espn_provider, yahoo as yahoo_provider
from integrations.matching import build_index, match_player

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
    # Yahoo (token obtained via the OAuth helper routes below)
    access_token: Optional[str] = None
    my_guid: Optional[str] = None     # Yahoo manager guid to flag as "mine"


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
    except PermissionError as e:
        raise HTTPException(status_code=401, detail=str(e))
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

    # 3. Create the league.
    league = League(user_id=user.id, name=data.name or norm.name,
                    format=LeagueFormat(norm.fmt), settings=norm.settings)
    db.add(league)
    await db.flush()

    # 4. Map each rostered player to a pick.
    overall = matched = 0
    unmatched: list[str] = []
    for team in norm.teams:
        for np in team.players:
            if not np.name:
                continue
            pid = match_player(index, np)
            if pid is None:
                unmatched.append(f"{np.name} ({np.pos or '?'}{'/' + np.team if np.team else ''})")
                continue
            overall += 1
            matched += 1
            db.add(DraftPick(league_id=league.id, player_id=pid, overall_pick=overall,
                             mine=team.is_mine, price=np.bid, slot=None))
    await db.commit()
    await db.refresh(league)

    return {
        "league": LeagueOut.model_validate(league).model_dump(mode="json"),
        "report": {
            "provider": norm.provider,
            "format": norm.fmt,
            "teams": len(norm.teams),
            "players_matched": matched,
            "players_unmatched": len(unmatched),
            "unmatched_sample": unmatched[:30],
            "mine_found": any(t.is_mine for t in norm.teams),
        },
    }


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


class YahooToken(BaseModel):
    access_token: str


@app.post("/api/integrations/yahoo/leagues")
async def yahoo_leagues(body: YahooToken, _: User = Depends(get_current_user)) -> dict:
    """List all NFL leagues (every season) for the connected Yahoo account, so the
    user can pick the exact league key — including unrenewed/past-season leagues."""
    try:
        leagues = await yahoo_provider.fetch_my_leagues(body.access_token)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Yahoo leagues fetch failed: {e}")
    return {"leagues": leagues}


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

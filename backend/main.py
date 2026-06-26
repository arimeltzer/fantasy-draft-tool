import logging
import os
from datetime import datetime, timedelta
from typing import Any, Optional

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
    price: Optional[int] = None
    slot: Optional[str] = None


class PickOut(BaseModel):
    id: int
    league_id: int
    player_id: Optional[int]
    overall_pick: int
    mine: bool
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
        price=data.price,
        slot=data.slot,
    )
    db.add(pick)
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

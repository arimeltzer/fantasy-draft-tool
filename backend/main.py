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
from integrations import espn as espn_provider, yahoo as yahoo_provider, yahoo_paste
from integrations.base import NormPlayer, opponent_team_ids
from integrations.matching import build_index, match_player, keeper_candidates

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
    aav: Optional[float]
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
    opponent_names, team_id_by_name = opponent_team_ids(norm.teams)

    settings = {**norm.settings, "source": {"provider": norm.provider, "extId": norm.ext_id}}
    if opponent_names:
        settings["opponents"] = opponent_names
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

    opponent_names, _ = opponent_team_ids(norm.teams)
    settings = {**norm.settings}
    if opponent_names:
        settings["opponents"] = opponent_names
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
    except Exception as e:  # noqa: BLE001 — surface provider errors cleanly
        raise HTTPException(status_code=502, detail=f"espn fetch failed: {e}")

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
        "season": data.season,
        "candidates": cands,
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

    try:
        if data.provider == "yahoo":
            if not data.access_token:
                raise HTTPException(status_code=400, detail="Yahoo access token required.")
            state = await yahoo_provider.fetch_live_draft(
                data.ext_id, data.access_token, my_guid=data.my_guid)
        else:
            norm_data = await espn_provider.fetch_raw_league(
                data.ext_id, data.season, espn_s2=data.espn_s2, swid=data.swid)
            state = espn_provider.parse_live_draft(norm_data, my_team=data.my_team)
    except yahoo_provider.FantasyScopeError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — surface provider errors cleanly
        raise HTTPException(status_code=502, detail=f"{data.provider} draft fetch failed: {e}")

    rows = (await db.execute(
        select(Player.id, Player.name, Player.pos, Player.team).where(Player.season == data.match_season)
    )).all()
    if not rows:
        raise HTTPException(status_code=409, detail=f"No players loaded for season {data.match_season}.")
    index = build_index([{"id": r.id, "name": r.name, "pos": r.pos, "team": r.team} for r in rows])

    existing = (await db.execute(
        select(DraftPick.player_id).where(DraftPick.league_id == league_id)
    )).scalars().all()
    have = {pid for pid in existing if pid is not None}

    settings = league.settings or {}
    opponents = settings.get("opponents") or []
    team_id_by_name = {name: i for i, name in enumerate(opponents)}

    added, unmatched, skipped = [], [], 0
    for lp in state.picks:
        pid = match_player(index, NormPlayer(name=lp.name, pos=lp.pos, team=lp.team))
        if pid is None:
            unmatched.append(f"{lp.name} ({lp.pos or '?'})")
            continue
        if pid in have:
            skipped += 1
            continue
        if data.apply:
            db.add(DraftPick(
                league_id=league_id, player_id=pid, overall_pick=lp.overall,
                mine=lp.is_mine,
                team_id=None if lp.is_mine else team_id_by_name.get(lp.owner or ""),
                price=lp.bid, slot=None,
            ))
        have.add(pid)
        added.append({"overall": lp.overall, "name": lp.name, "pos": lp.pos,
                      "owner": "Me" if lp.is_mine else lp.owner, "price": lp.bid})
    if data.apply and added:
        await db.commit()

    return {
        "provider": data.provider,
        "fmt": state.fmt,
        "on_the_clock": state.complete_through + 1,
        "added": added,
        "added_count": len(added),
        "already_had": skipped,
        # Names the pool doesn't contain (rookies not yet loaded, DST naming, …).
        # Reported, never silently dropped — an unlogged pick would corrupt the
        # board's idea of who is still available.
        "unmatched": unmatched,
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

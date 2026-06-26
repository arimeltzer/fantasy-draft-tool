from datetime import datetime
from sqlalchemy import (
    Boolean, Column, DateTime, Enum, Float, ForeignKey,
    Integer, String, Text, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, relationship
import enum


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "fantasy_users"

    id           = Column(Integer, primary_key=True, index=True)
    email        = Column(String, unique=True, nullable=False, index=True)
    display_name = Column(String, nullable=True)
    password_hash = Column(String, nullable=False)
    is_admin     = Column(Boolean, default=False, nullable=False)
    is_active    = Column(Boolean, default=True, nullable=False)
    created_at   = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_login   = Column(DateTime, nullable=True)

    leagues = relationship("League", back_populates="user", cascade="all, delete-orphan")


class LeagueFormat(str, enum.Enum):
    auction = "auction"
    snake   = "snake"


class League(Base):
    __tablename__ = "fantasy_leagues"

    id         = Column(Integer, primary_key=True, index=True)
    user_id    = Column(Integer, ForeignKey("fantasy_users.id", ondelete="CASCADE"), nullable=False)
    name       = Column(String, nullable=False)
    format     = Column(Enum(LeagueFormat, name="league_format_enum"), nullable=False)
    settings   = Column(JSONB, nullable=False, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user   = relationship("User", back_populates="leagues")
    picks  = relationship("DraftPick", back_populates="league", cascade="all, delete-orphan", order_by="DraftPick.overall_pick")


class Player(Base):
    __tablename__ = "fantasy_players"

    id     = Column(Integer, primary_key=True, index=True)
    season = Column(Integer, nullable=False)
    name   = Column(String, nullable=False)
    pos    = Column(String(4), nullable=False)
    team   = Column(String(5), nullable=False)
    age    = Column(Integer, nullable=True)
    proj   = Column(JSONB, nullable=True)
    last   = Column(JSONB, nullable=True)
    ecr    = Column(Float, nullable=True)
    adp    = Column(Float, nullable=True)

    __table_args__ = (UniqueConstraint("season", "name", "pos", "team", name="uq_player_season"),)

    logs = relationship("PlayerLog", back_populates="player", cascade="all, delete-orphan")
    picks = relationship("DraftPick", back_populates="player")


class SosMult(Base):
    __tablename__ = "fantasy_sos"

    season = Column(Integer, nullable=False, primary_key=True)
    team   = Column(String(5), nullable=False, primary_key=True)
    pos    = Column(String(4), nullable=False, primary_key=True)
    mult   = Column(Float, nullable=False)


class Schedule(Base):
    __tablename__ = "fantasy_schedule"

    id     = Column(Integer, primary_key=True, index=True)
    season = Column(Integer, nullable=False)
    team   = Column(String(5), nullable=False)
    week   = Column(Integer, nullable=False)
    opp    = Column(String(5), nullable=False)

    __table_args__ = (UniqueConstraint("season", "team", "week", name="uq_schedule"),)


class PlayerLog(Base):
    __tablename__ = "fantasy_player_logs"

    id        = Column(Integer, primary_key=True, index=True)
    season    = Column(Integer, nullable=False)
    player_id = Column(Integer, ForeignKey("fantasy_players.id", ondelete="CASCADE"), nullable=False)
    week      = Column(Integer, nullable=False)
    opp       = Column(String(5), nullable=False)
    fp        = Column(Float, nullable=False)

    player = relationship("Player", back_populates="logs")

    __table_args__ = (UniqueConstraint("season", "player_id", "week", name="uq_player_log"),)


class DraftPick(Base):
    __tablename__ = "fantasy_draft_picks"

    id           = Column(Integer, primary_key=True, index=True)
    league_id    = Column(Integer, ForeignKey("fantasy_leagues.id", ondelete="CASCADE"), nullable=False)
    player_id    = Column(Integer, ForeignKey("fantasy_players.id", ondelete="SET NULL"), nullable=True)
    overall_pick = Column(Integer, nullable=False)
    mine         = Column(Boolean, nullable=False, default=False)
    price        = Column(Integer, nullable=True)
    slot         = Column(Text, nullable=True)
    ts           = Column(DateTime, default=datetime.utcnow, nullable=False)

    league = relationship("League", back_populates="picks")
    player = relationship("Player", back_populates="picks")

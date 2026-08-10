"""
integrations/yahoo_paste.py
===========================
Yahoo league import WITHOUT API access.

Yahoo's developer program no longer reliably grants the Fantasy Sports scope,
so the OAuth path in `yahoo.py` can be blocked indefinitely. Every Yahoo league
member can still *see* their league in the web UI, so this module imports from
the two pages that carry everything the keeper tools need, pasted as text:

  1. **Draft Results**  -> each player's draft round (the keeper cost basis in a
     Yahoo round-cost league) and, in a keeper league, a badge on players who
     were kept that year.
  2. **Starting Rosters** (end of season) -> who is actually on each team now,
     i.e. the pool of players that could be kept next year.

Parsed from COPIED TEXT rather than HTML: it's what a user can reliably produce
from a rendered page, and it survives Yahoo re-skinning their markup.

Everything here is pure and fixture-tested against a real 10-team league export
(`integrations/selftest.py`); no network, no credentials.

FRAGILITY NOTE — the keeper badge
---------------------------------
Yahoo renders the "was kept" marker as an icon. Copying the page strips the
icon but leaves its whitespace, so a kept player shows up as a trailing space
after the name in Draft Results (and a blank line in Rosters). That is a real,
verifiable signal — in the reference league it flagged exactly one player per
team across all ten — but it IS whitespace-dependent and could be normalized
away by some editors. So `kept` is surfaced as a *proposal* for the user to
confirm in the UI, never silently committed. See `KeeperPasteResult.warnings`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .base import NormLeague, NormPlayer, NormTeam, make_settings

# Yahoo roster slot label -> our position bucket. Slot is where the player was
# *lined up*, not their position, so BN/IR carry no position information; the
# real position comes from matching against our player pool.
SLOT_TO_POS = {
    "QB": "QB", "WR": "WR", "RB": "RB", "TE": "TE",
    "K": "K", "DEF": "DST",
    "W/R/T": "", "W/T": "", "W/R": "", "R/W/T": "", "Q/W/R/T": "",
    "BN": "", "IR": "", "IL": "", "IL+": "", "NA": "",
}
ROSTER_HEADER = re.compile(r"^Pos\s*\t\s*Player\s*$", re.I)
# A player's block ends at its game line ("Final W 34-26 @ Ten", "Sun 1:00 pm",
# "Bye"). Anchoring on this is what keeps badge detection inside the block.
GAME_RESULT = re.compile(r"^(Final\b|Bye\b|[A-Z][a-z]{2}\s+\d|\d{1,2}:\d{2})", re.I)
PLAYER_BLOCK_SCAN = 6   # a roster block is short; don't run into the next team
ROUND_HEADER = re.compile(r"^Round\s+(\d+)\s*$", re.I)
# "12.\tPlayer Name\tTeam Name"  (tab-separated; name may carry a trailing
# space where the keeper badge icon was stripped by the copy)
PICK_LINE = re.compile(r"^(\d+)\.\s*\t(.*?)\t(.*)$")
TRUNCATED = re.compile(r"\.\.\.$|…$")


def _norm(s: str) -> str:
    """Normalize for comparison only (curly quotes, whitespace, case)."""
    return (s or "").replace("’", "'").replace("‘", "'").strip().casefold()


def _clean(s: str) -> str:
    """Display-clean a value while preserving nothing about the badge."""
    return (s or "").replace("’", "'").strip()


@dataclass
class PastePick:
    round: int
    pick: int
    name: str
    team: str          # as printed — may be truncated ("Becoming BEA...")
    kept: bool = False  # keeper badge detected (see module docstring)


@dataclass
class PasteRosterSpot:
    slot: str          # Yahoo slot label as printed (QB / BN / IR / W/R/T ...)
    pos: str           # our bucket, "" when the slot doesn't imply one
    name: str
    kept: bool = False


@dataclass
class PasteTeam:
    name: str
    players: list[PasteRosterSpot] = field(default_factory=list)


def parse_draft_results(text: str) -> list[PastePick]:
    """Parse a copied Yahoo 'Draft Results' page.

    Rounds are announced by a `Round N` line; picks are
    `<pick>.\\t<player>\\t<team>`. A trailing space on the player cell means the
    keeper badge was there (see module docstring).
    """
    picks: list[PastePick] = []
    rnd = 0
    for raw in (text or "").splitlines():
        line = raw.rstrip("\r")
        m = ROUND_HEADER.match(line.strip())
        if m:
            rnd = int(m.group(1))
            continue
        m = PICK_LINE.match(line)
        if not m or rnd == 0:
            continue
        pick_no, name_cell, team_cell = m.group(1), m.group(2), m.group(3)
        if not name_cell.strip():
            continue
        picks.append(PastePick(
            round=rnd,
            pick=int(pick_no),
            name=_clean(name_cell),
            team=_clean(team_cell),
            # badge = the stripped icon's whitespace, on the *name* cell
            kept=name_cell != name_cell.rstrip(),
        ))
    return picks


def parse_rosters(text: str) -> list[PasteTeam]:
    """Parse a copied Yahoo 'Starting Rosters' page.

    Shape per team:

        <Team Name>
        (blank)
        Pos<TAB>Player
        QB<TAB>
        Josh Allen
        Josh AllenVideo Forecast
        Final L 12-13 vs Phi

    The team name is the last non-empty line before the `Pos/Player` header.
    After a slot line, the next non-empty line is the player's name; the lines
    that follow (duplicate name, "- DEF", game result) are ignored — except a
    blank line before the result, which is where a keeper badge was stripped.
    """
    lines = [ln.rstrip("\r") for ln in (text or "").splitlines()]
    teams: list[PasteTeam] = []
    current: PasteTeam | None = None
    i = 0
    while i < len(lines):
        line = lines[i]
        if ROSTER_HEADER.match(line.strip()):
            # Team name = nearest preceding non-empty line.
            name = ""
            for j in range(i - 1, -1, -1):
                if lines[j].strip():
                    name = _clean(lines[j])
                    break
            current = PasteTeam(name=name)
            teams.append(current)
            i += 1
            continue

        # A slot line is "QB\t" / "W/R/T\t" — label then tab, nothing else.
        if current is not None and "\t" in line:
            label = line.split("\t", 1)[0].strip()
            rest = line.split("\t", 1)[1].strip()
            if not rest and label.upper() in SLOT_TO_POS:
                # Player name is the next non-empty line.
                k = i + 1
                while k < len(lines) and not lines[k].strip():
                    k += 1
                if k < len(lines):
                    pname = _clean(lines[k])
                    # Scan only this player's own block for the blank line that
                    # marks a stripped keeper badge. The block ends at the game
                    # result ("Final ..."), so we must stop there — scanning to
                    # the next slot/team boundary would swallow the blank line
                    # that precedes the NEXT team's header and flag every team's
                    # last player as kept.
                    kept = False
                    for m in range(k + 1, min(k + 1 + PLAYER_BLOCK_SCAN, len(lines))):
                        nxt = lines[m]
                        if GAME_RESULT.match(nxt.strip()):
                            break
                        if ROSTER_HEADER.match(nxt.strip()):
                            break
                        if "\t" in nxt:
                            lbl = nxt.split("\t", 1)[0].strip()
                            if not nxt.split("\t", 1)[1].strip() and lbl.upper() in SLOT_TO_POS:
                                break
                        if not nxt.strip():
                            kept = True
                    if pname:
                        current.players.append(PasteRosterSpot(
                            slot=label.upper(),
                            pos=SLOT_TO_POS.get(label.upper(), ""),
                            name=pname,
                            kept=kept,
                        ))
                    i = k + 1
                    continue
        i += 1
    return [t for t in teams if t.name]


def resolve_team_name(printed: str, full_names: list[str]) -> str:
    """Map a possibly-truncated draft-results team ("Becoming BEA...") onto a
    full roster team name. Exact match wins; otherwise the truncated stem must
    prefix exactly one full name (ambiguity returns the input unchanged so the
    caller can report it rather than silently mis-attributing picks)."""
    p = _norm(printed)
    for full in full_names:
        if _norm(full) == p:
            return full
    stem = _norm(TRUNCATED.sub("", printed))
    if not stem:
        return printed
    hits = [f for f in full_names if _norm(f).startswith(stem)]
    return hits[0] if len(hits) == 1 else printed


def draft_slots(picks: list[PastePick], full_names: list[str]) -> dict[str, int]:
    """Team -> draft slot, taken from ROUND 1 ONLY.

    Later rounds can't be trusted for order: traded picks make the board
    non-serpentine (the reference league has a team holding two picks in one
    round and none in another). Round 1 is the draft order as drawn.
    """
    out: dict[str, int] = {}
    for p in sorted((x for x in picks if x.round == 1), key=lambda x: x.pick):
        team = resolve_team_name(p.team, full_names)
        out.setdefault(team, p.pick)
    return out


def build_league(draft_text: str, rosters_text: str, *, league_name: str = "Yahoo League",
                 my_team: str | None = None, season: int = 0) -> tuple[NormLeague, dict]:
    """Combine both pastes into a NormLeague plus a report.

    Roster membership decides WHO is a keeper candidate (that's who you actually
    hold); the draft results decide WHAT they'd cost (the round they went in).
    A rostered player with no draft pick was added from waivers/FA during the
    season and carries no round — the league's undrafted-round rule applies,
    which is configured in the app, not guessed here.
    """
    teams = parse_rosters(rosters_text)
    picks = parse_draft_results(draft_text)
    full_names = [t.name for t in teams]

    # Draft round per player (a player traded mid-season keeps the round they
    # were drafted in — the pick record is about the player, not the owner).
    round_by_player: dict[str, int] = {}
    kept_by_player: dict[str, bool] = {}
    for p in picks:
        key = _norm(p.name)
        round_by_player.setdefault(key, p.round)
        if p.kept:
            kept_by_player[key] = True

    norm_teams: list[NormTeam] = []
    mine_key = _norm(my_team) if my_team else None
    for t in teams:
        players: list[NormPlayer] = []
        for spot in t.players:
            key = _norm(spot.name)
            players.append(NormPlayer(
                name=spot.name,
                pos=spot.pos,
                team="",                       # NFL team not present in this view
                round=round_by_player.get(key),
                keeper_ineligible=kept_by_player.get(key, False) or spot.kept,
            ))
        norm_teams.append(NormTeam(
            name=t.name,
            is_mine=bool(mine_key) and _norm(t.name) == mine_key,
            players=players,
        ))

    slots = draft_slots(picks, full_names)
    settings = make_settings(
        teams=len(norm_teams) or 10,
        ppr=0.5,                                # not visible on these pages
        roster={},                              # slot counts not reliably derivable
        fmt="snake",
        draft_slot=slots.get(my_team or "", None) if my_team else None,
    )

    lg = NormLeague(provider="yahoo-paste", ext_id="", name=league_name,
                    season=season, fmt="snake", settings=settings, teams=norm_teams)

    unmatched_teams = sorted({p.team for p in picks
                              if resolve_team_name(p.team, full_names) not in full_names})
    kept = sorted(
        {p.name for p in picks if p.kept}
        | {s.name for t in teams for s in t.players if s.kept}
    )
    undrafted = sorted({s.name for t in teams for s in t.players
                        if _norm(s.name) not in round_by_player})
    report = {
        "teams": len(norm_teams),
        "team_names": full_names,
        "picks": len(picks),
        "rounds": max((p.round for p in picks), default=0),
        "draft_slots": slots,
        "kept_detected": kept,
        "undrafted_on_roster": undrafted,
        "unresolved_draft_teams": unmatched_teams,
        "warnings": _warnings(norm_teams, picks, slots, kept, unmatched_teams),
    }
    lg.meta["paste"] = report
    return lg, report


def _warnings(norm_teams, picks, slots, kept, unmatched_teams) -> list[str]:
    """Surface anything the user should eyeball rather than trust blindly."""
    w: list[str] = []
    if kept:
        w.append(
            f"{len(kept)} player(s) detected as kept from a badge that copy-paste "
            "reduces to whitespace — confirm this list before committing.")
    if unmatched_teams:
        w.append("Draft-results team names that couldn't be matched to a roster: "
                 + ", ".join(unmatched_teams))
    if slots and len(slots) != len(norm_teams):
        w.append(f"Round 1 named {len(slots)} teams but {len(norm_teams)} rosters were "
                 "parsed — draft slots may be incomplete.")
    # Traded picks: a team appearing more than once in a round.
    by_round: dict[int, list[str]] = {}
    for p in picks:
        by_round.setdefault(p.round, []).append(_norm(p.team))
    traded = sorted({r for r, ts in by_round.items() if len(ts) != len(set(ts))})
    if traded:
        w.append(f"Round(s) {', '.join(map(str, traded))} contain duplicate teams "
                 "(traded picks) — draft slots were taken from round 1 only.")
    return w

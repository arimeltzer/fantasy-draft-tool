"""
integrations/fantasypros_aav_paste.py
======================================
Real auction dollar values, WITHOUT API access.

`fantasypros.py fetch_aav()` is a documented no-op — the public v2 API has no
auction-shaped endpoint at all (see its own docstring). FantasyPros DOES
publish an auction values cheat sheet on the website, though, and any user can
copy it out as text. Same shape of problem as `yahoo_paste.py`, same fix:
parse the pasted text instead of a payload that doesn't exist.

This matters more than a nice-to-have. `auction-engine.js marketPrice()`
already prefers real AAV over the modeled log curve when present — but the
modeled curve is what MOST of the board gets, because ADP itself only covers
roughly half of it in a typical season (see roadmap 3.5's finding: 36-62%
uncovered, 2017-2025). The cheat sheet has a row for essentially the whole
draftable pool, $0 included, so pasting it in replaces a modeled guess with a
real market number for players who currently get none at all.

FORMAT. One tab-separated row per player, exactly as FantasyPros's own page
renders when copied:

    1.\tJahmyr Gibbs (DET - RB)\t302\t$63
    156.\tHouston Texans (HOU - DST)\t120\t$2
    270.\tAustin Ekeler ( - RB)\t27\t$0
    288.\tTravis Hunter (JAC - WR,CB)\t70\t$0

Team is blank for a free agent, never absent as a field ("( - RB)"). A
multi-position player ("WR,CB") is filed under the FIRST position listed —
the app tracks one position per player, and FantasyPros orders by primary
role. An injury/practice tag (DTD, PUP, ...) sits glued to the closing paren
with no separating space or tab; stripped, not stored — this importer is
about PRICE, and `InjuryBadge` already owns status elsewhere.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .base import NormPlayer

# "12.\tName (TEAM - POS[,POS2])[TAG]\tPTS\t$VALUE"
# TEAM may be empty; POS may carry a comma-separated second position (kept
# whole here, split by the caller) trailing tag has no leading whitespace.
ROW = re.compile(
    r"""^\s*\d+\.\s*\t
        (?P<name>.+?)\s*
        \(\s*(?P<team>[A-Za-z]*)\s*-\s*(?P<pos>[A-Za-z,]+)\s*\)
        (?:[A-Za-z]+)?\s*\t
        \d+\s*\t
        \$(?P<aav>\d+(?:\.\d+)?)\s*$""",
    re.VERBOSE,
)

# FantasyPros' team defense rows spell out the franchise name, not an
# abbreviation. It doesn't need parsing out of the name — TEAM is already
# given directly in the parens for every row, DST included.
DEF_POS = {"DST", "DEF"}


@dataclass
class AavRow:
    name: str
    pos: str
    team: str
    aav: float
    raw_line: str


@dataclass
class AavPasteReport:
    rows: list[AavRow] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)   # lines that didn't parse


def parse_aav_sheet(text: str) -> AavPasteReport:
    """Pure, no network/DB — parse copied cheat-sheet text into AavRow rows.

    A line that doesn't match the expected shape is recorded in `skipped`
    rather than raising: a pasted sheet is long, and one malformed row (a
    stray header, a truncated copy) should not sink the other 300."""
    report = AavPasteReport()
    for line in text.splitlines():
        line = line.rstrip("\n")
        if not line.strip():
            continue
        m = ROW.match(line)
        if not m:
            report.skipped.append(line)
            continue
        pos = m.group("pos").split(",")[0].strip().upper()
        if pos == "DEF":
            pos = "DST"
        team = m.group("team").strip().upper()
        report.rows.append(AavRow(
            name=m.group("name").strip(),
            pos=pos,
            team=team,
            aav=float(m.group("aav")),
            raw_line=line,
        ))
    return report


def to_norm_players(report: AavPasteReport) -> list[NormPlayer]:
    """AavRow -> NormPlayer, so the existing `matching.py` index/matcher (the
    same one ESPN/Yahoo import already goes through) can be reused as-is
    rather than writing a second name-matching path."""
    return [NormPlayer(name=r.name, pos=r.pos, team=r.team) for r in report.rows]

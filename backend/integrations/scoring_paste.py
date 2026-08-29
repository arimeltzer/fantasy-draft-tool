"""
integrations/scoring_paste.py
==============================
Parses a fantasy platform's own Scoring settings page, pasted as plain text,
into this app's ScoringRules shape (frontend/src/lib/api.ts) — the SAME
"no reliable API access, so read what the page shows a human" pattern
already used for Yahoo draft results (yahoo_paste.py) and FantasyPros
auction values (fantasypros_aav_paste.py).

WHY THIS EXISTS. Yahoo's league-settings API labels each scoring rule only
by a numeric `stat_id` (see yahoo.py `raw_stat_modifiers()`) that this app
has never had a real payload to verify a category mapping against —
guessing wrong there would be a SILENT valuation bug, worse than not
mapping at all, so only receptions (stat_id 11, independently confirmed) is
auto-detected and everything else is left to League Settings -> Scoring.
Reported live: a user's Yahoo import only auto-mapped PPR, with "42 other
scoring rules... not auto-mapped." Yahoo's own Scoring settings PAGE, on
the other hand, labels every rule in plain English ("Passing Yards",
"Interceptions", ...) — there is nothing to guess there. This closes the
gap for every category this app's scoring model actually represents.

WHAT THIS APP CAN REPRESENT. `ScoringRules` (engine-core.js
`resolveScoring`) covers exactly 8 offensive stat categories, all
QB/RB/WR/TE: pass yards/TDs, interceptions, rush yards/TDs, rec yards/TDs,
fumbles lost — plus `ppr` (receptions) at the top level of LeagueSettings.
Kicker and Defense/Special Teams scoring (field goals by distance,
points-allowed brackets, sacks, etc.) are NOT modeled as stat categories
anywhere in this engine — K/DST valuation comes from historical fantasy-
point totals directly, not a reconstructed stat line — so those rows come
back as `unmapped` (visible, not silently dropped) rather than attempted.
Per-category BONUS brackets ("5 points at 360 yards") and 40+-yard-TD
bonuses are real Yahoo features this app's flat per-yard/per-TD model has
no way to express; the base rate is used and the bonus is called out in
`warnings` rather than silently ignored.

`parse_espn_scoring_page` below is the ESPN counterpart, built and verified
against a real captured ESPN Scoring page — same discipline, same scope
(the 8 `ScoringRules` fields; everything else surfaced as `unmapped`).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# Section headers on Yahoo's Scoring page. Only the OFFENSE section's rows
# are mapped to ScoringRules fields — Kickers/Defense have their own
# sections, and Defense's "Interception" (a defense picking a pass off)
# would otherwise collide in spirit with Offense's "Interceptions" (a QB
# throwing one) if matched by label alone. Gating by section is what keeps
# those apart.
_SECTION_HEADERS = {"offense": "offense", "kickers": "kickers",
                    "defense/special teams": "defense"}

# Header-row / badge tokens that carry no data of their own.
_SKIP_LINES = {"league value", "yahoo default value", "yahoo default"}

# label (lowercased) -> (ScoringRules field, "flat" | "rate"). "rate" values
# arrive as "N yards per point" and are stored as the per-YARD rate (1/N) —
# the unit resolveScoring()/points() already expect. "receptions" maps to
# `ppr` (LeagueSettings, not ScoringRules — resolveScoring() reads it from
# settings.ppr directly), handled specially by the caller.
_OFFENSE_FIELDS: dict[str, tuple[str, str]] = {
    "passing yards": ("ptsPerPassYd", "rate"),
    "passing touchdowns": ("ptsPerPassTD", "flat"),
    "interceptions": ("ptsPerInt", "flat"),
    "rushing yards": ("ptsPerRushYd", "rate"),
    "rushing touchdowns": ("ptsPerRushTD", "flat"),
    "receptions": ("ppr", "flat"),
    "receiving yards": ("ptsPerRecYd", "rate"),
    "receiving touchdowns": ("ptsPerRecTD", "flat"),
    "fumbles lost": ("ptsPerFumble", "flat"),
}

_RATE_RE = re.compile(r"([\d.]+)\s*yards?\s*per\s*point", re.IGNORECASE)
_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")


def _cols(line: str) -> list[str]:
    """Split a pasted row into columns. Yahoo's page copies as tab-separated;
    some paste paths collapse tabs into runs of spaces instead, so accept
    either."""
    parts = line.split("\t") if "\t" in line else re.split(r" {2,}", line)
    return [p.strip() for p in parts if p.strip() != ""]


def _parse_value(raw: str, kind: str) -> tuple[float | None, str | None]:
    """-> (parsed value, warning). `warning` flags a bonus clause the flat
    per-yard/per-TD model can't represent — the base rate is still used."""
    parts = raw.split(";")
    primary = parts[0].strip()
    warning = f"bonus clause ignored (not representable): {raw}" if len(parts) > 1 else None

    if kind == "rate":
        m = _RATE_RE.search(primary)
        if m:
            per = float(m.group(1))
            return (1.0 / per if per else None), warning
        m = _NUM_RE.search(primary)  # fallback: a bare number, already a per-yard rate
        return (float(m.group(0)) if m else None), warning

    m = _NUM_RE.search(primary)
    return (float(m.group(0)) if m else None), warning


@dataclass
class ScoringPasteReport:
    scoring: dict = field(default_factory=dict)          # ScoringRules-shaped partial
    ppr: float | None = None
    matched: list[dict] = field(default_factory=list)    # [{label, raw, field, value}]
    unmapped: list[dict] = field(default_factory=list)   # [{label, raw, section}] — visible, not applied
    warnings: list[str] = field(default_factory=list)


def parse_yahoo_scoring_page(text: str) -> ScoringPasteReport:
    """Parse Yahoo's League Settings -> Scoring page, pasted as plain text.

    Each category renders as its own block: a name line, an OPTIONAL
    "Yahoo Default" badge line (present only when the league's value differs
    from Yahoo's out-of-the-box default), then a row of the league's value
    and (only when it differs) Yahoo's default value. The name and the value
    row land on the same physical line when there's no badge — both shapes
    appear in a real captured page and are handled the same way here: once a
    known category name is found, the LEAGUE value is whatever non-empty
    column comes right after it, skipping a lone "Yahoo Default" marker line
    in between.
    """
    report = ScoringPasteReport()
    section: str | None = None
    lines = (text or "").splitlines()
    i = 0
    while i < len(lines):
        cols = _cols(lines[i])
        i += 1
        if not cols:
            continue
        first = cols[0].strip().lower()

        if first in _SECTION_HEADERS:
            section = _SECTION_HEADERS[first]
            continue
        if first in _SKIP_LINES:
            continue

        label = cols[0].strip()
        label_key = label.lower()

        value_cols = cols[1:]
        if not value_cols:
            # The label stood alone — the value is on a NEXT line, skipping a
            # lone "Yahoo Default" badge line in between.
            while i < len(lines):
                nxt = _cols(lines[i])
                i += 1
                if not nxt:
                    continue
                if len(nxt) == 1 and nxt[0].strip().lower() in _SKIP_LINES:
                    continue
                value_cols = nxt
                break

        if not value_cols:
            continue  # a label with nothing after it at all

        league_raw = value_cols[0]

        if section == "offense" and label_key in _OFFENSE_FIELDS:
            field_key, kind = _OFFENSE_FIELDS[label_key]
            value, warn = _parse_value(league_raw, kind)
            if value is None:
                report.unmapped.append({"label": label, "raw": league_raw, "section": section})
                continue
            if field_key == "ppr":
                report.ppr = value
            else:
                report.scoring[field_key] = value
            report.matched.append({"label": label, "raw": league_raw, "field": field_key, "value": value})
            if warn:
                report.warnings.append(f"{label}: {warn}")
        else:
            report.unmapped.append({"label": label, "raw": league_raw, "section": section or "unknown"})

    return report


# ── ESPN ─────────────────────────────────────────────────────────────────
#
# ESPN's Scoring Settings page renders each rule as ONE line:
#   "<label> (<CODE>)<value>"   e.g. "TD Pass (PTD)4", "Interceptions Thrown (INT)-2"
# with no space between the closing paren and the value. Per-yard categories
# are phrased "Every N <type> yards (<CODE>)<points>" — N points-per-yards
# lives IN the label text, not a separate "N yards per point" phrase the way
# Yahoo writes it, so the rate is parsed as points/N rather than 1/N.
# Section headers ("Passing", "Rushing", ...) are bare lines with no
# "(CODE)value" suffix at all.

# Only these sections carry offense stat categories this app models at all;
# Kicking and Team Defense / Special Teams are excluded outright (not just
# left unmatched) — ESPN repeats some labels/codes across sections (e.g. a
# defensive "Each Interception" alongside offense's "Interceptions Thrown"),
# and gating by section is what keeps a same-ish-sounding defensive stat
# from ever being a candidate for an offensive field, mirroring how the
# Yahoo parser above gates by its own Offense/Kickers/Defense sections.
_ESPN_SECTION_HEADERS = {
    "passing": "passing", "rushing": "rushing", "receiving": "receiving",
    "kicking": "kicking", "team defense / special teams": "defense",
    "miscellaneous": "misc",
}
_ESPN_OFFENSE_SECTIONS = {"passing", "rushing", "receiving", "misc"}

_ESPN_LINE_RE = re.compile(r"^(.*?)\s*\(([A-Za-z0-9]+)\)\s*(-?\d+(?:\.\d+)?)\s*$")

# Exact label (lowercased) -> ScoringRules field, for flat per-event values.
_ESPN_FLAT_LABELS = {
    "td pass": "ptsPerPassTD",
    "interceptions thrown": "ptsPerInt",
    "td rush": "ptsPerRushTD",
    "td reception": "ptsPerRecTD",
    "total fumbles lost": "ptsPerFumble",
}

# ScoringRules field -> regex pulling the yardage denominator out of an
# "Every N ... yards" label. The points value is the line's own trailing
# number, so the per-yard rate is (that number) / N.
_ESPN_RATE_LABEL_RE = {
    "ptsPerPassYd": re.compile(r"every\s+(\d+)\s+passing\s+yards", re.IGNORECASE),
    "ptsPerRushYd": re.compile(r"every\s+(\d+)\s+rushing\s+yards", re.IGNORECASE),
    "ptsPerRecYd": re.compile(r"every\s+(\d+)\s+receiving\s+yards", re.IGNORECASE),
}


def parse_espn_scoring_page(text: str) -> ScoringPasteReport:
    """Parse ESPN's League Settings -> Scoring Settings page, pasted as
    plain text. See the module docstring for scope; see the section header
    comments above for the exact line shapes this expects."""
    report = ScoringPasteReport()
    section: str | None = None

    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue

        header = _ESPN_SECTION_HEADERS.get(line.lower())
        if header:
            section = header
            continue

        m = _ESPN_LINE_RE.match(line)
        if not m:
            continue  # a page title or other non-data line ("Scoring") — not a stat row
        label, _code, value_raw = m.group(1).strip(), m.group(2), m.group(3)
        label_key = label.lower()
        points = float(value_raw)

        if section not in _ESPN_OFFENSE_SECTIONS:
            report.unmapped.append({"label": label, "raw": value_raw, "section": section or "unknown"})
            continue

        if label_key in _ESPN_FLAT_LABELS:
            field_key = _ESPN_FLAT_LABELS[label_key]
            report.scoring[field_key] = points
            report.matched.append({"label": label, "raw": value_raw, "field": field_key, "value": points})
            continue

        rate_field = next((f for f, rx in _ESPN_RATE_LABEL_RE.items() if rx.search(label)), None)
        if rate_field:
            n = float(_ESPN_RATE_LABEL_RE[rate_field].search(label).group(1))
            value = points / n if n else None
            if value is None:
                report.unmapped.append({"label": label, "raw": value_raw, "section": section})
                continue
            report.scoring[rate_field] = value
            report.matched.append({"label": label, "raw": value_raw, "field": rate_field, "value": value})
            continue

        report.unmapped.append({"label": label, "raw": value_raw, "section": section})

    return report

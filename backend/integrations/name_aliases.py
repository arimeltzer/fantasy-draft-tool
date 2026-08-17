"""
Given-name aliases — the Python half of `frontend/src/lib/playerName.ts`.

`data-pipeline/name_parity.py` asserts this table and the TypeScript one hold
exactly the same pairs, so adding an entry to one and not the other fails a
check rather than silently splitting a player across two rows.

WHY A TABLE AND NOT A RULE. A generic rule ("same surname, same first initial")
would fold every diminutive for free. It would also fold Michael Thomas (NO)
into Mike Thomas (LAR), who were contemporaries at the same position. A curated
table only ever merges names someone deliberately listed, and anything missing
stays a visible duplicate — which is recoverable, where a silent merge of two
players is not.

Deliberately EXCLUDED as too ambiguous to be safe: drew/andrew and nate/nathan
(both short forms are commonly the legal name), and the john/jon/jonathan
cluster (John is not a diminutive of Jonathan).

Folding is applied to the GIVEN name only. Surnames are identity.
"""
from __future__ import annotations

GIVEN_NAME_ALIASES: dict[str, str] = {
    # everyday diminutives
    "alex": "alexander", "andy": "andrew", "ben": "benjamin", "benny": "benjamin",
    "bill": "william", "billy": "william", "bob": "robert", "bobby": "robert",
    "brad": "bradley", "cam": "cameron", "charlie": "charles", "chris": "christopher",
    "chuck": "charles", "dan": "daniel", "danny": "daniel", "dave": "david",
    "dom": "dominic", "ed": "edward", "eddie": "edward", "fred": "frederick",
    "gabe": "gabriel", "greg": "gregory", "jake": "jacob", "jeff": "jeffrey",
    "jim": "james", "jimmy": "james", "joe": "joseph", "joey": "joseph",
    "josh": "joshua", "ken": "kenneth", "kenny": "kenneth", "matt": "matthew",
    "mike": "michael", "nick": "nicholas", "pat": "patrick", "ray": "raymond",
    "rich": "richard", "ricky": "richard", "rob": "robert", "ron": "ronald",
    "ronnie": "ronald", "sam": "samuel", "steve": "stephen", "steven": "stephen",
    "ted": "theodore", "tim": "timothy", "tom": "thomas", "tommy": "thomas",
    "tony": "anthony", "vic": "victor", "will": "william", "zach": "zachary",
    "zack": "zachary",
    # player-specific nicknames a feed may print instead of the legal name
    "chig": "chigoziem", "hollywood": "marquise", "tank": "nathaniel",
}


def alias_name(normalized: str) -> str:
    """Fold the given name of an ALREADY-normalized name string.

    Takes normalize_name() output, not a raw name, so the two callers cannot
    disagree about accents or punctuation before the fold happens.
    """
    parts = [p for p in (normalized or "").split(" ") if p]
    if len(parts) < 2:
        return " ".join(parts)      # single token: nothing to fold safely
    parts[0] = GIVEN_NAME_ALIASES.get(parts[0], parts[0])
    return " ".join(parts)


def same_team_or_unknown(a: str | None, b: str | None) -> bool:
    """True when two team codes do not positively contradict each other.

    Blank counts as agreement: a load that ran without roster data leaves the
    column empty, which is the commonest half of a split pair.
    """
    x = (a or "").upper()
    y = (b or "").upper()
    return not x or not y or x == y

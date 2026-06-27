"""
integrations/selftest.py
=======================
Fixture tests for the deterministic core of the league importers: player
matching and the ESPN/Yahoo settings+roster translation. These run without any
network or database (the live provider fetches must be validated against prod),
so they are the regression guard for the parsing/mapping logic.

Run:  python -m integrations.selftest   (from the backend/ dir)
"""
from __future__ import annotations

from .base import NormPlayer
from .matching import build_index, match_player
from . import espn, yahoo


def test_matching():
    rows = [
        {"id": 1, "name": "Patrick Mahomes", "pos": "QB", "team": "KC"},
        {"id": 2, "name": "A.J. Brown", "pos": "WR", "team": "PHI"},
        {"id": 3, "name": "Michael Pittman Jr.", "pos": "WR", "team": "IND"},
        {"id": 4, "name": "Kenneth Walker III", "pos": "RB", "team": "SEA"},
        {"id": 5, "name": "Marvin Harrison", "pos": "WR", "team": "ARI"},
        {"id": 6, "name": "Marvin Harrison", "pos": "WR", "team": "IND"},
        {"id": 7, "name": "49ers D/ST", "pos": "DST", "team": "SF"},
        {"id": 8, "name": "Justin Jefferson", "pos": "WR", "team": "MIN"},
    ]
    idx = build_index(rows)
    cases = [
        (NormPlayer("Patrick Mahomes", "QB", "KC"), 1),
        (NormPlayer("AJ Brown", "WR", "PHI"), 2),
        (NormPlayer("Michael Pittman", "WR", "IND"), 3),
        (NormPlayer("Kenneth Walker", "RB", "SEA"), 4),
        (NormPlayer("Marvin Harrison", "WR", "ARI"), 5),
        (NormPlayer("Marvin Harrison", "WR", "IND"), 6),
        (NormPlayer("Marvin Harrison", "WR", "ZZZ"), None),   # ambiguous, no team
        (NormPlayer("San Francisco 49ers", "DST", "SF"), 7),   # DST by team abbrev
        (NormPlayer("Niners D/ST", "DST", "SF"), 7),           # different name, same team -> ok
        (NormPlayer("San Francisco 49ers", "DST", "ZZZ"), None),  # wrong team -> no match
        (NormPlayer("Justin Jefferson", "RB", "MIN"), 8),      # wrong pos, unique name
        (NormPlayer("Nobody Here", "WR", "KC"), None),
    ]
    for np, exp in cases:
        got = match_player(idx, np)
        assert got == exp, f"match {np.name}/{np.pos}/{np.team}: got {got}, expected {exp}"


def test_espn():
    data = {
        "id": 123456,
        "settings": {
            "name": "Dynasty Warriors", "size": 12,
            "scoringSettings": {"scoringItems": [{"statId": 53, "points": 0.5}]},
            "draftSettings": {"type": "AUCTION", "auctionBudget": 300},
            "rosterSettings": {"lineupSlotCounts": {
                "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "7": 1, "17": 1, "16": 1, "20": 6, "21": 1}},
        },
        "teams": [
            {"id": 1, "name": "Team Ari", "roster": {"entries": [
                {"playerPoolEntry": {"player": {"id": 11, "fullName": "Patrick Mahomes", "defaultPositionId": 1, "proTeamId": 12}}},
            ]}},
            {"id": 2, "location": "Gridiron", "nickname": "Gurus", "roster": {"entries": [
                {"playerPoolEntry": {"player": {"id": 1, "fullName": "San Francisco 49ers", "defaultPositionId": 16, "proTeamId": 25}}},
            ]}},
        ],
        "draftDetail": {"picks": [{"teamId": 1, "playerId": 11, "bidAmount": 55}]},
    }
    lg = espn.parse_league(data, season=2026, my_team="Team Ari")
    assert lg.fmt == "auction" and lg.settings["budget"] == 300
    assert lg.settings["ppr"] == 0.5 and lg.settings["teams"] == 12
    assert lg.settings["superflex"] is True and lg.settings["roster"]["SF"] == 1
    assert lg.settings["roster"]["FLEX"] == 1 and lg.settings["roster"]["BENCH"] == 6
    assert lg.teams[0].is_mine and lg.teams[0].players[0].bid == 55
    assert lg.teams[1].players[0].pos == "DST" and lg.teams[1].players[0].team == "SF"

    # snake, no kicker, full PPR
    snake = {"id": 9, "settings": {"size": 10,
             "scoringSettings": {"scoringItems": [{"statId": 53, "points": 1.0}]},
             "draftSettings": {"type": "SNAKE"},
             "rosterSettings": {"lineupSlotCounts": {"0": 1, "2": 2, "4": 3, "6": 1, "23": 2, "20": 5}}},
             "teams": []}
    lg2 = espn.parse_league(snake, 2026)
    assert lg2.fmt == "snake" and lg2.settings["ppr"] == 1.0
    assert lg2.settings["roster"]["K"] == 0 and lg2.settings["roster"]["WR"] == 3 and lg2.settings["roster"]["FLEX"] == 2


def test_yahoo():
    league_node = [
        {"league_key": "nfl.l.123", "name": "Yahoo Ballers", "num_teams": 12},
        {"settings": [{
            "is_auction_draft": "1", "auction_budget": "260",
            "stat_modifiers": {"stats": [{"stat": {"stat_id": "11", "value": "0.5"}}]},
            "roster_positions": [
                {"roster_position": {"position": "QB", "count": 1}},
                {"roster_position": {"position": "RB", "count": 2}},
                {"roster_position": {"position": "WR", "count": 2}},
                {"roster_position": {"position": "TE", "count": 1}},
                {"roster_position": {"position": "W/R/T", "count": 1}},
                {"roster_position": {"position": "Q/W/R/T", "count": 1}},
                {"roster_position": {"position": "K", "count": 1}},
                {"roster_position": {"position": "DEF", "count": 1}},
                {"roster_position": {"position": "BN", "count": 5}},
                {"roster_position": {"position": "IR", "count": 2}},
            ]}]},
    ]
    settings, fmt, name = yahoo.parse_settings(league_node)
    assert fmt == "auction" and settings["budget"] == 260 and settings["ppr"] == 0.5
    assert settings["teams"] == 12 and settings["superflex"] is True
    assert settings["roster"]["FLEX"] == 1 and settings["roster"]["SF"] == 1 and settings["roster"]["BENCH"] == 5

    player_fields = [
        {"player_key": "nfl.p.5"}, {"player_id": "5"}, {"name": {"full": "A.J. Brown"}},
        {"editorial_team_abbr": "phi"}, {"display_position": "WR"}, {"primary_position": "WR"},
    ]
    players = {"count": 1, "0": {"player": [player_fields]}}
    roster_seg = {"roster": {"0": {"players": players}}}
    team_meta = [
        {"team_key": "nfl.l.123.t.1"}, {"team_id": "1"}, {"name": "Team Ari"},
        {"managers": {"0": {"manager": {"guid": "MEGUID"}}}},
    ]
    teams_node = {"count": 1, "0": {"team": [team_meta, roster_seg]}}
    teams = yahoo.parse_teams(teams_node, my_guid="MEGUID")
    assert teams[0].is_mine is True
    p = teams[0].players[0]
    assert p.name == "A.J. Brown" and p.pos == "WR" and p.team == "PHI"


def test_yahoo_leagues():
    data = {"fantasy_content": {"users": {"count": 1, "0": {"user": [
        {"guid": "MEGUID"},
        {"games": {"count": 2,
            "0": {"game": [{"game_key": "449", "code": "nfl", "season": "2025"},
                           {"leagues": {"count": 1, "0": {"league": [
                               {"league_key": "449.l.82486", "name": "Friends", "season": "2025", "num_teams": "12"}]}}}]},
            "1": {"game": [{"game_key": "423", "code": "nfl", "season": "2024"},
                           {"leagues": {"count": 1, "0": {"league": [
                               {"league_key": "423.l.82486", "name": "Friends", "season": "2024", "num_teams": "12"}]}}}]},
        }},
    ]}}}}
    leagues = yahoo.parse_my_leagues(data)
    assert len(leagues) == 2 and leagues[0]["season"] == 2025  # newest first
    assert leagues[0]["key"] == "449.l.82486" and leagues[1]["key"] == "423.l.82486"
    assert leagues[1]["num_teams"] == 12


def main():
    test_matching(); print("✓ matching")
    test_espn(); print("✓ espn parse")
    test_yahoo(); print("✓ yahoo parse")
    test_yahoo_leagues(); print("✓ yahoo leagues list")
    print("\nALL INTEGRATION SELFTESTS PASS")


if __name__ == "__main__":
    main()

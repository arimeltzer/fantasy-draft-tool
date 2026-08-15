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

import json

from .base import NormLeague, NormPlayer, NormTeam, opponent_team_ids
from .matching import build_index, match_player, keeper_candidates
from . import espn, live, yahoo, yahoo_paste


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
        "draftDetail": {"picks": [{"teamId": 1, "playerId": 11, "bidAmount": 55, "roundId": 3}]},
    }
    lg = espn.parse_league(data, season=2026, my_team="Team Ari")
    assert lg.fmt == "auction" and lg.settings["budget"] == 300
    assert lg.settings["ppr"] == 0.5 and lg.settings["teams"] == 12
    assert lg.settings["superflex"] is True and lg.settings["roster"]["SF"] == 1
    assert lg.settings["roster"]["FLEX"] == 1 and lg.settings["roster"]["BENCH"] == 6
    assert lg.teams[0].is_mine and lg.teams[0].players[0].bid == 55
    assert lg.teams[0].players[0].round == 3
    assert lg.teams[1].players[0].pos == "DST" and lg.teams[1].players[0].team == "SF"
    # DST was not in the draft -> no bid/round (a free-agent keeper).
    assert lg.teams[1].players[0].bid is None and lg.teams[1].players[0].round is None


def test_opponent_team_ids():
    """Real team names -> settings.opponents + a name->team_id lookup, so an
    imported opponent's picks attribute to the right label instead of an
    'Unassigned' bucket or generic 'Team N' placeholder."""
    teams = [
        NormTeam(name="Me", is_mine=True),
        NormTeam(name="The Gridiron Gurus", is_mine=False),
        NormTeam(name="Dynasty Warriors", is_mine=False),
    ]
    names, by_name = opponent_team_ids(teams)
    assert names == ["The Gridiron Gurus", "Dynasty Warriors"], names
    assert by_name == {"The Gridiron Gurus": 0, "Dynasty Warriors": 1}, by_name
    # "my" team never appears in opponents / gets no team_id.
    assert "Me" not in by_name

    # A name clash keeps the first team's index (stable, doesn't crash).
    clash = [NormTeam(name="Team A", is_mine=False), NormTeam(name="Team A", is_mine=False)]
    names2, by_name2 = opponent_team_ids(clash)
    assert names2 == ["Team A", "Team A"]
    assert by_name2 == {"Team A": 0}

    # No opponents (single-team fixture / everyone unnamed) -> empty, not an error.
    assert opponent_team_ids([NormTeam(name="Me", is_mine=True)]) == ([], {})


def test_scoring_diagnostics():
    """ESPN/Yahoo: only PPR is auto-mapped into valuations (statId/stat_id
    schemes for the rest are undocumented and not guessed — see the docstrings
    on raw_scoring_items/raw_stat_modifiers) but the FULL raw scoring rules are
    still surfaced, not silently dropped, so the import report can point at
    League Settings -> Scoring instead of pretending everything was detected."""
    espn_data = {
        "settings": {"scoringSettings": {"scoringItems": [
            {"statId": 53, "points": 0.5},                          # PPR (mapped)
            {"statId": 4, "points": 6, "isReverseItem": False},     # unmapped, still surfaced
            {"statId": 20, "points": -2, "isReverseItem": True},    # unmapped, still surfaced
        ]}}
    }
    raw = espn.raw_scoring_items(espn_data)
    assert len(raw) == 3
    assert {"statId": 53, "points": 0.5, "isReverseItem": None} in raw
    assert {"statId": 4, "points": 6, "isReverseItem": False} in raw

    yahoo_node = [
        {"name": "L"},
        {"settings": [{"stat_modifiers": {"stats": [
            {"stat": {"stat_id": "11", "value": "1"}},   # PPR (mapped)
            {"stat": {"stat_id": "2", "value": "6"}},    # unmapped, still surfaced
        ]}}]},
    ]
    raw_y = yahoo.raw_stat_modifiers(yahoo_node)
    assert raw_y == [{"stat_id": "11", "value": "1"}, {"stat_id": "2", "value": "6"}], raw_y


def test_keeper_candidates():
    # Current-season pool the keepers must map onto.
    idx = build_index([
        {"id": 11, "name": "Patrick Mahomes", "pos": "QB", "team": "KC"},
        {"id": 7, "name": "49ers D/ST", "pos": "DST", "team": "SF"},
    ])
    data = {
        "id": 123456,
        "settings": {"name": "L", "size": 12,
                     "scoringSettings": {"scoringItems": []},
                     "draftSettings": {"type": "AUCTION", "auctionBudget": 200},
                     "rosterSettings": {"lineupSlotCounts": {"0": 1, "20": 6}}},
        "teams": [
            {"id": 1, "name": "Team Ari", "roster": {"entries": [
                {"playerPoolEntry": {"player": {"id": 11, "fullName": "Patrick Mahomes", "defaultPositionId": 1, "proTeamId": 12}}},
            ]}},
            {"id": 2, "name": "Rivals", "roster": {"entries": [
                {"playerPoolEntry": {"player": {"id": 1, "fullName": "San Francisco 49ers", "defaultPositionId": 16, "proTeamId": 25}}},
            ]}},
        ],
        "draftDetail": {"picks": [{"teamId": 1, "playerId": 11, "bidAmount": 55, "roundId": 3}]},
        # ESPN football serves waiver claims through the ACTIVITY feed: topics ->
        # messages, messageTypeId 180, targetId=player, from=winning FAAB bid.
        "topics": [
            {"messages": [{"messageTypeId": 180, "targetId": 11, "to": 1, "from": 20}]},
            {"messages": [{"messageTypeId": 180, "targetId": 11, "to": 1, "from": 35}]},
            {"messages": [{"messageTypeId": 180, "targetId": 1, "to": 2, "from": 12}]},
            # Ignored: a plain FA add (178, no bid) and a $0 priority claim.
            {"messages": [{"messageTypeId": 178, "targetId": 11, "to": 1, "from": 99}]},
            {"messages": [{"messageTypeId": 180, "targetId": 1, "to": 2, "from": 0}]},
        ],
    }
    norm = espn.parse_league(data, season=2026, my_team="Team Ari")
    cands = keeper_candidates(norm, idx)
    assert len(cands) == 2
    me = next(c for c in cands if c["name"] == "Patrick Mahomes")
    assert me["player_id"] == 11 and me["owner"] == "Me" and me["is_mine"]
    assert me["bid"] == 55 and me["round"] == 3 and me["matched"]
    assert me["waiver"] == 35, f"Mahomes waiver should be max($20,$35)=35, got {me['waiver']}"
    fa = next(c for c in cands if c["pos"] == "DST")
    assert fa["player_id"] == 7 and fa["owner"] == "Rivals" and not fa["is_mine"]
    assert fa["bid"] is None and fa["round"] is None  # undrafted -> FA basis
    assert fa["waiver"] == 12, f"49ers waiver should be $12 (the $0 claim ignored), got {fa['waiver']}"

    # The legacy `transactions` array shape still parses, and both sources merge
    # to the highest bid per player.
    legacy = {"transactions": [
        {"status": "EXECUTED", "bidAmount": 44, "items": [{"type": "ADD", "playerId": 11}]},
        {"status": "CANCELED", "bidAmount": 99, "items": [{"type": "ADD", "playerId": 11}]},
        {"status": "EXECUTED", "bidAmount": 60, "items": [{"type": "DROP", "playerId": 11}]},
    ]}
    assert espn.all_waivers(legacy) == {11: 44}, espn.all_waivers(legacy)
    both = {**legacy, "topics": [{"messages": [{"messageTypeId": 180, "targetId": 11, "from": 50}]}]}
    assert espn.all_waivers(both) == {11: 50}, "merge should keep the higher bid"

    # The activity view is only valid on the league's /communication/ sub-resource;
    # on the base league URL ESPN 400s regardless of filter.
    for url in (espn.activity_url("1", 2025), espn.activity_url("1", 2025, history=True)):
        assert "/communication/" in url, f"activity URL missing /communication/: {url}"
        assert espn.ACTIVITY_VIEW in url, url
    # ESPN 400s this feed above 25 per page.
    assert espn.ACTIVITY_PAGE <= 25, "activity feed limit must stay <= 25"
    # Waiver history is scoped to a scoringPeriodId (week) and filtered on
    # WAIVER + WAIVER_ERROR — omit either and ESPN returns no transactions.
    u = espn.site_transactions_url("1", 2025, scoring_period=15)
    assert "scoringPeriodId=15" in u, u
    assert "view=mTransactions2" in u, u
    assert json.loads(espn.WAIVER_TXN_FILTER)["transactions"]["filterType"]["value"] == \
        ["WAIVER", "WAIVER_ERROR"], espn.WAIVER_TXN_FILTER
    # ESPN rejects `limit` without a sort (FILTER_LIMIT_MISSING_SORT), so every
    # filter variant must carry one — both on /communication/ and the base URL.
    for name, filt in espn.activity_filters(25, 0) + espn.base_activity_filters(25, 0):
        assert "sortMessageDate" in filt, f"{name} filter is missing a sort"
    # Base-league filters nest under `communication` (CommunicationGroupFilterParams).
    for name, filt in espn.base_activity_filters(25, 0):
        assert list(json.loads(filt).keys()) == ["communication"], name
        assert "topics" in json.loads(filt)["communication"], name
    # Both response shapes yield waivers.
    assert espn.all_waivers({"topics": [{"messages": [
        {"messageTypeId": 180, "targetId": 9, "from": 12}]}]}) == {9: 12}
    assert espn.all_waivers({"communication": {"topics": [{"messages": [
        {"messageTypeId": 180, "targetId": 7, "from": 33}]}]}}) == {7: 33}

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


def test_yahoo_keeper():
    """Yahoo OAuth keeper inputs: draft results, FAAB claims, keeper flags.

    Yahoo identifies a player by `player_key` in draft results and transactions
    but by `player_id` on rosters, so the fixture mixes both forms deliberately.
    """
    # ── draft results ────────────────────────────────────────────────
    draft_json = {"fantasy_content": {"league": [
        {"league_key": "449.l.82486"},
        {"draft_results": {"count": 3,
            "0": {"draft_result": {"pick": 1, "round": 1, "team_key": "449.l.82486.t.4",
                                   "player_key": "449.p.31883", "cost": "42"}},
            "1": {"draft_result": {"pick": 2, "round": 1, "team_key": "449.l.82486.t.1",
                                   "player_key": "449.p.30977"}},
            # a pick Yahoo returns with no player (forfeited/blank) must not crash
            "2": {"draft_result": {"pick": 3, "round": 1, "team_key": "449.l.82486.t.2"}},
        }},
    ]}}
    draft = yahoo.parse_draft_results(draft_json)
    assert set(draft) == {"31883", "30977"}, draft
    assert draft["31883"]["cost"] == 42 and draft["31883"]["round"] == 1
    assert draft["30977"]["cost"] is None, "snake pick carries a round, not a price"
    assert draft["30977"]["round"] == 1 and draft["30977"]["pick"] == 2

    # ── waiver / FAAB claims ─────────────────────────────────────────
    def add_txn(bid, pkey, status="successful", ptype="add"):
        return {"transaction": [
            {"transaction_key": f"449.l.1.tr.{bid}", "type": "add/drop",
             "status": status, "faab_bid": bid},
            {"players": {"count": 1, "0": {"player": [
                [{"player_key": pkey}, {"name": {"full": "X"}}],
                {"transaction_data": [{"type": ptype, "source_type": "waivers"}]},
            ]}}},
        ]}
    txn_json = {"fantasy_content": {"league": [
        {"league_key": "449.l.82486"},
        {"transactions": {"count": 5,
            "0": add_txn(17, "449.p.40000"),
            "1": add_txn(31, "449.p.40000"),            # same player, higher bid
            "2": add_txn(9, "449.p.41111"),
            "3": add_txn(99, "449.p.42222", status="failed"),   # lost claim
            "4": add_txn(50, "449.p.43333", ptype="drop"),      # the drop side
        }},
    ]}}
    waivers = yahoo.parse_transactions(txn_json)
    assert waivers["40000"] == 31, "only the top winning bid counts"
    assert waivers["41111"] == 9
    assert "42222" not in waivers, "a failed claim was never paid"
    assert "43333" not in waivers, "the dropped player wasn't bid on"

    # ── rosters + keeper flags, and folding it all together ──────────
    def player(pid, name, keeper=None):
        fields = [{"player_key": f"449.p.{pid}"}, {"player_id": pid},
                  {"name": {"full": name}}, {"editorial_team_abbr": "phi"},
                  {"display_position": "WR"}]
        if keeper is not None:
            fields.append({"is_keeper": keeper})
        return {"player": [fields]}

    teams_node = {"count": 2,
        "0": {"team": [
            [{"team_key": "449.l.82486.t.1"}, {"name": "Team Ari"},
             {"managers": {"0": {"manager": {"guid": "MEGUID"}}}}],
            {"roster": {"0": {"players": {"count": 2,
                "0": player("31883", "A.J. Brown", {"status": "1", "cost": "42", "kept": "1"}),
                "1": player("40000", "Waiver Guy"),
            }}}},
        ]},
        "1": {"team": [
            [{"team_key": "449.l.82486.t.4"}, {"name": "Rivals"}],
            {"roster": {"0": {"players": {"count": 1,
                "0": player("30977", "Snake Pick"),
            }}}},
        ]},
    }

    assert yahoo.team_names_by_key(teams_node) == {
        "449.l.82486.t.1": "Team Ari", "449.l.82486.t.4": "Rivals"}

    flags = yahoo.parse_keeper_flags(teams_node)
    assert flags["31883"]["kept"] is True and flags["31883"]["cost"] == 42
    assert "40000" not in flags, "no is_keeper block means no flag, not a false one"

    teams = yahoo.parse_teams(teams_node, my_guid="MEGUID")
    kept = yahoo.attach_keeper_inputs(teams, teams_node, draft, waivers, flags)
    assert kept == ["A.J. Brown"], kept
    mine = {p.name: p for p in teams[0].players}
    assert teams[0].is_mine is True and teams[1].is_mine is False
    assert mine["A.J. Brown"].bid == 42 and mine["A.J. Brown"].keeper_ineligible is True
    # Drafted AND claimed off waivers: both are carried, the keeper RULE picks.
    assert mine["Waiver Guy"].bid is None and mine["Waiver Guy"].waiver == 31
    assert mine["Waiver Guy"].round is None, "undrafted -> the undrafted-round rule applies"
    assert teams[1].players[0].round == 1 and teams[1].players[0].bid is None

    # Candidates come out in the shape the planner already consumes from ESPN.
    index = build_index([{"id": 7, "name": "A.J. Brown", "pos": "WR", "team": "PHI"}])
    lg = NormLeague(provider="yahoo", ext_id="449.l.82486", name="L", season=2025,
                    fmt="auction", settings={}, teams=teams)
    cands = {c["name"]: c for c in keeper_candidates(lg, index)}
    assert cands["A.J. Brown"]["owner"] == "Me" and cands["A.J. Brown"]["is_mine"] is True
    assert cands["A.J. Brown"]["bid"] == 42 and cands["A.J. Brown"]["matched"] is True
    assert cands["A.J. Brown"]["keeper_ineligible"] is True
    assert cands["Snake Pick"]["owner"] == "Rivals" and cands["Snake Pick"]["round"] == 1
    assert cands["Waiver Guy"]["waiver"] == 31 and cands["Waiver Guy"]["matched"] is False

    # Missing/absent transactions must degrade to draft-only, never explode.
    assert yahoo.parse_transactions({}) == {}
    assert yahoo.parse_draft_results({}) == {}
    assert yahoo.parse_keeper_flags({}) == {}


def test_live_draft():
    """Live sync joins the DRAFT endpoint (order/owner/price) to the ROSTER
    endpoint (names) on both platforms, because neither alone identifies who
    was taken. Mid-draft the two views disagree briefly — a pick whose player
    hasn't hit a roster yet must be skipped, not logged as an unknown."""

    # ── ESPN ─────────────────────────────────────────────────────────
    espn_data = {
        "id": 42,
        "settings": {"name": "L", "size": 2,
                     "scoringSettings": {"scoringItems": []},
                     "draftSettings": {"type": "SNAKE"},
                     "rosterSettings": {"lineupSlotCounts": {"0": 1, "20": 2}}},
        "teams": [
            {"id": 1, "name": "Team Ari", "roster": {"entries": [
                {"playerPoolEntry": {"player": {"id": 11, "fullName": "Patrick Mahomes",
                                                "defaultPositionId": 1, "proTeamId": 12}}},
            ]}},
            {"id": 2, "name": "Rivals", "roster": {"entries": [
                {"playerPoolEntry": {"player": {"id": 22, "fullName": "A.J. Brown",
                                                "defaultPositionId": 3, "proTeamId": 21}}},
            ]}},
        ],
        "draftDetail": {"inProgress": True, "picks": [
            {"playerId": 22, "teamId": 2, "roundId": 1, "roundPickNumber": 1, "overallPickNumber": 1},
            {"playerId": 11, "teamId": 1, "roundId": 1, "roundPickNumber": 2, "overallPickNumber": 2},
            # just taken — not on a roster in this payload yet
            {"playerId": 99, "teamId": 2, "roundId": 2, "roundPickNumber": 1, "overallPickNumber": 3},
        ]},
    }
    st = espn.parse_live_draft(espn_data, my_team="Team Ari")
    assert [p.overall for p in st.picks] == [1, 2], "ordered, and the unresolved pick is skipped"
    assert st.picks[0].name == "A.J. Brown" and st.picks[0].owner == "Rivals"
    assert st.picks[0].is_mine is False
    assert st.picks[1].name == "Patrick Mahomes" and st.picks[1].is_mine is True
    assert st.fmt == "snake" and st.meta["in_progress"] is True
    assert st.meta["drafted"] == 3 and st.meta["resolved"] == 2
    # Two contiguous picks are in, so pick 3 is on the clock.
    assert st.complete_through == 2

    # overallPickNumber missing -> derived from round + pick and league size
    derived = espn.parse_live_draft({**espn_data, "draftDetail": {"picks": [
        {"playerId": 11, "teamId": 1, "roundId": 2, "roundPickNumber": 2},
    ]}})
    assert derived.picks[0].overall == 4, derived.picks[0].overall   # (2-1)*2 + 2

    # An auction draft carries the price through.
    auc = espn.parse_live_draft({**espn_data, "draftDetail": {"picks": [
        {"playerId": 11, "teamId": 1, "overallPickNumber": 1, "bidAmount": 55},
    ]}})
    assert auc.fmt == "auction" and auc.picks[0].bid == 55

    # ── Yahoo ────────────────────────────────────────────────────────
    def yplayer(pid, name, pos="WR"):
        return {"player": [[{"player_key": f"449.p.{pid}"}, {"player_id": pid},
                            {"name": {"full": name}}, {"editorial_team_abbr": "phi"},
                            {"display_position": pos}]]}
    teams_json = {"fantasy_content": {"league": [
        {"league_key": "449.l.1"},
        {"teams": {"count": 2,
            "0": {"team": [
                [{"team_key": "449.l.1.t.1"}, {"name": "Team Ari"},
                 {"managers": {"0": {"manager": {"guid": "MEGUID"}}}}],
                {"roster": {"0": {"players": {"count": 1, "0": yplayer("11", "Bijan Robinson", "RB")}}}},
            ]},
            "1": {"team": [
                [{"team_key": "449.l.1.t.2"}, {"name": "Rivals"}],
                {"roster": {"0": {"players": {"count": 1, "0": yplayer("22", "A.J. Brown")}}}},
            ]},
        }},
    ]}}
    draft_json = {"fantasy_content": {"league": [
        {"league_key": "449.l.1"},
        {"draft_results": {"count": 3,
            "0": {"draft_result": {"pick": 1, "round": 1, "team_key": "449.l.1.t.2",
                                   "player_key": "449.p.22"}},
            "1": {"draft_result": {"pick": 2, "round": 1, "team_key": "449.l.1.t.1",
                                   "player_key": "449.p.11"}},
            # drafted but not yet on a roster in this snapshot
            "2": {"draft_result": {"pick": 3, "round": 2, "team_key": "449.l.1.t.1",
                                   "player_key": "449.p.99"}},
        }},
    ]}}
    ys = yahoo.parse_live_draft(draft_json, teams_json, my_guid="MEGUID")
    assert [p.overall for p in ys.picks] == [1, 2], [p.overall for p in ys.picks]
    assert ys.picks[0].name == "A.J. Brown" and ys.picks[0].owner == "Rivals"
    assert ys.picks[1].name == "Bijan Robinson" and ys.picks[1].pos == "RB"
    assert ys.picks[1].owner == "Team Ari" and ys.picks[1].is_mine is True
    assert ys.meta == {"drafted": 3, "resolved": 2}, ys.meta
    assert ys.complete_through == 2

    # Empty board before the draft starts: valid, just nothing to log.
    empty = yahoo.parse_live_draft({}, teams_json, my_guid="MEGUID")
    assert empty.picks == [] and empty.complete_through == 0
    assert espn.parse_live_draft({}).picks == []

    # A gap (platform published 1 and 3 but not 2) must not claim 3 is done.
    gapped = live.LiveDraftState(picks=[live.LivePick(overall=1, name="A"),
                                        live.LivePick(overall=3, name="C")])
    assert gapped.complete_through == 1


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
    test_opponent_team_ids(); print("✓ opponent team ids")
    test_scoring_diagnostics(); print("✓ scoring diagnostics")
    test_keeper_candidates(); print("✓ keeper candidates")
    test_yahoo(); print("✓ yahoo parse")
    test_yahoo_keeper(); print("✓ yahoo keeper inputs")
    test_live_draft(); print("✓ live draft sync")
    test_yahoo_leagues(); print("✓ yahoo leagues list")
    test_waiver_weekly_fetch(); print("✓ waiver weekly fetch")
    test_yahoo_paste(); print("✓ yahoo paste import")
    print("\nALL INTEGRATION SELFTESTS PASS")




def test_waiver_weekly_fetch():
    """fetch_league must sweep scoring periods and take the highest EXECUTED
    FAAB bid per player (ESPN returns transactions only per-week)."""
    import asyncio
    import types
    import urllib.parse as up

    league = {"id": 1, "settings": {"name": "L", "size": 12,
              "scoringSettings": {"scoringItems": []},
              "draftSettings": {"type": "AUCTION", "auctionBudget": 200},
              "rosterSettings": {"lineupSlotCounts": {"0": 1, "20": 6}}},
              "teams": [{"id": 1, "name": "T", "roster": {"entries": [
                  {"playerPoolEntry": {"player": {"id": 11, "fullName": "P M",
                                                  "defaultPositionId": 1, "proTeamId": 12}}}]}}],
              "draftDetail": {"picks": [{"teamId": 1, "playerId": 11, "bidAmount": 15, "roundId": 3}]}}

    class Resp:
        def __init__(self, code, payload): self.status_code, self._p = code, payload
        def json(self): return self._p
        def raise_for_status(self): pass

    class Fake:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, headers=None):
            q = up.parse_qs(up.urlparse(url).query)
            if "mTransactions2" not in q.get("view", []):
                return Resp(200, dict(league))
            sp = q.get("scoringPeriodId", [None])[0]
            if sp is None:
                return Resp(200, dict(league))
            if int(sp) == 5:
                return Resp(200, {**league, "transactions": [
                    {"id": "a", "status": "EXECUTED", "bidAmount": 30,
                     "items": [{"type": "ADD", "playerId": 11}]}]})
            if int(sp) == 9:
                return Resp(200, {**league, "transactions": [
                    {"id": "b", "status": "EXECUTED", "bidAmount": 44,
                     "items": [{"type": "ADD", "playerId": 11}]},
                    {"id": "c", "status": "CANCELED", "bidAmount": 99,
                     "items": [{"type": "ADD", "playerId": 11}]}]})
            return Resp(200, {**league, "transactions": []})

    real = espn.httpx
    try:
        espn.httpx = types.SimpleNamespace(AsyncClient=lambda **kw: Fake())
        lg = asyncio.run(espn.fetch_league("1", 2025, my_team="T"))
    finally:
        espn.httpx = real
    p = lg.teams[0].players[0]
    assert p.bid == 15 and p.waiver == 44, (p.bid, p.waiver)   # highest executed bid
    assert lg.meta["transactions"]["waiver_players"] == 1



def test_yahoo_paste():
    """Yahoo import with NO API access: parse the Draft Results + Starting
    Rosters pages a league member can copy out of the web UI.

    Fixture mirrors the structure of a real 10-team snake league export,
    including the details that actually broke first drafts of the parser.
    """
    # Keeper badges survive copy-paste as a trailing space (draft) / blank line
    # (rosters). Built with explicit \t and trailing spaces so the fixture can't
    # be silently "cleaned" by an editor.
    draft = "\n".join([
        "Round 1",
        "1.\tCeeDee Lamb\tMcLaurin Order",
        "2.\tJahmyr Gibbs\tBecoming BEA...",          # truncated team name
        "3.\tJustin Jefferson\tLet’s Play...",   # truncated + curly apostrophe
        "Round 2",
        "1.\tJustin Fields\tLet’s Play...",
        "2.\tTrey McBride \tBecoming BEA...",         # trailing space = keeper badge
        "3.\tJosh Jacobs\tMcLaurin Order",
        "Round 3",
        "1.\tSaquon Barkley \tMcLaurin Order",        # keeper badge
        "2.\tBo Nix\tBecoming BEA...",
        "3.\tBo Nix Jr.\tBecoming BEA...",            # same round twice => traded pick
    ])
    rosters = "\n".join([
        "Starting Rosters", "Team", " ", "Week 17", " ",
        "Becoming BEARable ", "", "Pos\tPlayer",
        "QB\t", "Jahmyr Gibbs", "Jahmyr GibbsVideo Forecast", "Final W 20-17 vs TB",
        "TE\t", "Trey McBride", "Trey McBrideVideo Forecast", "", "Final L 14-37 @ Cin",
        "DEF\t", "Saints", "Saints", "- DEF", "Final W 34-26 @ Ten",
        # last player on this team: must NOT inherit the blank line that
        # precedes the next team's header (regression guard)
        "IR\t", "Bo Nix", "Bo NixVideo Forecast", "Final W 20-13 @ KC",
        "McLaurin Order ", "", "Pos\tPlayer",
        "RB\t", "Saquon Barkley", "Saquon BarkleyVideo Forecast", "", "Final W 13-12 @ Buf",
        "WR\t", "CeeDee Lamb", "CeeDee LambVideo Forecast", "Final W 30-23 @ Was",
        "Let’s Play Golf! ", "", "Pos\tPlayer",
        "QB\t", "Justin Jefferson", "Justin JeffersonVideo Forecast", "Final W 23-10 vs Det",
        "BN\t", "Rhamondre Stevenson", "Rhamondre StevensonVideo Forecast", "Final W 42-10 @ NYJ",
    ])

    # ── draft results ────────────────────────────────────────────────
    picks = yahoo_paste.parse_draft_results(draft)
    assert len(picks) == 9, len(picks)
    kept = {p.name for p in picks if p.kept}
    assert kept == {"Trey McBride", "Saquon Barkley"}, kept
    # the badge must not leak into the stored name
    assert all(p.name == p.name.strip() for p in picks)

    # ── rosters ──────────────────────────────────────────────────────
    teams = yahoo_paste.parse_rosters(rosters)
    assert [t.name for t in teams] == ["Becoming BEARable", "McLaurin Order", "Let's Play Golf!"], \
        [t.name for t in teams]
    bear = teams[0]
    assert [s.name for s in bear.players] == ["Jahmyr Gibbs", "Trey McBride", "Saints", "Bo Nix"]
    assert bear.players[1].kept is True                    # blank-line badge
    # Regression: the LAST player of a team sits right before the next team's
    # header; an earlier version flagged every one of them as kept.
    assert bear.players[3].kept is False, "last player of a team must not be flagged kept"
    assert teams[1].players[0].kept is True                # Saquon, badge
    assert teams[1].players[1].kept is False
    # slot -> position mapping (DEF -> DST; BN/IR carry no position)
    assert bear.players[2].pos == "DST"
    assert bear.players[3].pos == ""

    # ── truncated team-name resolution ───────────────────────────────
    full = [t.name for t in teams]
    assert yahoo_paste.resolve_team_name("Becoming BEA...", full) == "Becoming BEARable"
    assert yahoo_paste.resolve_team_name("Let’s Play...", full) == "Let's Play Golf!"
    assert yahoo_paste.resolve_team_name("McLaurin Order", full) == "McLaurin Order"
    # ambiguous stem returns the input unchanged so the caller can report it
    assert yahoo_paste.resolve_team_name("X...", full) == "X..."

    # ── draft slots come from ROUND 1 ONLY (trades break serpentine) ──
    slots = yahoo_paste.draft_slots(picks, full)
    assert slots == {"McLaurin Order": 1, "Becoming BEARable": 2, "Let's Play Golf!": 3}, slots

    # ── combined league ──────────────────────────────────────────────
    lg, rep = yahoo_paste.build_league(draft, rosters, my_team="Becoming BEARable")
    assert lg.provider == "yahoo-paste" and lg.fmt == "snake"
    assert [t.is_mine for t in lg.teams] == [True, False, False]
    assert lg.settings["draftSlot"] == 2
    by_name = {p.name: p for t in lg.teams for p in t.players}
    # draft round carries the keeper cost basis; badge marks ineligibility
    assert by_name["Trey McBride"].round == 2 and by_name["Trey McBride"].keeper_ineligible
    assert by_name["Saquon Barkley"].round == 3 and by_name["Saquon Barkley"].keeper_ineligible
    assert by_name["Jahmyr Gibbs"].round == 1 and not by_name["Jahmyr Gibbs"].keeper_ineligible
    # rostered but never drafted => waiver/FA pickup, no round
    assert by_name["Saints"].round is None
    assert "Rhamondre Stevenson" in rep["undrafted_on_roster"]
    # traded picks are reported, not silently trusted for ordering
    assert any("traded picks" in w for w in rep["warnings"]), rep["warnings"]
    assert any("confirm this list" in w for w in rep["warnings"]), rep["warnings"]

    # ── what /api/leagues/import-yahoo-paste persists ────────────────
    # The paste knows every team's identity AND slot; the route writes both
    # (settings.opponents + settings.teamSlots), so opponent keeper predictions
    # start from the real draft order instead of a mid-round guess.
    names, by_name = opponent_team_ids(lg.teams)
    assert names == ["McLaurin Order", "Let's Play Golf!"], names   # mine excluded
    assert by_name["McLaurin Order"] == 0
    assert set(rep["draft_slots"]) == set(rep["team_names"]), "every team needs a slot"
    # Without my_team every team is an opponent — the paste can't tell which is
    # yours, so nothing is silently guessed.
    lg2, _ = yahoo_paste.build_league(draft, rosters)
    assert opponent_team_ids(lg2.teams)[0] == rep["team_names"]
    assert lg2.settings["draftSlot"] == 1

if __name__ == "__main__":
    main()

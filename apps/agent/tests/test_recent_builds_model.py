"""Each player's recent builds: parsing the server's lists and the copy drawn from them."""
from datetime import datetime, timezone

import pytest

from sc2tools_agent.build_checkin.scouting import (
    RecentBuild, RecentBuilds, age_text, parse_recent_builds, parse_scouting_brief,
    recent_build_columns, recent_games_label, scouting_model,
)

NOW = datetime(2026, 11, 9, 12, tzinfo=timezone.utc).timestamp()
DAY = 86_400
DOT = " \N{MIDDLE DOT} "


def row(index, **overrides):
    return {"gameId": f"game-{index}", "result": "Loss" if index % 2 else "Win", "map": f"Map {index}",
            "build": f"Build {index}", "date": datetime.fromtimestamp(NOW - index * DAY, timezone.utc).isoformat(),
            **overrides}


def lists(mine=5, theirs=5, matchup="PvZ"):
    return {"matchup": matchup, "mine": [row(index) for index in range(mine)],
            "theirs": [row(index, race="Zerg") for index in range(theirs)]}


def columns(mine=5, theirs=5, **kwargs):
    return recent_build_columns(parse_recent_builds(lists(mine, theirs, **kwargs)), NOW, "Zerg")


@pytest.mark.parametrize("payload", [None, [], "PvZ", 5, True])
def test_a_payload_without_the_lists_is_an_older_server_not_two_empty_lists(payload):
    assert parse_recent_builds(payload) is None


def test_two_empty_lists_are_an_answer():
    assert parse_recent_builds({"matchup": "PvZ", "mine": [], "theirs": []}) == RecentBuilds(matchup="PvZ")
    assert parse_recent_builds({}) == RecentBuilds()


def test_rows_keep_the_server_order_and_every_field():
    builds = parse_recent_builds(lists(2, 1))
    assert builds.matchup == "PvZ"
    assert builds.mine == (
        RecentBuild("Build 0", "Win", "Map 0", NOW, "game-0", ""),
        RecentBuild("Build 1", "Loss", "Map 1", NOW - DAY, "game-1", ""),
    )
    assert builds.theirs == (RecentBuild("Build 0", "Win", "Map 0", NOW, "game-0", "Zerg"),)


def test_five_games_at_most_are_kept_on_each_side():
    builds = parse_recent_builds(lists(9, 7))
    assert [game.game_id for game in builds.mine] == [f"game-{index}" for index in range(5)]
    assert len(builds.theirs) == 5


@pytest.mark.parametrize("bad", [None, [], 7, True, float("nan")])
def test_malformed_fields_cannot_crash_or_invent_a_detail(bad):
    game = row(0, result=bad, map=bad, build=bad, date=bad, gameId=bad, race=bad)
    builds = parse_recent_builds({"matchup": bad, "theirs": bad, "mine": [bad, "not a game", game]})
    assert builds.matchup == "" and builds.theirs == ()
    assert builds.mine == (RecentBuild(),)


def test_text_is_bounded_and_identifiers_are_trimmed():
    game = parse_recent_builds({"mine": [row(0, build="x" * 500, map="y" * 500, gameId="  spaced-id  ", result="Victory", race="zerg")]}).mine[0]
    assert (len(game.build), len(game.map_name), game.game_id, game.result, game.race) == (160, 120, "spaced-id", "", "Zerg")
    assert parse_recent_builds({"matchup": "Protoss v Zerg"}).matchup == ""


@pytest.mark.parametrize("count,label", [(5, "Last 5 games"), (9, "Last 5 games"), (4, "4 earlier games"),
                                         (2, "2 earlier games"), (1, "1 earlier game")])
def test_fewer_than_five_games_are_counted_outright(count, label):
    assert recent_games_label(count) == label


@pytest.mark.parametrize("seconds,text", [(0, "today"), (DAY - 1, "today"), (DAY, "yesterday"),
                                         (2 * DAY, "2 days ago"), (40 * DAY, "40 days ago"), (-3 * DAY, "today")])
def test_a_game_age_is_whole_days_and_never_in_the_future(seconds, text):
    assert age_text(NOW - seconds, NOW) == text


def test_five_games_on_each_side_are_headed_as_the_last_five():
    both = columns(5, 5)
    assert both["my"].heading == "YOU" + DOT + "PvZ" + DOT + "LAST 5 GAMES"
    assert both["opp"].heading == "OPPONENT" + DOT + "LAST 5 GAMES VS YOU"
    assert both["my"].empty_text == both["opp"].empty_text == ""
    assert [game.game_id for game in both["opp"].rows] == [f"game-{index}" for index in range(5)]


def test_fewer_than_five_games_say_how_many_there_are():
    both = columns(2, 1)
    assert both["my"].heading == "YOU" + DOT + "PvZ" + DOT + "2 EARLIER GAMES"
    assert both["opp"].heading == "OPPONENT" + DOT + "1 EARLIER GAME VS YOU"
    assert len(both["my"].rows) == 2 and len(both["opp"].rows) == 1


def test_a_first_meeting_lists_your_games_and_says_so_for_the_opponent():
    both = columns(5, 0)
    assert both["opp"].heading == "OPPONENT" + DOT + "FIRST MEETING"
    assert both["opp"].empty_text == "No earlier games against this player in your library."
    assert both["opp"].rows == ()
    assert len(both["my"].rows) == 5


def test_no_earlier_game_of_your_own_is_said_for_the_matchup_when_it_is_known():
    assert columns(0, 0)["my"].heading == "YOU" + DOT + "PvZ" + DOT + "NO EARLIER GAMES"
    assert columns(0, 0)["my"].empty_text == "You have no earlier games in this matchup."
    unknown = columns(0, 0, matchup=None)["my"]
    assert unknown.heading == "YOU" + DOT + "NO EARLIER GAMES"
    assert unknown.empty_text == "You have no earlier games."


def test_a_row_reads_result_build_map_and_age():
    yours, theirs = columns(2, 2)["my"].rows[1], columns(2, 2)["opp"].rows[1]
    assert (yours.result, yours.build, yours.details) == ("Loss", "Build 1", "Map 1" + DOT + "yesterday")
    assert yours.summary == "Loss with Build 1" + DOT + "Map 1" + DOT + "yesterday"
    assert theirs.summary == "Loss against Build 1" + DOT + "Map 1" + DOT + "yesterday"


def test_unknown_stays_unknown_on_a_row():
    builds = parse_recent_builds({"mine": [{"gameId": None, "result": None, "map": "", "build": "", "date": None}]})
    game = recent_build_columns(builds, NOW)["my"].rows[0]
    assert (game.game_id, game.result, game.build, game.details) == (None, "", "Unclassified build", "Unknown map")
    assert game.summary == "Unclassified build" + DOT + "Unknown map"


def test_another_race_is_named_only_when_it_differs_from_this_game():
    builds = parse_recent_builds({"theirs": [row(0, race="Terran"), row(1, race="Zerg"), row(2, race="")]})
    as_zerg = [game.details for game in recent_build_columns(builds, NOW, "zerg")["opp"].rows]
    assert as_zerg == ["as Terran" + DOT + "Map 0" + DOT + "today", "Map 1" + DOT + "yesterday", "Map 2" + DOT + "2 days ago"]
    race_unknown = [game.details for game in recent_build_columns(builds, NOW, None)["opp"].rows]
    assert not any(details.startswith("as ") for details in race_unknown)


def brief(recent_builds=...):
    payload = {"gameKey": "current", "oppName": "Opponent", "h2h": {"w": 3, "l": 2}}
    if recent_builds is not ...:
        payload["recentBuilds"] = recent_builds
    return parse_scouting_brief(payload, "current")


def test_the_strip_lists_both_players_builds_in_short_form_newest_first():
    model = scouting_model(brief({"matchup": "PvZ", "mine": [{"result": "Win", "build": "PvZ - Blink"}, {"result": "Loss", "build": "Protoss - Four Gate"}],
                                  "theirs": [{"result": "Loss", "build": "Zerg - 12 Pool"}, {"result": "Tie", "build": "ZvP - Hatch First"},
                                             {"result": None, "build": ""}]}), NOW)
    assert model.your_builds == "Your 2 earlier games: W with Blink" + DOT + "L with Four Gate"
    assert model.their_builds == "Their 3 earlier games: L vs 12 Pool" + DOT + "Tie vs Hatch First" + DOT + "Unclassified build"


def test_the_strip_says_last_five_and_keeps_a_prefix_that_names_another_race():
    games = [{"result": "Win", "build": name} for name in ("Terran - Proxy Barracks", "Zerg - 12 Pool", "Roach - Timing", "Zerg - ", "PvZ - Cannon Rush")]
    model = scouting_model(brief({"matchup": "PvZ", "mine": [], "theirs": games}), NOW)
    assert model.their_builds == ("Their last 5 games: W vs Terran - Proxy Barracks" + DOT + "W vs 12 Pool" + DOT + "W vs Roach - Timing"
                                  + DOT + "W vs Zerg -" + DOT + "W vs PvZ - Cannon Rush")
    assert model.your_builds == ""


def test_without_a_known_matchup_the_strip_keeps_every_name_whole():
    model = scouting_model(brief({"mine": [{"result": "Win", "build": "PvZ - Blink"}], "theirs": []}), NOW)
    assert model.your_builds == "Your 1 earlier game: W with PvZ - Blink"


def test_a_first_meeting_adds_no_opponent_line_to_the_strip():
    model = scouting_model(brief({"matchup": "PvZ", "mine": [{"result": "Win", "build": "Blink"}], "theirs": []}), NOW)
    assert model.their_builds == ""
    assert model.your_builds == "Your 1 earlier game: W with Blink"


def test_an_older_brief_draws_the_strip_it_drew_before():
    old = brief()
    assert old.recent_builds is None
    model = scouting_model(old, NOW)
    assert (model.record_line, model.their_builds, model.your_builds) == ("You 3\N{EN DASH}2", "", "")

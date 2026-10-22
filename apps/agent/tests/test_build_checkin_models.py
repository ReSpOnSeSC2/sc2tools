"""Parsers, view models, render rules and matching helpers of the
build check-in package (pure functions, no actor)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sc2tools_agent.build_checkin.matching import (
    accepted_ineligibility,
    game_started_ms,
    opponent_name_of,
    players_one_v_one,
    roster_complete,
    user_result,
    within_match_window,
)
from sc2tools_agent.build_checkin.models import (
    BuildOption,
    BuildOptions,
    BuildRef,
    CheckinPrefs,
    FrozenOptionRows,
    format_record,
    game_key_ms,
    iso_to_ms,
    matchup_for,
    matchups_for_race,
    normalize_player_name,
    option_models,
    parse_build_options,
    parse_game_intent,
    parse_live_state,
    parse_prefs,
    reason_label,
    sanitize_notes,
)
from sc2tools_agent.build_checkin.records import (
    NOTES_FIRST,
    LiveGame,
    LoadingCard,
    PostgameCard,
)
from sc2tools_agent.build_checkin.render import (
    loading_model,
    postgame_model,
    preselection,
)
from sc2tools_agent.build_checkin.models import parse_game_intent as _parse_state
from sc2tools_agent.build_checkin.models import LiveState
from tests.build_checkin_fakes import (
    WALL_START,
    cloud_game,
    game_state,
    iso,
    option,
    options_payload,
    suggestion,
)

DT = BuildRef("custom:dt-3-gate", "DT into 3 Gate", "dt-3-gate", "custom")


# ----------------------------------------------------------------- models


def test_prefs_default_on_and_only_false_turns_off() -> None:
    assert parse_prefs({}) == CheckinPrefs()
    assert parse_prefs({"enabled": None, "askAtLoading": 0}) == CheckinPrefs()
    prefs = parse_prefs({"enabled": True, "askAtLoading": False, "askAfterGame": True})
    assert prefs == CheckinPrefs(ask_at_loading=False)
    assert prefs.loading_cards is False and prefs.postgame_cards is True
    assert CheckinPrefs(enabled=False).postgame_cards is False
    assert parse_prefs([]) is None
    assert CheckinPrefs(ask_after_game=False).to_json() == {
        "enabled": True, "askAtLoading": True, "askAfterGame": False,
    }


def test_options_parse_drops_bad_rows_and_duplicates() -> None:
    payload = options_payload(
        "PvZ",
        option("custom:dt-3-gate", "DT into 3 Gate", games=12, wins=7, losses=5, source="custom"),
        {"key": "", "name": "blank"},
        {"name": "no key"},
        "junk",
        option("custom:dt-3-gate", "Duplicate"),
        {**option("pvz-x"), "games": True, "wins": -3, "group": "weird", "source": "?"},
        usual="pvz-x",
        randomizer=True,
    )
    parsed = parse_build_options(payload)
    assert [b.key for b in parsed.builds] == ["custom:dt-3-gate", "pvz-x"]
    dt, x = parsed.builds
    assert (dt.name, dt.source, dt.slug, dt.group, dt.games) == (
        "DT into 3 Gate", "custom", "dt-3-gate", "yours", 12,
    )
    assert (x.games, x.wins, x.group, x.source) == (0, 0, "catalog", "catalog")
    assert parsed.usual_key == "pvz-x"
    assert parsed.randomizer_enabled is True
    assert parsed.find("pvz-x") is x and parsed.find(None) is None
    assert parse_build_options({"matchup": "bad", "builds": "nope"}) == BuildOptions(matchup=None)
    assert parse_build_options(None) is None


def test_live_state_parse() -> None:
    state = parse_live_state({
        "gameKey": "A|B|1", "matchup": "PvZ", "myRace": "Protoss", "oppRace": "zerg",
        "declared": {**option("custom:dt-3-gate", "DT into 3 Gate", source="custom"), "via": "web"},
        "randomizer": {"key": "pvz-x", "name": "PvZ - X"},
        "randomizerEnabled": True, "holdRemainingMs": 4200, "gameId": None,
        "prefs": {"askAtLoading": False},
    }, "A|B|1")
    assert state.matchup == "PvZ" and state.opp_race == "Zerg"
    assert state.declared.key == "custom:dt-3-gate" and state.declared_via == "web"
    assert state.randomizer == BuildRef("pvz-x", "PvZ - X")
    assert state.hold_remaining_ms == 4200
    assert state.prefs.ask_at_loading is False
    empty = parse_live_state({"declared": {"key": "x"}, "holdRemainingMs": "soon"}, "k")
    assert empty == LiveState(game_key="k")
    assert parse_live_state("nope", "k") is None


def test_game_intent_parse() -> None:
    raw = game_state(
        "g", status="confirmed", origin="pregame", executed=False,
        build={**option("custom:dt-3-gate", "DT into 3 Gate", source="custom"), "deleted": True},
        suggestion={**suggestion("pvz-x", reason="rules"), "passedRules": 2, "ruleCount": 4},
        options=[option("pvz-x")], notes="n" * 1200,
    )
    raw["detected"]["key"] = "pvz-x"
    state = parse_game_intent(raw, "g")
    assert state.status == "confirmed" and state.eligible is True
    assert state.build.deleted is True
    assert (state.suggestion.reason, state.suggestion.passed_rules, state.suggestion.rule_count) == (
        "rules", 2, 4,
    )
    assert state.detected_key == "pvz-x"
    assert state.options.matchup == "PvZ" and [b.key for b in state.options.builds] == ["pvz-x"]
    assert len(state.notes) == 1000
    odd = parse_game_intent({"status": "weird", "suggestion": {"key": "k", "name": "n",
                                                             "reason": "magic"}}, "g")
    assert odd.status == "none" and odd.eligible is False
    assert odd.suggestion.reason is None and odd.options is None
    assert _parse_state(None, "g") is None


@pytest.mark.parametrize("raw,expected", [
    (" [oM]Cure#123 ", "cure"),
    ("[Clan] Zoë#1", "zoë"),
    ("Zoë", "zoë"),
    ("NoTag", "notag"),
    ("Name#abc", "name#abc"),
    ("[A] [B] Two", "[b] two"),
    ("", ""),
    (None, ""),
])
def test_player_name_normalisation_matches_the_api(raw, expected) -> None:
    assert normalize_player_name(raw) == expected


def test_matchups_and_keys() -> None:
    assert matchup_for("Protoss", "Zerg") == "PvZ"
    assert matchup_for("Random", "Zerg") is None
    assert matchup_for(None, "Zerg") is None
    assert matchups_for_race("Terran") == ("TvP", "TvT", "TvZ")
    assert matchups_for_race("Random") == ()
    assert game_key_ms("A|B|1717000000000") == 1717000000000
    assert game_key_ms("A|B|later") is None and game_key_ms("nokey") is None
    assert iso_to_ms("2026-10-22T18:00:00Z") == iso_to_ms("2026-10-22T18:00:00+00:00")
    assert iso_to_ms("2026-10-22T18:00:00") == iso_to_ms("2026-10-22T18:00:00Z")
    assert iso_to_ms("yesterday") is None and iso_to_ms(None) is None
    assert format_record(7, 5, 12) == "7–5" and format_record(0, 0, 0) == ""
    assert sanitize_notes(None) == "" and sanitize_notes("x" * 1001) == "x" * 1000
    assert reason_label("rules", passed_rules=3, rule_count=4) == "Matched 3 of 4 rules"
    assert reason_label("rules") == "Closest rule match"
    assert reason_label(None) is None


def test_frozen_rows_keep_first_paint_order() -> None:
    rows = FrozenOptionRows()
    first = [BuildOption("a", "A", group="yours"), BuildOption("b", "B"),
             BuildOption("c", "C", group="yours")]
    rows.merge(first)
    assert rows.featured == ("a", "c")
    rows.merge([BuildOption("d", "D", group="yours"), BuildOption("c", "C2", group="yours", games=3)])
    assert [o.key for o in rows.ordered()] == ["a", "b", "c", "d"]
    assert rows.featured == ("a", "c")
    assert rows.find("c").name == "C2"
    featured, more = option_models(rows.ordered(), rows.featured, rolled_key="b",
                                   usual_key="c", suggested_key="d")
    assert [m.key for m in featured] == ["a", "c"]
    assert [m.key for m in more] == ["b", "d"]
    assert [m.key for m in featured + more if m.rolled] == ["b"]
    assert featured[1].usual and more[1].suggested
    assert featured[1].accessible_name == "C2, 0 wins, 0 losses, your usual build"


def test_featured_rows_are_capped_at_six() -> None:
    rows = FrozenOptionRows()
    rows.merge([BuildOption(f"k{i}", f"K{i}", group="yours") for i in range(9)])
    assert rows.featured == tuple(f"k{i}" for i in range(6))


# ----------------------------------------------------------------- render


def _game(**kwargs) -> LiveGame:
    base = dict(game_key="Foo|Me|1", key_ms=1, seen_at=0.0, opp_name="Foo",
                my_race="Protoss", opp_race="Zerg")
    base.update(kwargs)
    return LiveGame(**base)


def _options(**kwargs) -> BuildOptions:
    return parse_build_options(options_payload(
        "PvZ", option("custom:dt-3-gate", "DT into 3 Gate", source="custom"),
        option("pvz-x", "PvZ - X"), **kwargs,
    ))


def _loading(game: LiveGame, **kwargs):
    params = dict(options=_options(randomizer=True), options_loading=False,
                  options_failed=False, declared_elsewhere=None, show_intro=False)
    params.update(kwargs)
    return loading_model(game, LoadingCard(shown_at=0.0), **params)


def test_loading_model_waiting_and_titles() -> None:
    waiting = _loading(_game(opp_race=None), options=None, options_loading=True)
    assert waiting.waiting_for_matchup is True
    assert waiting.title == "vs Foo"
    assert waiting.options_loading is False  # no matchup, nothing is loading
    assert waiting.randomizer is None
    no_one = _loading(_game(opp_name=None, opp_race=None), options=None)
    assert no_one.title == ""


def test_loading_model_strip_states() -> None:
    game = _game()
    assert _loading(game).randomizer.can_roll_now is True
    game.released = True
    assert _loading(game).randomizer.label == "🎲 Rolling the randomizer…"
    game.live = LiveState(game_key="k", randomizer=DT, randomizer_enabled=True)
    strip = _loading(game, options=_options()).randomizer
    assert (strip.label, strip.rolled_key, strip.can_roll_now) == (
        "🎲 Randomizer: DT into 3 Gate", DT.key, False,
    )
    assert _loading(_game(), options=_options()).randomizer is None


def test_loading_model_locked_labels() -> None:
    game = _game(declared=DT)
    mine = _loading(game)
    assert (mine.collapsed, mine.locked_label, mine.declared_elsewhere) == (
        True, "Locked in: DT into 3 Gate", False,
    )
    web = _loading(_game(), declared_elsewhere=DT)
    assert (web.locked_label, web.declared_elsewhere, web.can_change) == (
        "Picked on sc2tools.com: DT into 3 Gate", True, True,
    )


def test_loading_model_options_error_only_without_rows() -> None:
    failed = _loading(_game(), options=None, options_failed=True)
    assert failed.status == "Couldn't load your builds. We'll ask after the game."
    assert _loading(_game(), options_failed=True).status == ""


def _card(**kwargs) -> PostgameCard:
    base = dict(card_id="c1", seq=1, created_at=0.0, game_key="Foo|Me|1",
                opp_name="Foo", my_race="Protoss", opp_race="Zerg", result="Victory")
    base.update(kwargs)
    return PostgameCard(**base)


def test_preselection_order() -> None:
    options = _options(usual="pvz-x")
    roll = BuildRef("pvz-x", "PvZ - X")
    assert preselection(_card(), roll=None, options=options) == ("pvz-x", "usual", None, None)
    assert preselection(_card(), roll=DT, options=options).reason == "randomizer"
    assert preselection(_card(local_declared=roll), roll=DT, options=options) == (
        "pvz-x", "declared", None, None,
    )
    server = parse_game_intent(game_state("g", suggestion=suggestion(DT.key, reason="detected")), "g")
    assert preselection(_card(server=server), roll=roll, options=options).key == DT.key
    # The server lacks the local pick: the pick wins.
    assert preselection(_card(server=server, local_declared=roll), roll=None,
                        options=options).reason == "declared"
    # The server already has it: its suggestion speaks.
    has_it = parse_game_intent(game_state("g", suggestion=suggestion("pvz-x", reason="declared")), "g")
    assert preselection(_card(server=has_it, local_declared=roll), roll=None,
                        options=options).reason == "declared"
    no_suggestion = parse_game_intent(game_state("g"), "g")
    assert preselection(_card(server=no_suggestion), roll=roll, options=options).key is None
    assert preselection(_card(), roll=None, options=_options(usual="missing")).key is None


def test_postgame_model_full_and_notes_first() -> None:
    server = parse_game_intent(game_state(
        "g", suggestion=suggestion("pvz-x", "PvZ - X"), options=[option("pvz-x", "PvZ - X")],
    ), "g")
    card = _card(server=server, selection="pvz-x", reason="detected", result=None)
    model = postgame_model(card, roll=None, options=server.options,
                           options_loading=False, show_intro=True)
    assert model.title == "Victory · PvZ · vs Foo"
    assert model.detected_label == "Replay classified as: PvZ - Macro Transition (Unclassified)"
    assert model.reason_label == "Detected in your replay"
    assert model.featured[0].suggested is True
    assert model.prompt is None and model.planned_name is None
    assert model.show_intro is True and model.notes_max == 1000

    confirmed = parse_game_intent(game_state(
        "g", status="confirmed", origin="pregame", build=option("custom:dt-3-gate", "DT into 3 Gate"),
        detected=None,
    ), "g")
    notes_first = postgame_model(_card(server=confirmed, variant=NOTES_FIRST), roll=None,
                                 options=None, options_loading=False, show_intro=False)
    assert notes_first.heading == "What happened?"
    assert notes_first.prompt == (
        "You planned DT into 3 Gate · replay looked like something else. What happened?"
    )
    assert notes_first.detected_label is None


def test_postgame_model_title_without_matchup_or_result() -> None:
    model = postgame_model(_card(opp_race="Random", result=None), roll=None, options=None,
                           options_loading=True, show_intro=False)
    assert model.title == "vs Foo"
    assert model.result_tone == "neutral"
    assert model.options_loading is True


# --------------------------------------------------------------- matching


@pytest.mark.parametrize("roster,expected", [
    (None, None),
    ([], None),
    ([{"type": "user", "name": "A"}], None),
    ([{"type": "user"}, {"type": "user"}], True),
    ([{"type": "user"}, {"type": "computer"}], False),
    ([{"type": "user"}] * 3, False),
    ([{"type": "user"}, {"type": "user"}, {"type": "observer"}], False),
])
def test_players_one_v_one(roster, expected) -> None:
    assert players_one_v_one(roster) is expected


def test_roster_complete_and_user_result() -> None:
    roster = [
        {"type": "user", "name": "[T] Me#1", "result": "Victory"},
        {"type": "user", "name": "Foo", "result": "Defeat"},
    ]
    assert roster_complete(roster) is True
    assert roster_complete([{"name": "A"}, {"name": " "}]) is False
    assert user_result(roster, user_name="Me#1", opponent_name="Foo") == "Victory"
    assert user_result(roster, user_name=None, opponent_name="Foo") == "Victory"
    assert user_result(roster, user_name=None, opponent_name=None) is None
    assert user_result([{"type": "user", "name": "Me", "result": "Undecided"}],
                       user_name="Me", opponent_name=None) is None


def test_accepted_ineligibility_rules() -> None:
    now_ms = int(WALL_START * 1000)
    fresh = cloud_game("g", started=WALL_START - 600)
    row = {"created": True}
    assert accepted_ineligibility(fresh, row, now_ms=now_ms) is None
    assert accepted_ineligibility(fresh, {}, now_ms=now_ms) == "not_created"
    assert accepted_ineligibility(fresh, {**row, "quarantined": True}, now_ms=now_ms) == "quarantined"
    assert accepted_ineligibility(cloud_game("g", started=WALL_START - 600, match_format="ffa"),
                                  row, now_ms=now_ms) == "not_1v1"
    assert accepted_ineligibility(cloud_game("g", started=WALL_START - 600, resumed=True),
                                  row, now_ms=now_ms) == "resumed"
    assert accepted_ineligibility(cloud_game("g", started=WALL_START - 2000),
                                  row, now_ms=now_ms) == "stale"
    future = cloud_game("g", started=WALL_START + 1000)
    assert accepted_ineligibility(future, row, now_ms=now_ms) == "stale"
    assert accepted_ineligibility(SimpleNamespace(match_format="1v1", date_iso=None),
                                  row, now_ms=now_ms) == "stale"


def test_started_ms_and_window() -> None:
    game = cloud_game("g", started=WALL_START, duration=300)
    assert game_started_ms(game) == int(WALL_START * 1000)
    fallback = cloud_game("g", started=WALL_START, duration=300, with_started_at=False)
    assert game_started_ms(fallback) == int(WALL_START * 1000)
    assert game_started_ms(SimpleNamespace(started_at=None, date_iso=iso(WALL_START),
                                           duration_sec=True)) is None
    assert opponent_name_of(cloud_game("g", started=0, opponent="[X] Foo#12")) == "foo"
    assert opponent_name_of(SimpleNamespace(opponent=None)) == ""
    key_ms = 1_000_000
    assert within_match_window(key_ms - 120_000, key_ms)
    assert not within_match_window(key_ms - 120_001, key_ms)
    assert within_match_window(key_ms + 600_000, key_ms)
    assert not within_match_window(key_ms + 600_001, key_ms)

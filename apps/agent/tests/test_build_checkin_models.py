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
    opponent_change,
    option_models,
    parse_build_options,
    parse_game_intent,
    parse_live_state,
    parse_opponent_intent,
    parse_prefs,
    reason_label,
    sanitize_notes,
)
from sc2tools_agent.build_checkin.links import new_build_url, web_queue_url
from sc2tools_agent.build_checkin.records import (
    NOTES_FIRST,
    LiveGame,
    LoadingCard,
    PostgameCard,
)
from sc2tools_agent.build_checkin.render import (
    loading_model,
    opponent_pick,
    opponent_row_model,
    opponent_write,
    postgame_model,
    preselection,
)
from sc2tools_agent.build_checkin.models import parse_game_intent as _parse_state
from sc2tools_agent.build_checkin.models import LiveState
from tests.build_checkin_fakes import (
    OPP_OPTIONS,
    WALL_START,
    cloud_game,
    game_state,
    iso,
    opponent_state,
    option,
    options_payload,
    suggestion,
)

DT = BuildRef("custom:dt-3-gate", "DT into 3 Gate", "dt-3-gate", "custom")


# ----------------------------------------------------------------- models


def test_prefs_default_off_and_only_explicit_true_opts_in() -> None:
    assert parse_prefs({}) == CheckinPrefs()
    assert parse_prefs({"enabled": None, "askAtLoading": 0}) == CheckinPrefs()
    prefs = parse_prefs({"enabled": True, "askAtLoading": False, "askAfterGame": True})
    assert prefs == CheckinPrefs(enabled=True, ask_at_loading=False, ask_after_game=True)
    assert prefs.loading_cards is False and prefs.postgame_cards is True
    assert CheckinPrefs(enabled=False).postgame_cards is False
    assert parse_prefs([]) is None
    assert CheckinPrefs().to_json() == {
        "enabled": False, "askAtLoading": False, "askAfterGame": False,
    }
    assert parse_prefs({"enabled": 1, "askAtLoading": "true", "askAfterGame": []}) == CheckinPrefs()
    opted_in = {"enabled": True, "askAtLoading": True, "askAfterGame": True}
    assert parse_prefs(opted_in).to_json() == opted_in


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
    game.randomizer_request_inflight = True
    assert _loading(game).randomizer.label == "🎲 Choosing a build…"
    game.live = LiveState(game_key="k", randomizer=DT, randomizer_enabled=True)
    strip = _loading(game, options=_options()).randomizer
    assert (strip.label, strip.rolled_key, strip.can_roll_now) == (
        "🎲 Randomizer: DT into 3 Gate", DT.key, False,
    )
    assert _loading(_game(), options=_options()).randomizer is None


def test_saved_widget_pick_stays_visible_when_randomizer_is_disabled_after_the_draw():
    game = _game()
    game.live = LiveState(game_key="k", randomizer=DT, randomizer_enabled=False)
    strip = _loading(game, options=_options()).randomizer
    assert strip is not None
    assert strip.rolled_key == DT.key and strip.rolled_name == DT.name
    assert not strip.can_roll_now


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


# ------------------------------------------------------ opponent axis


def test_opponent_intent_parse() -> None:
    raw = game_state("g", opponent=opponent_state(
        options=OPP_OPTIONS,
        build={"key": "zvp-roach-rush", "name": "ZvP - Roach Rush", "slug": None,
               "source": "catalog", "deleted": True},
        suggestion={**suggestion("custom:ling-flood", reason="rules"),
                    "passedRules": 3, "ruleCount": 4},
    ))
    opp = parse_game_intent(raw, "g").opponent
    assert (opp.label, opp.status, opp.applied, opp.corrected) == (
        "ZvP - Roach Rush", "confirmed", True, True,
    )
    assert opp.build.deleted is True
    assert (opp.detected_name, opp.detected_key) == ("Zerg - 12 Pool", "zerg-12-pool")
    assert opp.effective_key == "zvp-roach-rush"
    assert opp.replay_name == "Zerg - 12 Pool"
    assert (opp.suggestion.reason, opp.suggestion.passed_rules) == ("rules", 3)
    assert opp.options.matchup == "PvZ"
    assert [b.key for b in opp.options.builds][:2] == ["zerg-12-pool", "custom:ling-flood"]

    plain = parse_game_intent(game_state("g", opponent=opponent_state()), "g").opponent
    assert plain.corrected is False and plain.options is None
    assert plain.effective_key == "zerg-12-pool"
    assert plain.executed is None


def test_opponent_intent_parse_is_defensive() -> None:
    assert parse_game_intent(game_state("g"), "g").opponent is None
    assert parse_opponent_intent(None, "PvZ") is None
    odd = parse_opponent_intent({"status": "pending", "applied": "yes", "detected": [],
                                 "executed": "no", "label": 7}, "PvZ")
    assert (odd.status, odd.applied, odd.label, odd.detected_key, odd.executed) == (
        "none", False, None, None, None,
    )
    # "Applied" without a build to show is no correction.
    broken = parse_opponent_intent({"applied": True, "detected": {"key": "k", "name": "K"}}, "PvZ")
    assert broken.corrected is False and broken.effective_key == "k"
    unclassified = parse_opponent_intent({"label": "Zerg Standard Play (Unclassified)"}, None)
    assert unclassified.replay_name == "Zerg Standard Play (Unclassified)"


@pytest.mark.parametrize("selection,server_key,corrected,expected", [
    ("a", "a", False, None),
    ("b", "a", False, ("b",)),
    ("b", "a", True, ("b",)),
    (None, None, False, None),
    (None, "a", True, (None,)),
    (None, "a", False, None),
    ("a", None, False, ("a",)),
    ("r", "a", True, (None,)),
    ("r", "r", False, None),
])
def test_opponent_change(selection, server_key, corrected, expected) -> None:
    assert opponent_change(
        selection, server_key=server_key, corrected=corrected, replay_key="r",
    ) == expected


ROACH = {"key": "zvp-roach-rush", "name": "ZvP - Roach Rush", "slug": None, "source": "catalog"}


def _opp_card(opponent, **kwargs) -> PostgameCard:
    server = parse_game_intent(game_state("g", opponent=opponent), "g")
    return _card(server=server, game_id="g", **kwargs)


def _opp_row(card: PostgameCard, **kwargs):
    return opponent_row_model(card, options_loading=kwargs.get("options_loading", False))


def test_opponent_row_follows_the_server_until_touched() -> None:
    card = _opp_card(opponent_state(options=OPP_OPTIONS))
    row = _opp_row(card)
    assert (row.label, row.name, row.selection) == (
        "Opponent's build: Zerg - 12 Pool", "Zerg - 12 Pool", "zerg-12-pool",
    )
    assert (row.changed, row.show_use_replay, row.detected_label, row.touched) == (
        False, False, None, False,
    )
    assert [m.key for m in row.featured] == ["zerg-12-pool", "custom:ling-flood"]
    assert row.featured[0].record == "2–1"
    assert opponent_pick(card) == "zerg-12-pool"
    assert opponent_write(card) is None


def test_opponent_row_after_a_pick() -> None:
    card = _opp_card(opponent_state(options=OPP_OPTIONS), opp_touched=True,
                     opp_selection="zvp-ling-bane-bust")
    row = _opp_row(card)
    assert row.label == "Opponent's build: ZvP - Ling Bane Bust"
    assert row.changed is True and row.touched is True
    assert row.detected_label == "Replay classified as: Zerg - 12 Pool"
    assert row.show_use_replay is True
    assert opponent_write(card) == ("zvp-ling-bane-bust",)


def test_opponent_row_names_picks_outside_the_list() -> None:
    corrected = _opp_card(opponent_state(build=ROACH), opp_touched=True,
                          opp_selection="zvp-roach-rush")
    assert _opp_row(corrected).name == "ZvP - Roach Rush"
    assert _opp_row(corrected).changed is False
    replay = _opp_card(opponent_state(build=ROACH), opp_touched=True,
                       opp_selection="zerg-12-pool")
    assert _opp_row(replay).name == "Zerg - 12 Pool"
    assert _opp_row(replay).changed is True
    assert opponent_write(replay) == (None,)  # the replay's label, as null
    unknown = _opp_card(opponent_state(), opp_touched=True, opp_selection="custom:gone")
    assert _opp_row(unknown).label == "Opponent's build: unknown"


def test_opponent_row_with_an_unclassified_replay() -> None:
    generic = dict(label="Zerg Standard Play (Unclassified)",
                   detected="Zerg Standard Play (Unclassified)", detected_key=None)
    row = _opp_row(_opp_card(opponent_state(**generic)))
    assert row.label == "Opponent's build: Zerg Standard Play (Unclassified)"
    assert row.selection is None and row.show_use_replay is False
    nameless = _opp_row(_opp_card(opponent_state(label=None, detected=None, detected_key=None)))
    assert nameless.label == "Opponent's build: unknown"
    # Back to the replay's label from a correction: cleared with null.
    back = _opp_card(opponent_state(build=ROACH, **generic), opp_touched=True, opp_selection=None)
    assert _opp_row(back).name == "Zerg Standard Play (Unclassified)"
    assert _opp_row(back).changed is True
    assert opponent_write(back) == (None,)


def test_opponent_rows_keep_their_order_across_refreshes() -> None:
    card = _opp_card(opponent_state(options=OPP_OPTIONS))
    _opp_row(card)
    card.server = parse_game_intent(game_state("g", opponent=opponent_state(
        options=[option("zvp-new", "ZvP - New", games=9)] + list(reversed(OPP_OPTIONS)),
    )), "g")
    row = _opp_row(card)
    assert [m.key for m in row.featured] == ["zerg-12-pool", "custom:ling-flood"]
    assert [m.key for m in row.more][-1] == "zvp-new"


def test_opponent_row_loading_only_without_rows() -> None:
    card = _opp_card(opponent_state())
    assert _opp_row(card, options_loading=True).options_loading is True
    card.opp_rows.merge(parse_build_options(options_payload("PvZ", *OPP_OPTIONS)).builds)
    assert _opp_row(card, options_loading=True).options_loading is False


def test_postgame_model_add_build_waits_for_the_replay() -> None:
    before = postgame_model(_card(), roll=None, options=None, options_loading=False,
                            show_intro=False)
    assert (before.can_add_build, before.add_build_hint, before.opponent) == (
        False, "Available once your replay uploads", None,
    )
    card = _opp_card(opponent_state(options=OPP_OPTIONS))
    after = postgame_model(card, roll=None, options=None, options_loading=False,
                           show_intro=False)
    assert after.can_add_build is True
    assert after.add_build_hint == "Opens sc2tools.com to save a build from this replay"
    assert after.opponent.label == "Opponent's build: Zerg - 12 Pool"


def test_loading_model_while_changing_a_pick() -> None:
    game = _game(declared=DT)
    card = LoadingCard(shown_at=0.0, changing=True)
    model = loading_model(game, card, options=_options(randomizer=True), options_loading=False,
                          options_failed=False, declared_elsewhere=None, show_intro=False)
    assert (model.collapsed, model.changing, model.can_change) == (False, True, False)
    assert model.locked_key == DT.key and model.current_pick_label == "Current pick"
    assert model.randomizer is None
    assert model.not_now_tip == "Clear your pick and skip this game's check-in"
    # Nothing left to change once the pick is gone.
    gone = loading_model(_game(), card, options=_options(randomizer=True), options_loading=False,
                         options_failed=False, declared_elsewhere=None, show_intro=False)
    assert (gone.changing, gone.collapsed) == (False, False)
    assert gone.randomizer is not None
    assert gone.not_now_tip == "Skip this game's check-in at loading"


def test_links() -> None:
    gid = "2026-10-22T18:10:00Z|Foo Bar|Map/1|600"
    assert new_build_url("https://sc2tools.com/", gid, "you") == (
        "https://sc2tools.com/app/game/2026-10-22T18%3A10%3A00Z%7CFoo%20Bar%7CMap%2F1%7C600"
        "?newBuild=you"
    )
    assert new_build_url("http://localhost:3000", "g", "opponent") == (
        "http://localhost:3000/app/game/g?newBuild=opponent"
    )
    with pytest.raises(ValueError):
        new_build_url("https://sc2tools.com", "g", "both")
    assert web_queue_url("https://sc2tools.com/") == "https://sc2tools.com/app"

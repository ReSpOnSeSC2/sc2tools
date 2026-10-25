"""End-card policy of ``BuildCheckinController`` (contract §1.3, §10.2):
the match-end shell, upload acceptance, saving, Later/auto-hide,
pre-emption, notes and re-opening."""

from __future__ import annotations

from dataclasses import replace

import pytest

from sc2tools_agent.build_checkin.controller import (
    OPTIONS_TTL_SEC,
    PENDING_CARD_MAX_AGE_SEC,
    POSTGAME_IDLE_HIDE_SEC,
    RESHOW_MAX_WAIT_SEC,
)
from sc2tools_agent.build_checkin.models import (
    CheckinPrefs,
    CHECKING_REPLAY,
    STATUS_REPLAY_UNAVAILABLE,
    STATUS_SAVE_FAILED,
    STATUS_SAVE_UNKNOWN_BUILD,
)
from tests.build_checkin_fakes import (
    OPP,
    WALL_START,
    Harness,
    ManualExecutor,
    api_error,
    cloud_game,
    envelope,
    game_state,
    option,
    suggestion,
)

GID = "2026-10-22T18:10:00Z|Foo|Map|600"


@pytest.fixture
def h() -> Harness:
    return Harness().boot()


def _card(h: Harness):
    return h.view.last("show_postgame", "update_postgame")


def _key_started(key: str) -> float:
    return int(key.rsplit("|", 1)[1]) / 1000


def _game(key: str, game_id: str = GID, **kwargs):
    """The replay of the game played under ``key``: starts a few seconds
    after the loading screen appeared."""
    return cloud_game(game_id, started=_key_started(key) + 8, **kwargs)


def _finish(h: Harness, key: str, *, result: str = "Victory", loading: bool = True) -> None:
    h.play(key, result=result, loading=loading)
    h.wall.advance(620)  # the replay lands about when the game ends


# ------------------------------------------------------------ match end


def test_match_end_opens_the_shell_with_live_data(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)

    shown = h.view.of("show_postgame")
    assert len(shown) == 1
    card = _card(h)
    assert card.variant == "full"
    assert card.heading == "Which build were you going for?"
    assert card.title == f"Victory · PvZ · vs {OPP}"
    assert card.result_tone == "success"
    assert card.status == CHECKING_REPLAY
    assert card.game_key == key
    assert card.game_id is None
    # No roll, so the matchup's usual build is pre-selected.
    assert (card.selection, card.reason) == ("pvz-2-stargate-phoenix", "usual")
    assert card.reason_label == "Your usual build"
    assert [row.key for row in card.featured][:1] == ["custom:dt-3-gate"]


def test_defeat_uses_the_danger_tone(h: Harness) -> None:
    _finish(h, h.new_key(), result="Defeat")
    card = _card(h)
    assert card.title.startswith("Defeat · PvZ")
    assert card.result_tone == "danger"


def test_randomizer_roll_is_preselected_over_the_usual(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.api.live[key]["randomizer"] = {
        "key": "custom:dt-3-gate", "name": "DT into 3 Gate", "slug": "dt-3-gate", "source": "custom",
    }
    _finish(h, key)
    card = _card(h)
    assert (card.selection, card.reason) == ("custom:dt-3-gate", "randomizer")
    assert card.randomizer_name == "DT into 3 Gate"


def test_ask_after_game_off_means_no_end_card() -> None:
    h = Harness()
    h.api.prefs["askAfterGame"] = False
    h.boot()
    key = h.new_key()
    _finish(h, key)
    h.accept(_game(key))
    assert h.view.of("show_postgame") == []
    assert h.api.calls_to("get_game_intent") == []


def test_random_game_shell_has_no_list_until_the_replay(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key, opponent=(OPP, "Random")))
    h.send(envelope("match_started", key, display_time=1.0, opponent=(OPP, "Random")))
    h.send(envelope(
        "match_ended", key, display_time=600.0, opponent=(OPP, "Random"),
        roster=[
            {"name": "Me#123", "type": "user", "race": "Prot", "result": "Victory"},
            {"name": OPP, "type": "user", "race": "Zerg", "result": "Defeat"},
        ],
    ))
    shell = _card(h)
    assert h.view.of("show_loading") == []
    assert shell.title == f"Victory · vs {OPP}"
    assert shell.matchup is None
    assert shell.featured == () and shell.more == ()

    h.api.games[GID] = game_state(
        GID, matchup="PvT",
        options=[option("pvt-1-1-1", "PvT - 1-1-1"), option("pvt-robo", "PvT - Robo")],
        suggestion=suggestion("pvt-robo", "PvT - Robo"),
    )
    h.wall.advance(620)
    h.accept(_game(key))
    card = _card(h)
    assert card.title == f"Victory · PvT · vs {OPP}"
    assert [row.key for row in card.featured] == ["pvt-1-1-1", "pvt-robo"]
    assert card.selection == "pvt-robo"


def test_match_end_without_opponent_identity_opens_nothing(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_ended", key, opponent=(None, None), user=None))
    assert h.view.of("show_postgame") == []


def test_repeated_match_end_envelopes_open_one_card(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.send(envelope("match_ended", key, with_players=False))
    assert len(h.view.of("show_postgame")) == 1


# -------------------------------------------------------- upload accepted


def test_accepted_replay_fills_in_the_suggestion(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.api.games[GID] = game_state(
        GID,
        suggestion={**suggestion("custom:dt-3-gate", "DT into 3 Gate", reason="rules"),
                    "passedRules": 3, "ruleCount": 4},
        options=[option("custom:dt-3-gate", "DT into 3 Gate", games=13, wins=8, losses=5),
                 option("pvz-2-stargate-phoenix", "PvZ - 2 Stargate Phoenix")],
    )
    h.accept(_game(key))

    assert h.api.calls_to("get_game_intent") == [((GID,), {"include_options": True})]
    card = _card(h)
    assert card.game_id == GID
    assert card.status == ""
    assert (card.selection, card.reason) == ("custom:dt-3-gate", "rules")
    assert card.reason_label == "Matched 3 of 4 rules"
    assert card.detected_label == "Replay classified as: PvZ - Macro Transition (Unclassified)"
    suggested = [row.key for row in card.featured + card.more if row.suggested]
    assert suggested == ["custom:dt-3-gate"]
    dt = next(row for row in card.featured if row.key == "custom:dt-3-gate")
    assert dt.record == "8–5"
    assert len(h.view.of("show_postgame")) == 1


def test_suggestion_never_overrides_a_touched_selection(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    card_id = _card(h).card_id
    h.ctl.update_draft(card_id, "pvz-chargelot-all-in", "went fine")
    h.pump()
    h.api.games[GID] = game_state(GID, suggestion=suggestion("custom:dt-3-gate"))
    h.accept(_game(key))
    card = _card(h)
    assert card.touched is True
    assert card.selection == "pvz-chargelot-all-in"
    assert card.notes == "went fine"


@pytest.mark.parametrize("row,game_kwargs,wall_shift", [
    ({"created": False}, {}, 0),
    ({"quarantined": True}, {}, 0),
    ({}, {"match_format": "team"}, 0),
    ({}, {"match_format": None}, 0),
    ({}, {"resumed": True}, 0),
    ({}, {}, 16 * 60),
    ({}, {"opponent": "SomeoneElse"}, 0),
])
def test_ineligible_acceptances_get_no_card(h: Harness, row, game_kwargs, wall_shift) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.send(envelope("match_started", key, display_time=45.0))
    h.wall.advance(620 + wall_shift)
    game = _game(key, **game_kwargs)
    h.ctl.on_game_accepted(None, game, GID, {"gameId": GID, "created": True, **row})
    h.pump()
    assert h.api.calls_to("get_game_intent") == []
    assert h.view.of("show_postgame") == []


@pytest.mark.parametrize("offset", [-121, 601])
def test_replay_outside_the_live_window_is_not_matched(h: Harness, offset: int) -> None:
    key = h.new_key()
    _finish(h, key)
    game = cloud_game(GID, started=_key_started(key) + offset)
    h.wall.now = _key_started(key) + offset + 600
    h.accept(game)
    assert h.api.calls_to("get_game_intent") == []


def test_matching_falls_back_to_end_minus_duration(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.api.games[GID] = game_state(GID, suggestion=suggestion("custom:dt-3-gate"))
    h.accept(_game(key, with_started_at=False))
    assert len(h.api.calls_to("get_game_intent")) == 1


def test_clan_tags_and_discriminators_do_not_break_matching(h: Harness) -> None:
    key = h.new_key(names="[oM] Cure#123|Me#123")
    tagged = ("[oM] Cure#123", "Zerg")
    h.send(envelope("match_loading", key, opponent=tagged))
    h.send(envelope("match_ended", key, opponent=tagged, display_time=600.0))
    h.wall.advance(620)
    h.api.games[GID] = game_state(GID, suggestion=suggestion("custom:dt-3-gate"))
    h.accept(_game(key, opponent="Cure"))
    assert len(h.api.calls_to("get_game_intent")) == 1


def test_each_game_id_is_handled_once(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.api.games[GID] = game_state(GID, suggestion=suggestion("custom:dt-3-gate"))
    h.accept(_game(key))
    h.accept(_game(key))
    assert len(h.api.calls_to("get_game_intent")) == 1


def test_accepted_without_a_shell_opens_the_card(h: Harness) -> None:
    """MATCH_ENDED never arrived (e.g. the client closed): the accepted
    replay still gets its card."""
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.send(envelope("match_started", key, display_time=45.0))
    h.send({"type": "liveGameState", "phase": "idle"})
    h.wall.advance(620)
    h.api.games[GID] = game_state(GID, suggestion=suggestion("custom:dt-3-gate"))
    h.accept(_game(key))
    card = _card(h)
    assert card.game_id == GID
    assert card.selection == "custom:dt-3-gate"


@pytest.mark.parametrize("state,reason", [
    (game_state(GID, status="none"), "not_eligible"),
    (game_state(GID, eligible=False, status="confirmed"), "not_eligible"),
    (game_state(GID, status="skipped"), "decided_elsewhere"),
    (game_state(GID, status="confirmed", origin="web",
                build=option("custom:dt-3-gate", "DT into 3 Gate")), "decided_elsewhere"),
])
def test_server_state_that_needs_no_card_retires_the_shell(h: Harness, state, reason) -> None:
    key = h.new_key()
    _finish(h, key)
    card_id = _card(h).card_id
    h.api.games[GID] = state
    h.accept(_game(key))
    assert h.view.of("hide_postgame") == [(card_id, reason)]
    h.ctl.reopen()
    h.pump()
    assert h.opened == ["https://sc2tools.test/app"]


def test_failed_game_read_keeps_the_card_usable(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.api.fail_next("get_game_intent", ConnectionError("offline"))
    h.accept(_game(key))
    card = _card(h)
    assert card.status == STATUS_REPLAY_UNAVAILABLE
    assert card.game_id == GID


def test_accepted_replay_refreshes_prefs_and_records(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    before = len(h.api.calls_to("get_build_options"))
    h.advance(31)
    h.api.games[GID] = game_state(GID)
    h.accept(_game(key))
    assert len(h.api.calls_to("get_checkin_prefs")) == 2
    refetched = [args[0] for args, _ in h.api.calls_to("get_build_options")[before:]]
    assert sorted(refetched) == ["PvP", "PvT", "PvZ"]
    # The card's own request went out before the prefetch.
    names = [name for name, *_ in h.api.calls]
    assert names.index("get_game_intent") < names.index("get_checkin_prefs", 1)


# ----------------------------------------------------- declared at loading


def _declare_and_finish(h: Harness, key: str, build: str = "custom:dt-3-gate") -> None:
    h.send(envelope("match_loading", key))
    h.ctl.declare(key, build)
    h.pump()
    h.send(envelope("match_started", key, display_time=1.0))
    h.send(envelope("match_in_progress", key, display_time=45.0))
    h.end(key)
    h.wall.advance(620)


def test_declared_game_gets_no_card_at_match_end(h: Harness) -> None:
    _declare_and_finish(h, h.new_key())
    assert h.view.of("show_postgame") == []


def test_executed_declaration_gets_no_card(h: Harness) -> None:
    key = h.new_key()
    _declare_and_finish(h, key)
    h.api.games[GID] = game_state(
        GID, status="confirmed", origin="pregame", executed=True,
        build=option("custom:dt-3-gate", "DT into 3 Gate"),
    )
    h.accept(_game(key))
    assert h.view.of("show_postgame") == []


def test_deviated_declaration_gets_the_notes_first_card(h: Harness) -> None:
    key = h.new_key()
    _declare_and_finish(h, key)
    h.api.games[GID] = game_state(
        GID, status="confirmed", origin="pregame", executed=False,
        build=option("custom:dt-3-gate", "DT into 3 Gate"),
        options=[option("custom:dt-3-gate", "DT into 3 Gate"), option("pvz-a", "PvZ - A")],
    )
    h.accept(_game(key))
    card = _card(h)
    assert card.variant == "notes_first"
    assert card.heading == "What happened?"
    assert card.planned_name == "DT into 3 Gate"
    assert card.detected_name == "PvZ - Macro Transition (Unclassified)"
    assert card.prompt == (
        "You planned DT into 3 Gate · replay looked like "
        "PvZ - Macro Transition (Unclassified). What happened?"
    )
    assert card.selection == "custom:dt-3-gate"
    assert [row.key for row in card.featured] == ["custom:dt-3-gate", "pvz-a"]


def test_notes_first_done_without_notes_just_closes(h: Harness) -> None:
    key = h.new_key()
    _declare_and_finish(h, key)
    h.api.games[GID] = game_state(
        GID, status="confirmed", origin="pregame",
        build=option("custom:dt-3-gate", "DT into 3 Gate"),
    )
    h.accept(_game(key))
    card_id = _card(h).card_id
    h.ctl.confirm(card_id, "custom:dt-3-gate", "")
    h.pump()
    assert h.view.of("hide_postgame") == [(card_id, "confirmed")]
    assert h.api.calls_to("put_game_intent") == []


def test_notes_first_done_saves_notes_only(h: Harness) -> None:
    key = h.new_key()
    _declare_and_finish(h, key)
    h.api.games[GID] = game_state(
        GID, status="confirmed", origin="pregame",
        build=option("custom:dt-3-gate", "DT into 3 Gate"),
    )
    h.accept(_game(key))
    card_id = _card(h).card_id
    h.ctl.confirm(card_id, "custom:dt-3-gate", "Zergling flood at 3:00")
    h.pump()
    assert h.api.calls_to("put_game_intent") == [
        ((GID, {"action": "notes", "notes": "Zergling flood at 3:00"}), {}),
    ]
    assert h.view.of("hide_postgame") == [(card_id, "confirmed")]


def test_notes_first_change_build_confirms_the_new_build(h: Harness) -> None:
    key = h.new_key()
    _declare_and_finish(h, key)
    h.api.games[GID] = game_state(
        GID, status="confirmed", origin="pregame",
        build=option("custom:dt-3-gate", "DT into 3 Gate"),
    )
    h.accept(_game(key))
    card_id = _card(h).card_id
    h.ctl.confirm(card_id, "pvz-2-stargate-phoenix", "")
    h.pump()
    body = h.api.calls_to("put_game_intent")[0][0][1]
    assert body == {"action": "confirm", "buildKey": "pvz-2-stargate-phoenix"}


def test_lost_declaration_is_preselected_and_sent_on_confirm(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.api.fail_next("put_live_intent", ConnectionError("offline"), times=1)
    h.ctl.declare(key, "custom:dt-3-gate")
    h.pump()
    h.send(envelope("match_started", key, display_time=45.0))
    h.end(key)

    card = _card(h)
    assert (card.selection, card.reason) == ("custom:dt-3-gate", "declared")
    assert card.reason_label == "Your pick at loading"

    # The server never got the pick: its suggestion says something else.
    h.wall.advance(620)
    h.api.games[GID] = game_state(GID, suggestion=suggestion("pvz-2-stargate-phoenix"))
    h.accept(_game(key))
    card = _card(h)
    assert (card.selection, card.reason) == ("custom:dt-3-gate", "declared")
    h.ctl.confirm(card.card_id, card.selection, "")
    h.pump()
    assert h.api.calls_to("put_game_intent")[-1][0][1] == {
        "action": "confirm", "buildKey": "custom:dt-3-gate",
    }


def test_declaration_the_server_has_defers_to_its_suggestion(h: Harness) -> None:
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.api.fail_next("put_live_intent", ConnectionError("offline"), times=1)
    h.ctl.declare(key, "custom:dt-3-gate")
    h.pump()
    h.end(key)
    h.wall.advance(620)
    h.api.games[GID] = game_state(
        GID, suggestion=suggestion("custom:dt-3-gate", "DT into 3 Gate", reason="declared"),
    )
    h.accept(_game(key))
    card = _card(h)
    assert (card.selection, card.reason) == ("custom:dt-3-gate", "declared")


# ---------------------------------------------------------------- saving


def test_confirm_before_ingest_answers_on_the_live_record(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    card_id = _card(h).card_id
    h.ctl.confirm(card_id, "custom:dt-3-gate", "Blink stalkers")
    h.pump()
    assert h.api.live_bodies()[-1] == {
        "action": "postgame", "buildKey": "custom:dt-3-gate", "notes": "Blink stalkers",
    }
    assert h.view.of("hide_postgame") == [(card_id, "confirmed")]


def test_confirm_switches_to_the_game_when_already_bound(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    card_id = _card(h).card_id
    h.api.live[key]["gameId"] = GID
    h.ctl.confirm(card_id, "custom:dt-3-gate", "")
    h.pump()
    assert h.api.calls_to("put_game_intent") == [
        ((GID, {"action": "confirm", "buildKey": "custom:dt-3-gate"}), {}),
    ]
    assert h.view.of("hide_postgame") == [(card_id, "confirmed")]


def test_confirm_after_ingest_uses_the_game_and_clears_the_matchup_cache(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.api.games[GID] = game_state(GID, suggestion=suggestion("custom:dt-3-gate"))
    h.accept(_game(key))
    card_id = _card(h).card_id
    options_calls = len(h.api.calls_to("get_build_options"))
    h.ctl.confirm(card_id, "custom:dt-3-gate", "  ")
    h.pump()
    assert h.api.calls_to("put_game_intent")[-1][0] == (
        GID, {"action": "confirm", "buildKey": "custom:dt-3-gate", "notes": "  "},
    )
    assert h.view.of("hide_postgame") == [(card_id, "confirmed")]
    h.send(envelope("match_loading", h.new_key()))
    assert [a[0] for a, _ in h.api.calls_to("get_build_options")[options_calls:]] == ["PvZ"]


def test_confirm_shows_busy_until_saved() -> None:
    executor = ManualExecutor()
    h = Harness(executor=executor, prefs=CheckinPrefs(enabled=True, ask_at_loading=True, ask_after_game=True))
    key = h.new_key()
    _finish(h, key)
    executor.run_all()
    h.pump()
    card_id = _card(h).card_id
    h.ctl.confirm(card_id, "custom:dt-3-gate", "")
    h.ctl.confirm(card_id, "custom:dt-3-gate", "")  # double click
    h.pump()
    assert _card(h).busy is True
    executor.run_all()
    h.pump()
    assert h.api.live_actions().count("postgame") == 1
    assert h.view.of("hide_postgame") == [(card_id, "confirmed")]


@pytest.mark.parametrize("error,status", [
    (ConnectionError("offline"), STATUS_SAVE_FAILED),
    (api_error(503, "unavailable"), STATUS_SAVE_FAILED),
    (api_error(400, "unknown_build"), STATUS_SAVE_UNKNOWN_BUILD),
])
def test_failed_confirm_keeps_the_card_with_an_error(h: Harness, error, status) -> None:
    key = h.new_key()
    _finish(h, key)
    h.api.games[GID] = game_state(GID)
    h.accept(_game(key))
    card_id = _card(h).card_id
    h.api.fail_next("put_game_intent", error)
    h.ctl.confirm(card_id, "custom:dt-3-gate", "notes")
    h.pump()
    card = _card(h)
    assert card.status == status
    assert card.busy is False
    assert card.notes == "notes"
    assert h.view.of("hide_postgame") == []
    # Trying again works.
    h.ctl.confirm(card_id, "custom:dt-3-gate", "notes")
    h.pump()
    assert h.view.of("hide_postgame") == [(card_id, "confirmed")]


def test_not_eligible_on_confirm_retires_the_card(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.api.games[GID] = game_state(GID)
    h.accept(_game(key))
    card_id = _card(h).card_id
    h.api.fail_next("put_game_intent", api_error(409, "not_eligible", reason="too_short"))
    h.ctl.confirm(card_id, "custom:dt-3-gate", "")
    h.pump()
    assert h.view.of("hide_postgame") == [(card_id, "not_eligible")]


def test_no_set_build_skips(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    card_id = _card(h).card_id
    h.ctl.no_set_build(card_id, "")
    h.pump()
    assert h.api.live_bodies()[-1] == {"action": "postgame", "skip": True}
    assert h.view.of("hide_postgame") == [(card_id, "skipped")]


def test_no_set_build_after_ingest_skips_the_game(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.api.games[GID] = game_state(GID, notes="old")
    h.accept(_game(key))
    card_id = _card(h).card_id
    assert _card(h).notes == "old"
    h.ctl.no_set_build(card_id, "")
    h.pump()
    assert h.api.calls_to("put_game_intent")[-1][0] == (GID, {"action": "skip", "notes": ""})


# ----------------------------------------------------- Later / auto-hide


def test_later_keeps_the_draft_and_flushes_notes_once_the_game_is_known(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    card_id = _card(h).card_id
    h.ctl.later(card_id, "Proxy gates")
    h.pump()
    assert h.view.of("hide_postgame") == [(card_id, "later")]
    assert h.api.calls_to("put_game_intent") == []

    h.api.games[GID] = game_state(GID)
    h.accept(_game(key))
    assert h.api.calls_to("put_game_intent") == [
        ((GID, {"action": "notes", "notes": "Proxy gates"}), {}),
    ]
    # Later is respected: the filled-in card does not pop back up.
    assert len(h.view.of("show_postgame")) == 1


def test_later_after_ingest_flushes_notes_immediately(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.api.games[GID] = game_state(GID)
    h.accept(_game(key))
    card_id = _card(h).card_id
    h.ctl.later(card_id, "Proxy gates")
    h.ctl.later(card_id, "Proxy gates")
    h.pump()
    assert h.api.calls_to("put_game_intent") == [
        ((GID, {"action": "notes", "notes": "Proxy gates"}), {}),
    ]


def test_later_without_notes_writes_nothing(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.api.games[GID] = game_state(GID)
    h.accept(_game(key))
    h.ctl.later(_card(h).card_id, "")
    h.pump()
    assert h.api.calls_to("put_game_intent") == []


def test_card_auto_hides_after_two_idle_minutes(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    card_id = _card(h).card_id
    h.advance(POSTGAME_IDLE_HIDE_SEC - 10)
    h.ctl.interacted(card_id)
    h.pump()
    h.advance(POSTGAME_IDLE_HIDE_SEC - 1)
    assert h.view.of("hide_postgame") == []
    h.advance(1)
    assert h.view.of("hide_postgame") == [(card_id, "timeout")]


def test_auto_hide_never_interrupts_a_save() -> None:
    executor = ManualExecutor()
    h = Harness(executor=executor, prefs=CheckinPrefs(enabled=True, ask_at_loading=True, ask_after_game=True))
    key = h.new_key()
    _finish(h, key)
    executor.run_all()
    h.pump()
    card_id = _card(h).card_id
    h.ctl.confirm(card_id, "custom:dt-3-gate", "")
    h.pump()
    h.advance(POSTGAME_IDLE_HIDE_SEC * 2)
    assert h.view.of("hide_postgame") == []
    executor.run_all()
    h.pump()
    assert h.view.of("hide_postgame") == [(card_id, "confirmed")]


# --------------------------------------------------------------- pre-emption


def test_next_game_preempts_and_a_touched_card_returns_once(h: Harness) -> None:
    first = h.new_key()
    _finish(h, first)
    first_card = _card(h).card_id
    h.ctl.update_draft(first_card, "pvz-chargelot-all-in", "draft notes")
    h.pump()

    second = h.new_key()
    h.send(envelope("match_loading", second))
    assert h.view.of("hide_postgame") == [(first_card, "preempted")]
    assert h.view.last("show_loading").game_key == second

    # Game 2 ends: its own card first, then game 1's card returns.
    h.send(envelope("match_started", second, display_time=45.0))
    h.end(second)
    second_card = _card(h).card_id
    assert second_card != first_card
    h.ctl.no_set_build(second_card, "")
    h.pump()
    returned = h.view.last("show_postgame")
    assert returned.card_id == first_card
    assert returned.selection == "pvz-chargelot-all-in"
    assert returned.notes == "draft notes"
    assert returned.touched is True

    # Pre-empted again by game 3: not shown a third time.
    third = h.new_key()
    h.send(envelope("match_loading", third))
    h.send(envelope("match_started", third, display_time=45.0))
    h.end(third)
    third_card = _card(h).card_id
    h.ctl.no_set_build(third_card, "")
    h.pump()
    assert [m.card_id for m in h.view.of("show_postgame")] == [
        first_card, second_card, first_card, third_card,
    ]


def test_untouched_preempted_card_is_left_to_the_web(h: Harness) -> None:
    first = h.new_key()
    _finish(h, first)
    first_card = _card(h).card_id
    second = h.new_key()
    h.send(envelope("match_loading", second))
    h.send(envelope("match_started", second, display_time=45.0))
    h.end(second)
    h.ctl.no_set_build(_card(h).card_id, "")
    h.pump()
    assert first_card not in [m.card_id for m in h.view.of("show_postgame")][1:]


def test_preempted_notes_flush_when_the_game_is_known(h: Harness) -> None:
    first = h.new_key()
    _finish(h, first)
    h.api.games[GID] = game_state(GID)
    h.accept(_game(first))
    card_id = _card(h).card_id
    h.ctl.update_draft(card_id, None, "Lost the probe")
    h.pump()
    h.send(envelope("match_loading", h.new_key()))
    assert h.api.calls_to("put_game_intent") == [
        ((GID, {"action": "notes", "notes": "Lost the probe"}), {}),
    ]


def test_replay_accepted_mid_game_waits_for_the_match_to_end(h: Harness) -> None:
    first = h.new_key()
    _declare_and_finish(h, first)
    second = h.new_key()
    h.send(envelope("match_loading", second))
    h.api.games[GID] = game_state(
        GID, status="confirmed", origin="pregame",
        build=option("custom:dt-3-gate", "DT into 3 Gate"),
    )
    h.accept(_game(first))
    assert h.view.of("show_postgame") == []

    h.send(envelope("match_started", second, display_time=45.0))
    h.send({"type": "liveGameState", "phase": "menu"})
    shown = h.view.of("show_postgame")
    assert [m.variant for m in shown] == ["notes_first"]


def test_waiting_cards_expire(h: Harness) -> None:
    """A card that never got the window (its replay landed mid-game) is
    left to the web queue once it is half an hour old."""
    first = h.new_key()
    _declare_and_finish(h, first)
    second = h.new_key()
    h.send(envelope("match_loading", second))
    h.api.games[GID] = game_state(
        GID, status="confirmed", origin="pregame",
        build=option("custom:dt-3-gate", "DT into 3 Gate"),
    )
    h.accept(_game(first))
    h.send(envelope("match_started", second, display_time=45.0))
    h.advance(PENDING_CARD_MAX_AGE_SEC + 1)
    h.send({"type": "liveGameState", "phase": "menu"})
    assert h.view.of("show_postgame") == []


@pytest.mark.parametrize("minutes", [28, 45])
def test_touched_preempted_card_returns_after_a_long_next_match(h: Harness, minutes: int) -> None:
    first = h.new_key()
    _finish(h, first)
    first_card = _card(h).card_id
    h.ctl.update_draft(first_card, "pvz-chargelot-all-in", "draft notes")
    h.pump()
    second = h.new_key()
    h.send(envelope("match_loading", second))
    h.send(envelope("match_started", second, display_time=45.0))
    h.advance(minutes * 60)
    h.end(second)
    second_card = _card(h).card_id
    h.ctl.no_set_build(second_card, "")
    h.pump()
    returned = h.view.last("show_postgame")
    assert returned.card_id == first_card
    assert (returned.selection, returned.notes) == ("pvz-chargelot-all-in", "draft notes")


def test_preempted_card_is_not_kept_forever(h: Harness) -> None:
    first = h.new_key()
    _finish(h, first)
    first_card = _card(h).card_id
    h.ctl.interacted(first_card)
    h.pump()
    second = h.new_key()
    h.send(envelope("match_loading", second))
    h.send(envelope("match_started", second, display_time=45.0))
    h.advance(RESHOW_MAX_WAIT_SEC + 1)
    h.send({"type": "liveGameState", "phase": "menu"})
    assert [m.card_id for m in h.view.of("show_postgame")] == [first_card]


# ---------------------------------------------------------------- reopen


def test_reopen_brings_back_the_newest_undecided_card(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    card_id = _card(h).card_id
    h.ctl.later(card_id, "half-written")
    h.pump()
    h.ctl.reopen()
    h.pump()
    model = h.view.last("show_postgame")
    assert model.card_id == card_id
    assert model.notes == "half-written"
    assert h.opened == []


def test_reopen_raises_the_visible_card(h: Harness) -> None:
    _finish(h, h.new_key())
    h.ctl.reopen()
    h.pump()
    assert len(h.view.of("show_postgame")) == 2
    assert h.view.of("hide_postgame") == []


def test_reopen_without_cards_opens_the_web_queue(h: Harness) -> None:
    h.ctl.reopen()
    h.pump()
    assert h.opened == ["https://sc2tools.test/app"]


def test_reopen_when_disabled_opens_the_web_queue(h: Harness) -> None:
    _finish(h, h.new_key())
    h.ctl.set_prefs(enabled=False)
    h.pump()
    h.ctl.reopen()
    h.pump()
    assert h.opened == ["https://sc2tools.test/app"]


# ------------------------------------------------------- server changes


def test_web_confirmation_retires_the_open_card(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.api.games[GID] = game_state(GID, options=[option("custom:dt-3-gate", "DT into 3 Gate")])
    h.accept(_game(key))
    card_id = _card(h).card_id
    h.api.games[GID] = game_state(
        GID, status="confirmed", origin="web",
        build=option("custom:dt-3-gate", "DT into 3 Gate"),
    )
    h.ctl.on_intent_changed({"gameId": GID})
    h.pump()
    assert h.view.of("hide_postgame") == [(card_id, "decided_elsewhere")]
    assert h.api.calls_to("get_game_intent")[-1] == ((GID,), {"include_options": False})


def test_disabling_after_games_sets_the_card_aside(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    card_id = _card(h).card_id
    h.ctl.disable("postgame")
    h.pump()
    assert h.view.of("hide_postgame") == [(card_id, "disabled")]
    assert h.api.calls_to("put_checkin_prefs")[-1][0][0]["askAfterGame"] is False


def test_a_game_state_older_than_a_save_never_reverts_it(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.ctl.set_prefs(ask_at_loading=False)
    h.pump()
    reads = len(h.api.calls_to("get_checkin_prefs"))
    # This state was answered before that save landed.
    h.api.games[GID] = game_state(GID, prefs={"enabled": True, "askAtLoading": True})
    h.accept(_game(key))
    assert h.ctl.prefs.ask_at_loading is False
    assert len(h.api.calls_to("get_checkin_prefs")) == reads + 1


def test_server_disabling_check_ins_hides_cards(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    card_id = _card(h).card_id
    # Turned off elsewhere: the game state says so, and so does the read it
    # prompts.
    h.api.prefs = {"enabled": False, "askAtLoading": True, "askAfterGame": True}
    h.api.games[GID] = game_state(GID, prefs={"enabled": False})
    h.accept(_game(key))
    assert h.view.of("hide_postgame") == [(card_id, "disabled")]


def test_unknown_or_finished_cards_ignore_actions(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    card_id = _card(h).card_id
    h.ctl.no_set_build(card_id, "")
    h.pump()
    calls = len(h.api.calls)
    for action in (h.ctl.confirm, h.ctl.no_set_build, h.ctl.later):
        action(card_id, "")  # type: ignore[call-arg]
        action("nope", "")  # type: ignore[call-arg]
    h.ctl.interacted("nope")
    h.ctl.update_draft("nope", "x", "y")
    h.pump()
    assert len(h.api.calls) == calls


def test_set_view_reshows_the_visible_card(h: Harness) -> None:
    from tests.build_checkin_fakes import FakeView

    _finish(h, h.new_key())
    late = FakeView()
    h.ctl.set_view(late)
    h.pump()
    assert len(late.of("show_postgame")) == 1


def test_intro_flag_reaches_the_end_card() -> None:
    h = Harness(intro_seen=False).boot()
    _finish(h, h.new_key())
    assert _card(h).show_intro is True
    h.ctl.dismiss_intro()
    h.pump()
    assert _card(h).show_intro is False


def test_notes_are_capped_locally(h: Harness) -> None:
    _finish(h, h.new_key())
    card_id = _card(h).card_id
    h.ctl.update_draft(card_id, None, "x" * 1500)
    h.ctl.later(card_id, "y" * 1500)
    h.pump()
    h.ctl.reopen()
    h.pump()
    assert len(h.view.last("show_postgame").notes) == 1000


def test_wall_clock_constant_is_sane() -> None:
    # Guards the fakes: keys and replay dates share one clock.
    assert replace(cloud_game("g", started=WALL_START)).date_iso.endswith("Z")


def test_decided_elsewhere_never_overwrites_server_notes(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.api.games[GID] = game_state(GID, options=[option("custom:dt-3-gate")])
    h.accept(_game(key))
    card_id = _card(h).card_id
    h.ctl.update_draft(card_id, None, "agent draft")
    h.pump()
    h.api.games[GID] = game_state(GID, status="skipped", notes="typed on the web")
    h.ctl.on_intent_changed({"gameId": GID})
    h.pump()
    assert h.view.of("hide_postgame") == [(card_id, "decided_elsewhere")]
    assert h.api.calls_to("put_game_intent") == []


def test_decided_elsewhere_keeps_a_draft_when_the_server_has_no_notes(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.api.games[GID] = game_state(GID, options=[option("custom:dt-3-gate")])
    h.accept(_game(key))
    card_id = _card(h).card_id
    h.ctl.update_draft(card_id, None, "agent draft")
    h.pump()
    h.api.games[GID] = game_state(GID, status="skipped")
    h.ctl.on_intent_changed({"gameId": GID})
    h.pump()
    assert h.api.calls_to("put_game_intent") == [
        ((GID, {"action": "notes", "notes": "agent draft"}), {}),
    ]


def test_answered_card_does_not_refetch_on_accept(h: Harness) -> None:
    key = h.new_key()
    _finish(h, key)
    h.ctl.confirm(_card(h).card_id, "custom:dt-3-gate", "")
    h.pump()
    h.accept(_game(key))
    assert h.api.calls_to("get_game_intent") == []


def test_match_end_refreshes_prefs(h: Harness) -> None:
    h.advance(31)
    _finish(h, h.new_key())
    assert len(h.api.calls_to("get_checkin_prefs")) == 2


# ------------------------------------------------ review regressions


def test_already_bound_after_the_acceptance_bound_the_card_reroutes() -> None:
    """The upload's acceptance reaches the state thread before the 409 of
    the live answer: the answer still goes to the game."""
    executor = ManualExecutor()
    h = Harness(executor=executor, prefs=CheckinPrefs(enabled=True, ask_at_loading=True, ask_after_game=True))
    h.boot()
    key = h.new_key()
    h.play(key)
    while executor.jobs:
        executor.run_all()
        h.pump()
    card_id = _card(h).card_id
    h.ctl.confirm(card_id, "custom:dt-3-gate", "")
    h.pump()
    put = len(executor.jobs) - 1  # the live postgame write, not sent yet
    h.api.live[key]["gameId"] = GID
    h.api.games[GID] = game_state(GID)
    h.wall.advance(620)
    h.accept(_game(key))
    executor.run(put)  # → 409 already_bound {gameId}
    h.pump()
    while executor.jobs:
        executor.run_all()
        h.pump()
    assert [args for args, _ in h.api.calls_to("put_game_intent")] == [
        (GID, {"action": "confirm", "buildKey": "custom:dt-3-gate"}),
    ]
    assert h.view.of("hide_postgame") == [(card_id, "confirmed")]


def _failed_declare(h: Harness, key: str) -> None:
    h.send(envelope("match_loading", key))
    h.api.fail_next("put_live_intent", ConnectionError("offline"))
    h.ctl.declare(key, "custom:dt-3-gate")
    h.pump()
    h.send(envelope("match_started", key, display_time=45.0))


def _without_end_cards() -> Harness:
    h = Harness()
    h.api.prefs["askAfterGame"] = False
    return h.boot()


def test_undelivered_pick_is_sent_after_the_game_when_end_cards_are_off() -> None:
    h = _without_end_cards()
    key = h.new_key()
    _failed_declare(h, key)
    h.end(key)
    assert h.view.of("show_postgame") == []
    assert h.api.live_bodies()[-1] == {"action": "postgame", "buildKey": "custom:dt-3-gate"}
    assert h.api.live[key]["postgame"]["buildKey"] == "custom:dt-3-gate"
    # Delivered: the replay's acceptance does not send it again.
    h.wall.advance(620)
    h.api.games[GID] = game_state(GID)
    h.accept(_game(key))
    assert h.api.calls_to("put_game_intent") == []


def test_undelivered_pick_goes_to_the_game_once_bound() -> None:
    h = _without_end_cards()
    key = h.new_key()
    _failed_declare(h, key)
    h.api.live[key]["gameId"] = GID
    h.end(key)
    assert [args for args, _ in h.api.calls_to("put_game_intent")] == [
        (GID, {"action": "confirm", "buildKey": "custom:dt-3-gate"}),
    ]


def test_undelivered_pick_is_retried_when_the_replay_is_accepted() -> None:
    h = _without_end_cards()
    key = h.new_key()
    _failed_declare(h, key)
    h.api.fail_next("put_live_intent", ConnectionError("still offline"))
    h.end(key)
    h.wall.advance(620)
    h.api.games[GID] = game_state(GID)
    h.accept(_game(key))
    assert [args for args, _ in h.api.calls_to("put_game_intent")] == [
        (GID, {"action": "confirm", "buildKey": "custom:dt-3-gate"}),
    ]
    assert h.view.of("show_postgame") == []


def test_declare_failing_after_the_match_ended_is_still_resent() -> None:
    executor = ManualExecutor()
    h = Harness(executor=executor)
    h.api.prefs["askAfterGame"] = False
    h.boot()
    while executor.jobs:
        executor.run_all()
        h.pump()
    key = h.new_key()
    h.send(envelope("match_loading", key))
    while executor.jobs:
        executor.run_all()
        h.pump()
    h.api.fail_next("put_live_intent", ConnectionError("offline"))
    h.ctl.declare(key, "custom:dt-3-gate")
    h.pump()
    h.send(envelope("match_started", key, display_time=45.0))
    h.end(key)
    while executor.jobs:  # the declare fails only now
        executor.run_all()
        h.pump()
    assert h.api.live_bodies()[-1] == {"action": "postgame", "buildKey": "custom:dt-3-gate"}


def test_with_end_cards_on_the_card_carries_the_undelivered_pick(h: Harness) -> None:
    key = h.new_key()
    _failed_declare(h, key)
    h.end(key)
    assert "postgame" not in h.api.live_actions()
    assert (_card(h).selection, _card(h).reason) == ("custom:dt-3-gate", "declared")


def test_a_rejected_resend_is_not_retried() -> None:
    h = _without_end_cards()
    key = h.new_key()
    _failed_declare(h, key)
    h.api.fail_next("put_live_intent", api_error(400, "unknown_build"))
    h.end(key)
    h.wall.advance(620)
    h.api.games[GID] = game_state(GID)
    h.accept(_game(key))
    assert h.api.calls_to("put_game_intent") == []


def test_resync_bursts_never_force_list_refetches(h: Harness) -> None:
    h.send(envelope("match_loading", h.new_key()))
    before = len(h.api.calls_to("get_build_options"))
    assert before == 3
    for index in range(10):
        game = cloud_game(f"old-{index}", started=WALL_START - 86_400 * (index + 1))
        h.ctl.on_game_accepted(None, game, game.game_id, {"created": False})
        h.ctl.on_game_accepted(None, game, f"stale-{index}", {"created": True})
    h.pump()
    assert len(h.api.calls_to("get_build_options")) == before
    h.advance(OPTIONS_TTL_SEC + 1)
    for index in range(10):
        game = cloud_game(f"later-{index}", started=WALL_START - 86_400)
        h.ctl.on_game_accepted(None, game, game.game_id, {"created": False})
    h.pump()
    assert len(h.api.calls_to("get_build_options")) == before + 3

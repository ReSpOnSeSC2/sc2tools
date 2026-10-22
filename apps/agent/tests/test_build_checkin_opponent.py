"""The end card's opponent row and **Add new build…** (contract addendum
§B.2): what the card shows once the replay is in, when an answer carries
``opponentBuildKey``, and how the card steps aside for the website."""

from __future__ import annotations

from urllib.parse import quote

import pytest

from sc2tools_agent.build_checkin.models import (
    ADD_NEW_BUILD_HINT,
    ADD_NEW_BUILD_UNAVAILABLE,
    STATUS_SAVE_UNKNOWN_OPPONENT_BUILD,
)
from tests.build_checkin_fakes import (
    OPP_OPTIONS,
    Harness,
    api_error,
    cloud_game,
    envelope,
    game_state,
    opponent_state,
    option,
    suggestion,
)

GID = "2026-10-22T18:10:00Z|Foo|Map|600"
PHOENIX = "pvz-2-stargate-phoenix"


@pytest.fixture
def h() -> Harness:
    return Harness().boot()


def _card(h: Harness):
    return h.view.last("show_postgame", "update_postgame")


def _game(key: str):
    return cloud_game(GID, started=int(key.rsplit("|", 1)[1]) / 1000 + 8)


def _accepted(h: Harness, *, opponent=None, **state) -> str:
    """A full end card whose replay is in; returns its card id."""
    key = h.new_key()
    h.play(key)
    h.wall.advance(620)
    h.api.games[GID] = game_state(
        GID,
        suggestion=suggestion(PHOENIX, "PvZ - 2 Stargate Phoenix"),
        opponent=opponent if opponent is not None else opponent_state(options=OPP_OPTIONS),
        **state,
    )
    h.accept(_game(key))
    return _card(h).card_id


def _declared_card(h: Harness, *, opponent=None) -> str:
    """A notes-first card (declared at loading, replay disagreed)."""
    key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.declare(key, "custom:dt-3-gate")
    h.pump()
    h.send(envelope("match_started", key, display_time=45.0))
    h.end(key)
    h.wall.advance(620)
    h.api.games[GID] = game_state(
        GID, status="confirmed", origin="pregame",
        build=option("custom:dt-3-gate", "DT into 3 Gate"),
        opponent=opponent if opponent is not None else opponent_state(options=OPP_OPTIONS),
    )
    h.accept(_game(key))
    return _card(h).card_id


def _game_bodies(h: Harness):
    return [args[1] for args, _ in h.api.calls_to("put_game_intent")]


# ------------------------------------------------------------- the row


def test_no_opponent_row_and_no_add_build_before_the_replay(h: Harness) -> None:
    h.play(h.new_key())
    card = _card(h)
    assert card.opponent is None
    assert card.can_add_build is False
    assert card.add_build_hint == ADD_NEW_BUILD_UNAVAILABLE
    assert card.add_build_label == "Add new build…"


def test_opponent_row_appears_once_the_replay_is_in(h: Harness) -> None:
    _accepted(h)
    card = _card(h)
    opp = card.opponent
    assert opp is not None
    assert opp.label == "Opponent's build: Zerg - 12 Pool"
    assert (opp.selection, opp.server_key, opp.replay_key) == (
        "zerg-12-pool", "zerg-12-pool", "zerg-12-pool",
    )
    assert opp.changed is False and opp.corrected is False
    assert opp.show_use_replay is False and opp.detected_label is None
    assert [row.key for row in opp.featured] == ["zerg-12-pool", "custom:ling-flood"]
    assert [row.key for row in opp.more] == ["zvp-roach-rush", "zvp-ling-bane-bust"]
    assert opp.featured[0].record == "2–1"
    assert (opp.featured_title, opp.more_title, opp.search_placeholder) == (
        "FACED BEFORE", "ALL BUILDS", "Search opponent builds",
    )
    assert card.can_add_build is True
    assert card.add_build_hint == ADD_NEW_BUILD_HINT


def test_a_correction_shows_with_the_replays_label_beside_it(h: Harness) -> None:
    _accepted(h, opponent=opponent_state(
        options=OPP_OPTIONS,
        build={"key": "zvp-roach-rush", "name": "ZvP - Roach Rush", "slug": None,
               "source": "catalog"},
    ))
    opp = _card(h).opponent
    assert opp.label == "Opponent's build: ZvP - Roach Rush"
    assert opp.corrected is True and opp.changed is False
    assert opp.selection == "zvp-roach-rush"
    assert opp.detected_label == "Replay classified as: Zerg - 12 Pool"
    assert opp.show_use_replay is True


def test_an_unclassified_opponent_is_named_by_the_replay(h: Harness) -> None:
    _accepted(h, opponent=opponent_state(
        label="Zerg Standard Play (Unclassified)",
        detected="Zerg Standard Play (Unclassified)", detected_key=None,
        options=OPP_OPTIONS,
        suggestion=suggestion("zvp-roach-rush", "ZvP - Roach Rush", reason="rules"),
    ))
    opp = _card(h).opponent
    assert opp.label == "Opponent's build: Zerg Standard Play (Unclassified)"
    assert opp.selection is None and opp.show_use_replay is False
    suggested = [row.key for row in opp.featured + opp.more if row.suggested]
    assert suggested == ["zvp-roach-rush"]


def test_game_without_an_opponent_axis_has_no_row(h: Harness) -> None:
    key = h.new_key()
    h.play(key)
    h.wall.advance(620)
    h.api.games[GID] = game_state(GID)
    h.accept(_game(key))
    assert _card(h).opponent is None
    assert _card(h).can_add_build is True


def test_picking_an_opponent_build_repaints_the_row(h: Harness) -> None:
    card_id = _accepted(h)
    h.view.clear()
    h.ctl.update_draft(card_id, PHOENIX, "", "zvp-roach-rush")
    h.pump()
    opp = h.view.last("update_postgame").opponent
    assert opp.label == "Opponent's build: ZvP - Roach Rush"
    assert opp.changed is True and opp.touched is True
    assert opp.detected_label == "Replay classified as: Zerg - 12 Pool"
    # Typing notes afterwards does not repaint the card.
    h.view.clear()
    h.ctl.update_draft(card_id, PHOENIX, "n", "zvp-roach-rush")
    h.pump()
    assert h.view.calls == []


def test_a_server_refresh_never_moves_a_touched_opponent_pick(h: Harness) -> None:
    card_id = _accepted(h)
    h.ctl.update_draft(card_id, PHOENIX, "", "zvp-roach-rush")
    h.pump()
    h.api.games[GID]["opponent"] = opponent_state(
        build={"key": "custom:ling-flood", "name": "Ling flood", "slug": "ling-flood",
               "source": "custom"},
    )
    h.ctl.on_intent_changed({"gameId": GID})
    h.pump()
    opp = _card(h).opponent
    assert opp.selection == "zvp-roach-rush"
    # The list rows survive a refresh that did not ask for them.
    assert len(opp.featured + opp.more) == 4


def test_an_untouched_row_follows_a_correction_made_on_the_web(h: Harness) -> None:
    _accepted(h)
    h.api.games[GID]["opponent"] = opponent_state(
        options=OPP_OPTIONS,
        build={"key": "custom:ling-flood", "name": "Ling flood", "slug": "ling-flood",
               "source": "custom"},
    )
    h.ctl.on_intent_changed({"gameId": GID})
    h.pump()
    opp = _card(h).opponent
    assert opp.label == "Opponent's build: Ling flood"
    assert opp.selection == "custom:ling-flood" and opp.changed is False


# ------------------------------------------------------------- answers


def test_confirm_leaves_the_opponent_alone_when_untouched(h: Harness) -> None:
    card_id = _accepted(h)
    h.ctl.confirm(card_id, PHOENIX, "")
    h.pump()
    assert _game_bodies(h) == [{"action": "confirm", "buildKey": PHOENIX}]


def test_confirm_with_the_same_opponent_sends_nothing_extra(h: Harness) -> None:
    card_id = _accepted(h)
    h.ctl.confirm(card_id, PHOENIX, "", "zerg-12-pool")
    h.pump()
    assert _game_bodies(h) == [{"action": "confirm", "buildKey": PHOENIX}]
    assert h.view.of("hide_postgame") == [(card_id, "confirmed")]


def test_confirm_carries_a_changed_opponent(h: Harness) -> None:
    card_id = _accepted(h)
    h.ctl.confirm(card_id, PHOENIX, "Went roaches", "zvp-roach-rush")
    h.pump()
    assert _game_bodies(h) == [{
        "action": "confirm", "buildKey": PHOENIX, "notes": "Went roaches",
        "opponentBuildKey": "zvp-roach-rush",
    }]
    assert h.api.games[GID]["opponent"]["build"]["key"] == "zvp-roach-rush"


def test_confirm_uses_the_drafted_opponent(h: Harness) -> None:
    card_id = _accepted(h)
    h.ctl.update_draft(card_id, PHOENIX, "", "custom:ling-flood")
    h.ctl.later(card_id, "")
    h.ctl.reopen()
    h.pump()
    assert _card(h).opponent.selection == "custom:ling-flood"
    h.ctl.confirm(card_id, PHOENIX, "")
    h.pump()
    assert _game_bodies(h)[-1]["opponentBuildKey"] == "custom:ling-flood"


def test_no_set_build_carries_a_changed_opponent(h: Harness) -> None:
    card_id = _accepted(h)
    h.ctl.no_set_build(card_id, "", "zvp-ling-bane-bust")
    h.pump()
    assert _game_bodies(h) == [{"action": "skip", "opponentBuildKey": "zvp-ling-bane-bust"}]
    assert h.view.of("hide_postgame") == [(card_id, "skipped")]


CORRECTED = {"key": "zvp-roach-rush", "name": "ZvP - Roach Rush", "slug": None,
             "source": "catalog"}


def test_using_the_replays_label_removes_a_correction(h: Harness) -> None:
    card_id = _accepted(h, opponent=opponent_state(options=OPP_OPTIONS, build=CORRECTED))
    # The view selects the replay's own row: the correction is cleared.
    h.ctl.confirm(card_id, PHOENIX, "", "zerg-12-pool")
    h.pump()
    body = _game_bodies(h)[-1]
    assert "opponentBuildKey" in body and body["opponentBuildKey"] is None
    assert h.api.games[GID]["opponent"]["applied"] is False


def test_replays_label_that_is_not_an_option_is_sent_as_null(h: Harness) -> None:
    card_id = _accepted(h, opponent=opponent_state(
        detected="Zerg Standard Play (Unclassified)", detected_key=None,
        options=OPP_OPTIONS, build=CORRECTED,
    ))
    h.ctl.update_draft(card_id, PHOENIX, "", None)
    h.pump()
    opp = _card(h).opponent
    assert opp.label == "Opponent's build: Zerg Standard Play (Unclassified)"
    assert opp.changed is True and opp.show_use_replay is False
    h.ctl.confirm(card_id, PHOENIX, "")
    h.pump()
    body = _game_bodies(h)[-1]
    assert "opponentBuildKey" in body and body["opponentBuildKey"] is None


def test_replays_label_without_a_correction_changes_nothing(h: Harness) -> None:
    card_id = _accepted(h, opponent=opponent_state(
        label="Zerg Standard Play (Unclassified)",
        detected="Zerg Standard Play (Unclassified)", detected_key=None,
        options=OPP_OPTIONS,
    ))
    h.ctl.confirm(card_id, PHOENIX, "", None)
    h.pump()
    assert "opponentBuildKey" not in _game_bodies(h)[-1]


def test_unknown_opponent_build_keeps_the_card_with_its_message(h: Harness) -> None:
    card_id = _accepted(h)
    h.api.fail_next("put_game_intent", api_error(400, "unknown_opponent_build"))
    h.ctl.confirm(card_id, PHOENIX, "", "custom:deleted")
    h.pump()
    card = _card(h)
    assert card.status == STATUS_SAVE_UNKNOWN_OPPONENT_BUILD
    assert card.status == "That opponent build isn't available any more — pick another."
    assert card.busy is False
    assert h.view.of("hide_postgame") == []
    h.ctl.confirm(card_id, PHOENIX, "", "zvp-roach-rush")
    h.pump()
    assert h.view.of("hide_postgame") == [(card_id, "confirmed")]


def test_an_answer_before_the_replay_never_carries_the_opponent(h: Harness) -> None:
    key = h.new_key()
    h.play(key)
    card_id = _card(h).card_id
    h.ctl.confirm(card_id, PHOENIX, "", "zvp-roach-rush")
    h.pump()
    assert h.api.live_bodies()[-1] == {"action": "postgame", "buildKey": PHOENIX}


# ------------------------------------------------------- notes-first card


def test_notes_first_card_also_offers_the_opponent(h: Harness) -> None:
    _declared_card(h)
    card = _card(h)
    assert card.variant == "notes_first"
    assert card.opponent.label == "Opponent's build: Zerg - 12 Pool"
    assert card.can_add_build is True


def test_notes_first_done_with_only_the_opponent_changed(h: Harness) -> None:
    card_id = _declared_card(h)
    h.ctl.confirm(card_id, "custom:dt-3-gate", "", "zvp-roach-rush")
    h.pump()
    assert _game_bodies(h) == [{"action": "opponent", "opponentBuildKey": "zvp-roach-rush"}]
    assert h.view.of("hide_postgame") == [(card_id, "confirmed")]


def test_notes_first_done_with_notes_and_opponent(h: Harness) -> None:
    card_id = _declared_card(h)
    h.ctl.confirm(card_id, "custom:dt-3-gate", "Fast lings", "zvp-ling-bane-bust")
    h.pump()
    assert _game_bodies(h) == [{
        "action": "opponent", "notes": "Fast lings", "opponentBuildKey": "zvp-ling-bane-bust",
    }]


def test_notes_first_done_with_an_unchanged_opponent_just_closes(h: Harness) -> None:
    card_id = _declared_card(h)
    h.ctl.confirm(card_id, "custom:dt-3-gate", "", "zerg-12-pool")
    h.pump()
    assert _game_bodies(h) == []
    assert h.view.of("hide_postgame") == [(card_id, "confirmed")]


def test_notes_first_change_build_carries_the_opponent_too(h: Harness) -> None:
    card_id = _declared_card(h)
    h.ctl.confirm(card_id, PHOENIX, "", "zvp-roach-rush")
    h.pump()
    assert _game_bodies(h) == [{
        "action": "confirm", "buildKey": PHOENIX, "opponentBuildKey": "zvp-roach-rush",
    }]


# ------------------------------------------------------- Add new build…


@pytest.mark.parametrize("side", ["you", "opponent"])
def test_add_build_opens_the_game_on_the_web_and_steps_aside(h: Harness, side: str) -> None:
    card_id = _accepted(h)
    h.ctl.update_draft(card_id, PHOENIX, "Half a note")
    h.ctl.add_build(card_id, side)
    h.pump()
    assert h.opened == [f"https://sc2tools.test/app/game/{quote(GID, safe='')}?newBuild={side}"]
    assert h.view.of("hide_postgame") == [(card_id, "opened_web")]
    # The draft notes went ahead so the game page shows them.
    assert _game_bodies(h) == [{"action": "notes", "notes": "Half a note"}]
    # It waits for the tray, not for the next pump.
    h.send({"type": "liveGameState", "phase": "menu"})
    assert len(h.view.of("show_postgame")) == 1


def test_add_build_drops_the_matchup_list_cache(h: Harness) -> None:
    card_id = _accepted(h)
    fetched = len(h.api.calls_to("get_build_options"))
    h.ctl.add_build(card_id, "you")
    h.pump()
    h.send(envelope("match_loading", h.new_key()))
    assert [a[0] for a, _ in h.api.calls_to("get_build_options")[fetched:]] == ["PvZ"]


def test_add_build_never_opens_the_browser_once_the_next_game_loads(h: Harness) -> None:
    card_id = _accepted(h)
    h.ctl.update_draft(card_id, PHOENIX, "")
    h.send(envelope("match_loading", h.new_key()))  # pre-empts the card
    h.ctl.add_build(card_id, "you")
    h.pump()
    assert h.opened == []


def test_reopening_after_the_web_lists_the_new_build(h: Harness) -> None:
    card_id = _accepted(h, options=[option(PHOENIX, "PvZ - 2 Stargate Phoenix")])
    h.ctl.add_build(card_id, "opponent")
    h.pump()
    # Saved on the web, not confirmed there.
    h.api.games[GID]["options"].append(option("custom:new-you", "New you build", source="custom"))
    h.api.games[GID]["opponent"]["options"] = OPP_OPTIONS + [
        option("custom:new-opp", "New opponent build", source="custom"),
    ]
    h.ctl.reopen()
    h.pump()
    assert h.api.calls_to("get_game_intent")[-1] == ((GID,), {"include_options": True})
    card = _card(h)
    assert card.card_id == card_id
    assert [row.key for row in card.featured + card.more][-1] == "custom:new-you"
    assert [row.key for row in card.opponent.featured + card.opponent.more][-1] == "custom:new-opp"
    # Fetched once; later pings go back to the cheap read.
    h.ctl.on_intent_changed({"gameId": GID})
    h.pump()
    assert h.api.calls_to("get_game_intent")[-1] == ((GID,), {"include_options": False})


def test_a_confirm_on_the_web_retires_the_card_set_aside(h: Harness) -> None:
    card_id = _accepted(h)
    h.ctl.add_build(card_id, "you")
    h.pump()
    h.api.games[GID] = game_state(
        GID, status="confirmed", origin="web",
        build=option("custom:new-you", "New you build", source="custom"),
    )
    h.ctl.on_intent_changed({"gameId": GID})
    h.pump()
    assert h.api.calls_to("get_game_intent")[-1] == ((GID,), {"include_options": True})
    h.ctl.reopen()
    h.pump()
    assert h.opened[-1] == "https://sc2tools.test/app"
    assert len(h.view.of("show_postgame")) == 1


def test_add_build_needs_the_replay(h: Harness) -> None:
    h.play(h.new_key())
    card_id = _card(h).card_id
    h.ctl.add_build(card_id, "you")
    h.pump()
    assert h.opened == []
    assert h.view.of("hide_postgame") == []


@pytest.mark.parametrize("card_id,side", [
    ("checkin-1", "both"), ("checkin-1", None), ("checkin-1", ["you"]), ("nope", "you"),
])
def test_add_build_ignores_bad_requests(h: Harness, card_id, side) -> None:
    _accepted(h)
    h.ctl.add_build(card_id, side)
    h.pump()
    assert h.opened == []


def test_add_build_waits_while_an_answer_is_saving() -> None:
    from tests.build_checkin_fakes import ManualExecutor

    executor = ManualExecutor()
    h = Harness(executor=executor)
    h.boot()
    executor.run_all()
    h.pump()
    key = h.new_key()
    h.play(key)
    h.wall.advance(620)
    h.api.games[GID] = game_state(GID, opponent=opponent_state(options=OPP_OPTIONS))
    h.accept(_game(key))
    while executor.jobs:
        executor.run_all()
        h.pump()
    card_id = _card(h).card_id
    h.ctl.confirm(card_id, PHOENIX, "")
    h.ctl.add_build(card_id, "you")
    h.pump()
    assert h.opened == []

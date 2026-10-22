"""End to end: the real ``BuildCheckinController`` (fake API, synchronous
executor) painting through ``CheckinViewProxy`` into the Qt cards, and
the cards' buttons driving the controller back."""

from __future__ import annotations

import os
from urllib.parse import quote

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest  # noqa: E402

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtTest, QtWidgets  # noqa: E402

from sc2tools_agent.ui import win32_window  # noqa: E402
from sc2tools_agent.ui.build_checkin_window import (  # noqa: E402
    LOADING,
    POSTGAME,
    BuildCheckinHost,
    CheckinViewProxy,
)
from tests.build_checkin_fakes import (  # noqa: E402
    OPP_OPTIONS,
    Harness,
    cloud_game,
    envelope,
    game_state,
    opponent_state,
    option,
    suggestion,
)

GID = "2026-10-22T18:10:00Z|Foo|Map|600"


@pytest.fixture
def app():
    return QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


@pytest.fixture
def flow(app, monkeypatch):
    for name in ("exclude_from_capture", "keep_topmost", "foreground_window",
                 "find_sc2_window", "monitor_of_window", "restore_foreground"):
        monkeypatch.setattr(win32_window, name, lambda *args: None)
    holder = {}
    host = BuildCheckinHost(controller=lambda: holder["proxy"].controller)
    proxy = CheckinViewProxy(lambda method, args: host.dispatch(method, args))
    holder["proxy"] = proxy
    h = Harness(view=proxy, intro_seen=False)
    proxy.bind_controller(h.ctl)
    h.boot()
    yield h, host
    host.close()
    for kind in (LOADING, POSTGAME):
        window = host.existing_window(kind)
        if window is not None:
            window.deleteLater()
    app.processEvents()


def click(widget) -> None:
    QtTest.QTest.mouseClick(widget, QtCore.Qt.LeftButton)


def test_declaring_from_the_loading_card(flow) -> None:
    h, host = flow
    key = h.new_key()
    h.send(envelope("match_loading", key))
    card = host.window(LOADING)
    assert card.isVisible()
    assert card.title.text() == "PvZ · vs Foo"
    assert card.intro.isVisibleTo(card)
    assert card.builds.keys()[0] == ["custom:dt-3-gate", "pvz-2-stargate-phoenix"]

    click(card.builds.row("custom:dt-3-gate"))
    h.pump()
    assert h.api.live[key]["declared"]["key"] == "custom:dt-3-gate"
    assert card.bar.isVisibleTo(card)
    assert card.locked.text() == "Locked in: DT into 3 Gate"
    assert not card.saving.isVisibleTo(card)

    card.change.click()
    h.pump()
    # Re-picking keeps the standing pick on the server (and the overlay
    # randomizer quiet) until another row replaces it.
    assert h.api.live[key]["declared"]["key"] == "custom:dt-3-gate"
    assert card.full.isVisibleTo(card)
    assert card.builds.keys()[0] == ["custom:dt-3-gate", "pvz-2-stargate-phoenix"]
    assert card.builds.row("custom:dt-3-gate").chips == [("Current pick", "reason")]
    assert card.not_now.toolTip() == "Clear your pick and skip this game's check-in"

    click(card.builds.row("pvz-2-stargate-phoenix"))
    h.pump()
    assert h.api.live[key]["declared"]["key"] == "pvz-2-stargate-phoenix"
    assert card.locked.text() == "Locked in: PvZ - 2 Stargate Phoenix"
    card.change.click()
    h.pump()
    assert card.builds.row("custom:dt-3-gate").chips == []
    assert card.builds.row("pvz-2-stargate-phoenix").chips[0] == ("Current pick", "reason")
    click(card.builds.row("pvz-2-stargate-phoenix"))
    h.pump()
    assert card.bar.isVisibleTo(card)

    card.intro_dismiss.click()
    h.pump()
    assert h.intro_dismissed == [True]
    assert not card.intro.isVisibleTo(card)

    h.send(envelope("match_started", key, display_time=31.0))
    assert not card.isVisible()


def test_roll_now_and_not_now(flow) -> None:
    h, host = flow
    key = h.new_key()
    h.send(envelope("match_loading", key))
    card = host.window(LOADING)
    assert card.strip.isVisibleTo(card)
    card.roll_now.click()
    h.pump()
    assert "release" in h.api.live_actions()
    assert card.strip_label.text() == "🎲 Rolling the randomizer…"
    assert not card.roll_now.isVisibleTo(card)
    card.not_now.click()
    h.pump()
    assert not card.isVisible()


def test_dont_ask_at_loading_turns_the_preference_off(flow) -> None:
    h, host = flow
    h.send(envelope("match_loading", h.new_key()))
    card = host.window(LOADING)
    card.dont_ask.click()
    h.pump()
    assert h.api.prefs["askAtLoading"] is False
    assert not card.isVisible()


def test_end_card_fills_in_and_confirms(flow) -> None:
    h, host = flow
    key = h.new_key()
    h.play(key)
    h.wall.advance(620)
    card = host.window(POSTGAME)
    assert card.isVisible()
    assert card.status.text() == "Checking your replay…"
    assert card.result.text() == "Victory · "
    assert card.builds.selection() == "pvz-2-stargate-phoenix"  # the usual

    QtTest.QTest.keyClicks(card.notes, "Got scouted")
    h.pump()
    h.api.games[GID] = game_state(
        GID,
        suggestion=suggestion("custom:dt-3-gate", "DT into 3 Gate", reason="detected"),
        options=[option("custom:dt-3-gate", "DT into 3 Gate", games=13, wins=8, losses=5),
                 option("pvz-2-stargate-phoenix", "PvZ - 2 Stargate Phoenix")],
    )
    started = int(key.rsplit("|", 1)[1]) / 1000 + 8
    h.accept(cloud_game(GID, started=started))

    assert not card.status.isVisibleTo(card)
    assert card.detected.text() == "Replay classified as: PvZ - Macro Transition (Unclassified)"
    assert card.notes.toPlainText() == "Got scouted"
    assert card.builds.selection() == "pvz-2-stargate-phoenix"  # touched: kept
    assert card.builds.row("custom:dt-3-gate").record == "8–5"

    click(card.builds.row("custom:dt-3-gate"))
    card.primary.click()
    h.pump()
    body = h.api.calls_to("put_game_intent")[-1][0][1]
    assert body == {"action": "confirm", "buildKey": "custom:dt-3-gate", "notes": "Got scouted"}
    assert not card.isVisible()


def test_later_keeps_the_draft_and_the_tray_reopens_it(flow) -> None:
    h, host = flow
    key = h.new_key()
    h.play(key)
    card = host.window(POSTGAME)
    click(card.builds.row("custom:dt-3-gate"))
    card.notes.setPlainText("Proxy gates")
    card.later.click()
    h.pump()
    assert not card.isVisible()
    h.ctl.reopen()
    h.pump()
    assert card.isVisible()
    assert card.builds.selection() == "custom:dt-3-gate"
    assert card.notes.toPlainText() == "Proxy gates"


def test_turn_off_after_games(flow) -> None:
    h, host = flow
    h.play(h.new_key())
    card = host.window(POSTGAME)
    card.turn_off.click()
    h.pump()
    assert h.api.prefs["askAfterGame"] is False
    assert not card.isVisible()


def _accepted_card(h, host):
    key = h.new_key()
    h.play(key)
    h.wall.advance(620)
    card = host.window(POSTGAME)
    assert not card.opp_row.isVisibleTo(card)
    assert not card.add_build.isEnabled()
    h.api.games[GID] = game_state(
        GID,
        suggestion=suggestion("custom:dt-3-gate", "DT into 3 Gate", reason="detected"),
        options=[option("custom:dt-3-gate", "DT into 3 Gate"),
                 option("pvz-2-stargate-phoenix", "PvZ - 2 Stargate Phoenix")],
        opponent=opponent_state(options=OPP_OPTIONS),
    )
    started = int(key.rsplit("|", 1)[1]) / 1000 + 8
    h.accept(cloud_game(GID, started=started))
    return card


def test_correcting_the_opponents_build_from_the_end_card(flow) -> None:
    h, host = flow
    card = _accepted_card(h, host)
    assert card.opp_row.isVisibleTo(card)
    assert card.opp_label.text() == "Opponent's build: Zerg - 12 Pool"
    assert card.add_build.isEnabled()

    card.opp_change.click()
    h.pump()
    assert card.opp_picker.isVisibleTo(card) and not card.picker.isVisibleTo(card)
    click(card.opp_builds.row("custom:ling-flood"))
    h.pump()
    assert not card.opp_picker.isVisibleTo(card)
    assert card.opp_label.text() == "Opponent's build: Ling flood"
    assert card.opp_changed.isVisibleTo(card)
    # The controller's own repaint agrees with what the card shows.
    assert card.model.opponent.changed is True
    assert card.model.opponent.label == "Opponent's build: Ling flood"

    card.primary.click()
    h.pump()
    body = h.api.calls_to("put_game_intent")[-1][0][1]
    assert body == {
        "action": "confirm", "buildKey": "custom:dt-3-gate",
        "opponentBuildKey": "custom:ling-flood",
    }
    assert h.api.games[GID]["opponent"]["build"]["key"] == "custom:ling-flood"
    assert not card.isVisible()


def test_add_new_build_opens_the_game_page_and_steps_aside(flow) -> None:
    h, host = flow
    card = _accepted_card(h, host)
    card.opp_change.click()
    card.opp_add.click()
    h.pump()
    assert h.opened == [
        f"https://sc2tools.test/app/game/{quote(GID, safe='')}?newBuild=opponent",
    ]
    assert not card.isVisible()
    # Back from the website: the tray reopens it with fresh lists.
    h.api.games[GID]["opponent"]["options"] = OPP_OPTIONS + [
        option("custom:new-opp", "New opponent build", source="custom"),
    ]
    h.ctl.reopen()
    h.pump()
    assert card.isVisible()
    assert card.opp_builds.row("custom:new-opp") is not None

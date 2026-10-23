from __future__ import annotations

from copy import deepcopy
import time

import pytest

from .test_companion_page import QtCore, companion, game, wait_until


def _replay(game_id, *, build, response, milestone, seconds):
    replay = game(game_id)
    replay.update({
        "myBuild": build,
        "oppStrategy": response,
        "map": game_id + " map",
        "myTechMilestones": [{"name": milestone, "timeSec": seconds, "kind": "building", "timing": "started"}],
        "oppTechMilestones": [{"name": "Factory", "timeSec": seconds + 15, "kind": "building", "timing": "started"}],
    })
    return replay


def _refresh_selected(page, app):
    page._job("opponent", {"action": "opponent", "pulseId": page._selected_id})
    wait_until(app, lambda: "opponent" not in page._requests)


@pytest.fixture
def navigation(companion):
    page, state, app = companion
    state["details"]["one"]["last5GamesScouting"] = [
        _replay("one-first", build="Blink expand", response="Bio timing", milestone="Cybernetics Core", seconds=85),
        _replay("one-second", build="Stargate expand", response="Mech opening", milestone="Stargate", seconds=140),
        _replay("one-third", build="Robo pressure", response="Fast third", milestone="Robotics Facility", seconds=160),
    ]
    state["details"]["two"]["last5GamesScouting"] = [
        _replay("two-first", build="Gateway pressure", response="Roach opening", milestone="Gateway", seconds=40),
        _replay("two-second", build="Dark shrine", response="Fast lair", milestone="Dark Shrine", seconds=210),
    ]
    _refresh_selected(page, app)
    page.set_density("standard")
    page.resize(1200, 900)
    page.show()
    app.processEvents()
    return page, state, app


def _assert_replay(page, game_id, build, milestone):
    assert page.game_select.currentData() == game_id
    assert page.console.context() == {"route": "scouting", "opponentId": page._selected_id, "gameId": game_id}
    assert page.chain_labels["my"].text() == build
    assert page.build_chains["my"].events[0]["name"] == milestone
    assert build in page.build_labels.text()


def test_console_game_arrows_and_back_restore_selected_build_chain(navigation):
    page, state, app = navigation
    assert not page.console.previous_game.isEnabled()
    page.console.next_game.click()
    _assert_replay(page, "one-second", "Stargate expand", "Stargate")
    assert "GAME 2 / 3" in page.console.game_title.text()
    page.console.next_game.click()
    _assert_replay(page, "one-third", "Robo pressure", "Robotics Facility")
    assert not page.console.next_game.isEnabled()
    page.console.back_button.click()
    _assert_replay(page, "one-second", "Stargate expand", "Stargate")
    page.console.previous_game.click()
    _assert_replay(page, "one-first", "Blink expand", "Cybernetics Core")


def test_console_opponent_arrows_and_back_restore_each_opponents_game(navigation):
    page, state, app = navigation
    page.console.next_game.click()
    page.console.next_player.click()
    wait_until(app, lambda: page._detail.get("name") == "Library two")
    _assert_replay(page, "two-first", "Gateway pressure", "Gateway")
    page.console.next_game.click()
    _assert_replay(page, "two-second", "Dark shrine", "Dark Shrine")
    page.console.previous_player.click()
    wait_until(app, lambda: page._detail.get("name") == "Library one")
    _assert_replay(page, "one-second", "Stargate expand", "Stargate")
    page.console.back_button.click()
    wait_until(app, lambda: page._detail.get("name") == "Library two")
    _assert_replay(page, "two-second", "Dark shrine", "Dark Shrine")


def test_refresh_retains_selected_replay_by_identifier_after_history_reorders(navigation, monkeypatch):
    page, state, app = navigation
    page.console.next_game.click()
    for name in ("build_selectors", "randomizer_page", "ghost_page"):
        monkeypatch.setattr(getattr(page, name), "refresh", lambda: None)
    replays = state["details"]["one"]["last5GamesScouting"]
    state["details"]["one"]["last5GamesScouting"] = [replays[2], replays[0], replays[1]]
    page.refresh_library()
    wait_until(app, lambda: "opponent" not in page._requests and "directory" not in page._requests and "snapshot" not in page._requests)
    _assert_replay(page, "one-second", "Stargate expand", "Stargate")
    assert page._games[0]["gameId"] == "one-third"
    assert page.game_select.currentIndex() == 2
    page.opponent_list.setCurrentRow(1)
    wait_until(app, lambda: page._detail.get("name") == "Library two")
    page.opponent_list.setCurrentRow(0)
    wait_until(app, lambda: page._detail.get("name") == "Library one")
    _assert_replay(page, "one-second", "Stargate expand", "Stargate")


def test_live_poll_updates_panels_without_replacing_browsed_game_or_chains(navigation):
    page, state, app = navigation
    page.console.next_game.click()
    historical_context = deepcopy(page.console.context())
    live = state["snapshot"]["liveGame"]
    live.update({"gameKey": "different-live-match", "displayTime": 123, "capturedAt": time.time(),
                 "opponent": {"name": "Different live opponent", "race": "Zerg", "profile": {"mmr": 4800}},
                 "streamerHistory": {"last5GamesScouting": [game("live-only-history")], "headToHead": {"wins": 9, "losses": 8}}})
    page.refresh()
    wait_until(app, lambda: page._snapshot.get("liveGame", {}).get("gameKey") == "different-live-match")
    _assert_replay(page, "one-second", "Stargate expand", "Stargate")
    assert page.console.context() == historical_context
    assert page._detail["name"] == "Library one"
    assert page.profile_card.name_label.text() == "Library one"
    assert page.overlays["opponent"].title.text() == "Different live opponent"
    assert page.overlays["scouting"]._games[0]["gameId"] == "live-only-history"


def test_routes_and_density_keep_notes_drafts_selected_game_and_feature_preferences(navigation):
    page, state, app = navigation
    page.console.next_game.click()
    page.notes.setPlainText("Keep scouting the second gas")
    page.read_aloud.setChecked(True)
    preferences = deepcopy(page._preferences)
    modes = deepcopy(page._modes)
    drafts = deepcopy(page._drafts)
    calls_before = len(state["calls"])
    widgets = [page.workspace_tabs.widget(index) for index in range(4)]
    parents = [widget.parentWidget() for widget in widgets]
    for route in ("home", "opponents", "history", "settings", "builds", "randomizer", "ghost", "scouting"):
        page.console.navigate(route)
        assert page.game_select.currentData() == "one-second"
        assert page.notes.toPlainText() == "Keep scouting the second gas"
    for density in ("compact", "standard", "detailed", "full"):
        page.set_density(density)
        assert page.console.current_route() == "scouting"
        assert page.game_select.currentData() == "one-second"
        assert page.notes.toPlainText() == "Keep scouting the second gas"
    assert page._drafts == drafts
    assert page._preferences == preferences
    assert page._modes == modes
    assert page.read_aloud.isChecked()
    assert [page.workspace_tabs.widget(index) for index in range(4)] == widgets
    assert [widget.parentWidget() for widget in widgets] == parents
    assert not [call for call in state["calls"][calls_before:] if call["action"] in {"preferences", "companion_modes", "save_notes", "randomizer_roll", "ghost_save"}]
    page.console.next_player.click()
    wait_until(app, lambda: page._detail.get("name") == "Library two")
    page.notes.setPlainText("Different private note")
    page.console.previous_player.click()
    wait_until(app, lambda: page._detail.get("name") == "Library one")
    assert page.notes.toPlainText() == "Keep scouting the second gas"
    assert page.read_aloud.isChecked()
    _assert_replay(page, "one-second", "Stargate expand", "Stargate")


def test_history_destination_opens_exact_game_and_back_retains_history_context(navigation):
    page, state, app = navigation
    page.console.navigate("history")
    item = page.overview_recent.topLevelItem(2)
    page.overview_recent.itemClicked.emit(item, 0)
    _assert_replay(page, "one-third", "Robo pressure", "Robotics Facility")
    page.console.back_button.click()
    assert page.console.current_route() == "history"
    assert page.console.content_stack.currentWidget() is page.overview_recent
    assert page.game_select.currentData() == "one-first"


def test_history_poll_keeps_current_row_identity_and_scroll_and_refresh_restores_by_id(navigation):
    page, state, app = navigation
    state["details"]["one"]["last5GamesScouting"] = [
        _replay(f"history-{index}", build=f"Opening {index}", response="Bio timing", milestone="Gateway", seconds=40)
        for index in range(40)
    ]
    _refresh_selected(page, app)
    page.console.navigate("history")
    page.resize(1000, 720)
    app.processEvents()
    history = page.overview_recent
    current_item = history.topLevelItem(15)
    history.setCurrentItem(current_item)
    wait_until(app, lambda: history.verticalScrollBar().maximum() > 0)
    history.verticalScrollBar().setValue(history.verticalScrollBar().maximum() // 2)
    vertical_position = history.verticalScrollBar().value()
    state["snapshot"]["liveGame"]["displayTime"] = 321
    page.refresh()
    wait_until(app, lambda: page._snapshot.get("liveGame", {}).get("displayTime") == 321)
    assert history.currentItem() is current_item
    assert history.verticalScrollBar().value() == vertical_position
    assert page.game_select.currentData() == "history-0"
    state["details"]["one"]["last5GamesScouting"].insert(0, _replay(
        "new-history", build="New opening", response="New response", milestone="Stargate", seconds=150))
    _refresh_selected(page, app)
    assert history.currentItem().data(0, QtCore.Qt.UserRole) == "history-15"
    assert history.verticalScrollBar().value() == vertical_position
    assert page.game_select.currentData() == "history-0"
    assert page.console.current_route() == "history"

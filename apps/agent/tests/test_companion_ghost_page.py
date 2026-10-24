from __future__ import annotations

from copy import deepcopy
import os
import threading
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtWidgets

from sc2tools_agent.companion_ghost import GhostClient, normalize_ghost_state
from sc2tools_agent.ui.companion_ghost import build_companion_ghost


def target(name="Blink expand"):
    return {"v": 1, "name": name, "sourceGameId": "source", "steps": [
        {"t": 50, "name": "Gateway", "kind": "building", "supply": 16},
        {"t": 100, "name": "Stalker", "kind": "unit", "supply": 22},
        {"t": 200, "name": "BlinkTech", "kind": "upgrade", "supply": None},
    ]}


def live_snapshot(clock=100, **extra):
    return {"liveGame": {"phase": "match_in_progress", "gameKey": "live", "displayTime": clock,
                         "capturedAt": time.time(), "user": {"race": "Protoss"},
                         "opponent": {"race": "Terran"}, **extra}}


def wait_until(app, predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        app.processEvents()
        time.sleep(0.005)
    assert predicate()


@pytest.fixture
def ghost_page():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    saved = [normalize_ghost_state({"v": 1, "enabled": True, "slots": {"PvT": target()}})]
    calls = []
    threads = []
    references = {}
    client = GhostClient(lambda *_args, **_kwargs: {}, lambda: saved[0], lambda value: saved.__setitem__(0, value))

    def candidates():
        return {"players": [
            {"id": "1", "name": "Player one", "matchup": "PvT", "target": target()},
            {"id": "2", "name": "Player two", "matchup": "TvP", "target": target("Bio timing")},
        ]}

    def handler(payload):
        calls.append(deepcopy(payload))
        threads.append(threading.get_ident())
        if payload["action"] == "ghost_state":
            return {**client.action(payload), "replayFolders": ["C:/Replays"], "references": deepcopy(references)}
        if payload["action"] == "ghost_save":
            return client.action(payload)
        if payload["action"] == "ghost_games":
            return {"items": [{"gameId": "source", "myBuild": "Blink expand", "myRace": "P", "opponent": {"race": "T"}}]}
        if payload["action"] in {"ghost_local_target", "ghost_target", "ghost_example_target"}:
            return candidates()
        if payload["action"] == "ghost_examples":
            return {"items": [{"id": "admin-example", "name": "Curated opener"}]}
        if payload["action"] == "ghost_reference":
            if payload["clear"]:
                references.clear()
            else:
                references["build"] = {"matchup": "PvT", "target": target()}
            return {"ghost": deepcopy(saved[0]), "references": deepcopy(references)}
        if payload["action"] == "ghost_reference_restore":
            return {"ghost": deepcopy(saved[0]), "references": {}, "history": {}}
        if payload["action"] == "ghost_comparison":
            return {"status": "ready", "rows": [{"name": "Gateway", "occurrence": 2, "targetSec": 50,
                                                    "actualSec": 55, "deltaSec": 5, "kind": "building", "timing": "started"}]}
        raise AssertionError(payload)

    page = build_companion_ghost(None, handler=handler, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    wait_until(app, lambda: page._state["enabled"] and bool(page._games))
    yield page, app, saved, calls, threads
    page.shutdown()
    page.deleteLater()
    app.processEvents()


def test_native_panel_follows_exact_live_clock_and_master_switch_without_erasing_targets(ghost_page):
    page, app, saved, calls, threads = ghost_page
    assert all(worker != threading.get_ident() for worker in threads)
    page.update_snapshot(live_snapshot(125))
    assert not page.panel.isVisible()
    page.set_assistance_enabled(True)
    assert page.panel.isVisible()
    assert "2:05" in page.panel.subtitle.text()
    assert page.panel.steps.topLevelItem(1).text(0) == "Stalker"
    assert page.panel.steps.topLevelItem(1).text(3) == "Target +25s"
    before = len(calls)
    page.set_assistance_enabled(False)
    assert not page.panel.isVisible()
    assert page._state["enabled"] is True
    assert saved[0]["slots"]["PvT"]
    assert len(calls) == before
    page.set_assistance_enabled(True)
    assert page.panel.isVisible()


@pytest.mark.parametrize("extra", [
    {"phase": "menu"}, {"isReplay": True}, {"capturedAt": time.time() - 100},
    {"opponent": {"race": "Zerg"}}, {"user": {"race": "Random"}},
])
def test_panel_hides_on_menu_replay_stale_or_wrong_matchup(ghost_page, extra):
    page, app, saved, calls, threads = ghost_page
    page.set_assistance_enabled(True)
    page.update_snapshot(live_snapshot())
    assert page.panel.isVisible()
    page.update_snapshot(live_snapshot(**extra))
    assert not page.panel.isVisible()


def test_closing_panel_turns_only_ghost_off_and_persists_target(ghost_page):
    page, app, saved, calls, threads = ghost_page
    page.set_assistance_enabled(True)
    page.update_snapshot(live_snapshot())
    page.panel.close()
    wait_until(app, lambda: saved[0]["enabled"] is False)
    assert saved[0]["slots"]["PvT"]
    assert not page.enabled_toggle.isChecked()
    assert not page.panel.isVisible()


def test_arbitrary_local_file_shows_both_players_and_selected_side_arms_matching_slot(ghost_page):
    page, app, saved, calls, threads = ghost_page
    page.load_local_replay("D:/Any folder/My game.SC2Replay")
    wait_until(app, lambda: page.players.count() == 2)
    assert any(call == {"action": "ghost_local_target", "path": "D:/Any folder/My game.SC2Replay"} for call in calls)
    assert page.players.tabText(0) == "Player one · PvT"
    assert page.players.tabText(1) == "Player two · TvP"
    page.players.setCurrentIndex(1)
    page.target_name.setText("My practice build")
    page.arm_button.click()
    wait_until(app, lambda: "TvP" in saved[0]["slots"])
    assert saved[0]["slots"]["TvP"]["name"] == "My practice build"
    assert saved[0]["slots"]["PvT"]["name"] == "Blink expand"
    assert all(worker != threading.get_ident() for worker in threads)


def test_ghost_preview_paints_unknown_units_and_warp_gate_research_from_offline_assets(ghost_page):
    page, app, saved, calls, threads = ghost_page
    source = {"v": 1, "name": "Icon reference", "sourceGameId": "icons", "steps": [
        {"t": 100, "name": "Sentry", "kind": "other", "timing": "completed"},
        {"t": 120, "name": "Phoenix", "kind": "other", "timing": "recorded"},
        {"t": 140, "name": "WarpGateResearch", "kind": "upgrade", "timing": "started"},
    ]}
    original = deepcopy(source)
    page._show_targets({"players": [{"id": "you", "name": "Player one", "matchup": "PvT", "target": source}]})
    assert page.preview_steps.topLevelItemCount() == 3
    assert [step["kind"] for step in page._preview["steps"]] == ["other", "other", "upgrade"]
    assert [step["timing"] for step in page._preview["steps"]] == ["completed", "recorded", "started"]
    page._state["slots"]["PvT"] = deepcopy(page._preview)
    page.set_assistance_enabled(True)
    page.update_snapshot(live_snapshot(0))
    assert page.panel.isVisible() and page.panel.steps.topLevelItemCount() == 3
    for tree in (page.preview_steps, page.panel.steps):
        for index in range(3):
            icon = tree.topLevelItem(index).icon(0)
            pixmap = icon.pixmap(26, 26)
            assert not pixmap.isNull()
            image = pixmap.toImage().convertToFormat(QtGui.QImage.Format_RGBA8888)
            pixels = image.constBits().tobytes()
            assert any(pixels[3::4]) and len(set(pixels)) > 4
    assert source == original


def test_replay_library_and_admin_examples_use_background_actions(ghost_page):
    page, app, saved, calls, threads = ghost_page
    page.sources.setCurrentIndex(1)
    page.load_button.click()
    wait_until(app, lambda: page.players.count() == 2)
    assert any(call == {"action": "ghost_target", "gameId": "source"} for call in calls)
    page.sources.setCurrentIndex(2)
    wait_until(app, lambda: page.examples.count() == 1)
    page.example_load_button.click()
    wait_until(app, lambda: page.players.count() == 2)
    assert any(call == {"action": "ghost_example_target", "exampleId": "admin-example"} for call in calls)


def test_shutdown_hides_panel_and_preserves_enabled_setting(ghost_page):
    page, app, saved, calls, threads = ghost_page
    page.set_assistance_enabled(True)
    page.update_snapshot(live_snapshot())
    page.shutdown()
    assert not page.panel.isVisible()
    assert not page.timer.isActive()
    assert saved[0]["enabled"] is True


def test_library_reference_star_uses_shared_account_actions_and_toggles(ghost_page):
    page, app, saved, calls, threads = ghost_page
    page.sources.setCurrentIndex(1)
    page.reference_button.click()
    wait_until(app, lambda: page.reference_button.text().startswith("★"))
    assert {"action": "ghost_reference", "gameId": "source", "side": "you", "clear": False} in calls
    page.reference_button.click()
    wait_until(app, lambda: page.reference_button.text().startswith("☆"))
    assert {"action": "ghost_reference", "gameId": "source", "side": "you", "clear": True} in calls


def test_library_filters_loaded_replays_without_replacing_a_filtered_out_selection(ghost_page):
    page, app, saved, calls, threads = ghost_page
    page.sources.setCurrentIndex(1)
    page._games = [
        {"gameId": "source", "myBuild": "Blink expand", "myRace": "P", "opponent": {"race": "T"}, "map": "Goldenaura", "result": "Victory", "playerCount": 2},
        {"gameId": "roach", "myBuild": "Roach push", "myRace": "Z", "opponent": {"race": "P"}, "map": "El Dorado", "result": "Defeat", "matchFormat": "1v1"},
        {"gameId": "blink-loss", "myBuild": "Blink expand", "myRace": "P", "opponent": {"race": "Z"}, "map": "Goldenaura", "result": "Defeat"},
        {"gameId": "team-game", "myBuild": "Team build", "myRace": "P", "opponent": {"race": "T"}, "playerCount": 4, "matchFormat": "team"},
    ]
    page._update_library_filters()
    page._fill_games()
    assert page.games.count() == 3
    assert "1 team / unsupported hidden" in page.library_count.text()
    page.load_button.click()
    wait_until(app, lambda: page.arm_button.isEnabled())
    page.matchup_filter.setCurrentIndex(page.matchup_filter.findData("ZvP"))
    assert page.games.count() == 1
    assert page.games.currentData() is None
    assert not page.arm_button.isEnabled()
    assert not page.load_button.isEnabled()
    assert "Selected replay is outside" in page.library_count.text()
    page.clear_filters_button.click()
    assert page.games.currentData() == "source"
    page.build_filter.setCurrentIndex(page.build_filter.findData("Blink expand"))
    page.map_filter.setCurrentIndex(page.map_filter.findData("Goldenaura"))
    page.result_filter.setCurrentIndex(page.result_filter.findData("loss"))
    assert page.games.count() == 1
    assert page.games.itemData(0) == "blink-loss"
    page.clear_filters_button.click()
    page._references = {"you:PvT:Blink": {"gameId": "source", "side": "you", "target": {**target(), "sourceGameId": "source"}}}
    page.starred_filter.setChecked(True)
    assert page.games.count() == 1
    assert page.games.itemText(0).startswith("★")
    page.search.setText("does not exist")
    assert not page.games.count()
    assert "loaded pages only" in page.library_count.text()


def test_admin_examples_filter_matchup_and_search_and_clear_stale_target(ghost_page):
    page, app, saved, calls, threads = ghost_page
    page.sources.setCurrentIndex(2)
    wait_until(app, lambda: bool(page._examples))
    page._examples = [
        {"id": "admin-example", "name": "Blink opener", "matchup": "PvT", "map": "Goldenaura"},
        {"id": "zerg-example", "name": "Roach practice", "matchup": "ZvP", "description": "Two base timing"},
    ]
    page._fill_examples()
    page.example_load_button.click()
    wait_until(app, lambda: page.arm_button.isEnabled())
    page.examples_matchup_filter.setCurrentIndex(page.examples_matchup_filter.findData("ZvP"))
    assert page.examples.count() == 1
    assert page.examples.currentData() is None
    assert not page.arm_button.isEnabled()
    assert "Selected example is hidden" in page.examples_count.text()
    page.examples_matchup_filter.setCurrentIndex(0)
    assert page.examples.currentData() == "admin-example"
    page.examples_search.setText("two base")
    assert page.examples.count() == 1
    assert page.examples.itemData(0) == "zerg-example"


def test_ghost_status_distinguishes_switch_stale_team_and_missing_matchup(ghost_page):
    page, app, saved, calls, threads = ghost_page
    page.set_assistance_enabled(False, reason="Teams preset hides 1v1 Ghost guidance")
    page.update_snapshot(live_snapshot())
    assert "Teams preset" in page.status.text()
    assert "Targets stay saved" in page.status.text()
    page.set_assistance_enabled(True)
    page.update_snapshot(live_snapshot(capturedAt=time.time() - 100))
    assert "fresh SC2 telemetry" in page.status.text()
    page.update_snapshot(live_snapshot(playerCount=4))
    assert "Confirm your own player and enemy roster" in page.status.text()
    page.update_snapshot(live_snapshot(opponent={"race": "Zerg"}))
    assert "No replay target assigned to PvZ" in page.status.text()
    assert "1 of 9 matchups assigned" in page.live_status.text()


def test_reference_history_requires_confirmation_and_sends_current_revision(ghost_page, monkeypatch):
    page, app, saved, calls, threads = ghost_page
    page.apply_account_result({"ghost": saved[0], "references": {"family": {
        "buildKey": "Blink", "matchup": "PvT", "side": "you", "revision": "current", "gameId": "source", "target": target(),
    }}, "history": {"family": [{"revision": "previous", "matchup": "PvT", "side": "you", "savedAt": "2026-10-23T12:00:00Z", "target": target("Earlier build")}]}})
    assert "Earlier build" in page.history_entry.currentText()
    assert page.restore_button.isEnabled()
    monkeypatch.setattr(QtWidgets.QMessageBox, "question", lambda *_args, **_kwargs: QtWidgets.QMessageBox.No)
    page.restore_button.click()
    assert not any(call["action"] == "ghost_reference_restore" for call in calls)
    monkeypatch.setattr(QtWidgets.QMessageBox, "question", lambda *_args, **_kwargs: QtWidgets.QMessageBox.Yes)
    page.restore_button.click()
    wait_until(app, lambda: any(call["action"] == "ghost_reference_restore" for call in calls))
    assert {"action": "ghost_reference_restore", "referenceKey": "family", "revision": "previous", "expectedCurrentRevision": "current"} in calls
    assert saved[0]["enabled"] is True


def test_postgame_comparison_displays_deltas_and_rejects_reference_replay(ghost_page):
    page, app, saved, calls, threads = ghost_page
    page.sources.setCurrentIndex(1)
    page.reference_side.setCurrentIndex(page.reference_side.findData("opponent"))
    page.compare_button.click()
    wait_until(app, lambda: page.comparison_tree.topLevelItemCount() == 1)
    assert {"action": "ghost_comparison", "gameId": "source", "side": "opponent"} in calls
    row = page.comparison_tree.topLevelItem(0)
    assert [row.text(column) for column in range(5)] == ["Gateway #2", "0:50", "0:55", "+5.0s", "started"]
    page._show_comparison({"status": "source_replay"})
    assert "reference replay itself" in page.comparison_status.text()
    assert page.comparison_tree.isHidden()


def test_late_comparison_does_not_show_under_another_selected_replay(ghost_page):
    page, app, saved, calls, threads = ghost_page
    page.sources.setCurrentIndex(1)
    page.compare_button.click()
    page._games.append({"gameId": "different", "myBuild": "Other build", "myRace": "P", "opponent": {"race": "T"}})
    page._fill_games()
    page.games.setCurrentIndex(page.games.findData("different"))
    wait_until(app, lambda: "comparison" not in page._busy)
    assert page.comparison_tree.isHidden()
    assert page.comparison_status.isHidden()

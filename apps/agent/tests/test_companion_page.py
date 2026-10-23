from __future__ import annotations

from copy import deepcopy
import os
import threading
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtWidgets

from sc2tools_agent.ui.companion_page import _events, _icon_root, _icon_token, _live_context, _note_length, _time, build_companion_page
from sc2tools_agent.companion_modes import default_modes


def wait_until(app, predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        app.processEvents()
        time.sleep(0.005)
    assert predicate()


def game(game_id="game-1"):
    return {
        "gameId": game_id, "myBuild": "Blink expand", "oppStrategy": "Bio timing",
        "map": "Test map", "result": "win", "durationSec": 500, "myRace": "Protoss", "oppRace": "Terran",
        "myTechMilestones": [{"name": "Cybernetics Core", "timeSec": 85, "kind": "building", "timing": "started"},
                             {"name": "Blink", "timeSec": 260, "kind": "upgrade", "timing": "completed"}],
        "oppTechMilestones": [{"name": "Factory", "timeSec": 130, "kind": "building", "timing": "started"}],
        "myBuildOrder": [{"name": "Gateway", "time": 40, "category": "building"}],
        "oppBuildOrder": [{"name": "Barracks", "time": 45, "category": "building"}],
    }


@pytest.fixture
def companion():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    preferences = {"overlaysEnabled": True, "opponentOverlay": True, "scoutingOverlay": True}
    state = {
        "snapshot": {"paired": True, "preferences": preferences, "modes": default_modes(), "liveGame": {
            "phase": "match_in_progress", "gameKey": "current", "displayTime": 50,
            "opponent": {"name": "Live opponent", "race": "Terran", "profile": {"mmr": 4000}},
            "streamerHistory": {"last5GamesScouting": [game()], "headToHead": {"wins": 2, "losses": 1}},
        }},
        "items": [{"pulseId": "one", "displayName": "Library one", "race": "Terran", "wins": 2, "losses": 1},
                  {"pulseId": "two", "displayName": "Library two", "race": "Zerg", "wins": 0, "losses": 2}],
        "details": {"one": {"name": "Library one", "last5GamesScouting": [game()], "notes": "Old note", "totals": {"wins": 2, "losses": 1}},
                    "two": {"name": "Library two", "last5GamesScouting": []}},
        "calls": [], "threads": [],
        "ghost_references": {},
    }

    def handler(payload):
        state["calls"].append(deepcopy(payload))
        state["threads"].append(threading.get_ident())
        action = payload["action"]
        if action == "snapshot":
            if state.get("snapshot_error"):
                raise RuntimeError("Network unavailable")
            return deepcopy(state["snapshot"])
        if action == "opponents":
            return {"items": deepcopy(state["items"]), "nextBefore": None}
        if action == "opponent":
            return deepcopy(state["details"][payload["pulseId"]])
        if action == "preferences":
            state["snapshot"]["preferences"] = deepcopy(payload["preferences"])
            return {"preferences": deepcopy(payload["preferences"])}
        if action == "companion_modes":
            if "modes" not in payload:
                saved = {"modes": deepcopy(state["snapshot"]["modes"]),
                         "preferences": deepcopy(state["snapshot"]["preferences"])}
                gate = state.get("local_settings_gate")
                if gate is not None:
                    gate.wait(2)
                return saved
            gate = state.get("mode_gate")
            if gate is not None:
                gate.wait(2)
            if state.get("mode_error"):
                raise RuntimeError("Disk unavailable")
            state["snapshot"]["modes"] = deepcopy(payload["modes"])
            return {"modes": deepcopy(payload["modes"])}
        if action == "save_notes":
            return {"notes": payload["text"], "notesReadAloud": payload["readAloud"]}
        if action == "ghost_state":
            return {"ghost": {"v": 1, "enabled": False, "slots": {}}, "references": deepcopy(state["ghost_references"])}
        if action == "ghost_games":
            return {"items": []}
        if action == "ghost_reference":
            gate = state.get("ghost_reference_gate")
            if gate is not None:
                gate.wait(2)
            key = payload["side"]
            if payload.get("clear"):
                state["ghost_references"].pop(key, None)
            else:
                state["ghost_references"][key] = {"gameId": payload["gameId"], "side": payload["side"], "matchup": "PvT"}
            return {"ghost": {"v": 1, "enabled": False, "slots": {}}, "references": deepcopy(state["ghost_references"])}
        raise AssertionError(action)

    page = build_companion_page(None, handler=handler, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    page.timer.stop()
    wait_until(app, lambda: page._detail.get("name") == "Library one")
    yield page, state, app
    page.shutdown()
    page.deleteLater()
    app.processEvents()


def test_handler_calls_run_off_the_gui_thread_and_real_timelines_render(companion):
    page, state, app = companion
    assert all(worker != threading.get_ident() for worker in state["threads"])
    assert "Blink expand" in page.build_labels.text()
    assert "Bio timing" in page.build_labels.text()
    mine = page.trees["tech"]["my"]
    assert mine.topLevelItem(0).text(0) == "Cybernetics Core"
    assert mine.topLevelItem(0).text(1) == "1:25"
    assert mine.topLevelItem(0).text(2) == "Started"
    assert mine.topLevelItem(1).text(2) == "Completed"
    assert page.trees["upgrades"]["my"].topLevelItem(0).text(0) == "Blink"
    assert page.trees["build"]["my"].topLevelItem(0).text(2) == "Recorded"


def test_explicit_library_refresh_synchronizes_all_workspaces_without_polling_them_each_tick(companion, monkeypatch):
    page, state, app = companion
    calls = []
    for name in ("build_selectors", "randomizer_page", "ghost_page"):
        monkeypatch.setattr(getattr(page, name), "refresh", lambda key=name: calls.append(key))
    for name in ("randomizer_page", "ghost_page"):
        monkeypatch.setattr(getattr(page, name), "update_snapshot", lambda _snapshot: None)
    page.refresh_library()
    assert calls == ["build_selectors", "randomizer_page", "ghost_page"]
    calls.clear()
    wait_until(app, lambda: "snapshot" not in page._requests)
    page.refresh()
    wait_until(app, lambda: "snapshot" not in page._requests)
    assert calls == []


def test_panels_use_current_opponent_while_browsing_another_and_main_hidden(companion):
    page, state, app = companion
    assert page.overlays["opponent"].isVisible()
    assert page.overlays["scouting"].isVisible()
    page.opponent_list.setCurrentRow(1)
    wait_until(app, lambda: page._detail.get("name") == "Library two")
    page.hide()
    assert page.overlays["opponent"].isVisible()
    assert page.overlays["opponent"].title.text() == "Live opponent"
    assert page.overlays["scouting"].games.count() == 1
    assert "No prior replay" in page.build_labels.text()


def test_master_off_persists_and_retains_independent_pin_choices(companion):
    page, state, app = companion
    page.preference_checks["overlaysEnabled"].setChecked(False)
    assert all(not panel.isVisible() for panel in page.overlays.values())
    wait_until(app, lambda: not page._preference_busy)
    preferences = state["snapshot"]["preferences"]
    assert preferences == {"overlaysEnabled": False, "opponentOverlay": True, "scoutingOverlay": True}
    page.preference_checks["overlaysEnabled"].setChecked(True)
    wait_until(app, lambda: not page._preference_busy)
    assert all(panel.isVisible() for panel in page.overlays.values())


def test_saved_modes_gate_panels_without_changing_shared_settings_and_keep_controls_adjustable(companion):
    page, state, app = companion
    original_preferences = deepcopy(state["snapshot"]["preferences"])
    changes = []
    page.modesChanged.connect(changes.append)
    controls = page.mode_controls
    assert controls.details.isHidden()
    controls.mode_select.setCurrentIndex(controls.mode_select.findData("review"))
    assert not any(panel.isVisible() for panel in page.overlays.values())
    assert "Pinned but hidden by preset" in controls.explanation.text()
    wait_until(app, lambda: not page._mode_busy)
    assert state["snapshot"]["preferences"] == original_preferences
    assert not [call for call in state["calls"] if call["action"] in {"randomizer_settings", "preferences"}]
    assert changes[-1]["mode"] == "review" and changes[-1]["ghost"] is False
    assert controls.feature_checks["ghost"].isEnabled()
    page.set_preference("overlaysEnabled", False)
    controls.mode_select.setCurrentIndex(controls.mode_select.findData("practice"))
    controls.customize_button.click()
    assert not controls.details.isHidden()
    controls.feature_checks["opponentOverlay"].setChecked(True)
    wait_until(app, lambda: not page._mode_busy and not page._preference_busy)
    controls.mode_select.setCurrentIndex(controls.mode_select.findData("review"))
    controls.mode_select.setCurrentIndex(controls.mode_select.findData("practice"))
    assert controls.feature_checks["opponentOverlay"].isChecked()
    assert not page.assistance_enabled()
    assert not page.randomizer_page._assistance
    assert page.mode_gates()["ghost"] is True


def test_mode_saves_coalesce_and_hotkey_notifies_once_per_change(companion):
    page, state, app = companion
    gate = state["mode_gate"] = threading.Event()
    hotkey = []
    page.hotkeyEnabledChanged.connect(hotkey.append)
    controls = page.mode_controls
    controls.mode_select.setCurrentIndex(controls.mode_select.findData("customs"))
    controls.feature_checks["randomizer"].setChecked(False)
    controls.hotkey_check.setChecked(True)
    controls.mode_select.setCurrentIndex(controls.mode_select.findData("practice"))
    controls.feature_checks["ghost"].setChecked(False)
    assert page._mode_busy and page._modes_queued
    assert hotkey == [True]
    gate.set()
    wait_until(app, lambda: not page._mode_busy)
    saved = state["snapshot"]["modes"]
    assert saved["active"] == "practice" and saved["hotkeyEnabled"] is True
    assert saved["profiles"]["customs"]["randomizer"] is False
    assert saved["profiles"]["practice"]["ghost"] is False
    assert len([call for call in state["calls"] if call["action"] == "companion_modes" and "modes" in call]) == 2
    page.set_hotkey_status("Ctrl+Shift+F10 is already in use")
    assert "already in use" in controls.hotkey_check.toolTip()


def test_mode_save_failure_rolls_back_and_teams_never_unhides_unknown_team_guidance(companion):
    page, state, app = companion
    state["mode_error"] = True
    controls = page.mode_controls
    controls.mode_select.setCurrentIndex(controls.mode_select.findData("practice"))
    wait_until(app, lambda: not page._mode_busy)
    assert page._modes["active"] == "ladder"
    assert "not saved" in controls.save_status.text()
    state["mode_error"] = False
    controls.mode_select.setCurrentIndex(controls.mode_select.findData("teams"))
    for checkbox in controls.feature_checks.values():
        checkbox.setChecked(True)
    wait_until(app, lambda: not page._mode_busy)
    assert not page.mode_gates()["ghost"]
    assert not page.mode_gates()["scoutingOverlay"]
    assert "team-game guidance is unsupported" in controls.explanation.text()
    assert not any(panel.isVisible() for panel in page.overlays.values())
    state["snapshot"]["liveGame"]["players"] = [{"type": "user"}] * 2
    page.refresh()
    wait_until(app, lambda: "snapshot" not in page._requests)
    assert page.mode_gates()["ghost"]
    assert page._modes["active"] == "teams"


def test_late_local_settings_cannot_overwrite_new_mode_or_master_choice(companion):
    page, state, app = companion
    gate = state["local_settings_gate"] = threading.Event()
    page._job("modes_load", {"action": "companion_modes"})
    page.mode_controls.mode_select.setCurrentIndex(page.mode_controls.mode_select.findData("practice"))
    page.set_preference("overlaysEnabled", False)
    wait_until(app, lambda: not page._mode_busy and not page._preference_busy)
    gate.set()
    wait_until(app, lambda: "modes_load" not in page._requests)
    assert page._modes["active"] == "practice"
    assert page._preferences == {"overlaysEnabled": False, "opponentOverlay": True, "scoutingOverlay": True}


def test_offline_start_restores_local_modes_hotkey_and_pins_without_telemetry():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    modes = default_modes()
    modes["active"] = "review"
    modes["hotkeyEnabled"] = True
    modes["profiles"]["customs"]["ghost"] = False
    state = {"modes": modes, "preferences": {"overlaysEnabled": True, "opponentOverlay": True, "scoutingOverlay": False}}
    calls = []

    def handler(payload):
        calls.append(deepcopy(payload))
        if payload["action"] == "snapshot":
            raise RuntimeError("Network unavailable")
        if payload["action"] == "companion_modes":
            if "modes" in payload:
                state["modes"] = deepcopy(payload["modes"])
            return deepcopy(state)
        if payload["action"] == "preferences":
            state["preferences"] = deepcopy(payload["preferences"])
            return {"preferences": deepcopy(state["preferences"])}
        raise AssertionError(payload["action"])

    page = build_companion_page(None, handler=handler, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    page.timer.stop()
    hotkey = []
    page.hotkeyEnabledChanged.connect(hotkey.append)
    try:
        wait_until(app, lambda: page._modes_loaded and "snapshot" not in page._requests)
        assert page._modes == modes
        assert page._preferences == state["preferences"]
        assert hotkey == [True]
        assert not page._snapshot_healthy
        assert not any(panel.isVisible() for panel in page.overlays.values())
        assert page.mode_controls.isEnabled()
        page.set_preference("overlaysEnabled", False)
        wait_until(app, lambda: not page._preference_busy)
        assert state["preferences"] == {"overlaysEnabled": False, "opponentOverlay": True, "scoutingOverlay": False}
        page.mode_controls.mode_select.setCurrentIndex(page.mode_controls.mode_select.findData("practice"))
        wait_until(app, lambda: not page._mode_busy)
        assert state["modes"]["profiles"]["customs"]["ghost"] is False
        assert state["modes"]["hotkeyEnabled"] is True
        assert not [call for call in calls if call["action"] in {"randomizer_roll", "randomizer_settings", "opponents"}]
    finally:
        page.shutdown()
        page.deleteLater()
        app.processEvents()


def test_rapid_panel_closes_are_serialized_and_persist_final_choices(companion):
    page, state, app = companion
    page.overlays["opponent"].close()
    page.overlays["scouting"].close()
    wait_until(app, lambda: not page._preference_busy)
    assert not state["snapshot"]["preferences"]["opponentOverlay"]
    assert not state["snapshot"]["preferences"]["scoutingOverlay"]
    assert not page.preference_checks["opponentOverlay"].isChecked()
    assert not page.preference_checks["scoutingOverlay"].isChecked()


def test_snapshot_failure_cannot_reshow_stale_match(companion):
    page, state, app = companion
    state["snapshot_error"] = True
    page.refresh()
    wait_until(app, lambda: not page._snapshot_healthy)
    page._render_detail()
    page.preview_button.setChecked(True)
    assert all(not panel.isVisible() for panel in page.overlays.values())


def test_search_filters_loaded_library_and_note_drafts_follow_opponent(companion):
    page, state, app = companion
    page.notes.setPlainText("Remember the early factory")
    page.read_aloud.setChecked(True)
    page.opponent_list.setCurrentRow(1)
    wait_until(app, lambda: page._detail.get("name") == "Library two")
    page.opponent_list.setCurrentRow(0)
    wait_until(app, lambda: page._detail.get("name") == "Library one")
    assert page.notes.toPlainText() == "Remember the early factory"
    assert page.read_aloud.isChecked()
    page.save_notes()
    wait_until(app, lambda: "notes" not in page._requests)
    assert any(call == {"action": "save_notes", "pulseId": "one", "text": "Remember the early factory", "readAloud": True} for call in state["calls"])
    page.search.setText("zerg")
    assert page.opponent_list.count() == 1
    assert "Library two" in page.opponent_list.item(0).text()
    page.search.setText("No matching account")
    assert "No opponents match" in page.library_count.text()


def test_note_limit_blocks_oversized_save(companion):
    page, state, app = companion
    page.notes.setPlainText("x" * 501)
    assert not page.save_notes_button.isEnabled()
    page.save_notes()
    assert all(call["action"] != "save_notes" for call in state["calls"])


def test_replay_menu_and_unpaired_states_hide_panels(companion):
    page, state, app = companion
    state["snapshot"]["liveGame"]["isReplay"] = True
    page.refresh()
    wait_until(app, lambda: page._snapshot.get("liveGame", {}).get("isReplay"))
    assert all(not panel.isVisible() for panel in page.overlays.values())
    state["snapshot"]["paired"] = False
    page.refresh()
    wait_until(app, lambda: not page._paired)
    assert not page._detail
    assert not page._drafts
    assert "Pair your agent" in page.live_label.text()


def test_stale_detail_response_does_not_replace_new_selection(companion):
    page, state, app = companion
    page._selected_id = "two"
    page._requests["opponent"] = 101
    page._completed({"channel": "opponent", "request": 100, "payload": {"action": "opponent", "pulseId": "one"}, "result": {"name": "Stale"}})
    assert page._detail.get("name") != "Stale"
    page._completed({"channel": "opponent", "request": 101, "payload": {"action": "opponent", "pulseId": "one"}, "result": {"name": "Stale"}})
    assert page._detail.get("name") != "Stale"


def test_time_and_older_event_data_do_not_invent_completed_timings():
    assert _time(0) == "0:00"
    assert _time(None) == "—"
    assert _time(float("nan")) == "—"
    assert _time(-2) == "—"
    events = _events({"oppBuildOrder": [{"name": "Factory", "category": "building", "time": 95}]}, "opp")
    assert events == [{"name": "Factory", "kind": "building", "timeSec": 95, "timing": "recorded"}]


def test_live_context_rejects_previous_match_data():
    active, context = _live_context({"liveGame": {"phase": "match_in_progress", "gameKey": "new", "opponent": {"name": "Current"}},
                                     "live": {"gameKey": "old", "oppName": "Previous", "last5GamesScouting": [game()]}})
    assert active
    assert context["name"] == "Current"
    assert not context.get("last5GamesScouting")


def test_live_context_expires_abandoned_active_match():
    active, context = _live_context({"liveGame": {"phase": "match_in_progress", "capturedAt": time.time() - 31, "opponent": {"name": "Old"}}})
    assert not active
    active, context = _live_context({"liveGame": {"phase": "match_in_progress", "receivedAt": (time.time() - 2) * 1000, "opponent": {"name": "Current"}}})
    assert active


def test_note_limit_matches_server_utf16_length():
    assert _note_length("a" * 500) == 500
    assert _note_length("🎮" * 251) == 502


def test_full_opponent_scouting_library_is_browsable(companion):
    page, state, app = companion
    page._detail["gamesScouting"] = [game("one"), game("two"), game("three")]
    page._render_detail()
    assert page.game_select.count() == 3
    assert page.overlays["scouting"].games.count() == 1


def test_no_service_handler_never_starts_threads(monkeypatch):
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])

    def unexpected_thread(*args, **kwargs):
        raise AssertionError("Companion must not start workers without its service handler")

    monkeypatch.setattr(threading.Thread, "start", unexpected_thread)
    page = build_companion_page(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    page.refresh()
    assert not page.timer.isActive()
    assert "unavailable" in page.live_label.text()
    assert not page._requests
    page.shutdown()
    page.deleteLater()
    app.processEvents()


@pytest.mark.parametrize(("name", "kind", "expected"), [
    ("BlinkTech", "upgrade", "blink"), ("Stimpack", "upgrade", "stim"),
    ("ShieldWall", "upgrade", "combatshield"), ("PunisherGrenades", "upgrade", "concussive"),
    ("zerglingmovementspeed", "upgrade", "metabolicboost"),
    ("FactoryTechLab", "building", "techlab"), ("StarportReactor", "building", "reactor"),
    ("ProtossGroundArmorsLevel2", "upgrade", "protossgroundarmor2"),
    ("TerranVehicleAndShipArmorsLevel3", "upgrade", "terranvehiclearmor3"),
    ("ZergFlyerWeaponsLevel1", "upgrade", "zergflyerattacks1"),
    ("ZergGroundArmorsLevel2", "upgrade", "zerggroundcarapace2"),
])
def test_common_replay_names_resolve_to_shipped_icons(name, kind, expected):
    token = _icon_token(name, kind)
    assert token == expected
    directory = "buildings" if kind == "building" else "upgrades"
    assert (_icon_root() / directory / (token + ".png")).is_file()


def test_shutdown_is_idempotent_and_stops_hidden_panel_refresh(companion):
    page, state, app = companion
    page.shutdown()
    app.processEvents()
    page.shutdown()
    page.refresh()
    assert not page.timer.isActive()
    assert not page._requests


def test_previous_encounter_can_star_each_players_build_reference(companion):
    page, state, app = companion
    page.ghost_reference_buttons["you"].click()
    wait_until(app, lambda: "you" in state["ghost_references"])
    wait_until(app, lambda: page.ghost_reference_buttons["you"].text().startswith("★"))
    assert {"action": "ghost_reference", "gameId": "game-1", "side": "you", "clear": False} in state["calls"]
    page.ghost_reference_buttons["opponent"].click()
    wait_until(app, lambda: "opponent" in state["ghost_references"])
    wait_until(app, lambda: page.ghost_reference_buttons["opponent"].text().startswith("★"))
    assert {"action": "ghost_reference", "gameId": "game-1", "side": "opponent", "clear": False} in state["calls"]
    page.ghost_reference_buttons["you"].click()
    wait_until(app, lambda: "you" not in state["ghost_references"])
    assert "opponent" in state["ghost_references"]


def test_reference_response_does_not_change_selected_encounter_or_claim_wrong_replay(companion):
    page, state, app = companion
    gate = threading.Event()
    state["ghost_reference_gate"] = gate
    page.ghost_reference_buttons["you"].click()
    page._games.append(game("other-game"))
    page.game_select.addItem("Another replay", "other-game")
    page.game_select.setCurrentIndex(1)
    page.notice.setText("Viewing the other replay")
    gate.set()
    wait_until(app, lambda: "ghost_reference" not in page._requests)
    assert page.game_select.currentData() == "other-game"
    assert page.notice.text() == "Viewing the other replay"
    assert page.ghost_reference_buttons["you"].text().startswith("☆")

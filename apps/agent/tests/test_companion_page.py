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
        "snapshot": {"paired": True, "accountKey": "fixture-owner", "preferences": preferences, "modes": default_modes(), "liveGame": {
            "phase": "match_in_progress", "gameKey": "current", "displayTime": 50, "capturedAt": time.time(),
            "opponent": {"name": "Live opponent", "race": "Terran", "profile": {"mmr": 4000}},
            "streamerHistory": {"last5GamesScouting": [game()], "headToHead": {"wins": 2, "losses": 1}},
        }},
        "items": [{"pulseId": "one", "displayName": "Library one", "race": "Terran", "wins": 2, "losses": 1},
                  {"pulseId": "two", "displayName": "Library two", "race": "Zerg", "wins": 0, "losses": 2}],
        "details": {"one": {"name": "Library one", "last5GamesScouting": [game()], "notes": "Old note", "totals": {"wins": 2, "losses": 1}},
                    "two": {"name": "Library two", "last5GamesScouting": []}},
        "calls": [], "threads": [],
        "ghost_references": {},
        "trace": [],
    }

    def dispatch(payload):
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

    def handler(payload):
        state["trace"].append(("start", payload["action"], time.monotonic()))
        try:
            return dispatch(payload)
        finally:
            state["trace"].append(("finish", payload["action"], time.monotonic()))

    page = build_companion_page(None, handler=handler, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    page.timer.stop()
    page.show()
    page.console.navigate("scouting")
    try:
        wait_until(app, lambda: page._detail.get("name") == "Library one", timeout=15)
    except AssertionError:
        diagnostic = {"paired": page._paired, "healthy": page._snapshot_healthy,
                      "requests": page._requests, "selected": page._selected_id,
                      "detail_name": page._detail.get("name"), "opponents": len(page._opponents),
                      "directory_loaded": page._directory_loaded, "list_rows": page.opponent_list.count(),
                      "notice": page.notice.text(), "trace": state["trace"],
                      "workers": [worker.name for worker in threading.enumerate() if worker.name.startswith("companion-")]}
        page.shutdown()
        page.deleteLater()
        app.processEvents()
        pytest.fail("Companion fixture did not settle: " + repr(diagnostic))
    yield page, state, app
    page.shutdown()
    page.deleteLater()
    app.processEvents()


def test_handler_calls_run_off_the_gui_thread_and_real_timelines_render(companion):
    page, state, app = companion
    assert all(worker != threading.get_ident() for worker in state["threads"])
    assert "Blink expand" in page.build_labels.text()
    assert "Bio timing" in page.build_labels.text()
    page.set_density("full")
    page.tabs.setCurrentIndex(0)
    app.processEvents()
    mine = page.trees["tech"]["my"]
    assert mine.topLevelItem(0).text(0) == "Cybernetics Core"
    assert mine.topLevelItem(0).text(1) == "1:25"
    assert mine.topLevelItem(0).text(2) == "Started"
    assert mine.topLevelItem(1).text(2) == "Completed"
    page.tabs.setCurrentIndex(2)
    app.processEvents()
    assert page.trees["upgrades"]["my"].topLevelItem(0).text(0) == "Blink"
    page.tabs.setCurrentIndex(1)
    app.processEvents()
    assert page.trees["build"]["my"].topLevelItem(0).text(2) == "Recorded"


def test_assistance_controls_explain_saved_choices_and_historical_pins(companion):
    page, state, app = companion
    assert {key: page.preference_checks[key].text() for key in ("overlaysEnabled", "opponentOverlay", "scoutingOverlay")} == {
        "overlaysEnabled": "In-game assistance",
        "opponentOverlay": "Keep opponent on top",
        "scoutingOverlay": "Keep scouting on top",
    }
    master_tip = page.preference_checks["overlaysEnabled"].toolTip()
    assert "replay syncing and browsing continue" in master_tip
    assert "Off hides or stops native assistance" in master_tip
    assert "Randomize selects a shared build from check-in" in master_tip
    assert "Its animation and audio stay in the separate overlay widget" in master_tip
    assert "controlled by its own settings" in master_tip
    opponent_tip = page.preference_checks["opponentOverlay"].toolTip()
    assert "above other windows" in opponent_tip and "mode" in opponent_tip
    scouting_tip = page.preference_checks["scoutingOverlay"].toolTip()
    assert "Historical scouting" in scouting_tip and "not live enemy tracking" in scouting_tip
    assert "Turning it off keeps your choices" in page.assistance_help.text()
    assert "not replay syncing or browsing" in page.assistance_help.text()


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
    assert preferences == {"overlaysEnabled": False, "opponentOverlay": True, "scoutingOverlay": True, "scoutingReadAloud": False}
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
    assert "confirm yourself and enemy membership" in controls.explanation.text()
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
    assert page._preferences == {"overlaysEnabled": False, "opponentOverlay": True, "scoutingOverlay": True, "scoutingReadAloud": False}


def test_offline_start_restores_local_modes_hotkey_and_pins_without_telemetry():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    modes = default_modes()
    modes["active"] = "review"
    modes["hotkeyEnabled"] = True
    modes["profiles"]["customs"]["ghost"] = False
    state = {"modes": modes, "preferences": {"overlaysEnabled": True, "opponentOverlay": True, "scoutingOverlay": False, "scoutingReadAloud": False}}
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
        assert state["preferences"] == {"overlaysEnabled": False, "opponentOverlay": True, "scoutingOverlay": False, "scoutingReadAloud": False}
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
    active, context = _live_context({"liveGame": {"phase": "match_in_progress", "gameKey": "new", "capturedAt": time.time(), "opponent": {"name": "Current"}},
                                     "live": {"gameKey": "old", "oppName": "Previous", "last5GamesScouting": [game()]}})
    assert active
    assert context["name"] == "Current"
    assert not context.get("last5GamesScouting")


def test_live_context_expires_abandoned_active_match():
    active, context = _live_context({"liveGame": {"phase": "match_in_progress", "capturedAt": time.time() - 31, "opponent": {"name": "Old"}}})
    assert not active
    active, context = _live_context({"liveGame": {"phase": "match_in_progress", "receivedAt": (time.time() - 2) * 1000, "opponent": {"name": "Current"}}})
    assert active


@pytest.mark.parametrize(("timestamp", "offset"), [(None, None), (True, None), (float("nan"), None), (None, 60), (None, -31)],
                         ids=["missing", "boolean", "not-finite", "future", "stale"])
def test_live_context_rejects_unknown_stale_or_future_clock(timestamp, offset):
    if offset is not None:
        timestamp = time.time() + offset
    active, _context = _live_context({"liveGame": {"phase": "match_in_progress", "capturedAt": timestamp,
                                                   "opponent": {"name": "Current"}}})
    assert not active


def test_live_identity_never_infers_missing_race_or_mmr_from_history():
    active, context = _live_context({"liveGame": {"phase": "match_in_progress", "capturedAt": time.time(),
        "opponent": {"name": "Current"}, "streamerHistory": {"oppRace": "Zerg", "oppMmr": 5000}}})
    assert active
    assert context["race"] is None and context["mmr"] is None


@pytest.mark.parametrize("opponent", [{"name": "Current player"}, {"revealedName": "Current player"},
                                      {"name": " ", "revealedName": "Current player"}])
def test_live_history_name_mismatch_cannot_attach_previous_player_records(opponent):
    active, context = _live_context({"liveGame": {"phase": "match_in_progress", "capturedAt": time.time(),
        "opponent": opponent, "streamerHistory": {"oppName": "Previous player", "headToHead": {"wins": 7, "losses": 2},
            "opponentNotes": {"text": "Not this player", "readAloud": True}}}})
    assert active
    assert not context.get("headToHead") and not context.get("opponentNotes")


def test_unmatched_live_identity_does_not_present_candidate_records_or_notes(companion):
    page, state, app = companion
    history = page._snapshot["liveGame"]["streamerHistory"]
    history["opponentIdentityMatched"] = False
    history["opponentNotes"] = {"text": "Not this player", "readAloud": True}
    page.set_density("compact")
    assert page.compact_card.record["wins"] is None
    assert page.compact_card.win_rate_label.text() == "—"
    active, context = _live_context(page._snapshot)
    assert active and context["name"] == "Live opponent"
    assert not context.get("headToHead") and not context.get("opponentNotes")
    assert not context.get("last5GamesScouting")


def test_compact_record_and_percentage_follow_the_live_opponent_not_browsed_dossier(companion):
    page, state, app = companion
    page._detail["totals"] = {"wins": 20, "losses": 0}
    page.set_density("compact")
    assert page.compact_card.record["wins"] == 2
    assert page.compact_card.record["losses"] == 1
    assert page.compact_card.win_rate_label.text() == "66.7%"
    assert page.overlays["opponent"].identity_card.record["wins"] == 2


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
    assert {"action": "ghost_reference", "gameId": "game-1", "side": "you", "clear": False, "accountKey": "fixture-owner"} in state["calls"]
    page.ghost_reference_buttons["opponent"].click()
    wait_until(app, lambda: "opponent" in state["ghost_references"])
    wait_until(app, lambda: page.ghost_reference_buttons["opponent"].text().startswith("★"))
    assert {"action": "ghost_reference", "gameId": "game-1", "side": "opponent", "clear": False, "accountKey": "fixture-owner"} in state["calls"]
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


def test_four_information_layouts_change_visible_data_and_keep_full_details_available(companion):
    page, state, app = companion
    page._snapshot["liveGame"]["capturedAt"] = time.time()
    page._snapshot_healthy = True
    saved_preferences = deepcopy(page._preferences)
    page.set_density("compact")
    assert not page.compact_card.isHidden()
    assert page.console.isHidden()
    assert all(widget.isHidden() for widget in page._normal_chrome)
    assert page.compact_card.identity == {"name": "Live opponent", "race": "Terran", "mmr": "4000"}
    requests = []
    page.windowSizeRequested.connect(requests.append)
    page.compact_enlarge.click()
    assert requests == ["standard"]
    page.set_density("standard")
    assert page.compact_card.isHidden() and not page.console.isHidden()
    assert page.scouting_stack.currentWidget() is page.overview
    assert page.workspace_tabs.tabBar().isHidden()
    assert page.chain_labels["my"].text() == "Blink expand"
    assert page.chain_labels["opp"].text() == "Bio timing"
    assert page.overview_recent.topLevelItemCount() == 1
    assert page.build_time_range.currentData() == 180
    assert len(page.build_chains["my"].steps) == 1
    page.build_time_range.setCurrentIndex(page.build_time_range.findData(360))
    assert len(page.build_chains["my"].steps) == 2
    assert page.upgrade_chains["my"].isHidden()
    page.set_density("detailed")
    assert page.scouting_stack.currentWidget() is page.overview
    assert not page.upgrade_chains["my"].isHidden()
    assert page.notes_section.isHidden()
    assert not page.tabs.isTabVisible(1)
    assert page.ghost_page.filters_widget.isHidden()
    assert page.notes.toPlainText() == "Old note"
    page.set_density("full")
    assert page.scouting_stack.currentWidget() is page.dossier
    assert page.tabs.isTabVisible(1)
    assert not page.notes_section.isHidden()
    assert not page.ghost_page.filters_widget.isHidden()
    assert not page.ghost_page.history_toggle.isHidden()
    page.set_density("standard")
    page.open_full_details()
    assert page.current_density() == "full"
    assert not page.return_overview_button.isHidden()
    page.return_overview_button.click()
    assert page.current_density() == "standard"
    assert page._preferences == saved_preferences


def test_compact_identity_uses_fresh_direct_opponent_fields_without_inference(companion):
    page, state, app = companion
    page._detail = {"name": "Browsed player", "race": "Zerg", "mmr": 4700}
    page._snapshot_healthy = True
    page._snapshot = {"liveGame": {"phase": "match_in_progress", "gameKey": "fresh", "capturedAt": time.time(),
                                   "opponent": {"name": "Current player"},
                                   "streamerHistory": {"oppRace": "Terran", "oppMmr": 5000}}}
    page.set_density("compact")
    assert page.compact_card.identity == {"name": "Current player", "race": "—", "mmr": "—"}
    page._snapshot["liveGame"]["capturedAt"] = time.time() - 100
    page._render_information_layout()
    assert page.compact_card.identity == {"name": "—", "race": "—", "mmr": "—"}
    page._snapshot = {"liveGame": {"phase": "menu"}}
    page._render_information_layout()
    assert page.compact_card.identity == {"name": "—", "race": "—", "mmr": "—"}
    assert page.compact_card.name_label.full_text == "Waiting for next match"


def test_assistance_off_reason_follows_the_switch_pairing_snapshot_and_shutdown(companion):
    page, state, app = companion
    assert page.assistance_off_reason() is None and page.assistance_enabled()
    page.set_preference("overlaysEnabled", False)
    assert page.assistance_off_reason() == "assistance_off" and not page.assistance_enabled()
    state["snapshot"]["paired"] = False
    page.refresh(); wait_until(app, lambda: not page._paired)
    # Unpairing clears the library, so the next snapshot is what confirms it.
    assert page.assistance_off_reason() == "connecting"
    page.refresh(); wait_until(app, lambda: page._snapshot_healthy)
    assert page.assistance_off_reason() == "unpaired"
    state["snapshot_error"] = True
    page.refresh(); wait_until(app, lambda: not page._snapshot_healthy)
    # A failed snapshot leaves pairing unknown, so the page reports connecting instead.
    assert page.assistance_off_reason() == "connecting"
    page.shutdown()
    assert page.assistance_off_reason() == "closed"

from copy import deepcopy
import os
import threading
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtWidgets

from sc2tools_agent.companion import CompanionError
from sc2tools_agent.ui.companion_randomizer import build_companion_randomizer, randomizer_context


def wait_until(app, predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        app.processEvents()
        time.sleep(0.005)
    assert predicate()


def snapshot(key="Opp|Streamer|1790000000000", phase="match_loading"):
    return {"paired": True, "liveGame": {"phase": phase, "gameKey": key, "isReplay": False,
            "user": {"race": "Protoss"}, "opponent": {"race": "Zerg"}}}


@pytest.fixture
def panel():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    state = {"calls": [], "threads": [], "rolled": {}, "config": {"version": 2, "matchups": {
        "PvZ": {"enabled": True, "builds": [{"id": "first", "name": "Blink opener", "weight": 1}]},
    }}, "options": {"builds": [{"key": "first", "name": "Blink opener"}, {"key": "second", "name": "Robo opener"}]}}

    def handler(request):
        state["calls"].append(deepcopy(request))
        state["threads"].append(threading.get_ident())
        action = request["action"]
        if action == "randomizer_state":
            result = {"config": deepcopy(state["config"]), "options": deepcopy(state["options"]),
                      "intent": {"gameKey": request.get("gameKey"), "randomizer": state["rolled"].get(request.get("gameKey")),
                                 "holdRemainingMs": 1000, "prefs": {"enabled": True, "askAtLoading": True},
                                 "declared": state.get("declared")}}
            if state.get("read_block"):
                state["read_entered"].set()
                state["read_block"].wait(3)
            if state.get("error"):
                raise CompanionError("Cannot reach SC2 Tools.")
            return result
        if action == "randomizer_settings":
            if state.get("settings_block"):
                state["settings_entered"].set()
                state["settings_block"].wait(3)
            config = state["config"]["matchups"].setdefault(request["matchup"], {})
            if "enabled" in request:
                config["enabled"] = request["enabled"]
            if "buildKeys" in request:
                config["builds"] = [{"id": key, "name": key} for key in request["buildKeys"]]
            return {"config": deepcopy(state["config"])}
        if action == "randomizer_roll":
            state["rolled"].setdefault(request["gameKey"], {"key": "first", "name": "Canonical persisted pick"})
            return {"gameKey": request["gameKey"], "randomizer": state["rolled"][request["gameKey"]]}
        raise AssertionError(action)

    widget = build_companion_randomizer(None, handler=handler, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    widget.timer.stop()
    widget.update_snapshot(snapshot())
    wait_until(app, lambda: widget._loaded and not widget._busy)
    yield widget, state, app
    for key in ("read_block", "settings_block"):
        if state.get(key):
            state[key].set()
    widget.shutdown()
    widget.deleteLater()
    app.processEvents()


def test_loads_real_pool_off_thread_and_honors_loading_hold(panel):
    widget, state, _app = panel
    assert all(worker != threading.get_ident() for worker in state["threads"])
    assert widget.matchup_select.currentText() == "PvZ"
    assert widget.enabled_check.isChecked()
    assert widget.pool.topLevelItemCount() == 2
    assert widget.pool.topLevelItem(0).text(0) == "Blink opener"
    assert widget.pool.topLevelItem(0).checkState(0) == QtCore.Qt.Checked
    assert "loading check-in" in widget.status.text()
    assert not state["rolled"]


def test_roll_now_actually_requests_persisted_pick_and_never_redraws(panel):
    widget, state, app = panel
    widget.roll_button.click()
    wait_until(app, lambda: "Canonical persisted pick" in widget.result_label.text())
    assert [call for call in state["calls"] if call["action"] == "randomizer_roll"][0]["releaseHold"] is True
    for _ in range(3):
        widget.refresh()
        wait_until(app, lambda: not widget._busy)
    assert len([call for call in state["calls"] if call["action"] == "randomizer_roll"]) == 1
    assert not widget.roll_button.isEnabled()


def test_explicit_roll_waits_for_busy_read_and_unchanged_master_does_not_refresh(panel):
    widget, state, app = panel
    before = len(state["calls"])
    widget.set_assistance_enabled(True)
    widget.set_assistance_enabled(True)
    app.processEvents()
    assert len(state["calls"]) == before
    state["read_block"] = threading.Event()
    state["read_entered"] = threading.Event()
    widget.refresh()
    wait_until(app, state["read_entered"].is_set)
    widget.request_roll_now()
    assert not state["rolled"]
    state["read_block"].set()
    wait_until(app, lambda: "Canonical persisted pick" in widget.result_label.text())
    rolls = [call for call in state["calls"] if call["action"] == "randomizer_roll"]
    assert len(rolls) == 1 and rolls[0]["releaseHold"] is True


def test_match_start_autorolls_without_any_overlay_source(panel):
    widget, state, app = panel
    widget.update_snapshot(snapshot(phase="match_started"))
    widget.refresh()
    wait_until(app, lambda: "Canonical persisted pick" in widget.result_label.text())
    assert [call for call in state["calls"] if call["action"] == "randomizer_roll"][0]["releaseHold"] is False


def test_master_gate_prevents_rolls_and_toggling_remains_available(panel):
    widget, state, app = panel
    widget.set_assistance_enabled(False)
    widget.update_snapshot(snapshot(phase="match_started"))
    widget.refresh()
    wait_until(app, lambda: not widget._busy)
    assert not state["rolled"] and not widget.roll_button.isEnabled()
    widget.enabled_check.setChecked(False)
    wait_until(app, lambda: not widget._busy and not widget._pending_settings)
    assert state["config"]["matchups"]["PvZ"]["enabled"] is False
    widget.set_assistance_enabled(True)
    wait_until(app, lambda: not widget._busy)
    assert not state["rolled"]


def test_master_off_cancels_a_queued_explicit_draw_before_read_finishes(panel):
    widget, state, app = panel
    state["read_block"] = threading.Event()
    state["read_entered"] = threading.Event()
    widget.refresh()
    wait_until(app, state["read_entered"].is_set)
    widget.request_roll_now()
    widget.set_assistance_enabled(False)
    state["read_block"].set()
    wait_until(app, lambda: not widget._busy)
    assert not state["rolled"]
    assert widget._explicit_roll is None
    assert widget.enabled_check.isEnabled()


def test_rapid_toggle_writes_are_serialized_and_last_choice_wins(panel):
    widget, state, app = panel
    state["settings_block"] = threading.Event()
    state["settings_entered"] = threading.Event()
    widget.enabled_check.setChecked(False)
    wait_until(app, state["settings_entered"].is_set)
    widget.enabled_check.setChecked(True)
    widget.enabled_check.setChecked(False)
    assert not widget.roll_button.isEnabled()
    state["settings_block"].set()
    wait_until(app, lambda: not widget._busy and not widget._pending_settings)
    assert state["config"]["matchups"]["PvZ"]["enabled"] is False
    assert not widget.enabled_check.isChecked()
    assert not state["rolled"]


def test_pool_can_be_edited_and_saved(panel):
    widget, state, app = panel
    widget.pool.topLevelItem(1).setCheckState(0, QtCore.Qt.Checked)
    widget.save_pool_button.click()
    wait_until(app, lambda: not widget._busy and not widget._pool_dirty)
    assert [build["id"] for build in state["config"]["matchups"]["PvZ"]["builds"]] == ["first", "second"]


def test_declared_build_blocks_randomization(panel):
    widget, state, app = panel
    state["declared"] = {"key": "chosen", "name": "Manual plan"}
    widget.update_snapshot(snapshot(phase="match_started"))
    widget.refresh()
    wait_until(app, lambda: "Manual plan" in widget.result_label.text())
    assert not widget.roll_button.isEnabled()
    assert not state["rolled"]


def test_stale_read_cannot_roll_a_new_match_or_show_the_old_pick(panel):
    widget, state, app = panel
    state["read_block"] = threading.Event()
    state["read_entered"] = threading.Event()
    state["rolled"][widget._context[0]] = {"key": "old", "name": "Old match pick"}
    widget.refresh()
    wait_until(app, state["read_entered"].is_set)
    widget.update_snapshot(snapshot("Next|Streamer|1790000001000"))
    state["read_block"].set()
    wait_until(app, lambda: not widget._busy)
    assert "Old match pick" not in widget.result_label.text()
    assert not [call for call in state["calls"] if call["action"] == "randomizer_roll"]


def test_network_errors_are_visible_and_shutdown_blocks_new_work(panel):
    widget, state, app = panel
    state["error"] = True
    widget.refresh()
    wait_until(app, lambda: not widget._busy)
    assert "Cannot reach SC2 Tools" in widget.status.text()
    before = len(state["calls"])
    widget.shutdown()
    widget.refresh()
    widget.update_snapshot(snapshot(phase="match_started"))
    assert len(state["calls"]) == before


@pytest.mark.parametrize("patch", [{"phase": "match_ended"}, {"isReplay": True}, {"players": [{}, {}, {}]},
                                   {"players": [{"type": "user"}, {"type": "computer"}]},
                                   {"receivedAt": 1000}, {"user": {"race": "Random"}}])
def test_randomizer_context_rejects_stale_replay_and_unresolved_sources(patch):
    source = snapshot()
    source["liveGame"].update(patch)
    assert randomizer_context(source, now=1800000000) is None

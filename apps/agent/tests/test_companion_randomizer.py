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
    widget.show()
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
    assert "overlay widget" in widget.status.text()
    assert not hasattr(widget, "roll_button")
    assert not state["rolled"]


def test_only_observes_the_widget_pick_and_cannot_draw_or_redraw(panel):
    widget, state, app = panel
    assert not hasattr(widget, "roll_button") and not hasattr(widget, "request_roll_now")
    state["rolled"][widget._context[0]] = {"key": "first", "name": "Canonical persisted pick"}
    widget.refresh()
    wait_until(app, lambda: "Canonical persisted pick" in widget.result_label.text())
    for _ in range(3):
        widget.refresh()
        wait_until(app, lambda: not widget._busy)
    widget._request("roll", {"action": "randomizer_roll"})
    assert not [call for call in state["calls"] if call["action"] == "randomizer_roll"]
    assert "Read-only saved result" in widget.status.text()


def test_busy_read_and_unchanged_master_never_launch_a_native_draw(panel):
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
    widget._request("roll", {"action": "randomizer_roll"})
    assert not state["rolled"]
    state["read_block"].set()
    wait_until(app, lambda: not widget._busy)
    rolls = [call for call in state["calls"] if call["action"] == "randomizer_roll"]
    assert not rolls and not state["rolled"]


def test_match_start_and_progress_never_autoroll_without_the_widget(panel):
    widget, state, app = panel
    widget.update_snapshot(snapshot(phase="match_started"))
    widget.refresh()
    wait_until(app, lambda: not widget._busy)
    widget.update_snapshot(snapshot(phase="match_in_progress"))
    widget.refresh()
    wait_until(app, lambda: not widget._busy)
    assert not state["rolled"]
    assert not [call for call in state["calls"] if call["action"] == "randomizer_roll"]


def test_master_gate_prevents_rolls_and_toggling_remains_available(panel):
    widget, state, app = panel
    widget.set_assistance_enabled(False)
    widget.update_snapshot(snapshot(phase="match_started"))
    widget.refresh()
    wait_until(app, lambda: not widget._busy)
    assert not state["rolled"] and not hasattr(widget, "roll_button")
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
    widget._request("roll", {"action": "randomizer_roll"})
    widget.set_assistance_enabled(False)
    state["read_block"].set()
    wait_until(app, lambda: not widget._busy)
    assert not state["rolled"]
    assert not hasattr(widget, "_explicit_roll")
    assert widget.enabled_check.isEnabled()


def test_rapid_toggle_writes_are_serialized_and_last_choice_wins(panel):
    widget, state, app = panel
    state["settings_block"] = threading.Event()
    state["settings_entered"] = threading.Event()
    widget.enabled_check.setChecked(False)
    wait_until(app, state["settings_entered"].is_set)
    widget.enabled_check.setChecked(True)
    widget.enabled_check.setChecked(False)
    assert not hasattr(widget, "roll_button")
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
    assert not hasattr(widget, "roll_button")
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


def test_account_change_discards_old_private_pool_pick_and_delayed_response(panel):
    widget, state, app = panel
    source = {**snapshot(), "accountKey": "first-account"}
    widget.update_snapshot(source)
    wait_until(app, lambda: not widget._busy)
    state["rolled"][widget._context[0]] = {"key": "first", "name": "Private old pick"}
    blocked = threading.Event()
    state["read_block"] = blocked
    state["read_entered"] = threading.Event()
    widget.refresh()
    wait_until(app, state["read_entered"].is_set)
    state["read_block"] = None
    state["rolled"].clear()
    state["options"] = {"builds": [{"key": "new", "name": "New account pool"}]}
    widget.update_snapshot({**snapshot(), "accountKey": "second-account"})
    wait_until(app, lambda: not widget._busy)
    blocked.set()
    app.processEvents()
    assert "Private old pick" not in widget.result_label.text()
    assert widget.pool.topLevelItem(0).text(0) == "New account pool"
    assert state["calls"][-1]["accountKey"] == "second-account"
    widget.update_snapshot({"paired": False})
    assert widget.pool.topLevelItemCount() == 0
    assert not widget.enabled_check.isEnabled()


@pytest.mark.parametrize("patch", [{"phase": "match_ended"}, {"isReplay": True}, {"players": [{}, {}, {}]},
                                   {"players": [{"type": "user"}, {"type": "computer"}]},
                                   {"receivedAt": 1000}, {"user": {"race": "Random"}}])
def test_randomizer_context_rejects_stale_replay_and_unresolved_sources(patch):
    source = snapshot()
    source["liveGame"].update(patch)
    assert randomizer_context(source, now=1800000000) is None

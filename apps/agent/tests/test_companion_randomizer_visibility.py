from copy import deepcopy
import os
import threading
import time

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtWidgets

from sc2tools_agent.ui.companion_randomizer import build_companion_randomizer
from sc2tools_agent.companion import CompanionError


@pytest.fixture
def visible_panel():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    state = {"calls": [], "configs": {}, "save_gate": None, "save_error": False}

    def handler(payload):
        state["calls"].append(deepcopy(payload))
        owner = payload.get("accountKey")
        config = state["configs"].setdefault(owner, {"matchups": {"PvZ": {"enabled": True, "builds": []}}})
        if payload["action"] == "randomizer_settings":
            if state["save_error"]:
                raise CompanionError("Cannot save the pool while offline.")
            if state["save_gate"] is not None:
                state["save_gate"][0].set()
                assert state["save_gate"][1].wait(3)
            config["matchups"][payload["matchup"]].update({key: payload[key] for key in ("enabled",) if key in payload})
            if "buildKeys" in payload:
                config["matchups"][payload["matchup"]]["builds"] = [{"id": key, "name": key} for key in payload["buildKeys"]]
            return {"config": deepcopy(config)}
        assert payload["action"] == "randomizer_state"
        return {"config": deepcopy(config), "options": {"builds": [{"key": "first", "name": "First build"}]},
                "intent": {"randomizer": {"key": "first", "name": owner + " saved widget pick"}}}

    def wait(predicate):
        deadline = time.monotonic() + 3
        while not predicate() and time.monotonic() < deadline:
            app.processEvents()
            time.sleep(0.005)
        assert predicate()

    def snapshot(owner="owner-A", key="Opponent|Streamer|1790000000000"):
        return {"paired": True, "accountKey": owner, "liveGame": {"phase": "match_in_progress", "gameKey": key,
                "capturedAt": time.time(), "user": {"race": "Protoss"}, "opponent": {"race": "Zerg"}}}

    panel = build_companion_randomizer(None, handler=handler, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    yield panel, app, state, wait, snapshot
    if state["save_gate"] is not None:
        state["save_gate"][1].set()
    panel.shutdown()
    panel.deleteLater()
    app.processEvents()


def test_hidden_page_defers_timer_snapshot_and_explicit_refresh_until_opening(visible_panel):
    panel, app, state, wait, snapshot = visible_panel
    panel.update_snapshot(snapshot())
    panel.refresh()
    panel.timer.timeout.emit()
    panel._request("state", {"action": "randomizer_state", "matchup": "PvZ"})
    app.processEvents()
    assert state["calls"] == [] and not panel._loaded and not panel.timer.isActive()
    panel.show()
    wait(lambda: panel._loaded and not panel._busy)
    assert len(state["calls"]) == 1
    assert "owner-A saved widget pick" in panel.result_label.text()
    panel.hide()
    panel.update_snapshot(snapshot(key="Other|Streamer|1790000001000"))
    panel.refresh()
    panel.timer.timeout.emit()
    app.processEvents()
    assert len(state["calls"]) == 1 and not panel.timer.isActive()
    panel.show()
    wait(lambda: not panel._busy and len(state["calls"]) == 2)
    assert state["calls"][-1]["gameKey"] == "Other|Streamer|1790000001000"


def test_pending_explicit_saves_finish_while_hidden_without_followup_reads(visible_panel):
    panel, app, state, wait, snapshot = visible_panel
    panel.update_snapshot(snapshot())
    panel.show()
    wait(lambda: panel._loaded and not panel._busy)
    state["save_gate"] = (threading.Event(), threading.Event())
    panel.enabled_check.setChecked(False)
    wait(state["save_gate"][0].is_set)
    panel.enabled_check.setChecked(True)
    panel.hide()
    state["save_gate"][1].set()
    wait(lambda: not panel._busy and not panel._pending_settings)
    assert state["configs"]["owner-A"]["matchups"]["PvZ"]["enabled"] is True
    assert [call["action"] for call in state["calls"]] == ["randomizer_state", "randomizer_settings", "randomizer_settings"]
    assert not hasattr(panel, "roll_button")
    panel.show()
    wait(lambda: not panel._busy and state["calls"][-1]["action"] == "randomizer_state")


def test_hidden_owner_change_clears_cache_and_queued_old_owner_work(visible_panel):
    panel, app, state, wait, snapshot = visible_panel
    panel.update_snapshot(snapshot())
    panel.show()
    wait(lambda: panel._loaded and not panel._busy)
    state["save_gate"] = (threading.Event(), threading.Event())
    panel.enabled_check.setChecked(False)
    wait(state["save_gate"][0].is_set)
    panel.enabled_check.setChecked(True)
    panel.hide()
    panel.update_snapshot(snapshot("owner-B"))
    assert panel.pool.topLevelItemCount() == 0 and not panel._loaded
    assert panel._pending_settings == {}
    state["save_gate"][1].set()
    app.processEvents()
    assert len(state["calls"]) == 2
    assert "owner-A saved widget pick" not in panel.result_label.text()
    panel.show()
    wait(lambda: panel._loaded and not panel._busy)
    assert state["calls"][-1]["accountKey"] == "owner-B"
    assert "owner-B saved widget pick" in panel.result_label.text()
    assert len([call for call in state["calls"] if call["action"] == "randomizer_settings"]) == 1


@pytest.mark.parametrize("assistance", [True, False])
def test_failed_pool_save_keeps_draft_and_retry_available_even_when_assistance_off(visible_panel, assistance):
    panel, app, state, wait, snapshot = visible_panel
    panel.update_snapshot(snapshot())
    panel.show()
    wait(lambda: panel._loaded and not panel._busy)
    panel.set_assistance_enabled(assistance)
    panel.pool.topLevelItem(0).setCheckState(0, QtCore.Qt.Checked)
    state["save_error"] = True
    panel.save_pool_button.click()
    wait(lambda: not panel._busy and panel._status_error)
    assert panel._pool_dirty and panel.save_pool_button.isEnabled()
    assert panel.pool.topLevelItem(0).checkState(0) == QtCore.Qt.Checked
    assert "Cannot save the pool" in panel.status.text()
    state["save_error"] = False
    panel.save_pool_button.click()
    wait(lambda: not panel._busy and not panel._pool_dirty)
    assert [row["id"] for row in state["configs"]["owner-A"]["matchups"]["PvZ"]["builds"]] == ["first"]
    assert not panel._status_error and not panel.save_pool_button.isEnabled()
    assert not hasattr(panel, "roll_button")


def test_owner_reset_clears_failed_private_draft_error_and_retry_action(visible_panel):
    panel, app, state, wait, snapshot = visible_panel
    panel.update_snapshot(snapshot())
    panel.show()
    wait(lambda: panel._loaded and not panel._busy)
    panel.pool.topLevelItem(0).setCheckState(0, QtCore.Qt.Checked)
    state["save_error"] = True
    panel.save_pool_button.click()
    wait(lambda: not panel._busy and panel._status_error)
    panel.hide()
    before = len(state["calls"])
    panel.update_snapshot(snapshot("owner-B"))
    assert not panel._pool_dirty and not panel._status_error and not panel._loaded
    assert panel.pool.topLevelItemCount() == 0 and not panel.save_pool_button.isEnabled()
    assert "Cannot save the pool" not in panel.status.text()
    panel._save_pool()
    app.processEvents()
    assert len(state["calls"]) == before

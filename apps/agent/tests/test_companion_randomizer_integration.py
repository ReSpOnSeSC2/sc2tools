from copy import deepcopy
from dataclasses import replace
import os
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtWidgets

from sc2tools_agent.build_checkin.models import CheckinPrefs, LoadingCardModel, RandomizerStripModel
from sc2tools_agent.ui.companion_page import build_companion_page


def wait_until(app, predicate):
    deadline = time.monotonic() + 3
    while not predicate() and time.monotonic() < deadline:
        app.processEvents()
        time.sleep(0.005)
    assert predicate()


def test_embedded_selector_only_releases_widget_hold_and_displays_its_canonical_pick():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    key = "Opponent|Streamer|1790000000000"
    state = {"calls": [], "roll": None, "declared": None}

    class Controller:
        prefs = CheckinPrefs()
        available = True
        released = False
        releases = 0

        def roll_now(self, game_key):
            assert game_key == key
            if not self.released:
                self.releases += 1
                self.released = True

    controller = Controller()

    def handler(request):
        state["calls"].append(deepcopy(request))
        action = request["action"]
        if action == "snapshot":
            return {"paired": True, "preferences": {"overlaysEnabled": True}, "liveGame": {
                "phase": "match_loading", "gameKey": key, "user": {"race": "Protoss"},
                "opponent": {"name": "Opponent", "race": "Zerg"},
            }}
        if action == "randomizer_state":
            return {"config": {"matchups": {"PvZ": {"enabled": True, "builds": [{"id": "build", "name": "Saved build"}]}}},
                    "options": {"builds": [{"key": "build", "name": "Saved build"}]},
                    "intent": {"gameKey": key, "randomizer": state["roll"], "declared": state["declared"],
                               "holdRemainingMs": 5000, "prefs": {"enabled": True, "askAtLoading": True}}}
        if action == "randomizer_roll":
            assert request["gameKey"] == key and request["releaseHold"] is True
            assert state["declared"] is None
            state["roll"] = {"key": "build", "name": "Saved canonical build"}
            return {"gameKey": key, "randomizer": state["roll"]}
        if action.startswith("ghost_"):
            return {"enabled": False, "targets": {}, "items": [], "references": {}}
        return {"items": []}

    page = build_companion_page(None, handler=handler, checkin_controller_provider=lambda: controller,
                               QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    page.timer.stop()
    page.randomizer_page.timer.stop()
    page.ghost_page.timer.stop()
    try:
        wait_until(app, lambda: page.randomizer_page._loaded and not page.randomizer_page._busy)
        model = LoadingCardModel(game_key=key, matchup="PvZ", waiting_for_matchup=False,
                                 randomizer=RandomizerStripModel("Randomizer will roll", can_roll_now=True))
        page.dispatch_build_checkin("show_loading", (model,))
        route = page.workspace_tabs.currentWidget()
        assert page.build_selectors.roll_now.text() == "Roll in widget"
        page.build_selectors.roll_now.click()
        page.build_selectors.roll_now.click()
        app.processEvents()
        assert controller.releases == 1
        assert not state["roll"]
        assert not [call for call in state["calls"] if call["action"] == "randomizer_roll"]
        assert page.workspace_tabs.currentWidget() is route
        assert not page.randomizer_page.isWindow()
        state["roll"] = {"key": "build", "name": "Saved canonical build"}
        page.randomizer_page.refresh()
        wait_until(app, lambda: not page.randomizer_page._busy and "Saved canonical build" in page.randomizer_page.result_label.text())
        page.dispatch_build_checkin("update_loading", (replace(model,
            randomizer=RandomizerStripModel("Widget drew: " + state["roll"]["name"],
                rolled_key="build", rolled_name=state["roll"]["name"])),))
        assert page.build_selectors.roll_label.text() == "Widget drew: Saved canonical build"
        assert not page.build_selectors.roll_now.isVisible()
        assert "Saved canonical build" in page.randomizer_page.result_label.text()

        state["roll"] = None
        state["declared"] = {"key": "manual", "name": "My plan"}
        page.randomizer_page.refresh()
        wait_until(app, lambda: not page.randomizer_page._busy and "My plan" in page.randomizer_page.result_label.text())
        page.build_selectors.roll_now.click()
        app.processEvents()
        assert not [call for call in state["calls"] if call["action"] == "randomizer_roll"]

        page.preference_checks["overlaysEnabled"].setChecked(False)
        app.processEvents()
        assert page.build_selectors.loading_toggle.isEnabled()
        assert page.build_selectors.postgame_toggle.isEnabled()
        assert page.randomizer_page.enabled_check.isEnabled()
        assert not hasattr(page.randomizer_page, "roll_button")
    finally:
        page.shutdown()
        page.deleteLater()
        app.processEvents()

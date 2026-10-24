from __future__ import annotations

from copy import deepcopy
import os
import threading
import time

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtWidgets

from sc2tools_agent.ui.companion_build_chain import TIME_RANGES
from sc2tools_agent.ui.companion_page import _stored_build_events, build_companion_page


def wait_until(app, condition):
    deadline = time.monotonic() + 4
    while not condition() and time.monotonic() < deadline:
        app.processEvents()
        time.sleep(0.005)
    assert condition()


def replay(game_id):
    return {
        "gameId": game_id, "myBuild": "Gateway opening", "oppStrategy": "Bio timing",
        "myTechMilestones": [{"name": "CyberneticsCore", "kind": "building", "timeSec": 85, "timing": "started"}],
        "oppTechMilestones": [{"name": "Factory", "kind": "building", "timeSec": 130, "timing": "started"}],
        "myBuildOrder": [{"name": "Gateway", "time": 40, "category": "building"}],
        "oppBuildOrder": [{"name": "Barracks", "time": 45, "category": "building"}],
    }


def stored_order(game_id):
    return {
        "ok": True, "game_id": game_id, "my_status": "ok", "opp_status": "ok",
        "events": [{"name": "Gateway", "category": "building", "is_building": True, "time": index * 10}
                   for index in range(14)] + [
            {"name": "Probe", "category": "unit", "time": 20, "complete_time": 32},
            {"name": "Pylon", "category": "building", "is_building": True, "time": 25},
            {"name": "Stalker", "category": "unit", "time": 50, "complete_time": 80},
            {"name": "Stalker", "category": "unit", "time": 805, "complete_time": 835},
            {"name": "Blink", "category": "upgrade", "time": 120, "complete_time": 170},
            {"name": "Charge", "category": "upgrade", "time": 500, "complete_time": 610},
            {"name": "Oracle", "category": "unit", "time": -1, "complete_time": None},
        ],
        "opp_events": [
            {"name": "Barracks", "category": "building", "is_building": True, "time": 40},
            {"name": "Stimpack", "category": "upgrade", "time": 100, "complete_time": 150},
            {"name": "Stimpack", "category": "upgrade", "time": 300, "complete_time": 420},
        ],
    }


@pytest.fixture
def desk_factory():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    desks = []

    def make(*, initial_gate=None, initial_error=False, count=2):
        key = ("one", "replay-0")
        state = {
            "paired": True, "calls": [], "gates": {key: initial_gate} if initial_gate else {},
            "errors": {key} if initial_error else set(), "orders": {},
            "games": [replay(f"replay-{index}") for index in range(count)],
        }

        def handler(payload):
            state["calls"].append(deepcopy(payload))
            action = payload["action"]
            if action == "snapshot":
                return {"paired": state["paired"], "preferences": {}, "liveGame": {"phase": "menu"}}
            if action == "opponents":
                return {"items": [{"pulseId": "one", "name": "One"}, {"pulseId": "two", "name": "Two"}]}
            if action == "opponent":
                return {"name": payload["pulseId"], "last5GamesScouting": deepcopy(state["games"])}
            if action == "game_build_order":
                request_key = (payload["opponentId"], payload["gameId"])
                gate = state["gates"].get(request_key)
                if gate:
                    gate.wait(4)
                if request_key in state["errors"]:
                    raise ValueError("Stored replay is unavailable")
                return deepcopy(state["orders"].get(request_key, stored_order(payload["gameId"])))
            if action == "ghost_reference":
                state["ghost_target"] = deepcopy(payload)
            return {}

        page = build_companion_page(None, handler=handler, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
        page.timer.stop()
        desks.append((page, state))
        wait_until(app, lambda: page._selected_id == "one" and page.game_select.currentData() == "replay-0")
        return page, state, app

    yield make
    for page, state in desks:
        page.shutdown()
        for gate in state["gates"].values():
            gate.set()
        page.deleteLater()
    app.processEvents()


def build_calls(state):
    return [call for call in state["calls"] if call["action"] == "game_build_order"]


def test_observations_use_recorded_completion_and_never_guess_invalid_times():
    source = stored_order("replay")
    source["events"].extend([
        {"name": "Lair", "category": "building", "is_building": True, "time": 80},
        {"name": "UnknownUnit", "category": "unknown", "time": 125},
        {"name": "Invalid", "category": "unit", "time": 90, "complete_time": float("nan")},
    ])
    events = _stored_build_events(source, "my")
    stalkers = [event for event in events if event["name"] == "Stalker"]
    assert [event["timeSec"] for event in stalkers] == [80, 835]
    assert all(event["timing"] == "completed" for event in stalkers)
    assert next(event for event in events if event["name"] == "Gateway")["timing"] == "started"
    assert next(event for event in events if event["name"] == "Lair")["timing"] == "recorded"
    assert next(event for event in events if event["name"] == "UnknownUnit")["timing"] == "recorded"
    assert next(event for event in events if event["name"] == "Invalid")["timeSec"] is None
    assert next(event for event in events if event["name"] == "Oracle")["timeSec"] is None
    assert source["events"][16]["time"] == 50


def test_unknown_replay_unit_categories_paint_icons_in_both_chains_and_full_timelines(desk_factory):
    gate = threading.Event()
    page, state, app = desk_factory(initial_gate=gate)
    source = {
        "ok": True, "game_id": "replay-0", "my_status": "ok", "opp_status": "ok",
        "events": [
            {"name": "Sentry", "category": "unknown", "is_building": False, "time": 90, "complete_time": 125},
            {"name": "Phoenix", "category": "unknown", "is_building": False, "time": 100, "complete_time": 150},
        ],
        "opp_events": [
            {"name": "Phoenix", "category": "unknown", "is_building": False, "time": 110, "complete_time": 160},
            {"name": "Sentry", "category": "unknown", "is_building": False, "time": 120, "complete_time": 170},
        ],
    }
    original = deepcopy(source)
    state["orders"][("one", "replay-0")] = source
    gate.set()
    wait_until(app, lambda: ("one", "replay-0") in page._build_order_cache)
    for side in ("my", "opp"):
        observed = _stored_build_events(source, side)
        chain = page.build_chains[side]
        assert chain.events == observed
        assert all(event["kind"] == "unknown" and event["timing"] == "completed" for event in observed)
        assert [step.time_label.text() for step in chain.steps] == (["2:05", "2:30"] if side == "my" else ["2:40", "2:50"])
        for index, step in enumerate(chain.steps):
            assert step.icon_label.text() == ""
            assert not step.icon_label.pixmap().isNull()
            assert not page.trees["build"][side].topLevelItem(index).icon(0).pixmap(30, 30).isNull()
    assert source == original


def test_shared_time_range_loads_full_stored_source_once_and_has_no_density_caps(desk_factory):
    page, state, app = desk_factory()
    wait_until(app, lambda: ("one", "replay-0") in page._build_order_cache)
    assert [(page.build_time_range.itemText(index), page.build_time_range.itemData(index))
            for index in range(page.build_time_range.count())] == list(TIME_RANGES)
    assert page.build_time_range.currentData() == 180
    assert len(page.build_chains["my"].steps) > 8
    assert len(build_calls(state)) == 1
    assert "Stored replay events" in page.build_source_status.toolTip()
    assert not page.include_workers_supply.isChecked()
    assert "Probe" not in [event["name"] for event in page.build_chains["my"].events]
    for horizon in (360, 600, None):
        page.build_time_range.setCurrentIndex(page.build_time_range.findData(horizon))
        for density in ("standard", "detailed", "full", "compact"):
            page.set_density(density)
            assert all(chain.time_range() == horizon for chain in [*page.build_chains.values(), *page.upgrade_chains.values()])
    assert len([event for event in page.build_chains["my"].events if event["name"] == "Stalker"]) == 2
    assert page.build_chains["my"].steps[-1].time_label.text() == "Time unknown"
    page.include_workers_supply.setChecked(True)
    assert {"Probe", "Pylon"}.issubset({event["name"] for event in page.build_chains["my"].events})
    page._save_ghost_reference("you")
    wait_until(app, lambda: "ghost_reference" not in page._requests)
    assert state["ghost_target"] == {"action": "ghost_reference", "gameId": "replay-0", "side": "you", "clear": False}
    assert len(build_calls(state)) == 1


def test_valid_empty_source_does_not_fall_back_to_preview(desk_factory):
    page, state, app = desk_factory()
    wait_until(app, lambda: ("one", "replay-0") in page._build_order_cache)
    state["orders"][("one", "replay-1")] = {
        "ok": True, "game_id": "replay-1", "events": [], "opp_events": [],
        "my_status": "empty", "opp_status": "not_extracted",
    }
    page.game_select.setCurrentIndex(1)
    wait_until(app, lambda: ("one", "replay-1") in page._build_order_cache)
    assert not page.build_chains["my"].events and not page.build_chains["opp"].events
    assert "You: no recorded events" in page.build_source_status.toolTip()
    assert "Opponent: not extracted" in page.build_source_status.toolTip()
    assert "Scouting preview" not in page.build_source_status.toolTip()
    assert page.trees["build"]["my"].topLevelItem(0).text(0) == "No replay timing data available"


def test_preview_failure_requires_explicit_retry_and_navigation_keeps_preview(desk_factory):
    page, state, app = desk_factory(initial_error=True)
    wait_until(app, lambda: ("one", "replay-0") in page._build_order_failures)
    assert page.build_chains["my"].events[0]["name"] == "CyberneticsCore"
    assert "Scouting preview" in page.build_source_status.toolTip() and "load failed" in page.build_source_status.toolTip()
    assert not page.build_retry.isHidden()
    for horizon in (360, 600, None):
        page.build_time_range.setCurrentIndex(page.build_time_range.findData(horizon))
        page.set_density("standard")
        page._game_selected()
    assert len(build_calls(state)) == 1
    state["errors"].clear()
    page.build_retry.click()
    wait_until(app, lambda: ("one", "replay-0") in page._build_order_cache)
    assert len(build_calls(state)) == 2
    assert "Stored replay events" in page.build_source_status.toolTip()
    assert page.build_retry.isHidden()


def test_inflight_dedup_and_late_result_cannot_replace_selected_replay(desk_factory):
    first_gate, second_gate = threading.Event(), threading.Event()
    page, state, app = desk_factory(initial_gate=first_gate)
    state["gates"][("one", "replay-1")] = second_gate
    state["orders"][("one", "replay-0")] = {
        "ok": True, "game_id": "replay-0", "events": [{"name": "Nexus", "category": "building", "time": 50}],
        "opp_events": [], "my_status": "ok", "opp_status": "empty",
    }
    page._game_selected()
    page.game_select.setCurrentIndex(1)
    page._game_selected()
    assert len(build_calls(state)) == 1
    first_gate.set()
    wait_until(app, lambda: len(build_calls(state)) == 2)
    assert page.game_select.currentData() == "replay-1"
    assert page.build_chains["my"].events[0]["name"] == "CyberneticsCore"
    assert "Scouting preview" in page.build_source_status.toolTip()
    second_gate.set()
    wait_until(app, lambda: ("one", "replay-1") in page._build_order_cache)
    assert page.build_chains["my"].events[0]["name"] == "Gateway"
    page.game_select.setCurrentIndex(0)
    assert page.build_chains["my"].events[0]["name"] == "Nexus"
    assert len(build_calls(state)) == 2


def test_cache_is_scoped_to_opponent_and_unpair_discards_inflight_results(desk_factory):
    page, state, app = desk_factory()
    wait_until(app, lambda: ("one", "replay-0") in page._build_order_cache)
    other_gate = state["gates"][("two", "replay-0")] = threading.Event()
    page.opponent_list.setCurrentRow(1)
    wait_until(app, lambda: page._selected_id == "two" and page._build_order_inflight == ("two", "replay-0"))
    assert len(build_calls(state)) == 2
    assert "Scouting preview" in page.build_source_status.toolTip()
    state["paired"] = False
    page.refresh()
    wait_until(app, lambda: not page._paired)
    assert not page._build_order_cache and page._build_order_inflight is None
    other_gate.set()
    for _index in range(8):
        app.processEvents()
        time.sleep(0.005)
    assert not page._build_order_cache and page._selected_id is None
    assert "game_build_order" not in page._requests


def test_build_order_cache_retains_at_most_twelve_replays(desk_factory):
    page, state, app = desk_factory(count=14)
    wait_until(app, lambda: ("one", "replay-0") in page._build_order_cache)
    for index in range(1, 14):
        page.game_select.setCurrentIndex(index)
        wait_until(app, lambda current=index: ("one", f"replay-{current}") in page._build_order_cache)
        assert len(page._build_order_cache) <= 12
    assert ("one", "replay-0") not in page._build_order_cache
    assert ("one", "replay-1") not in page._build_order_cache
    page.game_select.setCurrentIndex(2)
    assert next(reversed(page._build_order_cache)) == ("one", "replay-2")


def test_explicit_library_refresh_reloads_reanalyzed_selected_replay(desk_factory):
    page, state, app = desk_factory()
    key = ("one", "replay-0")
    wait_until(app, lambda: key in page._build_order_cache)
    refreshed = stored_order("replay-0")
    refreshed["events"] = [{"name": "Stargate", "category": "building", "is_building": True, "time": 75}]
    state["orders"][key] = refreshed
    page.refresh_library()
    wait_until(app, lambda: key in page._build_order_cache)
    assert len([call for call in build_calls(state) if call["gameId"] == "replay-0"]) == 2
    assert page.build_chains["my"].events[0]["name"] == "Stargate"
    assert page.game_select.currentData() == "replay-0"


def test_pinned_opponent_uses_compact_size_and_its_window_controls(desk_factory):
    page, state, app = desk_factory()
    panel = page.overlays["opponent"]
    panel.show()
    app.processEvents()
    assert panel.windowFlags() & QtCore.Qt.FramelessWindowHint
    assert panel.minimumSize().toTuple() == (280, 68)
    assert panel.size().toTuple() == panel.identity_card.sizeHint().toTuple() == (340, 78)
    panel.identity_card.minimize_button.click()
    assert panel.isMinimized()
    panel.showNormal()
    page._preferences["opponentOverlay"] = True
    panel.identity_card.close_button.click()
    wait_until(app, lambda: not page._preference_busy)
    assert not panel.isVisible()
    assert page._preferences["opponentOverlay"] is False


def test_standard_uses_one_line_status_and_two_player_cards(desk_factory):
    page, state, app = desk_factory()
    wait_until(app, lambda: ("one", "replay-0") in page._build_order_cache)
    page.resize(480, 440)
    page.show()
    page.set_density("standard")
    for _index in range(10):
        app.processEvents()
    assert page.build_source_status.height() == 18
    assert not page.build_source_status.wordWrap()
    assert page.build_source_status.toolTip() == page.build_source_status.full_text
    assert page.build_options_menu.actions()[0].defaultWidget().isAncestorOf(page.include_workers_supply)
    assert page.chain_cards[0].y() == page.chain_cards[1].y()
    assert page.chain_cards[0].x() < page.chain_cards[1].x()
    for side in ("my", "opp"):
        chain = page.build_chains[side]
        assert chain._tile_width == 80
    page.include_workers_supply.setChecked(True)
    assert any(event["name"] == "Probe" for event in page.build_chains["my"].events)


def test_narrow_opponent_summary_stays_with_selected_profile_not_live_context(desk_factory):
    page, state, app = desk_factory()
    page._detail.update({"name": "Selected opponent", "race": "Terran", "mmr": 4321,
                         "totals": {"wins": 3, "losses": 1}})
    page._snapshot = {"liveGame": {"phase": "match_in_progress", "capturedAt": time.time(),
                                   "opponent": {"name": "Live opponent", "race": "Zerg", "profile": {"mmr": 5555}},
                                   "streamerHistory": {"headToHead": {"wins": 10, "losses": 20}}}}
    page._snapshot_healthy = True
    page.resize(520, 480)
    page.show()
    page.set_density("standard")
    app.processEvents()
    summary = page.console.opponent_summary.toolTip()
    assert "Selected opponent" in summary and "Terran" in summary and "4321" in summary
    assert "3W" in summary and "1L" in summary and "75%" in summary
    assert "Live opponent" not in summary and "5555" not in summary


def test_explicit_pinned_enable_and_preview_restore_minimized_panel_without_poll_restoring_it(desk_factory):
    page, state, app = desk_factory()
    page.set_preference("overlaysEnabled", True)
    page.set_preference("opponentOverlay", True)
    page.preview_button.setChecked(True)
    wait_until(app, lambda: not page._preference_busy)
    panel = page.overlays["opponent"]
    assert panel.isVisible()
    panel.identity_card.minimize_button.click()
    page._update_overlays()
    assert panel.isMinimized()
    page.set_preference("opponentOverlay", False)
    page.set_preference("opponentOverlay", True)
    wait_until(app, lambda: not page._preference_busy)
    assert panel.isVisible() and not panel.isMinimized()
    panel.identity_card.minimize_button.click()
    page.preview_button.setChecked(False)
    page.preview_button.setChecked(True)
    assert panel.isVisible() and not panel.isMinimized()


def test_real_standard_main_window_fits_two_columns_and_first_observed_timings(tmp_path):
    from tests._gui_offscreen import run_gui_check
    run_gui_check(tmp_path, '''
        from tests.test_companion_build_range_scope import replay, stored_order
        def handler(payload):
            action = payload["action"]
            if action == "snapshot":
                return {"paired": True, "preferences": {}, "liveGame": {"phase": "menu"}}
            if action == "opponents":
                return {"items": [{"pulseId": "one", "name": "Selected opponent", "race": "Terran"}]}
            if action == "opponent":
                return {"name": "Selected opponent", "race": "Terran", "mmr": 4321,
                        "totals": {"wins": 3, "losses": 1}, "last5GamesScouting": [replay("fixture")]}
            if action == "game_build_order":
                return stored_order(payload["gameId"])
            return {}
        ui, win = make_window(on_companion_action=handler, window_information_layout="standard")
        page = win._companion_page
        page.timer.stop()
        win._go_to_page("companion")
        win._set_window_size("Standard")
        win.show()
        deadline = QtCore.QDeadlineTimer(4000)
        while ("one", "fixture") not in page._build_order_cache and not deadline.hasExpired():
            QtTest.QTest.qWait(5)
        QtTest.QTest.qWait(100)
        assert win.size().toTuple() == (520, 480), win.size().toTuple()
        assert page.current_density() == "standard"
        viewport = page.overview.viewport()
        for side in ("my", "opp"):
            chain = page.build_chains[side]
            assert chain._columns == 2, (side, chain.scroll.viewport().size().toTuple(), chain._columns)
            for observation in (chain.steps[0].icon_label, chain.steps[0].time_label, chain.steps[0].timing_label):
                rectangle = QtCore.QRect(observation.mapTo(viewport, QtCore.QPoint()), observation.size())
                assert viewport.rect().contains(rectangle), (side, viewport.size().toTuple(), rectangle)
        summary = page.console.opponent_summary.toolTip()
        assert "Selected opponent" in summary and "4321" in summary and "75%" in summary
        page.shutdown()
        win.hide()
    ''')

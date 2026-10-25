import pytest

from .test_companion_page import QtCore, companion, game, wait_until
from sc2tools_agent.ui import companion_page


def stored_order(game_id, name="Gateway", times=(40, 180, 360, 600, 900)):
    return {"ok": True, "game_id": game_id, "my_status": "ok", "opp_status": "ok",
            "events": [{"name": name, "category": "building", "is_building": True, "time": stamp}
                       for stamp in times],
            "opp_events": [{"name": "Barracks", "category": "building", "is_building": True, "time": stamp}
                           for stamp in times]}


def complete(page, key, *, name="Gateway", times=(40, 180, 360, 600, 900)):
    page._build_order_inflight = key
    page._finish_build_order({"payload": {"opponentId": key[0], "gameId": key[1]},
                              "result": stored_order(key[1], name, times)})


@pytest.fixture
def quiet_history(companion, monkeypatch):
    page, state, app = companion
    wait_until(app, lambda: "game_build_order" not in page._requests)
    page._preferences.update(scoutingOverlay=False, scoutingReadAloud=False)
    state["snapshot"]["preferences"].update(scoutingOverlay=False, scoutingReadAloud=False)
    page._update_overlays()
    page.hide()
    page._build_order_cache.clear()
    page._build_order_failures.clear()
    page._clear_history_render_cache(clear_widgets=True)
    calls = []
    original_filter = companion_page._filter_build_events
    def filtered(events, **kwargs):
        calls.append(len(events))
        return original_filter(events, **kwargs)
    monkeypatch.setattr(companion_page, "_filter_build_events", filtered)
    yield page, state, app, calls


def test_hidden_history_arrival_and_live_ticks_do_not_hydrate_any_view(quiet_history, monkeypatch):
    page, state, app, filters = quiet_history
    page.set_density("compact")
    loaded = []
    original = companion_page.load_icon
    def icon(*args, **kwargs):
        loaded.append(args)
        return original(*args, **kwargs)
    monkeypatch.setattr(companion_page, "load_icon", icon)
    key = page._current_build_key()
    complete(page, key)
    for _ in range(3):
        page._update_overlays()
        app.processEvents()
    assert key in page._build_order_cache
    assert loaded == [] and filters == []
    assert not page.build_chains["my"].events
    assert all(tree.topLevelItem(0).text(0) == "No replay timing data available"
               for trees in page.trees.values() for tree in trees.values())
    # An expanded Home still is not a historical build consumer.
    page.set_density("standard")
    page.console.navigate("home")
    page.show()
    app.processEvents()
    assert loaded == [] and filters == []
    page.console.navigate("scouting")
    wait_until(app, lambda: bool(page.build_chains["my"].events))
    assert [step.observation["timeSec"] for step in page.build_chains["my"].steps] == [40, 180]
    assert all(tree.topLevelItem(0).text(0) == "No replay timing data available"
               for trees in page.trees.values() for tree in trees.values())
    loaded.clear()
    filters.clear()
    for _ in range(3):
        page._update_overlays()
        app.processEvents()
    assert loaded == [] and filters == []


def test_full_details_hydrates_only_the_selected_legacy_tab(quiet_history):
    page, state, app, filters = quiet_history
    complete(page, page._current_build_key())
    page.set_density("full")
    page.console.navigate("scouting")
    page.show()
    wait_until(app, lambda: page.trees["tech"]["my"].topLevelItem(0).text(0) == "Gateway")
    assert not page.build_chains["my"].events
    assert page.trees["build"]["my"].topLevelItem(0).text(0) == "No replay timing data available"
    assert page.trees["upgrades"]["my"].topLevelItem(0).text(0) == "No replay timing data available"
    page.tabs.setCurrentIndex(1)
    wait_until(app, lambda: page.trees["build"]["my"].topLevelItemCount() == 5)
    # Legacy full timelines still contain the full recorded data independently
    # of the three-minute comparison horizon.
    assert page.trees["build"]["my"].topLevelItem(4).text(1) == "15:00"


def test_minimized_main_defers_range_and_same_key_data_until_restore(quiet_history):
    page, state, app, filters = quiet_history
    key = page._current_build_key()
    complete(page, key)
    page.set_density("standard")
    page.console.navigate("scouting")
    page.show()
    wait_until(app, lambda: bool(page.build_chains["my"].events))
    page.showMinimized()
    app.processEvents()
    filters.clear()
    page.build_time_range.setCurrentIndex(page.build_time_range.findData(600))
    complete(page, key, name="Stargate")
    assert filters == []
    assert page.build_chains["my"].events[0]["name"] == "Gateway"
    page.showNormal()
    wait_until(app, lambda: page.build_chains["my"].events[0]["name"] == "Stargate")
    assert [step.observation["timeSec"] for step in page.build_chains["my"].steps] == [40, 180, 360, 600]
    filters.clear()
    page._update_overlays()
    assert filters == []
    page._clear_library()
    assert not page.build_chains["my"].events
    assert not page._build_order_cache
    assert all(source is None for source in page._history_sources.values())
    assert all(signature[1] is None for signature in page._history_signatures.values())


def test_floating_scouting_hydrates_independently_and_catches_up_on_restore(quiet_history):
    page, state, app, filters = quiet_history
    complete(page, page._current_build_key())
    panel = page.overlays["scouting"]
    context = {"name": "Separate live enemy", "pulseId": "live-enemy",
               "last5GamesScouting": [game("other-encounter")]}
    panel.update_context(context, scope=("fixture-owner", "live-game"))
    key = panel._key
    complete(page, key, name="Hatchery")
    assert filters == [] and not panel.comparison.build_chains["my"].events
    panel.show()
    wait_until(app, lambda: bool(panel.comparison.build_chains["my"].events))
    assert panel.comparison.build_chains["my"].events[0]["name"] == "Hatchery"
    assert not page.build_chains["my"].events and not page.isVisible()
    panel.showMinimized()
    app.processEvents()
    filters.clear()
    panel.build_time_range.setCurrentIndex(panel.build_time_range.findData(None))
    page.include_workers_supply.setChecked(True)
    complete(page, key, name="Lair")
    assert filters == []
    panel.showNormal()
    wait_until(app, lambda: panel.comparison.build_chains["my"].events[0]["name"] == "Lair")
    assert panel.comparison.build_chains["my"].time_range() is None
    assert len(panel.comparison.build_chains["my"].steps) == 5
    assert not page.build_chains["my"].events
    filters.clear()
    panel.render_build_data()
    assert filters == []
    page._ghost_references = {"PvT": {"gameId": key[1], "side": "you"}}
    panel.render_build_data()
    assert panel.comparison.chain_reference_buttons["you"].text().startswith("★")
    assert filters == []

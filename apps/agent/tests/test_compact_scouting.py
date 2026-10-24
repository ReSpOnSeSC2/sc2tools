from copy import deepcopy
import time

from tests.test_companion_build_range_scope import desk_factory, replay, wait_until
from tests.test_companion_page import companion


def test_compact_scouting_button_toggles_only_the_live_report_without_changing_saved_pin_choice(companion):
    page, state, app = companion
    page.set_density("compact")
    page.set_preference("scoutingOverlay", False)
    wait_until(app, lambda: not page._preference_busy)
    before = deepcopy(page._preferences)
    route = page.console.context()
    panel = page.overlays["scouting"]
    requests = len([entry for entry in state["calls"] if entry["action"] == "preferences"])
    assert page.compact_card.scouting_button.isEnabled()
    assert not panel.isVisible()
    for card in (page.compact_card, page.overlays["opponent"].identity_card):
        card.scouting_button.click()
        app.processEvents()
        assert panel.isVisible() and card.scouting_button.isChecked()
        assert page.current_density() == "compact"
        assert page.console.context() == route
        card.scouting_button.click()
        assert not panel.isVisible() and not card.scouting_button.isChecked()
    assert page._preferences == before
    assert len([entry for entry in state["calls"] if entry["action"] == "preferences"]) == requests


def test_scouting_panel_uses_its_live_replay_and_detailed_cards_while_library_selection_stays_put(desk_factory):
    page, state, app = desk_factory()
    wait_until(app, lambda: page._build_order_inflight is None)
    page._preferences.update(overlaysEnabled=True, opponentOverlay=True, scoutingOverlay=False)
    page._snapshot = {"paired": True, "liveGame": {
        "phase": "match_in_progress", "gameKey": "live-match", "capturedAt": time.time(),
        "opponent": {"name": "Live enemy", "race": "Terran", "profile": {"mmr": 4300}},
        "streamerHistory": {"last5GamesScouting": [{**replay("live-replay"), "myBuild": "Live scouting build", "map": "Live history map"}]},
    }}
    page._snapshot_healthy = True
    page.set_density("compact")
    page._update_overlays()
    selected = page.game_select.currentData()
    page.compact_card.scouting_button.click()
    panel = page.overlays["scouting"]
    wait_until(app, lambda: panel._key in page._build_order_cache)
    assert panel.games.currentData() == "live-replay"
    assert page.game_select.currentData() == selected == "replay-0"
    assert panel.comparison.chain_labels["my"].text() == "Live scouting build"
    assert panel.comparison.chain_headings["my"].text() == "YOUR BUILD ORDER"
    assert panel.comparison.upgrade_chains["my"].isVisible()
    assert "Stored replay events" in panel.source_status.toolTip()
    assert any(step.timing_label.text() == "Completed" for step in panel.comparison.build_chains["my"].steps)
    initial = len(panel.comparison.build_chains["my"].steps)
    panel.build_time_range.setCurrentIndex(panel.build_time_range.findData(None))
    assert page.build_time_range.currentData() is None
    assert len(panel.comparison.build_chains["my"].steps) > initial
    assert any(step.time_label.text() == "13:55" for step in panel.comparison.build_chains["my"].steps)
    assert any(step.observation["name"] == "Charge" for step in panel.comparison.upgrade_chains["my"].steps)
    panel.comparison.chain_reference_buttons["opponent"].click()
    wait_until(app, lambda: "ghost_target" in state)
    assert state["ghost_target"]["gameId"] == "live-replay"
    assert state["ghost_target"]["side"] == "opponent"
    assert page.game_select.currentData() == selected


def test_ending_or_losing_a_live_match_clears_opponent_fields_and_disables_scouting(companion):
    page, state, app = companion
    page.set_density("compact")
    for phase in ("match_ended", "menu", "offline"):
        page._snapshot["liveGame"].update(phase="match_in_progress", capturedAt=time.time())
        page._snapshot_healthy = True
        page._update_overlays()
        assert page.compact_card.identity["name"] == "Live opponent"
        page._snapshot["liveGame"]["phase"] = phase
        page._update_overlays()
        assert page.compact_card.identity == {"name": "—", "race": "—", "mmr": "—"}
        assert page.compact_card.record["text"] == "—"
        assert not page.compact_card.scouting_button.isEnabled()
        assert not any(panel.isVisible() for panel in page.overlays.values())
        assert page.overlays["opponent"].identity_card.identity["name"] == "—"
        assert page.overlays["scouting"]._key is None
    page._snapshot["liveGame"].update(phase="match_in_progress", capturedAt=time.time() - 31)
    page._update_overlays()
    assert not page.compact_card.scouting_button.isEnabled()
    assert page.compact_card.identity["name"] == "—"


def test_manual_scouting_close_survives_polling_and_master_off_hides_the_report(companion):
    page, state, app = companion
    panel = page.overlays["scouting"]
    assert panel.isVisible()
    page.compact_card.scouting_button.click()
    assert not panel.isVisible()
    page._update_overlays()
    assert not panel.isVisible()
    page.compact_card.scouting_button.click()
    assert panel.isVisible()
    page.set_preference("overlaysEnabled", False)
    assert not panel.isVisible() and not page.compact_card.scouting_button.isEnabled()


def test_explicit_scouting_pin_choice_overrides_temporary_toggle_and_a_new_match_resets_dismissal(companion):
    page, state, app = companion
    panel = page.overlays["scouting"]
    page.compact_card.scouting_button.click()
    assert not panel.isVisible()
    page.set_preference("scoutingOverlay", True)
    wait_until(app, lambda: not page._preference_busy)
    assert panel.isVisible()
    page.set_preference("scoutingOverlay", False)
    wait_until(app, lambda: not page._preference_busy)
    page.compact_card.scouting_button.click()
    assert panel.isVisible()
    page.set_preference("scoutingOverlay", False)
    wait_until(app, lambda: not page._preference_busy)
    assert not panel.isVisible()
    page.set_preference("scoutingOverlay", True)
    wait_until(app, lambda: not page._preference_busy)
    page.compact_card.scouting_button.click()
    page._snapshot["liveGame"].update(gameKey="next-match", capturedAt=time.time())
    page._update_overlays()
    assert panel.isVisible() and page.compact_card.scouting_button.isChecked()


def test_scouting_panel_retry_reloads_its_own_replay_and_reports_loading(desk_factory):
    page, state, app = desk_factory()
    wait_until(app, lambda: page._build_order_inflight is None)
    page._preferences.update(overlaysEnabled=True, scoutingOverlay=False)
    page._snapshot = {"paired": True, "liveGame": {
        "phase": "match_in_progress", "gameKey": "retry-match", "capturedAt": time.time(),
        "opponent": {"name": "Live enemy", "race": "Terran"},
        "streamerHistory": {"pulseId": "live-history", "last5GamesScouting": [replay("live-replay")]},
    }}
    page._snapshot_healthy = True
    state["errors"].add(("live-history", "live-replay"))
    page._update_overlays()
    page.compact_card.scouting_button.click()
    panel = page.overlays["scouting"]
    wait_until(app, lambda: panel._key in page._build_order_failures)
    assert panel.retry.isVisible() and panel.retry.isEnabled()
    assert "load failed" in panel.source_status.toolTip()
    state["errors"].clear()
    panel.retry.click()
    assert not panel.retry.isEnabled()
    assert "loading stored replay events" in panel.source_status.toolTip()
    wait_until(app, lambda: panel._key in page._build_order_cache)
    assert not panel.retry.isVisible()
    assert "Stored replay events" in panel.source_status.toolTip()
    assert page.game_select.currentData() == "replay-0"

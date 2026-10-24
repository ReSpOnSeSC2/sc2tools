from __future__ import annotations

from copy import deepcopy

import pytest

from .test_companion_page import companion, game, wait_until


def _order(game_id, *, name="Gateway", times=(40, 180, 360, 600, 900)):
    return {
        "ok": True, "game_id": game_id, "my_status": "ok", "opp_status": "ok",
        "events": [{"name": name, "category": "building", "is_building": True, "time": stamp} for stamp in times],
        "opp_events": [{"name": "Barracks", "category": "building", "is_building": True, "time": stamp} for stamp in times],
    }


@pytest.fixture
def controlled_builds(companion, monkeypatch):
    page, state, app = companion
    wait_until(app, lambda: "game_build_order" not in page._requests)
    page.set_preference("scoutingOverlay", False)
    wait_until(app, lambda: not page._preference_busy)
    original = page._job
    pending = []

    def capture(channel, payload):
        if channel != "game_build_order":
            return original(channel, payload)
        page._sequence += 1
        page._requests[channel] = page._sequence
        pending.append({"channel": channel, "request": page._sequence, "payload": deepcopy(payload)})

    def deliver(result=None, *, error=None, request=None):
        response = deepcopy(request or pending[-1])
        response.update({"result": deepcopy(result), "error": error})
        page._completed(response)

    monkeypatch.setattr(page, "_job", capture)
    page._build_order_cache.clear()
    page._build_order_failures.clear()
    page._build_order_inflight = None
    page._retry_build_order()
    page.set_density("standard")
    yield page, state, app, pending, deliver


def _set_range(page, horizon):
    index = page.build_time_range.findData(horizon)
    assert index >= 0
    page.build_time_range.setCurrentIndex(index)


def _times(chain):
    return [step.observation["timeSec"] for step in chain.steps]


def _source_text(page):
    status = page.build_source_status
    return getattr(status, "full_text", "") or status.toolTip() or status.text()


def test_default_three_minutes_is_inclusive_for_both_sides_without_a_four_or_eight_step_cap(controlled_builds):
    page, state, app, pending, deliver = controlled_builds
    times = tuple(range(0, 180, 15)) + (180, 180.01, 360, 600)
    deliver(_order("game-1", times=times))
    assert page.build_time_range.currentData() == 180
    assert len(pending) == 1
    for side in ("my", "opp"):
        assert page.build_chains[side].time_range() == 180
        assert _times(page.build_chains[side]) == list(times[:13])
        assert len(page.build_chains[side].steps) > 8
    assert "Stored replay events" in _source_text(page)


@pytest.mark.parametrize("horizon", [180, 360, 600, None])
def test_ranges_use_finite_recorded_observations_and_never_infer_completion_offsets(controlled_builds, horizon):
    page, state, app, pending, deliver = controlled_builds
    source = _order("game-1", times=(180, 180.01, 360, 360.01, 600, 600.01, None, float("nan"), float("inf"), -1))
    source["events"].append({"name": "Blink", "category": "upgrade", "time": 120, "complete_time": 360})
    source["opp_events"].append({"name": "Stimpack", "category": "upgrade", "time": 150, "complete_time": 600})
    deliver(source)
    _set_range(page, horizon)
    for side in ("my", "opp"):
        shown = _times(page.build_chains[side])
        if horizon is None:
            assert shown[-4:] == [None] * 4
        else:
            assert shown and all(stamp is not None and 0 <= stamp <= horizon for stamp in shown)
            assert horizon in shown
        assert page.upgrade_chains[side].time_range() == horizon
    blink = next(event for event in page.build_chains["my"].events if event["name"] == "Blink")
    assert blink == {"name": "Blink", "timeSec": 360, "kind": "upgrade", "timing": "completed"}
    assert all(event["timeSec"] != 120 for event in page.build_chains["my"].events)


def test_late_replay_result_is_cached_without_replacing_current_preview_then_new_result_renders(controlled_builds):
    page, state, app, pending, deliver = controlled_builds
    first_request = deepcopy(pending[0])
    page._detail["last5GamesScouting"].append(game("second-game"))
    page._render_detail()
    page.game_select.setCurrentIndex(1)
    assert len(pending) == 1
    deliver(_order("game-1", name="Nexus"), request=first_request)
    assert ("one", "game-1") in page._build_order_cache
    assert page.game_select.currentData() == "second-game"
    assert all(event["name"] != "Nexus" for event in page.build_chains["my"].events)
    assert pending[-1]["payload"]["gameId"] == "second-game"
    deliver(_order("second-game", name="Stargate"))
    assert page.build_chains["my"].events[0]["name"] == "Stargate"
    page.game_select.setCurrentIndex(0)
    assert page.build_chains["my"].events[0]["name"] == "Nexus"
    assert len(pending) == 2


def test_range_survives_snapshot_refresh_and_layout_changes_without_refetch(controlled_builds):
    page, state, app, pending, deliver = controlled_builds
    deliver(_order("game-1"))
    _set_range(page, 600)
    page.notes.setPlainText("Unsaved range-test notes")
    for density in ("detailed", "full", "compact", "standard"):
        page.set_density(density)
        assert page.build_time_range.currentData() == 600
        assert all(chain.time_range() == 600 for chain in [*page.build_chains.values(), *page.upgrade_chains.values()])
    state["snapshot"]["liveGame"]["displayTime"] = 91
    page.refresh()
    wait_until(app, lambda: page._snapshot.get("liveGame", {}).get("displayTime") == 91)
    assert page.build_time_range.currentData() == 600
    assert _times(page.build_chains["my"]) == [40, 180, 360, 600]
    assert page.notes.toPlainText() == "Unsaved range-test notes"
    assert len(pending) == 1


def test_mismatched_payload_is_truthfully_unavailable_and_only_explicit_retry_can_replace_it(controlled_builds):
    page, state, app, pending, deliver = controlled_builds
    stale = deepcopy(pending[-1])
    deliver(_order("wrong-replay", name="Nexus"))
    assert not page._build_order_cache
    assert "Scouting preview" in _source_text(page)
    assert "load failed" in _source_text(page)
    assert not page.build_retry.isHidden()
    _set_range(page, None)
    page._game_selected()
    assert len(pending) == 1
    page.build_retry.click()
    assert len(pending) == 2
    deliver(_order("game-1", name="Nexus"), request=stale)
    assert not page._build_order_cache
    assert page._build_order_inflight == ("one", "game-1")
    deliver(_order("game-1", name="Stargate"))
    assert page.build_chains["my"].events[0]["name"] == "Stargate"
    assert page.build_retry.isHidden()


def test_cache_and_failures_are_bounded_and_old_cached_entries_refetch_after_eviction(controlled_builds):
    page, state, app, pending, deliver = controlled_builds
    deliver(_order("game-1"))
    page._detail["last5GamesScouting"] = [game(f"range-{index}") for index in range(15)]
    page._render_detail()
    for index in range(15):
        page.game_select.setCurrentIndex(index)
        deliver(_order(f"range-{index}"))
        assert len(page._build_order_cache) <= 12
    assert ("one", "range-0") not in page._build_order_cache
    before = len(pending)
    page.game_select.setCurrentIndex(0)
    assert len(pending) == before + 1
    deliver(error="Connection unavailable")
    for index in range(1, 15):
        page._build_order_cache.pop(("one", f"range-{index}"), None)
        page.game_select.setCurrentIndex(index)
        deliver(error="Connection unavailable")
        assert len(page._build_order_failures) <= 12
    assert ("one", "range-0") not in page._build_order_failures

from dataclasses import replace

import pytest

from sc2tools_agent.build_checkin.models import LoadingCardModel, PostgameCardModel
from sc2tools_agent.ui.build_checkin_window import BuildCheckinHost
from tests.test_build_checkin_ui_core import FakeWindow


def host():
    return BuildCheckinHost(controller=lambda: None, window_factory=lambda kind, owner: FakeWindow(kind))


def test_master_off_caches_latest_selector_without_opening_a_window():
    view = host()
    view.set_panels_enabled(False)
    model = LoadingCardModel(game_key="current")
    view.dispatch("show_loading", (model,))
    updated = replace(model, locked_label="Chosen build", collapsed=True)
    view.dispatch("update_loading", (updated,))
    assert view.existing_window("loading") is None
    view.set_panels_enabled(True)
    window = view.existing_window("loading")
    assert window.visible
    assert window.calls[-1] == ("show", updated)


def test_disabling_and_reenabling_panels_keeps_only_current_pending_card():
    view = host()
    current = PostgameCardModel(card_id="current")
    view.dispatch("show_postgame", (current,))
    window = view.existing_window("postgame")
    view.set_panels_enabled(False)
    assert not window.visible
    view.dispatch("hide_postgame", ("unrelated", "confirmed"))
    view.set_panels_enabled(True)
    assert window.visible
    view.set_panels_enabled(False)
    view.dispatch("hide_postgame", ("current", "confirmed"))
    view.set_panels_enabled(True)
    assert not window.visible


def test_old_game_updates_cannot_replace_the_cached_current_selector():
    view = host()
    view.set_panels_enabled(False)
    current = LoadingCardModel(game_key="current")
    view.dispatch("show_loading", (current,))
    view.dispatch("update_loading", (LoadingCardModel(game_key="old"),))
    view.dispatch("hide_loading", ("old", "ended"))
    view.set_panels_enabled(True)
    assert view.existing_window("loading").identity == "current"


def test_preset_gates_each_selector_without_losing_the_pending_model():
    view = host()
    view.set_feature_gates({"preGameSelector": False, "postGameSelector": True})
    view.dispatch("show_loading", (LoadingCardModel(game_key="current"),))
    view.dispatch("show_postgame", (PostgameCardModel(card_id="finished"),))
    assert view.existing_window("loading") is None
    assert view.existing_window("postgame").visible
    view.set_feature_gates({"preGameSelector": True, "postGameSelector": False})
    assert view.existing_window("loading").visible
    assert not view.existing_window("postgame").visible
    view.set_panels_enabled(False)
    view.set_feature_gates({"preGameSelector": False, "postGameSelector": True})
    assert not view.existing_window("postgame").visible


def test_refused_preview_names_why_assistance_is_off_without_opening_a_card():
    reasons = iter(["unpaired", None])
    view = BuildCheckinHost(controller=lambda: None, assistance_reason=lambda: next(reasons),
                            window_factory=lambda kind, owner: pytest.fail("a refused preview opened a card"))
    view.set_panels_enabled(False)
    assert view.show_preview("loading") == "unpaired"
    # No reason from the Companion page still means its master switch is off.
    assert view.show_preview("postgame") == "assistance_off"
    view.set_panels_enabled(True)
    assert view.show_preview("future-hud") == "unavailable"
    view.close()
    assert view.show_preview("loading") == "unavailable"

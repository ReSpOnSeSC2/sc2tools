from __future__ import annotations

from copy import deepcopy

from tests.test_companion_build_range_scope import desk_factory, wait_until


def test_local_appearance_controls_include_default_and_emit_only_user_changes(desk_factory):
    page, state, app = desk_factory()
    wait_until(app, lambda: ("one", "replay-0") in page._build_order_cache)
    assert [(page.appearance_skin.itemText(index), page.appearance_skin.itemData(index))
            for index in range(page.appearance_skin.count())] == [
        ("Default", "default"), ("Protoss", "protoss"), ("Terran", "terran"), ("Zerg", "zerg"),
    ]
    assert page.current_appearance() == {"skin": "default", "animations": True}
    preferences, modes = deepcopy(page._preferences), deepcopy(page._modes)
    events = []
    page.appearanceChanged.connect(lambda skin, animations: events.append((skin, animations)))
    calls_before = list(state["calls"])
    page.set_appearance("zerg", False)
    assert not events
    assert page.current_appearance() == {"skin": "zerg", "animations": False}
    assert page.appearance_skin.currentData() == "zerg" and not page.appearance_animations.isChecked()
    page.appearance_skin.setCurrentIndex(page.appearance_skin.findData("protoss"))
    page.appearance_animations.setChecked(True)
    assert events == [("protoss", False), ("protoss", True)]
    page.set_appearance("zerg", False)
    assert events == [("protoss", False), ("protoss", True)]
    assert page._preferences == preferences and page._modes == modes
    assert state["calls"] == calls_before
    assert "purple" in page.appearance_skin.toolTip()
    assert "not your race" in page.appearance_skin.toolTip()
    assert "explicitly expand" in page.appearance_animations.toolTip()
    assert "instant" in page.appearance_animations.toolTip()


def test_appearance_options_jump_and_save_failure_notice_keep_selected_replay(desk_factory):
    page, state, app = desk_factory()
    selected = page._current_build_key()
    action = next(action for action in page.build_options_menu.actions() if action.text() == "Appearance…")
    action.trigger()
    assert page.console.current_route() == "settings"
    assert page._current_build_key() == selected
    page.set_appearance_notice("Appearance was not saved. Check your disk and try again.")
    assert not page.appearance_notice.isHidden()
    assert "not saved" in page.appearance_notice.text()
    page.set_appearance("default", False)
    page.set_appearance_notice("")
    assert page.appearance_notice.isHidden()
    assert page.current_appearance() == {"skin": "default", "animations": False}

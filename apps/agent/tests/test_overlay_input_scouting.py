"""Real Companion window actions while the game owns the foreground."""
import pytest

from sc2tools_agent.ui.overlay_input import install_overlay_input
from tests.test_companion_page import companion, wait_until


@pytest.fixture
def game_input(companion):
    from PySide6 import QtCore, QtWidgets

    page, state, app = companion
    panel = page.overlays["scouting"]
    foreground = [True]

    class Native:
        def set_click_through(self, hwnd, locked):
            return True

        def restore_all(self):
            pass

    controller = install_overlay_input(
        page, panels_provider=lambda: list(page.overlays.values()), compact_provider=lambda: False,
        scouting_buttons_provider=page.scouting_buttons, QtCore=QtCore, QtWidgets=QtWidgets,
        native=Native(), foreground_provider=lambda: foreground[0],
    )
    controller.timer.stop()
    page.inputTargetsChanged.connect(controller.refresh)
    try:
        controller.refresh()
        assert panel.isVisible() and panel.property("gameClickThrough") is False
        assert panel.window_controls.close_button not in controller._scouting_controls
        yield page, state, app, panel, controller, foreground
    finally:
        page.inputTargetsChanged.disconnect(controller.refresh)
        controller.shutdown()
    assert not controller._scouting_controls


def test_close_stays_closed_after_polling_and_scouting_icon_reopens_report(game_input):
    page, state, app, panel, controller, _foreground = game_input
    close = panel.window_controls.close_button
    minimize = panel.window_controls.minimize_button
    close.click()
    wait_until(app, lambda: not page._preference_busy)
    assert not panel.isVisible() and not close.isVisible() and not minimize.isVisible()
    assert state["snapshot"]["preferences"]["scoutingOverlay"] is False
    for _ in range(3):
        page._update_overlays()
        assert not panel.isVisible()
    glyph = controller._scouting_controls[page.overlays["opponent"].identity_card.scouting_button]
    glyph.click()
    assert panel.isVisible() and not panel.isMinimized()
    assert close.isVisible() and minimize.isVisible()


def test_minimize_and_alt_tab_keep_native_scouting_controls_usable(game_input):
    _page, _state, app, panel, controller, foreground = game_input
    close_source = panel.window_controls.close_button
    minimize = panel.window_controls.minimize_button
    minimize.click()
    app.processEvents()
    controller.refresh()
    assert panel.isMinimized()
    panel.showNormal()
    app.processEvents()
    controller.refresh()
    foreground[0] = False
    controller.refresh()
    assert panel.property("gameClickThrough") is False
    assert close_source.isEnabled()
    foreground[0] = True
    controller.refresh()
    panel.move(panel.x() + 30, panel.y() + 20)
    app.processEvents()
    controller.refresh()
    assert close_source.isVisible() and minimize.isVisible()
    assert close_source not in controller._scouting_controls
    close_source.click()
    assert not panel.isVisible()


def test_scouting_is_interactive_while_display_overlays_stay_click_through(game_input, monkeypatch):
    from PySide6 import QtCore
    from sc2tools_agent.ui import overlay_input

    page, _state, _app, panel, controller, foreground = game_input
    flags = panel.windowFlags()
    for source in (panel.window_controls.close_button, panel.window_controls.minimize_button):
        assert source.isVisible() and source.isEnabled()
        assert source not in controller._scouting_controls
    assert panel.testAttribute(QtCore.Qt.WA_ShowWithoutActivating)
    assert panel.property("gameInteractiveOverlay") is True
    assert panel.property("gameClickThrough") is False
    assert page.overlays["opponent"].property("gameClickThrough") is True
    monkeypatch.setattr(overlay_input, "mouse_activation_reply", lambda _message: (True, 3))
    assert panel.nativeEvent(b"windows_generic_MSG", object()) == (True, 3)
    foreground[0] = False
    controller.refresh()
    foreground[0] = True
    controller.refresh()
    assert panel.windowFlags() == flags
    assert panel.games not in controller._scouting_controls
    assert panel.window_controls.maximize_button not in controller._scouting_controls


@pytest.mark.parametrize("side", ["my", "opp"])
@pytest.mark.parametrize("clicked", [False, True])
def test_build_order_wheel_scrolls_when_hovered_or_clicked_with_game_foreground(game_input, side, clicked):
    from PySide6 import QtCore, QtTest

    _page, _state, app, panel, controller, _foreground = game_input
    events = [{"name": "Gateway", "kind": "building", "timeSec": index + 1, "timing": "started"}
              for index in range(40)]
    panel.resize(650, 450)
    for chain in panel.comparison.build_chains.values():
        chain.set_events(events)
    app.processEvents()
    controller.refresh()
    chain = panel.comparison.build_chains[side]
    other = panel.comparison.build_chains["opp" if side == "my" else "my"]
    scrollbar = chain.scroll.verticalScrollBar()
    assert scrollbar.maximum() > 0
    scrollbar.setValue(0)
    other.scroll.verticalScrollBar().setValue(0)
    target = chain.steps[0].icon_label
    point = target.rect().center()
    QtTest.QTest.mouseMove(target, point)
    if clicked:
        QtTest.QTest.mouseClick(target, QtCore.Qt.LeftButton, pos=point)
    # Deliver through the native Qt window so wheel routing uses the hovered
    # child, just as a real wheel event does (sendEvent does not bubble).
    QtTest.QTest.wheelEvent(panel.windowHandle(), target.mapTo(panel, point), QtCore.QPoint(0, -120))
    app.processEvents()
    assert scrollbar.value() > 0
    assert other.scroll.verticalScrollBar().value() == 0
    assert panel.property("gameClickThrough") is False
    assert panel.testAttribute(QtCore.Qt.WA_ShowWithoutActivating)

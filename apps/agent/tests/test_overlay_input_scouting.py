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
    close_source = panel.window_controls.close_button
    minimize_source = panel.window_controls.minimize_button
    try:
        controller.refresh()
        assert panel.isVisible() and panel.property("gameClickThrough") is True
        assert close_source in controller._scouting_controls
        yield page, state, app, panel, controller, foreground
    finally:
        page.inputTargetsChanged.disconnect(controller.refresh)
        controller.shutdown()
    assert not controller._scouting_controls


def test_close_stays_closed_after_polling_and_scouting_icon_reopens_report(game_input):
    page, state, app, panel, controller, _foreground = game_input
    close = controller._scouting_controls[panel.window_controls.close_button]
    minimize = controller._scouting_controls[panel.window_controls.minimize_button]
    close.click()
    wait_until(app, lambda: not page._preference_busy)
    assert not panel.isVisible() and not close.isVisible() and not minimize.isVisible()
    assert state["snapshot"]["preferences"]["scoutingOverlay"] is False
    for _ in range(3):
        page._update_overlays()
        assert not panel.isVisible()
    close.click()  # A hidden source cannot be activated by an old native handle.
    assert not panel.isVisible()
    glyph = controller._scouting_controls[page.overlays["opponent"].identity_card.scouting_button]
    glyph.click()
    assert panel.isVisible() and not panel.isMinimized()
    assert close.isVisible() and minimize.isVisible()


def test_minimize_and_alt_tab_hide_proxies_and_reject_stale_clicks(game_input):
    from PySide6 import QtCore

    _page, _state, app, panel, controller, foreground = game_input
    close_source = panel.window_controls.close_button
    close = controller._scouting_controls[close_source]
    minimize = controller._scouting_controls[panel.window_controls.minimize_button]
    minimize.click()
    app.processEvents()
    controller.refresh()
    assert panel.isMinimized() and not close.isVisible() and not minimize.isVisible()
    close.click()  # A stale proxy cannot close a minimized source.
    assert panel.isMinimized()
    panel.showNormal()
    app.processEvents()
    controller.refresh()
    foreground[0] = False
    controller.refresh()
    assert panel.property("gameClickThrough") is False
    assert not close.isVisible() and not minimize.isVisible() and close_source.isEnabled()
    close.click()  # Alt-Tab invalidates queued clicks on the proxy.
    assert panel.isVisible()
    foreground[0] = True
    controller.refresh()
    panel.move(panel.x() + 30, panel.y() + 20)
    app.processEvents()
    controller.refresh()
    assert close.geometry().topLeft() == close_source.mapToGlobal(QtCore.QPoint())
    close.click()
    assert not panel.isVisible()


def test_only_window_actions_gain_non_activating_input_and_inherit_themed_chrome(game_input):
    from PySide6 import QtCore

    _page, _state, _app, panel, controller, _foreground = game_input
    for source in (panel.window_controls.close_button, panel.window_controls.minimize_button):
        control = controller._scouting_controls[source]
        assert control.isVisible() and not control.isCheckable()
        assert control.windowFlags() & QtCore.Qt.WindowDoesNotAcceptFocus
        assert control.testAttribute(QtCore.Qt.WA_ShowWithoutActivating)
        assert control.focusPolicy() == QtCore.Qt.NoFocus
        assert control.parentWidget() is source.parentWidget()
        assert control.geometry().topLeft() == source.mapToGlobal(QtCore.QPoint())
        assert control.size() == source.size()
    assert panel.games not in controller._scouting_controls
    assert panel.window_controls.maximize_button not in controller._scouting_controls

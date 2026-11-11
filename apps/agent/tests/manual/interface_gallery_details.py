"""Render Streams and desktop menus and dialogs with inert fixtures."""

from pathlib import Path
from threading import Event
from time import time


def stream_details(page, save, QtWidgets):
    page.timer.stop()
    page.render({
        "account_mode": "sc2tools",
        "metadata": {"title": "SC2 ladder | {mmr} MMR", "description": "StarCraft II ladder and practice."},
        "youtube": {"connected": False},
        "platforms": {},
        "title_automation": {"values": {"mmr": "5100"}},
    })
    QtWidgets.QApplication.processEvents()
    page.ensureWidgetVisible(page.format_labels["horizontal"])
    save(page, "streams-destinations")
    for toggle, control, name in (
        (page.setup_toggle, page.channel_combo, "streams-setup"),
        (page.obs_toggle, page.obs_destination, "streams-obs"),
    ):
        toggle.setChecked(True)
        QtWidgets.QApplication.processEvents()
        page.ensureWidgetVisible(control)
        save(page, name)
        toggle.setChecked(False)


def tray_menu_preview(window, folder: Path, QtWidgets):
    """Project the native menu's actual items into an offscreen Qt menu."""
    import pystray
    from sc2tools_agent.ui.tray import TrayUI

    tray = TrayUI(
        dashboard_url="https://example.test", log_dir=folder,
        replay_folders=[Path("C:/Games/StarCraft II/Replays")], on_show_window=lambda: None,
        on_build_checkin=lambda: None, on_pause_for=lambda _until: None,
    )

    def project(source, target):
        for item in source.items:
            if item is pystray.Menu.SEPARATOR:
                target.addSeparator()
                continue
            if item.submenu:
                child = QtWidgets.QMenu(item.text, target)
                project(item.submenu, child)
                action = target.addMenu(child)
            else:
                action = target.addAction(item.text)
            action.setEnabled(item.enabled)
            if item.default:
                target.setDefaultAction(action)

    menu = QtWidgets.QMenu(window)
    project(tray._build_menu(pystray), menu)
    return menu


def capture_modal(open_dialog, name, save, QtCore, QtWidgets):
    def capture():
        dialog = QtWidgets.QApplication.activeModalWidget()
        try:
            if dialog is not None:
                save(dialog, name)
        finally:
            if dialog is not None:
                dialog.reject()

    timer = QtCore.QTimer()
    timer.setSingleShot(True)
    timer.timeout.connect(capture)
    timer.start(30)
    try:
        open_dialog()
    finally:
        timer.stop()


def render_details(window, folder, skin, sizes, *, save, QtCore, QtWidgets):
    from sc2tools_agent.ui.obs_confirmation import show_obs_confirmation
    from sc2tools_agent.ui.stream_title_controls import connect_platform

    tray = tray_menu_preview(window, folder, QtWidgets)
    try:
        for size, dimensions in sizes:
            window.resize(*dimensions)
            window._go_to_page("streams")
            page = window._stack.currentWidget()

            def capture(widget, surface):
                save(widget, folder, f"{surface}-{skin}-{size}", QtWidgets=QtWidgets)

            original_state = page.state
            stream_details(page, capture, QtWidgets)
            for menu, name in ((window._agent_menu, "agent-menu"), (tray, "tray-menu-layout")):
                menu.show()
                menu.setActiveAction(next(action for action in menu.actions() if action.isEnabled()))
                capture(menu, name)
                menu.hide()
            page.render({"account_mode": "custom"})
            capture_modal(lambda: connect_platform(page, "kick", QtWidgets), "connection-dialog", capture, QtCore, QtWidgets)
            request = {"expiresAt": (time() + 10) * 1000, "done": Event(), "label": "Game clock", "scene": "Sample scene"}
            capture_modal(lambda: show_obs_confirmation(request, parent=window, QtCore=QtCore, QtWidgets=QtWidgets),
                          "confirmation-dialog", capture, QtCore, QtWidgets)
            page.render(original_state)
    finally:
        tray.deleteLater()

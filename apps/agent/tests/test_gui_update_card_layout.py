import pytest

from tests._gui_offscreen import run_gui_check
from tests.test_companion_resize_shell import THEMED_SETUP


def test_update_recovery_actions_fit_narrow_agent_pages(tmp_path):
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "10") + '''
from types import SimpleNamespace
from sc2tools_agent.ui.update_card import build_update_card
host = QtWidgets.QWidget()
layout = QtWidgets.QVBoxLayout(host)
card = build_update_card(host, QtCore=QtCore, QtWidgets=QtWidgets,
                        install=lambda: None, later=lambda: None, download=lambda: None,
                        help_button=QtWidgets.QPushButton("Update help"))
layout.addWidget(card)
layout.addStretch()
release = SimpleNamespace(latest="0.24.0", release_notes="New update")
card.apply(release, "failed", "Connection interrupted. Retry when ready.")
host.show()
for width in (480, 380, 900, 380):
    host.resize(width, 480)
    QtTest.QTest.qWait(10)
    assert host.width() == width
    controls = (card.notes_button, card.install_button, card.later_button, card.download_button)
    for control in controls:
        assert card.rect().contains(control.mapTo(card, control.rect().bottomRight()))
        assert control.width() >= control.sizeHint().width()
        assert host.rect().contains(control.mapTo(host, control.rect().bottomRight()))
card.notes_button.setChecked(True)
assert card.notes.toPlainText() == "New update"
host.close()
''')


@pytest.mark.parametrize("scale", ["1", "1.5"])
def test_dashboard_recovery_and_settings_fit_minimum_agent_width(tmp_path, monkeypatch, scale):
    monkeypatch.setenv("QT_SCALE_FACTOR", scale)
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "10") + '''
from types import SimpleNamespace
ui, win = make_window(window_animations=False)
win._set_window_size("Standard")
win._on_update_state(SimpleNamespace(latest="0.24.0", release_notes="Audit sample"), "failed", "Retry when ready.")
win._game_dashboard.set_progress({"phase": "importing", "total": 700, "completed": 123})
win._on_replay_archive_status(12, 100)
win.show()
for skin in ("default", "protoss", "terran", "zerg"):
    page = win._companion_page
    page.appearance_skin.setCurrentIndex(page.appearance_skin.findData(skin))
    for route in ("dashboard", "settings"):
        win._go_to_page(route)
        for width in (520, 480, 1300, 480):
            win.resize(width, 480)
            QtTest.QTest.qWait(15)
            scroll = win._stack.currentWidget()
            assert win.width() == width
            assert scroll.horizontalScrollBar().maximum() == 0, (skin, route, width, scroll.widget().width(), scroll.viewport().width())
            if route == "settings":
                for checkbox in scroll.widget().findChildren(QtWidgets.QCheckBox):
                    if checkbox.isVisible():
                        assert checkbox.width() >= checkbox.minimumSizeHint().width(), (skin, width, checkbox.text())
            else:
                for control in (win._update_card.install_button, win._update_card.download_button,
                                win._replay_archive_button, win._game_dashboard.season):
                    scroll.ensureWidgetVisible(control)
                    QtTest.QTest.qWait(5)
                    assert scroll.viewport().rect().contains(control.mapTo(scroll.viewport(), control.rect().bottomRight()))
                    assert control.width() >= control.sizeHint().width()
win._companion_page.shutdown()
win._race_effects.shutdown()
win._really_quit = True
win.close()
''', timeout=90)

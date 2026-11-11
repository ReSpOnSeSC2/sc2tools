"""Small scaled Streams controls and keyboard-safe desktop dialogs."""

import pytest

from tests._gui_offscreen import run_gui_check
from tests.test_companion_resize_shell import THEMED_SETUP


@pytest.mark.parametrize("scale", ("1.25", "1.5"))
def test_stream_setup_and_obs_controls_fit_the_smallest_display(tmp_path, monkeypatch, scale):
    monkeypatch.setenv("QT_SCALE_FACTOR", scale)
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "9") + '''
from sc2tools_agent.ui.streams_page import build_streams_page

page = build_streams_page(None, provider=lambda: {}, handler=lambda _: {}, QtCore=QtCore, QtWidgets=QtWidgets)
page.timer.stop()
page.show()
page.setup_toggle.setChecked(True)
page.obs_toggle.setChecked(True)
page.auto_check.setChecked(True)
for width, wraps in ((425, True), (1024, False), (425, True)):
    page.resize(width, 235)
    for _ in range(5):
        app.processEvents()
    assert page.horizontalScrollBar().maximum() == 0, (width, page.widget().minimumSizeHint())
    assert page.widget().width() <= page.viewport().width()
    assert ("\\n" in page.auto_check.text()) is wraps
    assert page.auto_check.isChecked()
    assert page.auto_check.accessibleName() == " ".join(page.auto_check.text().split())
    form = page.setup_box.findChild(QtWidgets.QFormLayout)
    label = form.labelForField(page.channel_combo)
    assert (label.geometry().bottom() < page.channel_combo.geometry().top()) is wraps
    for field in (page.channel_combo, page.audience, page.auto_check, page.obs_destination, page.obs_fetch_button):
        assert field.isVisible()
        assert field.width() >= field.minimumSizeHint().width(), field.objectName()
        page.ensureWidgetVisible(field)
        assert page.viewport().rect().contains(field.mapTo(page.viewport(), field.rect().bottomRight()))
page.close()
''')


def test_obs_dialog_keeps_cancel_focused_and_uses_shared_type(tmp_path):
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "9") + '''
from threading import Event
from time import time
from sc2tools_agent.ui import theme
from sc2tools_agent.ui.obs_confirmation import show_obs_confirmation

parent = QtWidgets.QWidget()
parent.show()
request = {"done": Event(), "expiresAt": (time() + 5) * 1000, "label": "Game clock", "scene": "Sample scene"}
seen = []
def escape():
    dialog = QtWidgets.QApplication.activeModalWidget()
    if dialog is not None:
        label = dialog.findChild(QtWidgets.QLabel, "qt_msgbox_label")
        seen.append((dialog.defaultButton(), dialog.escapeButton(), label.font().pixelSize()))
        QtTest.QTest.keyClick(dialog, QtCore.Qt.Key_Escape)
QtCore.QTimer.singleShot(30, escape)
show_obs_confirmation(request, parent=parent, QtCore=QtCore, QtWidgets=QtWidgets)
assert len(seen) == 1 and seen[0][0] == seen[0][1]
assert seen[0][2] == theme.TYPE_SUBTITLE
assert request["done"].is_set() and not request["accepted"]
parent.close()
''')

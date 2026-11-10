import pytest

from tests._gui_offscreen import run_gui_check

_PICK_SKIN = '''
def pick_skin(win, skin):
    control = win._companion_page.appearance_skin
    control.setCurrentIndex(control.findData(skin))
    app.processEvents()
'''


def test_the_brand_mark_and_the_selected_page_take_the_skin_the_player_picks(tmp_path):
    run_gui_check(tmp_path, _PICK_SKIN + '''
from sc2tools_agent.ui import theme
app.setStyleSheet(gui._STYLE)
ui, win = make_window(window_page="dashboard")
win.resize(1100, 760)
win.show()
app.processEvents()
mark = win._agent_brandbar.findChild(QtWidgets.QWidget, "agentBrandMark")
assert mark is not None

def check(skin):
    assert mark.skin == skin and ui._window_skin == skin
    image = win._nav_group.checkedButton().grab().toImage()
    edge = {image.pixelColor(column, image.height() // 2).name() for column in range(3)}
    assert theme.SKINS[skin].accent in edge, (skin, edge)

# A skin change restyles the whole application, so the check makes only the two that matter.
check("default")
for skin in ("zerg", "default"):
    pick_skin(win, skin)
    check(skin)
win._companion_page.shutdown()
win.hide()
''')


def test_status_dots_keep_their_colour_when_a_race_skin_is_applied(tmp_path):
    run_gui_check(tmp_path, _PICK_SKIN + '''
import time
from sc2tools_agent.health import HealthFacts, evaluate
from sc2tools_agent.ui import palette
app.setStyleSheet(gui._STYLE)
ui, win = make_window(window_page="dashboard")
win.show()
now = time.time()
ui.on_health(evaluate(HealthFacts(phase="watching", paired=True, heartbeat_ok_at=now, socket_connected=True), now))
app.processEvents()
dots = [line.dot for line in win._health_view.lines]
assert dots and all(dot.styleSheet() == "color: " + palette.GREEN for dot in dots)
for skin in ("protoss", "zerg"):
    pick_skin(win, skin)
    assert [dot.styleSheet() for dot in dots] == ["color: " + palette.GREEN] * len(dots), skin
win._companion_page.shutdown()
win.hide()
''')


def test_dashboard_stat_numbers_and_captions_share_one_line_and_labels_show_their_ampersand(tmp_path):
    run_gui_check(tmp_path, '''
import re
app.setStyleSheet(gui._STYLE)
ui, win = make_window(window_page="dashboard")
# Wide enough that each stat card is wider than its contents, so an alignment shows.
win.resize(1600, 900)
win.show()
QtTest.QTest.qWait(200)
for part in ("value", "label"):
    rows = {card[part].mapTo(win, QtCore.QPoint()).y() for card in win._stat_cards}
    assert len(rows) == 1, (part, rows)
problems = win._stat_failed["frame"].findChild(QtWidgets.QPushButton)
assert problems.text() == "View problems" and problems.x() == win._stat_failed["label"].x()
image, rect = win._stat_failed["frame"].grab().toImage(), problems.geometry()
assert rect.width() - problems.sizeHint().width() >= 40, (rect.getRect(), problems.sizeHint())
ink = [x for x in range(rect.left(), rect.right())
       if any(image.pixelColor(x, y).lightness() > 80 for y in range(rect.top(), rect.bottom()))]
# Its text starts at the button's own padding, like the caption above it, not centred.
assert ink and ink[0] - rect.left() <= 16, (ink[:1], rect.getRect())
texts = [*(button.text() for button in win.findChildren(QtWidgets.QAbstractButton)),
         *(action.text() for action in win.findChildren(QtGui.QAction))]
# An "&" before a space makes the space an access key, so "Help & support" draws as "Help  support".
assert not [text for text in texts if re.search(r"&\\s", text.replace("&&", ""))], texts
win._companion_page.shutdown()
win.hide()
''')


@pytest.mark.parametrize("scale", ["1.25", "1.5"])
def test_the_shell_fits_the_minimum_window_at_windows_display_scaling(tmp_path, monkeypatch, scale):
    monkeypatch.setenv("QT_SCALE_FACTOR", scale)
    run_gui_check(tmp_path, '''
from sc2tools_agent.ui.window_sizes import minimum_window_size
app.setStyleSheet(gui._STYLE)
ui, win = make_window(window_page="dashboard")
win.show()
win.resize(*minimum_window_size("standard"))
app.processEvents()
assert win.size() == QtCore.QSize(*minimum_window_size("standard"))
for page in ("dashboard", "settings", "log"):
    win._go_to_page(page)
    app.processEvents()
    for widget in (*win._agent_brandbar.findChildren(QtWidgets.QWidget), *win._agent_toolbar.findChildren(QtWidgets.QPushButton)):
        if not widget.isVisible():
            continue
        assert win.rect().contains(QtCore.QRect(widget.mapTo(win, QtCore.QPoint()), widget.size())), (page, widget)
        if isinstance(widget, (QtWidgets.QLabel, QtWidgets.QAbstractButton)) and widget.objectName() != "agentBreadcrumb":
            # A control with a set width is sized by design; its text must still fit inside it.
            designed = widget.maximumWidth() < 16777215
            needed = widget.fontMetrics().horizontalAdvance(widget.text()) if designed else widget.minimumSizeHint().width()
            assert widget.width() >= needed, (page, widget.objectName(), widget.text(), widget.width(), needed)
win._companion_page.shutdown()
win.hide()
''')

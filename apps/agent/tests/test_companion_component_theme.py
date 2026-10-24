from __future__ import annotations

from tests._gui_offscreen import run_gui_check


def test_native_components_share_the_companion_palette_without_changing_geometry(tmp_path):
    run_gui_check(tmp_path, '''
from sc2tools_agent.ui import theme
from sc2tools_agent.ui.build_checkin_widgets import card_stylesheet
from sc2tools_agent.ui.companion_build_chain import build_build_chain
from sc2tools_agent.ui.companion_console import build_companion_console
from sc2tools_agent.ui.companion_ghost import build_companion_ghost
from sc2tools_agent.ui.companion_page import build_companion_page

app.setStyleSheet(theme.STYLE)
page = build_companion_page(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
ghost = build_companion_ghost(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
chain = build_build_chain(None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
                          icon_provider=lambda *_args: QtGui.QIcon())
shell = build_companion_console(None, profile_widget=QtWidgets.QLabel("Opponent"),
                                scouting_widget=QtWidgets.QWidget(),
                                QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
for widget in (page, ghost, ghost.panel):
    style = widget.styleSheet()
    assert theme.TEXT in style and theme.BORDER_STRONG in style
    assert theme.BUTTON in style and theme.BUTTON_CHECKED in style
    assert not any(old in style for old in ("#101827", "#192338", "#22334a", "#273b56"))
assert theme.CONSOLE_GRADIENT in shell.styleSheet()
assert theme.SURFACE in shell.styleSheet() and theme.BUTTON in shell.styleSheet()
assert "border-radius: 18px" in shell.styleSheet()
assert theme.TEXT in chain.styleSheet() and theme.TEXT_MUTED in chain.styleSheet()
assert theme.SUBTLE in chain.styleSheet()
style = card_stylesheet()
assert theme.SURFACE in style and theme.BUTTON in style and theme.BUTTON_CHECKED in style
assert theme.SUCCESS in style and theme.DANGER in style and theme.WARNING in style
assert "background-color: transparent" in style
assert "border-radius: 14px" in style
assert not any(old in style for old in ("#141924", "#606d80", "#202938", "#72d8d8"))
page.shutdown()
ghost.shutdown()
for widget in (page, ghost, ghost.panel, chain, shell):
    widget.close()
    widget.deleteLater()
app.processEvents()
''')

from __future__ import annotations

from tests._gui_offscreen import run_gui_check


def test_native_components_use_the_shared_companion_styles(tmp_path):
    run_gui_check(tmp_path, '''
from sc2tools_agent.ui import theme
from sc2tools_agent.ui.build_checkin_widgets import card_stylesheet
from sc2tools_agent.ui.companion_build_chain import build_build_chain
from sc2tools_agent.ui.companion_builds import build_companion_builds
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
builds = build_companion_builds(None, controller_provider=lambda: None, QtCore=QtCore,
                                QtGui=QtGui, QtWidgets=QtWidgets)
assert page.styleSheet() == theme.COMPANION_PAGE_STYLE
assert ghost.styleSheet() == ghost.panel.styleSheet() == theme.COMPANION_GHOST_STYLE
assert shell.styleSheet() == theme.COMPANION_CONSOLE_STYLE
assert builds.styleSheet().endswith(theme.COMPANION_BUILDS_STYLE)
assert "gradient" not in shell.styleSheet()
assert shell.findChild(QtWidgets.QWidget, "agentBrandMark") is not None
assert ghost.history_toggle.objectName() == "ghostHistory"
assert ghost.panel.title.objectName() == "ghostHeading"
assert theme.TEXT in chain.styleSheet() and theme.TEXT_MUTED in chain.styleSheet()
assert theme.SUBTLE in chain.styleSheet()
style = card_stylesheet()
assert theme.SURFACE in style and theme.BUTTON in style and theme.ON_ACCENT in style
assert theme.SUCCESS in style and theme.DANGER in style and theme.WARNING in style
assert "background-color: transparent" in style
assert "border-radius: 14px" in style
assert not any(old in style for old in ("#141924", "#606d80", "#202938", "#72d8d8"))
page.shutdown()
ghost.shutdown()
for widget in (page, ghost, ghost.panel, chain, shell, builds):
    widget.close()
    widget.deleteLater()
app.processEvents()
''')

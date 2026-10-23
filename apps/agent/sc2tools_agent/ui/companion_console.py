"""Reference-led console shell without controller or network ownership."""
from __future__ import annotations

from copy import deepcopy


_UNSET = object()
_DESTINATIONS = (
    ("scouting", "Scouting"),
    ("builds", "Build selectors"),
    ("randomizer", "Randomizer"),
    ("ghost", "Build Order Ghost"),
)
_STYLE = """
QFrame#companionConsole {
    background: qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #7737b3,stop:0.5 #56218a,stop:1 #9146c8);
    border: 2px solid #ae6de0; border-radius: 18px; color: #f2eaff;
}
QFrame#consoleProfile, QFrame#consoleDisplay {
    background: #151021; border: 2px solid #341b50; border-radius: 10px;
}
QWidget#consoleHome, QStackedWidget#consolePages, QScrollArea#consoleProfileScroll,
QScrollArea#consoleProfileScroll > QWidget > QWidget { background: transparent; border: none; }
QFrame#companionConsole QLabel { color: #f0e8ff; background: transparent; border: none; }
QLabel#consoleBrand { font-size: 18px; font-weight: 800; letter-spacing: 2px; }
QLabel#consoleEdition { color: #e0c5f5; font-size: 10px; letter-spacing: 2px; }
QLabel#consoleBreadcrumb { color: #ba9ed4; font-size: 12px; }
QLabel#consoleGameTitle { color: #9fe8b2; font-size: 12px; font-weight: 600; }
QLabel#consolePageHeading { font-size: 23px; font-weight: 700; color: #e6d3fb; }
QLabel#consolePageDescription { color: #af9cbe; font-size: 13px; }
QFrame#companionConsole QPushButton, QFrame#companionConsole QToolButton {
    background: #42205d; color: #f4e9ff; border: 1px solid #9164b0;
    border-radius: 6px; padding: 7px 10px; font-weight: 600;
}
QFrame#companionConsole QPushButton:hover, QFrame#companionConsole QToolButton:hover {
    background: #62317f; border-color: #cf9cf2;
}
QFrame#companionConsole QPushButton:checked { background: #8146a3; border-color: #deb6fa; }
QFrame#companionConsole QPushButton:disabled, QFrame#companionConsole QToolButton:disabled {
    background: #251b30; color: #786486; border-color: #44304f;
}
QPushButton#consoleHomeAction { text-align: left; padding: 12px 16px; }
QFrame#consoleDivider { background: #422653; border: none; max-height: 1px; }
"""


def _identifier(value):
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > 200:
        raise ValueError("Console context requires an identifier of at most 200 characters")
    return value


class ConsoleNavigation:
    """Bounded route history containing identifiers, never live widgets or data."""

    def __init__(self, route="home"):
        self._entries = [{"route": route, "opponentId": None, "gameId": None}]

    def current(self):
        return deepcopy(self._entries[-1])

    def history(self):
        return deepcopy(self._entries)

    def navigate(self, route, *, opponent_id=_UNSET, game_id=_UNSET, remember=True):
        if not isinstance(route, str) or not route or len(route) > 80:
            raise ValueError("Invalid console route")
        entry = self.current()
        entry["route"] = route
        if opponent_id is not _UNSET:
            opponent_id = _identifier(opponent_id)
            if entry["opponentId"] != opponent_id and game_id is _UNSET:
                entry["gameId"] = None
            entry["opponentId"] = opponent_id
        if game_id is not _UNSET:
            entry["gameId"] = _identifier(game_id)
        if entry == self._entries[-1]:
            return False
        if remember:
            self._entries.append(entry)
            self._entries = self._entries[-32:]
        else:
            self._entries[-1] = entry
        return True

    def back(self):
        if len(self._entries) < 2:
            return False
        self._entries.pop()
        return True


def build_companion_console(parent, *, profile_widget, scouting_widget=None, tools=None,
                            QtCore, QtGui, QtWidgets, home_widget=None, opponents_widget=None,
                            workspace_tabs=None):
    """Mount supplied pages once; consumers retain their existing data callbacks.

    Route changes emit the selected identifiers through ``navigationChanged``.
    ``set_context`` updates identifiers without emitting a request, so data render
    callbacks can acknowledge a selection without creating navigation loops.
    """

    class CompanionConsole(QtWidgets.QFrame):
        routeChanged = QtCore.Signal(str)
        navigationChanged = QtCore.Signal(dict)
        gameStepRequested = QtCore.Signal(int)
        playerStepRequested = QtCore.Signal(int)

        def __init__(self):
            super().__init__(parent)
            self.setObjectName("companionConsole")
            self.setStyleSheet(_STYLE)
            self._navigation = ConsoleNavigation()
            self._pages = {}
            self._titles = {}
            self._density = "standard"
            self._opponent_name = ""
            self._game_title = ""
            self._rendering_workspace = False
            self._workspace_routes = [route for route, _title in _DESTINATIONS]
            self._build_ui()
            if workspace_tabs is not None:
                if workspace_tabs.count() != len(self._workspace_routes):
                    raise ValueError("Console workspace requires its four existing live pages")
                workspace_tabs.tabBar().hide()
                self.content_stack.addWidget(workspace_tabs)
                for route, title in _DESTINATIONS:
                    self._pages[route] = workspace_tabs
                    self._titles[route] = "Scouting dossier" if route == "scouting" else title
                workspace_tabs.currentChanged.connect(self._workspace_changed)
            else:
                self.register_page("scouting", scouting_widget, "Scouting dossier")
                for route, title in _DESTINATIONS:
                    if route in (tools or {}):
                        self.register_page(route, tools[route], title)
            if opponents_widget is not None:
                self.register_page("opponents", opponents_widget, "Opponent library")
            self.register_page("home", home_widget or self._build_home(), "Home")
            self._render_navigation()

        def _button(self, text, accessible_name=None):
            button = QtWidgets.QPushButton(text)
            button.setAccessibleName(accessible_name or text)
            button.setCursor(QtCore.Qt.PointingHandCursor)
            return button

        def _build_ui(self):
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(14, 12, 14, 14)
            layout.setSpacing(10)
            brand_row = QtWidgets.QHBoxLayout()
            emblem = QtWidgets.QLabel()
            emblem.setFixedSize(23, 23)
            emblem.setStyleSheet("background: #64d8eb; border: 2px solid #b0edfa; border-radius: 11px;")
            brand_row.addWidget(emblem)
            brand = QtWidgets.QLabel("SC2 TOOLS")
            brand.setObjectName("consoleBrand")
            brand_row.addWidget(brand)
            edition = QtWidgets.QLabel("COMPANION")
            edition.setObjectName("consoleEdition")
            brand_row.addWidget(edition)
            brand_row.addStretch()
            self.brand_actions = QtWidgets.QHBoxLayout()
            brand_row.addLayout(self.brand_actions)
            layout.addLayout(brand_row)
            self.body_layout = QtWidgets.QHBoxLayout()
            self.body_layout.setSpacing(12)
            self.profile_panel = QtWidgets.QFrame()
            self.profile_panel.setObjectName("consoleProfile")
            self.profile_panel.setFixedWidth(240)
            self.profile_panel.setSizePolicy(QtWidgets.QSizePolicy.Preferred, QtWidgets.QSizePolicy.Expanding)
            profile_layout = QtWidgets.QVBoxLayout(self.profile_panel)
            profile_layout.setContentsMargins(10, 10, 10, 10)
            profile_layout.setSpacing(8)
            self.profile_scroll = QtWidgets.QScrollArea()
            self.profile_scroll.setObjectName("consoleProfileScroll")
            self.profile_scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
            self.profile_scroll.setWidgetResizable(True)
            self.profile_scroll.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
            self.profile_scroll.setWidget(profile_widget)
            profile_layout.addWidget(self.profile_scroll, 1)
            player_row = QtWidgets.QHBoxLayout()
            self.previous_player = self._button("‹", "Previous opponent")
            self.next_player = self._button("›", "Next opponent")
            self.player_position = QtWidgets.QLabel("Opponent")
            self.player_position.setAlignment(QtCore.Qt.AlignCenter)
            for button, direction in [(self.previous_player, -1), (self.next_player, 1)]:
                button.setFixedWidth(32)
                button.clicked.connect(lambda _checked=False, step=direction: self.playerStepRequested.emit(step))
                button.setEnabled(False)
            player_row.addWidget(self.previous_player)
            player_row.addWidget(self.player_position, 1)
            player_row.addWidget(self.next_player)
            profile_layout.addLayout(player_row)
            divider = QtWidgets.QFrame()
            divider.setObjectName("consoleDivider")
            divider.setFixedHeight(1)
            profile_layout.addWidget(divider)
            self.destination_buttons = {}
            for route, title in _DESTINATIONS:
                button = self._button(title)
                button.setCheckable(True)
                button.clicked.connect(lambda _checked=False, destination=route: self.navigate(destination))
                profile_layout.addWidget(button)
                self.destination_buttons[route] = button
            self.body_layout.addWidget(self.profile_panel)
            self.display_panel = QtWidgets.QFrame()
            self.display_panel.setObjectName("consoleDisplay")
            display_layout = QtWidgets.QVBoxLayout(self.display_panel)
            display_layout.setContentsMargins(12, 10, 12, 12)
            display_layout.setSpacing(10)
            navigation_row = QtWidgets.QHBoxLayout()
            self.back_button = self._button("‹ Back")
            self.back_button.clicked.connect(self.back)
            self.home_button = self._button("Home")
            self.home_button.setIcon(self.style().standardIcon(QtWidgets.QStyle.SP_DirHomeIcon))
            self.home_button.clicked.connect(lambda: self.navigate("home"))
            navigation_row.addWidget(self.back_button)
            navigation_row.addWidget(self.home_button)
            self.breadcrumb = QtWidgets.QLabel()
            self.breadcrumb.setObjectName("consoleBreadcrumb")
            self.breadcrumb.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
            navigation_row.addWidget(self.breadcrumb, 1)
            display_layout.addLayout(navigation_row)
            self.game_controls = QtWidgets.QWidget()
            game_row = QtWidgets.QHBoxLayout(self.game_controls)
            game_row.setContentsMargins(0, 0, 0, 0)
            self.previous_game = self._button("‹", "Previous game")
            self.next_game = self._button("›", "Next game")
            self.game_title = QtWidgets.QLabel("No replay selected")
            self.game_title.setObjectName("consoleGameTitle")
            self.game_title.setWordWrap(True)
            for button, direction in [(self.previous_game, -1), (self.next_game, 1)]:
                button.setFixedWidth(32)
                button.clicked.connect(lambda _checked=False, step=direction: self.gameStepRequested.emit(step))
                button.setEnabled(False)
            game_row.addWidget(self.previous_game)
            game_row.addWidget(self.game_title, 1)
            game_row.addWidget(self.next_game)
            display_layout.addWidget(self.game_controls)
            self.content_stack = QtWidgets.QStackedWidget()
            self.content_stack.setObjectName("consolePages")
            self.content_stack.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Ignored)
            display_layout.addWidget(self.content_stack, 1)
            self.body_layout.addWidget(self.display_panel, 1)
            layout.addLayout(self.body_layout, 1)

        def _build_home(self):
            page = QtWidgets.QWidget()
            page.setObjectName("consoleHome")
            layout = QtWidgets.QVBoxLayout(page)
            layout.setContentsMargins(16, 16, 16, 16)
            layout.setSpacing(12)
            heading = QtWidgets.QLabel("MATCH DOSSIER")
            heading.setObjectName("consolePageHeading")
            layout.addWidget(heading)
            description = QtWidgets.QLabel("Browse your opponents and previous encounters, or prepare the build you want to practice.")
            description.setObjectName("consolePageDescription")
            description.setWordWrap(True)
            layout.addWidget(description)
            layout.addSpacing(8)
            choices = [("opponents" if opponents_widget is not None else "scouting", "Opponent library  ›"),
                       ("scouting", "Selected game dossier  ›"),
                       ("builds", "Build selectors  ›"), ("ghost", "Build Order Ghost  ›")]
            self.home_actions = {}
            for route, title in choices:
                if route not in self._pages:
                    continue
                button = self._button(title)
                button.setObjectName("consoleHomeAction")
                button.clicked.connect(lambda _checked=False, destination=route: self.navigate(destination))
                layout.addWidget(button)
                self.home_actions[title] = button
            layout.addStretch()
            return page

        def register_page(self, route, widget, title):
            if route in self._pages:
                raise ValueError("Console route is already registered")
            if not isinstance(route, str) or not route or len(route) > 80:
                raise ValueError("Invalid console route")
            if widget is None or widget in self._pages.values():
                raise ValueError("Each console page must have its own widget")
            self._pages[route] = widget
            self._titles[route] = str(title)
            self.content_stack.addWidget(widget)

        def navigate(self, route, *, opponent_id=_UNSET, game_id=_UNSET, remember=True):
            if route not in self._pages:
                return False
            changed = self._navigation.navigate(route, opponent_id=opponent_id, game_id=game_id, remember=remember)
            self._render_navigation()
            if changed:
                self.routeChanged.emit(route)
                self.navigationChanged.emit(self._navigation.current())
            return changed

        def back(self):
            if not self._navigation.back():
                return False
            self._render_navigation()
            self.routeChanged.emit(self.current_route())
            self.navigationChanged.emit(self._navigation.current())
            return True

        def set_context(self, *, opponent_id=_UNSET, game_id=_UNSET):
            self._navigation.navigate(self.current_route(), opponent_id=opponent_id, game_id=game_id, remember=False)

        def context(self):
            return self._navigation.current()

        def route_history(self):
            return self._navigation.history()

        def current_route(self):
            return self._navigation.current()["route"]

        def set_breadcrumb(self, *, opponent_name="", game_title=""):
            self._opponent_name = str(opponent_name or "")
            self._game_title = str(game_title or "")
            self._render_navigation()

        def set_game_navigation(self, index, total, title=""):
            valid = isinstance(index, int) and not isinstance(index, bool) and isinstance(total, int) and not isinstance(total, bool) and 0 <= index < total
            self.previous_game.setEnabled(valid and index > 0)
            self.next_game.setEnabled(valid and index + 1 < total)
            self.game_title.setText(f"GAME {index + 1} / {total}" + ("  ·  " + str(title) if title else "") if valid else "No replay selected")
            self.game_title.setToolTip(str(title or ""))

        def set_player_navigation(self, index, total):
            valid = isinstance(index, int) and not isinstance(index, bool) and isinstance(total, int) and not isinstance(total, bool) and 0 <= index < total
            self.previous_player.setEnabled(valid and index > 0)
            self.next_player.setEnabled(valid and index + 1 < total)
            self.player_position.setText(f"{index + 1} / {total}" if valid else "Opponent")

        def set_density(self, level):
            if level not in {"compact", "standard", "detailed", "full"}:
                raise ValueError("Unknown Companion information layout")
            self._density = level
            self.profile_panel.setFixedWidth(252 if level in {"compact", "standard"} else 280)
            self.layout().setSpacing(8 if level == "standard" else 10)

        def current_density(self):
            return self._density

        def _render_navigation(self):
            route = self.current_route()
            self.content_stack.setCurrentWidget(self._pages[route])
            if workspace_tabs is not None and route in self._workspace_routes:
                self._rendering_workspace = True
                try:
                    workspace_tabs.setCurrentIndex(self._workspace_routes.index(route))
                finally:
                    self._rendering_workspace = False
            self.back_button.setEnabled(len(self._navigation.history()) > 1)
            self.home_button.setEnabled(route != "home")
            self.game_controls.setVisible(route in {"scouting", "history", "game"})
            for destination, button in self.destination_buttons.items():
                button.setEnabled(destination in self._pages)
                button.setChecked(destination == route)
            parts = [self._titles[route]]
            if route != "home" and self._opponent_name:
                parts.append(self._opponent_name)
            if route in {"scouting", "game"} and self._game_title:
                parts.append(self._game_title)
            text = "  /  ".join(parts)
            self.breadcrumb.setText(text)
            self.breadcrumb.setToolTip(text)

        def _workspace_changed(self, index):
            if not self._rendering_workspace and 0 <= index < len(self._workspace_routes):
                self.navigate(self._workspace_routes[index])

    return CompanionConsole()

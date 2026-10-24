"""Native Ghost configuration and its time-following in-game panel."""

from __future__ import annotations

from pathlib import Path
import math
import re
import threading

from ..companion_ghost import GhostError, GhostSession, TeamGhostSession, MATCHUPS, concrete_race, normalize_ghost_state, normalize_target, supports_ghost_game
from . import theme
from .sc2_icons import load_icon


_STYLE = f"""
QWidget#ghostDesk, QWidget#ghostPanel {{ background: {theme.SURFACE}; color: {theme.TEXT}; }}
QWidget#ghostDesk QLabel, QWidget#ghostDesk QCheckBox,
QWidget#ghostPanel QLabel {{ color: {theme.TEXT}; background: transparent; }}
QWidget#ghostDesk QLineEdit, QWidget#ghostDesk QComboBox,
QWidget#ghostDesk QTreeWidget, QWidget#ghostPanel QTreeWidget {{
    background: {theme.ELEVATED}; color: {theme.TEXT}; border: 1px solid {theme.BORDER_STRONG};
    border-radius: 5px; padding: 5px; selection-background-color: {theme.BUTTON_CHECKED};
}}
QWidget#ghostDesk QPushButton {{
    background: {theme.BUTTON}; color: {theme.TEXT}; border: 1px solid {theme.BORDER_STRONG};
    border-radius: 5px; padding: 7px 10px;
}}
QWidget#ghostDesk QPushButton:hover {{ background: {theme.BUTTON_HOVER}; border-color: {theme.ACCENT_HOVER}; }}
QWidget#ghostDesk QPushButton:focus, QWidget#ghostDesk QLineEdit:focus,
QWidget#ghostDesk QComboBox:focus {{ border-color: {theme.FOCUS}; }}
QWidget#ghostDesk QPushButton:disabled {{ color: {theme.TEXT_DIM}; background: {theme.ELEVATED}; border-color: {theme.BORDER}; }}
QWidget#ghostDesk QHeaderView::section, QWidget#ghostPanel QHeaderView::section {{
    background: {theme.SUBTLE}; color: {theme.TEXT_MUTED}; padding: 6px;
}}
QWidget#ghostDesk QTabWidget::pane {{ border: 1px solid {theme.BORDER_STRONG}; }}
QWidget#ghostDesk QTabBar::tab {{ color: {theme.TEXT_MUTED}; background: {theme.SURFACE}; padding: 8px 12px; }}
QWidget#ghostDesk QTabBar::tab:selected {{ color: {theme.TEXT}; background: {theme.BUTTON_CHECKED}; }}
"""


def _clock(value):
    seconds = max(0, int(value))
    return f"{seconds // 60}:{seconds % 60:02d}"


def _display(name):
    names = {"BlinkTech": "Blink", "ShieldWall": "Combat Shield", "PunisherGrenades": "Concussive Shells",
             "zerglingmovementspeed": "Metabolic Boost", "WarpGateResearch": "Warp Gate"}
    return names.get(name, re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name))


def build_companion_ghost(parent, *, handler, QtCore, QtGui, QtWidgets):
    def label(text):
        widget = QtWidgets.QLabel(text)
        widget.setTextFormat(QtCore.Qt.PlainText)
        widget.setWordWrap(True)
        return widget

    def tree():
        widget = QtWidgets.QTreeWidget()
        widget.setColumnCount(4)
        widget.setHeaderLabels(["TARGET STEP", "TIME", "SUPPLY", "STATUS"])
        widget.setRootIsDecorated(False)
        widget.setIconSize(QtCore.QSize(26, 26))
        widget.header().setSectionResizeMode(0, QtWidgets.QHeaderView.Stretch)
        for column in (1, 2, 3):
            widget.header().setSectionResizeMode(column, QtWidgets.QHeaderView.ResizeToContents)
        return widget

    def step_icon(step):
        return load_icon(step["name"], step["kind"], QtGui=QtGui)

    def add_step(widget, step, status):
        row = QtWidgets.QTreeWidgetItem([_display(step["name"]), _clock(step["t"]),
                                        str(step["supply"]) if step.get("supply") is not None else "—", status])
        row.setIcon(0, step_icon(step))
        if "completeTime" in step:
            row.setToolTip(1, "Start " + _clock(step["t"]) + " · recorded completion " + _clock(step["completeTime"]))
        widget.addTopLevelItem(row)
        return row

    def source_page(content):
        content.setObjectName("ghostSource")
        content.setStyleSheet(f"QWidget#ghostSource {{ background: {theme.SURFACE}; }}")
        scroll = QtWidgets.QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
        scroll.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
        scroll.setWidget(content)
        return scroll

    class Signals(QtCore.QObject):
        result = QtCore.Signal(dict)

    class GhostPanel(QtWidgets.QWidget):
        def __init__(self, owner):
            super().__init__(None, QtCore.Qt.Tool | QtCore.Qt.WindowStaysOnTopHint | QtCore.Qt.FramelessWindowHint)
            self.owner = owner
            self.setObjectName("ghostPanel")
            self.setWindowTitle("SC2TOOLS · Build Order Ghost")
            self.setFont(QtGui.QFont("Segoe UI", 10))
            self.setAttribute(QtCore.Qt.WA_ShowWithoutActivating)
            self.setAttribute(QtCore.Qt.WA_QuitOnClose, False)
            self.setStyleSheet(_STYLE)
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(32, 30, 32, 28)
            self.title = label("Build Order Ghost")
            self.header = QtWidgets.QFrame(self)
            header_layout = QtWidgets.QHBoxLayout(self.header)
            header_layout.setContentsMargins(0, 0, 0, 0)
            header_layout.addWidget(self.title, 1)
            from .window_chrome import build_window_controls, install_window_interactions
            self.window_controls = build_window_controls(self.header, window=self, QtCore=QtCore, QtWidgets=QtWidgets)
            self.window_controls.maximize_button.hide()
            header_layout.addWidget(self.window_controls)
            self.subtitle = label("")
            self.steps = tree()
            self.note = label("Target schedule only · elapsed time does not confirm that you built a step.")
            for widget in (self.header, self.subtitle, self.steps, self.note):
                layout.addWidget(widget)
            self.setMinimumSize(420, 275)
            self.resize(510, 315)
            from .race_visuals import create_race_effects
            self._race_effects = create_race_effects(self, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
            self._window_interactions = install_window_interactions(
                self, drag_widgets=[self.header], QtCore=QtCore, QtWidgets=QtWidgets, can_maximize=lambda: False,
            )

        def set_appearance(self, skin, animations):
            from .race_visuals import css_for_skin, normalize_skin
            skin = normalize_skin(skin)
            override = css_for_skin(skin)
            for widget in (self, *self.findChildren(QtWidgets.QWidget)):
                base_style = widget.property("pinnedRaceBaseStyle")
                if base_style is None and widget.styleSheet():
                    base_style = widget.styleSheet()
                    widget.setProperty("pinnedRaceBaseStyle", base_style)
                if base_style is not None:
                    widget.setStyleSheet(base_style + override)
            self._race_effects.apply_skin(skin)
            self._race_effects.set_motion_enabled(animations)

        def closeEvent(self, event):
            if not self.owner._closed:
                self.owner._set_enabled(False)
            event.accept()

        def paint_view(self, view):
            self.title.setText(view["target"]["name"])
            self.subtitle.setText(view["matchup"] + " · SC2 clock " + _clock(view["clock"]))
            self.steps.clear()
            steps = view["target"]["steps"]
            current = view["index"]
            for index in range(max(0, current - 1), min(len(steps), current + 4)):
                step = steps[index]
                if step["t"] > view["clock"]:
                    status = "In " + str(int(step["t"] - view["clock"])) + "s"
                elif index == current:
                    status = "Target now" if view["clock"] - step["t"] < 1 else "Target +" + str(int(view["clock"] - step["t"])) + "s"
                else:
                    status = "Earlier target"
                row = add_step(self.steps, step, status)
                if index == current:
                    row.setForeground(0, QtGui.QBrush(QtGui.QColor(theme.ACCENT_CYAN)))
            self.note.setText("Target timeline finished · completion is not verified." if view["complete"] else
                              "Target schedule only · elapsed time does not confirm a built step.")

    class GhostPage(QtWidgets.QWidget):
        referencesChanged = QtCore.Signal(dict)

        def __init__(self):
            super().__init__(parent)
            self._closed = False
            self._assistance_enabled = False
            self._density = "full"
            self._assistance_reason = "Hidden by the master assistance switch"
            self._state = normalize_ghost_state(None)
            self._session = GhostSession()
            self._team_session = TeamGhostSession()
            self._team_context = None
            self._team_game = False
            self._busy = set()
            self._revision = 0
            self._desired_enabled = None
            self._panel_restore_requested = False
            self._pending_saves = []
            self._games = []
            self._examples = []
            self._replay_folders = []
            self._references = {}
            self._history = {}
            self._selected_library_game_id = None
            self._selected_example_id = None
            self._filling_games = False
            self._cursor = None
            self._preview = None
            self._preview_matchup = None
            self._preview_race = None
            self._preview_manual = False
            self._pending_local = None
            self._player_targets = []
            self._signals = Signals(self)
            self._signals.result.connect(self._reply)
            self.panel = GhostPanel(self)
            self.setObjectName("ghostDesk")
            self.setFont(QtGui.QFont("Segoe UI", 10))
            self.setStyleSheet(_STYLE)
            self.setAcceptDrops(True)
            outer = QtWidgets.QVBoxLayout(self)
            outer.setContentsMargins(0, 0, 0, 0)
            scroll = QtWidgets.QScrollArea()
            scroll.setWidgetResizable(True)
            scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
            scroll.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
            content = QtWidgets.QWidget()
            content.setObjectName("ghostContent")
            content.setStyleSheet(f"QWidget#ghostContent {{ background: {theme.SURFACE}; }}")
            layout = QtWidgets.QVBoxLayout(content)
            scroll.setWidget(content)
            outer.addWidget(scroll)
            self.scroll = scroll
            layout.addWidget(label("BUILD ORDER GHOST"))
            layout.addWidget(label("Assign replay builds for 1v1 matchups, or explicitly follow a same-race target in your current confirmed team game. Ghost follows SC2's game clock in its own always-on-top panel."))
            self.enabled_toggle = QtWidgets.QCheckBox("Show Build Order Ghost during matching games")
            self.enabled_toggle.toggled.connect(self._set_enabled)
            layout.addWidget(self.enabled_toggle)
            self.status = label("Loading saved Ghost settings…")
            layout.addWidget(self.status)
            self.live_status = label("1v1 automatic · teams manual · targets follow recorded replay timings")
            layout.addWidget(self.live_status)
            slots = QtWidgets.QHBoxLayout()
            self.matchup = QtWidgets.QComboBox()
            self.matchup.addItems(MATCHUPS)
            self.matchup.currentTextChanged.connect(self._show_slot)
            self.assigned = label("No target assigned")
            self.clear_button = QtWidgets.QPushButton("Clear matchup")
            self.clear_button.clicked.connect(lambda: self._save({"matchup": self.matchup.currentText(), "target": None}))
            for widget in (self.matchup, self.assigned, self.clear_button):
                slots.addWidget(widget)
            layout.addLayout(slots)
            self.sources = QtWidgets.QTabWidget()
            local = QtWidgets.QWidget()
            local_layout = QtWidgets.QVBoxLayout(local)
            local_layout.setAlignment(QtCore.Qt.AlignTop)
            local_layout.addWidget(label("Open any .SC2Replay from this PC, or drop a replay onto Ghost. Choose any available human player's build. Team replay targets are manual-only and never become a 1v1 matchup."))
            self.local_button = QtWidgets.QPushButton("Choose local .SC2Replay…")
            self.local_button.clicked.connect(self._choose_local)
            local_layout.addWidget(self.local_button)
            self.local_path = label("No local replay selected")
            local_layout.addWidget(self.local_path)
            self.sources.addTab(source_page(local), "Local replays")
            library = QtWidgets.QWidget()
            library_layout = QtWidgets.QVBoxLayout(library)
            library_layout.setAlignment(QtCore.Qt.AlignTop)
            self.search = QtWidgets.QLineEdit()
            self.search.setPlaceholderText("Filter your replays by build, map or opponent")
            self.search.textChanged.connect(self._fill_games)
            library_layout.addWidget(self.search)
            filters = QtWidgets.QGridLayout()
            self.matchup_filter = QtWidgets.QComboBox()
            self.matchup_filter.addItem("All matchups", None)
            for matchup in MATCHUPS:
                self.matchup_filter.addItem(matchup, matchup)
            self.build_filter = QtWidgets.QComboBox()
            self.build_filter.addItem("All builds", None)
            self.map_filter = QtWidgets.QComboBox()
            self.map_filter.addItem("All maps", None)
            self.result_filter = QtWidgets.QComboBox()
            for title, value in [("All results", None), ("Wins", "win"), ("Losses", "loss"), ("Ties", "tie")]:
                self.result_filter.addItem(title, value)
            for position, widget in enumerate((self.matchup_filter, self.build_filter, self.map_filter, self.result_filter)):
                widget.setMinimumContentsLength(12)
                widget.setSizeAdjustPolicy(QtWidgets.QComboBox.AdjustToMinimumContentsLengthWithIcon)
                widget.currentIndexChanged.connect(self._fill_games)
                filters.addWidget(widget, position // 2, position % 2)
            self.starred_filter = QtWidgets.QCheckBox("Reference replays only")
            self.starred_filter.toggled.connect(self._fill_games)
            filters.addWidget(self.starred_filter, 2, 0)
            self.clear_filters_button = QtWidgets.QPushButton("Clear filters")
            self.clear_filters_button.clicked.connect(self._clear_filters)
            filters.addWidget(self.clear_filters_button, 2, 1)
            self.filters_widget = QtWidgets.QWidget()
            self.filters_widget.setLayout(filters)
            library_layout.addWidget(self.filters_widget)
            self.library_count = label("Filters apply to loaded pages only. Load older replays to search further.")
            library_layout.addWidget(self.library_count)
            self.games = QtWidgets.QComboBox()
            self.games.setMinimumContentsLength(20)
            self.games.setSizeAdjustPolicy(QtWidgets.QComboBox.AdjustToMinimumContentsLengthWithIcon)
            self.games.currentIndexChanged.connect(self._selection_changed)
            library_layout.addWidget(self.games)
            self.reference_button = QtWidgets.QPushButton("☆ Use as this build's reference replay")
            self.reference_button.clicked.connect(self._save_reference)
            library_layout.addWidget(self.reference_button)
            reference_actions = QtWidgets.QHBoxLayout()
            self.reference_side = QtWidgets.QComboBox()
            self.reference_side.addItem("My build", "you")
            self.reference_side.addItem("Opponent's build", "opponent")
            self.reference_side.currentIndexChanged.connect(self._reference_side_changed)
            reference_actions.addWidget(self.reference_side)
            self.compare_button = QtWidgets.QPushButton("Compare with reference")
            self.compare_button.clicked.connect(self._compare_reference)
            reference_actions.addWidget(self.compare_button)
            library_layout.addLayout(reference_actions)
            actions = QtWidgets.QHBoxLayout()
            self.refresh_button = QtWidgets.QPushButton("Refresh replays")
            self.refresh_button.clicked.connect(self.refresh)
            self.more_button = QtWidgets.QPushButton("Load older replays")
            self.more_button.clicked.connect(lambda: self._call("games", {"action": "ghost_games", "before": self._cursor}))
            self.load_button = QtWidgets.QPushButton("Preview replay build")
            self.load_button.clicked.connect(self._load_target)
            self.arm_button = QtWidgets.QPushButton("Assign replay target")
            self.arm_button.clicked.connect(self._arm)
            self.arm_button.setEnabled(False)
            for widget in (self.refresh_button, self.more_button, self.load_button):
                actions.addWidget(widget)
            library_layout.addLayout(actions)
            self.sources.addTab(source_page(library), "Replay library")
            examples = QtWidgets.QWidget()
            examples_layout = QtWidgets.QVBoxLayout(examples)
            examples_layout.setAlignment(QtCore.Qt.AlignTop)
            examples_layout.addWidget(label("Practice from an administrator's curated replay examples."))
            self.examples_search = QtWidgets.QLineEdit()
            self.examples_search.setPlaceholderText("Search loaded examples by name, map or description")
            self.examples_search.textChanged.connect(self._fill_examples)
            examples_layout.addWidget(self.examples_search)
            self.examples_matchup_filter = QtWidgets.QComboBox()
            self.examples_matchup_filter.addItem("All matchups", None)
            for matchup in MATCHUPS:
                self.examples_matchup_filter.addItem(matchup, matchup)
            self.examples_matchup_filter.currentIndexChanged.connect(self._fill_examples)
            examples_layout.addWidget(self.examples_matchup_filter)
            self.examples = QtWidgets.QComboBox()
            self.examples.setMinimumContentsLength(20)
            self.examples.setSizeAdjustPolicy(QtWidgets.QComboBox.AdjustToMinimumContentsLengthWithIcon)
            self.examples.currentIndexChanged.connect(self._example_selected)
            examples_layout.addWidget(self.examples)
            self.examples_count = label("No examples loaded")
            examples_layout.addWidget(self.examples_count)
            example_actions = QtWidgets.QHBoxLayout()
            self.examples_button = QtWidgets.QPushButton("Refresh examples")
            self.examples_button.clicked.connect(lambda: self._call("examples", {"action": "ghost_examples"}))
            self.example_load_button = QtWidgets.QPushButton("Preview example")
            self.example_load_button.clicked.connect(self._load_example)
            self.example_load_button.setEnabled(False)
            example_actions.addWidget(self.examples_button)
            example_actions.addWidget(self.example_load_button)
            examples_layout.addLayout(example_actions)
            self.sources.addTab(source_page(examples), "Admin examples")
            self.sources.currentChanged.connect(self._source_changed)
            self.sources.setSizePolicy(QtWidgets.QSizePolicy.Expanding, QtWidgets.QSizePolicy.Fixed)
            self.sources.setFixedHeight(180)
            layout.addWidget(self.sources)
            self.preview_label = label("Select a replay, then preview its recorded build order.")
            layout.addWidget(self.preview_label)
            name_row = QtWidgets.QHBoxLayout()
            name_row.addWidget(label("Target name"))
            self.target_name = QtWidgets.QLineEdit()
            self.target_name.setMaxLength(80)
            name_row.addWidget(self.target_name)
            name_row.addWidget(self.arm_button)
            layout.addLayout(name_row)
            self.team_arm_button = QtWidgets.QPushButton("Use this target in current team game")
            self.team_arm_button.setAccessibleName("Use this target in current team game")
            self.team_arm_button.setToolTip("Manual for this game, account, confirmed own player and selected enemy only. The target race must match your own race. Turning assistance off clears this temporary choice.")
            self.team_arm_button.clicked.connect(self._arm_team)
            self.team_arm_button.setEnabled(False)
            layout.addWidget(self.team_arm_button)
            self.team_target_status = label("Confirm your own player and enemies before using a manual team target.")
            layout.addWidget(self.team_target_status)
            self.team_arm_button.hide()
            self.team_target_status.hide()
            self.players = QtWidgets.QTabWidget()
            self.players.currentChanged.connect(self._player_changed)
            self.preview_steps = tree()
            self.preview_steps.setMinimumHeight(220)
            self.players.addTab(self.preview_steps, "Choose a replay")
            layout.addWidget(self.players)
            self.history_toggle = QtWidgets.QToolButton()
            self.history_toggle.setText("Reference history / Undo")
            self.history_toggle.setCheckable(True)
            self.history_toggle.setToolButtonStyle(QtCore.Qt.ToolButtonTextBesideIcon)
            self.history_toggle.setArrowType(QtCore.Qt.RightArrow)
            self.history_toggle.setStyleSheet(f"QToolButton {{ background: {theme.BUTTON}; color: {theme.TEXT_MUTED}; border: 1px solid {theme.BORDER_STRONG}; border-radius: 4px; padding: 6px 10px; }} QToolButton:hover {{ background: {theme.BUTTON_HOVER}; color: {theme.TEXT}; }} QToolButton:focus {{ border-color: {theme.FOCUS}; }}")
            self.history_toggle.toggled.connect(self._toggle_history)
            layout.addWidget(self.history_toggle)
            history_group = QtWidgets.QGroupBox()
            self.history_group = history_group
            history_layout = QtWidgets.QVBoxLayout(history_group)
            self.history_reference = QtWidgets.QComboBox()
            self.history_reference.setMinimumContentsLength(20)
            self.history_reference.setSizeAdjustPolicy(QtWidgets.QComboBox.AdjustToMinimumContentsLengthWithIcon)
            self.history_reference.currentIndexChanged.connect(self._history_reference_changed)
            history_layout.addWidget(self.history_reference)
            history_row = QtWidgets.QHBoxLayout()
            self.history_entry = QtWidgets.QComboBox()
            self.history_entry.setMinimumContentsLength(20)
            self.history_entry.setSizeAdjustPolicy(QtWidgets.QComboBox.AdjustToMinimumContentsLengthWithIcon)
            history_row.addWidget(self.history_entry)
            self.restore_button = QtWidgets.QPushButton("Restore selected reference…")
            self.restore_button.clicked.connect(self._restore_reference)
            history_row.addWidget(self.restore_button)
            history_layout.addLayout(history_row)
            self.history_status = label("No reference history yet. Reference changes keep up to three prior choices per build.")
            history_layout.addWidget(self.history_status)
            layout.addWidget(history_group)
            history_group.hide()
            self.comparison_status = label("")
            self.comparison_status.hide()
            layout.addWidget(self.comparison_status)
            self.comparison_tree = QtWidgets.QTreeWidget()
            self.comparison_tree.setColumnCount(5)
            self.comparison_tree.setHeaderLabels(["STEP", "REFERENCE", "THIS REPLAY", "DIFFERENCE", "EVENT"])
            self.comparison_tree.setRootIsDecorated(False)
            self.comparison_tree.header().setSectionResizeMode(0, QtWidgets.QHeaderView.Stretch)
            for column in (1, 2, 3, 4):
                self.comparison_tree.header().setSectionResizeMode(column, QtWidgets.QHeaderView.ResizeToContents)
            self.comparison_tree.setMinimumHeight(190)
            self.comparison_tree.hide()
            layout.addWidget(self.comparison_tree)
            self.notice = label("Choose a source, preview both players, then assign the selected player's build. The master switch hides Ghost without clearing targets.")
            layout.addWidget(self.notice)
            self._update_history_controls()
            self.timer = QtCore.QTimer(self)
            self.timer.setInterval(500)
            self.timer.timeout.connect(self._render)
            self.timer.start()
            if callable(handler):
                self.refresh()
            else:
                self.timer.stop()
                self.enabled_toggle.setEnabled(False)
                self.local_button.setEnabled(False)
                self.refresh_button.setEnabled(False)
                self.examples_button.setEnabled(False)
                self.notice.setText("Ghost will be available when the agent service connects.")

        def _call(self, channel, payload):
            if self._closed or not callable(handler) or channel in self._busy:
                return False
            self._busy.add(channel)
            revision = self._revision
            signal = self._signals

            def work():
                try:
                    if handler is None:
                        raise ValueError("Pair this agent to load your replay builds.")
                    result = handler(payload)
                    if not isinstance(result, dict):
                        raise ValueError("Ghost returned an invalid response.")
                    response = {"channel": channel, "payload": payload, "revision": revision, "result": result}
                except Exception as error:
                    message = str(error) if isinstance(error, ValueError) else "Ghost could not load this data. Please refresh."
                    response = {"channel": channel, "payload": payload, "revision": revision, "error": message[:180]}
                if not self._closed:
                    try:
                        signal.result.emit(response)
                    except RuntimeError:
                        pass

            threading.Thread(target=work, name="companion-ghost-" + channel, daemon=True).start()
            return True

        def _reply(self, response):
            if self._closed:
                return
            channel = response["channel"]
            self._busy.discard(channel)
            if response.get("error"):
                self.notice.setText(response["error"])
                if channel == "save":
                    if response["payload"].get("enabled") is self._desired_enabled:
                        self._desired_enabled = None
                    self._call("state", {"action": "ghost_state"})
                if channel == "restore":
                    self.notice.setText("Could not restore that reference. Refresh history if it changed on another device.")
                    self._call("state", {"action": "ghost_state"})
                if (channel == "comparison" and response["payload"].get("gameId") == self.games.currentData()
                        and response["payload"].get("side") == self.reference_side.currentData()):
                    self.comparison_status.setText("Comparison unavailable. Retry after this replay finishes analysis.")
                    self.comparison_status.show()
            else:
                result = response["result"]
                if isinstance(result.get("warning"), str):
                    self.notice.setText(result["warning"])
                if isinstance(result.get("history"), dict):
                    self._history = result["history"]
                if isinstance(result.get("references"), dict):
                    self._references = result["references"]
                    self._update_reference_button()
                    self.referencesChanged.emit(self._references)
                    self._fill_games()
                if isinstance(result.get("history"), dict) or isinstance(result.get("references"), dict):
                    self._update_history_controls()
                if channel in {"state", "save"}:
                    if channel == "save" or response["revision"] == self._revision:
                        self._accept_state(result.get("ghost"), response["payload"] if channel == "save" else None)
                        folders = result.get("replayFolders")
                        if isinstance(folders, list):
                            self._replay_folders = [folder for folder in folders if isinstance(folder, str)]
                elif channel == "reference":
                    if isinstance(result.get("ghost"), dict):
                        self._accept_state(result["ghost"])
                    self.notice.setText("Reference replay saved for this build." if not response["payload"].get("clear") else "Build reference replay cleared.")
                    self._update_reference_button()
                elif channel == "restore":
                    self.apply_account_result(result)
                    self.notice.setText("Previous reference restored. Your local Ghost on/off choice stays unchanged.")
                elif channel == "comparison":
                    if (response["payload"].get("gameId") == self.games.currentData()
                            and response["payload"].get("side") == self.reference_side.currentData()
                            and self.sources.currentIndex() == 1):
                        self._show_comparison(result)
                elif channel == "games":
                    rows = [row for row in result.get("items", []) if isinstance(row, dict) and isinstance(row.get("gameId"), str)]
                    if response["payload"].get("before"):
                        existing = {row["gameId"] for row in self._games}
                        self._games.extend(row for row in rows if row["gameId"] not in existing)
                    else:
                        self._games = rows
                    self._games = self._games[:500]
                    self._cursor = result.get("nextBefore") if len(self._games) < 500 else None
                    self.more_button.setEnabled(bool(self._cursor))
                    self._update_library_filters()
                    self._fill_games()
                elif channel == "examples":
                    self._examples = [row for row in result.get("items", []) if isinstance(row, dict) and isinstance(row.get("id"), str)][:100]
                    self._fill_examples()
                    if not self._examples:
                        self.notice.setText("No curated replay examples are available yet. Choose a local replay or your replay library.")
                elif channel in {"target", "local", "example"}:
                    source = {"target": 1, "local": 0, "example": 2}[channel]
                    payload = response["payload"]
                    valid = (channel != "target" or payload.get("gameId") == self.games.currentData())
                    valid = valid and (channel != "local" or payload.get("path") == self.local_path.text())
                    valid = valid and (channel != "example" or payload.get("exampleId") == self.examples.currentData())
                    if valid and self.sources.currentIndex() == source:
                        self._show_targets(result)
            if channel == "save":
                self.enabled_toggle.setEnabled(True)
                self._next_save()
            if channel == "reference":
                self._update_reference_button()
            if channel == "restore":
                self._history_reference_changed()
            if channel == "comparison":
                self.compare_button.setEnabled(bool(self.games.currentData()))
            if channel == "local" and self._pending_local:
                path = self._pending_local
                self._pending_local = None
                self._call("local", {"action": "ghost_local_target", "path": path})
            self._render()

        def _save(self, changes):
            if self._closed:
                return
            self._revision += 1
            self._pending_saves.append({"action": "ghost_save", **changes})
            self._next_save()

        def _next_save(self):
            if "save" not in self._busy and self._pending_saves:
                self.enabled_toggle.setEnabled(False)
                self._call("save", self._pending_saves.pop(0))

        def _set_enabled(self, enabled):
            self._panel_restore_requested = bool(enabled)
            if not enabled:
                self._team_session.clear_target()
            self._desired_enabled = bool(enabled)
            self._state["enabled"] = bool(enabled)
            self.enabled_toggle.blockSignals(True)
            self.enabled_toggle.setChecked(bool(enabled))
            self.enabled_toggle.blockSignals(False)
            self._render()
            self._save({"enabled": bool(enabled)})

        def _accept_state(self, state, saved_payload=None):
            normalized = normalize_ghost_state(state)
            if self._desired_enabled is not None:
                if isinstance(saved_payload, dict) and saved_payload.get("enabled") is self._desired_enabled:
                    self._desired_enabled = None
                else:
                    normalized["enabled"] = self._desired_enabled
            self._state = normalized
            self.enabled_toggle.blockSignals(True)
            self.enabled_toggle.setChecked(self._state["enabled"])
            self.enabled_toggle.blockSignals(False)
            self._show_slot()

        def _show_slot(self, *_):
            target = self._state["slots"].get(self.matchup.currentText())
            self.assigned.setText(target["name"] if target else "No target assigned")
            self.clear_button.setEnabled(target is not None)

        def _fill_games(self, *_):
            if not hasattr(self, "games"):
                return
            previous = self.games.currentData()
            selected = self._selected_library_game_id or previous
            self._filling_games = True
            self.games.blockSignals(True)
            self.games.clear()
            query = self.search.text().strip().casefold()
            excluded = 0
            for row in self._games:
                if not supports_ghost_game(row):
                    excluded += 1
                    continue
                opponent = row.get("opponent") if isinstance(row.get("opponent"), dict) else {}
                mine, theirs = concrete_race(row.get("myRace")), concrete_race(opponent.get("race"))
                matchup = mine + "v" + theirs if mine and theirs else None
                build = row.get("myBuild") if isinstance(row.get("myBuild"), str) else ""
                map_name = row.get("map") if isinstance(row.get("map"), str) else ""
                result = str(row.get("result") or "").lower()
                result = "win" if result in {"victory", "win", "w"} else "loss" if result in {"defeat", "loss", "l"} else "tie" if result in {"tie", "draw"} else None
                starred = self._is_game_starred(row["gameId"])
                text = " · ".join(str(value) for value in [build or "Unclassified build", matchup or "Unknown matchup",
                                      map_name, opponent.get("displayName"), row.get("result"), str(row.get("date") or "")[:10]] if value)
                if (query and query not in text.casefold()
                        or self.matchup_filter.currentData() is not None and matchup != self.matchup_filter.currentData()
                        or self.build_filter.currentData() is not None and build != self.build_filter.currentData()
                        or self.map_filter.currentData() is not None and map_name != self.map_filter.currentData()
                        or self.result_filter.currentData() is not None and result != self.result_filter.currentData()
                        or self.starred_filter.isChecked() and not starred):
                    continue
                self.games.addItem(("★ " if starred else "☆ ") + text, row["gameId"])
            index = self.games.findData(selected)
            if index >= 0:
                self.games.setCurrentIndex(index)
            elif selected:
                self.games.setCurrentIndex(-1)
            self.games.blockSignals(False)
            self._filling_games = False
            self.load_button.setEnabled(bool(self.games.currentData()))
            self.library_count.setText(f"{self.games.count()} of {len(self._games)} loaded replays shown · filters apply to loaded pages only"
                                       + (f" · {excluded} team / unsupported hidden" if excluded else "")
                                       + (" · Selected replay is outside these filters; clear filters to restore it." if selected and index < 0 else ""))
            if previous != self.games.currentData():
                self._selection_changed()
            else:
                self._update_reference_button()

        def _update_library_filters(self):
            for control, field, title in ((self.build_filter, "myBuild", "All builds"), (self.map_filter, "map", "All maps")):
                selected = control.currentData()
                blocker = QtCore.QSignalBlocker(control)
                control.clear()
                control.addItem(title, None)
                values = sorted({row.get(field) if isinstance(row.get(field), str) else "" for row in self._games if supports_ghost_game(row)}, key=str.casefold)
                for value in values:
                    control.addItem(value or ("Unclassified builds" if field == "myBuild" else "Unknown map"), value)
                index = control.findData(selected)
                control.setCurrentIndex(index if index >= 0 else 0)
                del blocker

        def _clear_filters(self):
            controls = (self.search, self.matchup_filter, self.build_filter, self.map_filter, self.result_filter, self.starred_filter)
            blockers = [QtCore.QSignalBlocker(control) for control in controls]
            self.search.clear()
            for control in (self.matchup_filter, self.build_filter, self.map_filter, self.result_filter):
                control.setCurrentIndex(0)
            self.starred_filter.setChecked(False)
            del blockers
            self._fill_games()

        def _selection_changed(self, *_):
            if not self._filling_games and self.games.currentData():
                self._selected_library_game_id = self.games.currentData()
            self._update_reference_button()
            if hasattr(self, "comparison_tree"):
                self._clear_comparison()
            if self.sources.currentIndex() == 1:
                self._clear_preview()

        def _is_reference(self):
            game_id = self.games.currentData()
            return bool(game_id) and any(isinstance(row, dict) and isinstance(row.get("target"), dict)
                                        and row.get("side", "you") == self.reference_side.currentData()
                                        and (row.get("gameId") == game_id or row["target"].get("sourceGameId") == game_id)
                                        for row in self._references.values())

        def _is_game_starred(self, game_id):
            return any(isinstance(row, dict) and (row.get("gameId") == game_id
                       or isinstance(row.get("target"), dict) and row["target"].get("sourceGameId") == game_id)
                       for row in self._references.values())

        def _fill_examples(self, *_):
            if not hasattr(self, "examples"):
                return
            previous = self.examples.currentData()
            selected = self._selected_example_id or previous
            query = self.examples_search.text().strip().casefold()
            self.examples.blockSignals(True)
            self.examples.clear()
            for row in self._examples:
                if not supports_ghost_game(row):
                    continue
                matchup = row.get("matchup")
                text = " · ".join(str(row.get(field) or "") for field in ("name", "matchup", "map", "description"))
                if (query and query not in text.casefold()
                        or self.examples_matchup_filter.currentData() is not None and matchup != self.examples_matchup_filter.currentData()):
                    continue
                self.examples.addItem(str(row.get("name") or row["id"]) + (" · " + matchup if matchup in MATCHUPS else ""), row["id"])
            index = self.examples.findData(selected)
            if index >= 0:
                self.examples.setCurrentIndex(index)
            elif selected:
                self.examples.setCurrentIndex(-1)
            self.examples.blockSignals(False)
            self.example_load_button.setEnabled(bool(self.examples.currentData()))
            self.examples_count.setText(f"{self.examples.count()} of {len(self._examples)} loaded examples shown"
                                        + (" · Selected example is hidden by these filters." if selected and index < 0 else ""))
            if previous != self.examples.currentData():
                self._example_selected()

        def _example_selected(self, *_):
            if self.examples.currentData():
                self._selected_example_id = self.examples.currentData()
            self.example_load_button.setEnabled(bool(self.examples.currentData()))
            if self.sources.currentIndex() == 2:
                self._clear_preview()

        def _update_reference_button(self):
            self.reference_button.setText("★ Clear this build's reference replay" if self._is_reference() else
                                          "☆ Use as this build's reference replay")
            self.reference_button.setEnabled(bool(self.games.currentData()) and "reference" not in self._busy)
            if hasattr(self, "compare_button"):
                self.compare_button.setEnabled(bool(self.games.currentData()) and "comparison" not in self._busy)

        def _save_reference(self):
            game_id = self.games.currentData()
            if game_id:
                self._call("reference", {"action": "ghost_reference", "gameId": game_id,
                                          "side": self.reference_side.currentData(), "clear": self._is_reference()})
                self._update_reference_button()

        def _reference_side_changed(self, *_):
            self._update_reference_button()
            if hasattr(self, "comparison_tree"):
                self._clear_comparison()

        def _update_history_controls(self):
            selected = self.history_reference.currentData()
            blocker = QtCore.QSignalBlocker(self.history_reference)
            self.history_reference.clear()
            for key in sorted(set(self._references) | set(self._history)):
                current = self._references.get(key)
                entries = self._history.get(key)
                example = current if isinstance(current, dict) else entries[0] if isinstance(entries, list) and entries else None
                if not isinstance(example, dict):
                    continue
                target = example.get("target") if isinstance(example.get("target"), dict) else {}
                name = str(example.get("buildKey") or target.get("name") or "Replay build")
                side = "My build" if example.get("side", "you") == "you" else "Opponent's build"
                self.history_reference.addItem(side + " · " + str(example.get("matchup") or "") + " · " + name, key)
            index = self.history_reference.findData(selected)
            if index >= 0:
                self.history_reference.setCurrentIndex(index)
            del blocker
            self._history_reference_changed()
            count = sum(len(entries) for entries in self._history.values() if isinstance(entries, list))
            self.history_toggle.setText("Reference history / Undo" + (f" · {count} earlier choices" if count else ""))

        def _toggle_history(self, opened):
            self.history_toggle.setArrowType(QtCore.Qt.DownArrow if opened else QtCore.Qt.RightArrow)
            self.history_group.setVisible(opened)

        def _history_reference_changed(self, *_):
            key = self.history_reference.currentData()
            previous = self.history_entry.currentData()
            self.history_entry.clear()
            entries = self._history.get(key)
            for entry in entries[:3] if isinstance(entries, list) else []:
                if not isinstance(entry, dict) or not isinstance(entry.get("revision"), str):
                    continue
                target = entry.get("target") if isinstance(entry.get("target"), dict) else {}
                stamp = str(entry.get("savedAt") or "Earlier reference").replace("T", " ")[:19]
                self.history_entry.addItem(stamp + " · " + str(target.get("name") or "Replay build")
                                           + " · " + str(len(target.get("steps", []))) + " steps", entry["revision"])
            index = self.history_entry.findData(previous)
            if index >= 0:
                self.history_entry.setCurrentIndex(index)
            self.restore_button.setEnabled(bool(self.history_entry.count()) and "restore" not in self._busy)
            current = self._references.get(key)
            if isinstance(current, dict) and isinstance(current.get("target"), dict):
                self.history_status.setText("Current reference: " + str(current["target"].get("name") or "Replay build")
                                           + f" · {self.history_entry.count()} previous choices available")
            else:
                self.history_status.setText("Choose an earlier reference to undo a change." if self.history_entry.count() else
                                           "No reference history yet. Reference changes keep up to three prior choices per build.")

        def _restore_reference(self):
            key, revision = self.history_reference.currentData(), self.history_entry.currentData()
            entries = self._history.get(key)
            entry = next((row for row in entries if isinstance(row, dict) and row.get("revision") == revision), None) if isinstance(entries, list) else None
            if not entry:
                return
            target = entry.get("target") if isinstance(entry.get("target"), dict) else {}
            answer = QtWidgets.QMessageBox.question(self, "Restore reference replay?",
                "Restore “" + str(target.get("name") or "Replay build") + "” for " + str(entry.get("matchup") or "this build")
                + "?\nThis replaces the current reference for this build.",
                QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No, QtWidgets.QMessageBox.No)
            if answer != QtWidgets.QMessageBox.Yes:
                return
            current = self._references.get(key)
            expected = current.get("revision") if isinstance(current, dict) else None
            self._call("restore", {"action": "ghost_reference_restore", "referenceKey": key,
                                   "revision": revision, "expectedCurrentRevision": expected})
            self.restore_button.setEnabled(False)

        def _clear_comparison(self):
            self.comparison_tree.clear()
            self.comparison_tree.hide()
            self.comparison_status.clear()
            self.comparison_status.hide()

        def _compare_reference(self):
            game_id = self.games.currentData()
            if not game_id:
                return
            self._clear_comparison()
            self.comparison_status.setText("Comparing this replay with the saved reference…")
            self.comparison_status.show()
            self._call("comparison", {"action": "ghost_comparison", "gameId": game_id,
                                      "side": self.reference_side.currentData()})
            self.compare_button.setEnabled(False)
            self.scroll.ensureWidgetVisible(self.comparison_status)

        def _show_comparison(self, result):
            statuses = {"no_reference": "No reference is saved for this build and matchup yet. Star a replay first.",
                        "source_replay": "This is the reference replay itself. Choose another game to compare.",
                        "replay_pending": "This replay's build order is still being analyzed. Refresh after analysis finishes."}
            status = result.get("status")
            self.comparison_status.setText(statuses.get(status, "Replay timing comparison · positive differences happened later than the reference."))
            self.comparison_status.show()
            self.comparison_tree.clear()
            if status == "ready":
                rows = result.get("rows") if isinstance(result.get("rows"), list) else []
                for row in rows[:250]:
                    if not isinstance(row, dict):
                        continue
                    target, actual, delta = row.get("targetSec"), row.get("actualSec"), row.get("deltaSec")
                    valid = lambda value: type(value) in {int, float} and math.isfinite(value)
                    name = _display(str(row.get("name") or "Step"))
                    occurrence = row.get("occurrence")
                    if type(occurrence) is int and occurrence > 1:
                        name += " #" + str(occurrence)
                    self.comparison_tree.addTopLevelItem(QtWidgets.QTreeWidgetItem([
                        name, _clock(target) if valid(target) else "—", _clock(actual) if valid(actual) else "Not observed",
                        f"{delta:+.1f}s" if valid(delta) else "—", str(row.get("timing") or "recorded"),
                    ]))
                self.comparison_tree.show()
            else:
                self.comparison_tree.hide()
            self.scroll.ensureWidgetVisible(self.comparison_status)

        def _clear_preview(self):
            self._preview = None
            self._preview_matchup = None
            self._preview_race = None
            self._preview_manual = False
            self.arm_button.setEnabled(False)
            self.team_arm_button.setEnabled(False)
            self._player_targets = []
            self.players.blockSignals(True)
            while self.players.count():
                widget = self.players.widget(0)
                self.players.removeTab(0)
                widget.deleteLater()
            self.preview_steps = tree()
            self.preview_steps.setMinimumHeight(220)
            self.players.addTab(self.preview_steps, "Choose a replay")
            self.players.blockSignals(False)
            self.target_name.clear()
            self.preview_label.setText("Select a replay, then preview its recorded build order.")

        def _source_changed(self, index):
            self.sources.setFixedHeight({0: 180, 1: 300, 2: 250}.get(index, 180))
            self._clear_preview()
            self._clear_comparison()
            if index == 2 and not self._examples:
                self._call("examples", {"action": "ghost_examples"})

        def _show_targets(self, result):
            candidates = result.get("players")
            if not isinstance(candidates, list):
                candidates = [{"name": "Replay player", "target": result.get("target"), "matchup": result.get("matchup")}]
            choices = []
            for candidate in candidates[:16]:
                if not isinstance(candidate, dict):
                    continue
                target = normalize_target(candidate.get("target"))
                matchup = candidate.get("matchup")
                race = concrete_race(candidate.get("race")) or (matchup[0] if matchup in MATCHUPS else None)
                manual = candidate.get("manualOnly") is True
                if target and race and (matchup in MATCHUPS or manual):
                    choices.append({"name": str(candidate.get("name") or "Replay player")[:80], "target": target, "matchup": matchup,
                                    "race": race, "manualOnly": manual,
                                    "side": candidate.get("id") if candidate.get("id") in ("you", "opponent") else None})
            self._clear_preview()
            if not choices:
                self.notice.setText("This replay has no usable timed player build orders yet.")
                return
            self._player_targets = choices
            self.players.blockSignals(True)
            placeholder = self.players.widget(0)
            self.players.removeTab(0)
            placeholder.deleteLater()
            for choice in choices:
                preview = tree()
                preview.setMinimumHeight(220)
                for step in choice["target"]["steps"]:
                    add_step(preview, step, "Target " + step["timing"])
                self.players.addTab(preview, choice["name"] + " · " + (choice["matchup"] or choice["race"] + " · team replay"))
            self.players.blockSignals(False)
            self._player_changed(0)
            self.notice.setText("Choose a human player's build. A 1v1 source can be assigned to its exact matchup; a team source can only be explicitly used in your current confirmed same-race team game.")

        def _player_changed(self, index):
            if not 0 <= index < len(self._player_targets):
                return
            choice = self._player_targets[index]
            self._preview = choice["target"]
            self._preview_matchup = choice["matchup"]
            self._preview_race = choice["race"]
            self._preview_manual = choice["manualOnly"]
            if self.sources.currentIndex() == 1 and choice.get("side"):
                self.reference_side.setCurrentIndex(self.reference_side.findData(choice["side"]))
            self.preview_steps = self.players.widget(index)
            self.target_name.setText(self._preview["name"])
            self.preview_label.setText(choice["name"] + " · " + (self._preview_matchup or self._preview_race + " · team replay · manual only") + " · " + str(len(self._preview["steps"])) + " timed steps")
            self.arm_button.setText("Use for " + self._preview_matchup if self._preview_matchup else "Team replay · manual only")
            self.arm_button.setEnabled(self._preview_matchup in MATCHUPS and not self._preview_manual)
            self._render()

        def _choose_local(self):
            initial = self._replay_folders[0] if self._replay_folders else str(Path.home() / "Documents" / "StarCraft II")
            path, _ = QtWidgets.QFileDialog.getOpenFileName(self, "Choose a StarCraft II replay", initial, "StarCraft II replay (*.SC2Replay)")
            if path:
                self.load_local_replay(path)

        def load_local_replay(self, path):
            if not isinstance(path, str) or Path(path).suffix.lower() != ".sc2replay":
                self.notice.setText("Choose a .SC2Replay file.")
                return
            self.sources.setCurrentIndex(0)
            self._clear_preview()
            self.local_path.setText(path)
            self.notice.setText("Reading replay players and build steps…")
            if "local" in self._busy:
                self._pending_local = path
            else:
                self._call("local", {"action": "ghost_local_target", "path": path})

        def dragEnterEvent(self, event):
            urls = event.mimeData().urls() if event.mimeData().hasUrls() else []
            if any(url.isLocalFile() and Path(url.toLocalFile()).suffix.lower() == ".sc2replay" for url in urls):
                event.acceptProposedAction()

        def dropEvent(self, event):
            for url in event.mimeData().urls():
                if url.isLocalFile() and Path(url.toLocalFile()).suffix.lower() == ".sc2replay":
                    self.load_local_replay(url.toLocalFile())
                    event.acceptProposedAction()
                    return

        def _load_example(self):
            example_id = self.examples.currentData()
            if example_id:
                self._clear_preview()
                self.notice.setText("Loading curated replay example…")
                self._call("example", {"action": "ghost_example_target", "exampleId": example_id})

        def _load_target(self):
            game_id = self.games.currentData()
            if game_id:
                self.notice.setText("Loading this replay's target start times…")
                self._call("target", {"action": "ghost_target", "gameId": game_id})

        def _arm(self):
            if self._preview and self._preview_matchup in MATCHUPS and not self._preview_manual:
                name = self.target_name.text().strip()
                if not name:
                    self.notice.setText("Give this target a name first.")
                    return
                target = {**self._preview, "name": name}
                self.matchup.setCurrentText(self._preview_matchup)
                self._save({"matchup": self._preview_matchup, "target": target})
                self.notice.setText("Saving this replay target for " + self._preview_matchup + ".")

        def _arm_team(self):
            if not self._assistance_enabled or not self._state["enabled"]:
                self.notice.setText("Turn on Ghost and in-game assistance before using this temporary team target.")
                return
            name = self.target_name.text().strip()
            if not self._preview or not name:
                self.notice.setText("Preview a player's replay build and give the target a name first.")
                return
            try:
                self._team_session.arm({**self._preview, "name": name}, self._preview_race)
            except GhostError as error:
                self.notice.setText(str(error))
                self._render()
                return
            self._panel_restore_requested = True
            self.notice.setText("Manual team target is active for this game only. Changing player, enemy or game, or turning assistance off, clears it. No 1v1 assignment is changed.")
            self._render()

        def refresh(self):
            if self._closed:
                return
            self._call("state", {"action": "ghost_state"})
            self._call("games", {"action": "ghost_games"})

        def apply_account_result(self, result):
            if self._closed or not isinstance(result, dict):
                return
            if isinstance(result.get("ghost"), dict):
                self._accept_state(result["ghost"])
            if isinstance(result.get("references"), dict):
                self._references = result["references"]
                self._update_reference_button()
                self.referencesChanged.emit(self._references)
                self._fill_games()
            if isinstance(result.get("history"), dict):
                self._history = result["history"]
            self._update_history_controls()
            self._render()

        def update_snapshot(self, snapshot):
            self._session.update_snapshot(snapshot)
            self._team_session.update_snapshot(snapshot)
            envelope = snapshot.get("liveGame") if isinstance(snapshot, dict) else None
            players = envelope.get("players") if isinstance(envelope, dict) else None
            self._team_game = bool(isinstance(envelope, dict) and
                (isinstance(players, list) and len(players) > 2 or not supports_ghost_game(envelope)))
            self._render()

        def set_team_context(self, context):
            self._team_context = context if isinstance(context, dict) else None
            self._team_session.update_context(self._team_context)
            self._render()

        def set_assistance_enabled(self, enabled, reason=None):
            if enabled and not self._assistance_enabled:
                self._panel_restore_requested = True
            self._assistance_enabled = bool(enabled)
            if not enabled:
                self._team_session.clear_target()
            self._assistance_reason = reason[:180] if isinstance(reason, str) and reason else "Hidden by the master assistance switch"
            self._render()

        def set_density(self, level):
            self._density = level if level in ("compact", "standard", "detailed", "full") else "standard"
            full = self._density == "full"
            self.filters_widget.setVisible(full)
            self.history_toggle.setVisible(full)
            self.history_group.setVisible(full and self.history_toggle.isChecked())
            self.examples_search.setVisible(full)
            self.examples_matchup_filter.setVisible(full)

        def overview_summary(self, limit=3):
            view, status = self._current_view()
            if not self._state["enabled"]:
                return "Ghost is off"
            if not self._assistance_enabled:
                return self._assistance_reason
            if not view:
                return status
            steps = view["target"]["steps"][view["index"]:view["index"] + max(1, min(3, limit))]
            return view["target"]["name"] + "\n" + "\n".join(_clock(step["t"]) + " · " + _display(step["name"]) + " · " + step["timing"] for step in steps)

        def _current_view(self):
            if self._team_game or self._team_context is not None:
                return self._team_session.view()
            return self._session.view(self._state)

        def _render(self):
            if self._closed:
                return
            if not self._state["enabled"] or not self._assistance_enabled:
                self._team_session.clear_target()
            view, status = self._current_view()
            manual = self._team_game or self._team_context is not None or self._preview_manual
            self.team_arm_button.setVisible(manual)
            self.team_target_status.setVisible(manual)
            can_arm = bool(self._preview and self._assistance_enabled and self._state["enabled"]
                           and self._team_session.can_arm(self._preview_race))
            self.team_arm_button.setEnabled(can_arm)
            self.team_target_status.setText(status if not can_arm else "Same-race target ready. Use it explicitly for this confirmed team game; it is not saved to a 1v1 matchup.")
            self.status.setText(status if self._state["enabled"] and self._assistance_enabled else
                                "Ghost is off · Turn it on above to follow an assigned replay target." if not self._state["enabled"] else self._assistance_reason + " · Targets stay saved.")
            self.live_status.setText(f"{len(self._state['slots'])} of 9 matchups assigned · 1v1 automatic / teams manual · "
                                    + (f"Live {view['matchup']} · SC2 clock {_clock(view['clock'])}" if view else status))
            visible = bool(self._state["enabled"] and self._assistance_enabled and view)
            if visible:
                self.panel.paint_view(view)
                if self._panel_restore_requested:
                    self.panel.showNormal()
                    self._panel_restore_requested = False
                elif not self.panel.isVisible():
                    self.panel.show()
            else:
                self.panel.hide()

        def shutdown(self):
            self._closed = True
            self.timer.stop()
            self._team_session.clear_target()
            self.panel.close()

    return GhostPage()

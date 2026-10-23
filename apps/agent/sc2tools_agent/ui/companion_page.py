"""Interactive native scouting desk and optional in-game companion panels."""
from __future__ import annotations

from copy import deepcopy
import math
from pathlib import Path
import re
import threading
import time

from ..companion_modes import build_companion_modes, effective_mode_features, normalize_modes


_STYLE = """
QWidget#companionDesk, QWidget#companionContent, QWidget#companionPanel { background: #10131f; color: #e8edf8; }
QWidget#companionDesk QLabel, QWidget#companionPanel QLabel { color: #e8edf8; background: transparent; }
QFrame#companionCard { background: #191d2f; border: 1px solid #34334f; border-radius: 12px; }
QLabel#companionTitle { font-size: 25px; font-weight: 700; color: #f1eaff; }
QLabel#companionHeading { font-size: 17px; font-weight: 650; color: #e8dcff; }
QLabel#companionMuted { color: #a7b0c8; font-size: 12px; }
QLabel#companionAccent { color: #71e2d2; font-size: 12px; font-weight: 600; }
QWidget#companionDesk QLineEdit, QWidget#companionDesk QPlainTextEdit,
QWidget#companionDesk QComboBox, QWidget#companionPanel QComboBox {
    background: #111627; color: #e8edf8; border: 1px solid #414365; border-radius: 6px; padding: 7px;
}
QWidget#companionDesk QPushButton, QWidget#companionPanel QPushButton {
    background: #302647; color: #ede4ff; border: 1px solid #62518c; border-radius: 6px; padding: 7px 12px;
}
QWidget#companionDesk QPushButton:hover, QWidget#companionPanel QPushButton:hover { background: #473361; }
QWidget#companionDesk QPushButton:checked { background: #50407b; border-color: #ac84ff; }
QWidget#companionDesk QPushButton:disabled { color: #6e7588; border-color: #32394a; background: #1b2130; }
QWidget#companionDesk QCheckBox, QWidget#companionPanel QCheckBox { color: #d9def0; spacing: 8px; }
QWidget#companionDesk QTreeWidget, QWidget#companionDesk QListWidget, QWidget#companionPanel QTreeWidget {
    background: #121727; alternate-background-color: #1b2033; color: #e1e7f6;
    border: 1px solid #313951; border-radius: 7px; outline: none;
}
QWidget#companionDesk QTreeWidget::item, QWidget#companionPanel QTreeWidget::item { padding: 6px 3px; }
QWidget#companionDesk QListWidget::item { padding: 12px 7px; border-bottom: 1px solid #252d43; }
QWidget#companionDesk QListWidget::item:selected { background: #49376d; color: #ffffff; }
QWidget#companionDesk QHeaderView::section, QWidget#companionPanel QHeaderView::section {
    background: #26283e; color: #bcb2d9; padding: 7px; border: none; font-size: 11px;
}
QWidget#companionDesk QTabWidget::pane { border: 1px solid #34334f; border-radius: 6px; }
QWidget#companionDesk QTabBar::tab { background: #1b2033; color: #bfc7dd; padding: 9px 14px; }
QWidget#companionDesk QTabBar::tab:selected { background: #443363; color: #f3ecff; }
"""

_ICON_ALIASES = {
    "blinktech": "blink", "stimpack": "stim", "shieldwall": "combatshield",
    "punishergrenades": "concussive", "concussiveshells": "concussive",
    "psistormtech": "psistorm", "psionicstorm": "psistorm",
    "adeptpiercingattack": "resonatingglaives", "darktemplarblinkupgrade": "shadowstride",
    "zerglingmovementspeed": "metabolicboost", "zerglingmetabolicboost": "metabolicboost",
    "zerglingattackspeed": "adrenalglands", "overlordspeed": "pneumatizedcarapace",
    "centrificalhooks": "centrifugalhooks", "evolvemuscularaugments": "muscularaugments",
    "evolvegroovedspines": "groovedspines", "lurkerrange": "seismicspines",
    "diggingclaws": "adaptivetalons", "bansheecloak": "cloak", "cloakingfield": "cloak",
    "templararchives": "templararchive", "lurkermpden": "lurkerden", "lurkermp": "lurker",
    "banelingcocoon": "baneling", "ravagercocoon": "ravager", "broodlordcocoon": "broodlord",
}


def _icon_token(name, kind):
    token = re.sub(r"[^a-z0-9]", "", name.lower())
    if kind == "race":
        return {"p": "protoss", "t": "terran", "z": "zerg", "r": "random"}.get(token, token)
    addon = re.fullmatch(r"(?:barracks|factory|starport)(techlab|reactor)", token)
    if kind == "building" and addon:
        return addon.group(1)
    tiered = re.fullmatch(r"(.+?)level([1-3])", token)
    if kind == "upgrade" and tiered:
        family, tier = tiered.groups()
        family = re.sub(r"^terranvehicleandship(?:plating|armors?)$", "terranvehiclearmor", family)
        family = re.sub(r"^terranshiparmors?$", "terranvehiclearmor", family)
        family = re.sub(r"armors$", "armor", family)
        family = re.sub(r"^zerg(melee|missile|flyer)(?:weapons|attacks)$", r"zerg\1attacks", family)
        family = re.sub(r"^zerg(ground|flyer)(?:armor|carapace)$", r"zerg\1carapace", family)
        return family + tier
    return _ICON_ALIASES.get(token, token)


def _display_name(name):
    prefix, separator, remainder = name.partition(" · ")
    if separator and prefix in {"YOU", "OPP"}:
        return prefix + separator + _display_name(remainder)
    token = re.sub(r"[^a-z0-9]", "", name.lower())
    names = {
        "blinktech": "Blink", "zerglingmovementspeed": "Metabolic Boost",
        "zerglingmetabolicboost": "Metabolic Boost", "stimpack": "Stimpack",
        "shieldwall": "Combat Shield", "punishergrenades": "Concussive Shells",
        "adeptpiercingattack": "Resonating Glaives", "psistormtech": "Psionic Storm",
    }
    if token in names:
        return names[token]
    readable = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name)
    readable = re.sub(r"(?<=[A-Za-z])(?=[0-9])", " ", readable)
    return readable.replace("_", " ").strip()


def _time(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return "—"
    seconds = int(value)
    return f"{seconds // 60}:{seconds % 60:02d}"


def _name(row):
    return str(row.get("revealedName") or row.get("name") or row.get("displayName") or row.get("displayNameSample") or "Unknown opponent")


def _note_length(text):
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def _events(game, side, *, full=False, upgrades=False):
    source = game.get(side + "BuildOrder") if full else game.get(side + "TechMilestones")
    if not isinstance(source, list):
        source = game.get(side + "BuildOrder") or []
    events = []
    for row in source:
        if not isinstance(row, dict) or not row.get("name"):
            continue
        kind = row.get("kind") or row.get("category") or "building"
        if upgrades and kind != "upgrade":
            continue
        timing = row.get("timing")
        events.append({
            "name": str(row["name"]), "timeSec": row.get("timeSec", row.get("time")),
            "kind": kind, "timing": timing if timing in {"started", "completed"} else "recorded",
        })
    return sorted(events, key=lambda row: row["timeSec"] if _time(row["timeSec"]) != "—" else float("inf"))


def _live_context(snapshot):
    envelope = snapshot.get("liveGame") or {}
    active = envelope.get("phase") in {"match_loading", "match_started", "match_in_progress"} and not envelope.get("isReplay")
    timestamp = envelope.get("receivedAt")
    if isinstance(timestamp, (int, float)) and not isinstance(timestamp, bool):
        timestamp /= 1000
    else:
        timestamp = envelope.get("capturedAt")
    if isinstance(timestamp, (int, float)) and (not math.isfinite(timestamp) or time.time() - timestamp > 30):
        active = False
    history = envelope.get("streamerHistory") or {}
    post = snapshot.get("live") or {}
    if active:
        if envelope.get("gameKey") and post.get("gameKey") == envelope.get("gameKey"):
            history = {**history, **post}
        opponent = envelope.get("opponent") or {}
        profile = opponent.get("profile") or {}
        return active, {
            **history,
            "name": opponent.get("revealedName") or opponent.get("name") or history.get("oppName") or "Opponent resolving…",
            "race": opponent.get("race") or history.get("oppRace"),
            "mmr": profile.get("mmr") or history.get("oppMmr"),
            "league": profile.get("league"), "region": profile.get("region"),
            "elapsed": envelope.get("displayTime"),
        }
    return False, post


def _icon_root():
    packaged = Path(__file__).resolve().parent / "assets" / "sc2"
    return packaged if packaged.is_dir() else Path(__file__).resolve().parents[3] / "web" / "public" / "icons" / "sc2"


def build_companion_page(parent, *, handler, QtCore, QtGui, QtWidgets,
                         checkin_controller_provider=None):
    """Build a lazy-Qt page; all handler calls run in daemon workers."""
    icon_root = _icon_root()

    def label(text, kind="", parent=None):
        widget = QtWidgets.QLabel(text, parent)
        widget.setTextFormat(QtCore.Qt.PlainText)
        widget.setWordWrap(True)
        if kind:
            widget.setObjectName("companion" + kind)
        return widget

    def icon(name, kind):
        token = _icon_token(name, kind)
        directory = {"building": "buildings", "unit": "units", "upgrade": "upgrades", "race": "races"}.get(kind, "buildings")
        for extension in (".png", ".svg"):
            path = icon_root / directory / (token + extension)
            if path.is_file():
                return QtGui.QIcon(str(path))
        return QtGui.QIcon()

    def timeline():
        tree = QtWidgets.QTreeWidget()
        tree.setColumnCount(3)
        tree.setHeaderLabels(["TECH / UNIT", "TIME", "EVENT"])
        tree.setRootIsDecorated(False)
        tree.setAlternatingRowColors(True)
        tree.setIconSize(QtCore.QSize(30, 30))
        tree.setMinimumHeight(245)
        tree.header().setSectionResizeMode(0, QtWidgets.QHeaderView.Stretch)
        tree.header().setSectionResizeMode(1, QtWidgets.QHeaderView.ResizeToContents)
        tree.header().setSectionResizeMode(2, QtWidgets.QHeaderView.ResizeToContents)
        return tree

    def fill_timeline(tree, events):
        tree.clear()
        for event in events:
            item = QtWidgets.QTreeWidgetItem([_display_name(event["name"]), _time(event["timeSec"]), event["timing"].title()])
            item.setIcon(0, icon(event.get("iconName") or event["name"], event["kind"]))
            item.setToolTip(0, f"{event['kind'].title()} · {event['timing']} at {_time(event['timeSec'])}")
            tree.addTopLevelItem(item)
        if not events:
            tree.addTopLevelItem(QtWidgets.QTreeWidgetItem(["No replay timing data available", "", ""]))

    class CompanionPanel(QtWidgets.QWidget):
        def __init__(self, owner, kind):
            super().__init__(None, QtCore.Qt.Tool | QtCore.Qt.WindowStaysOnTopHint)
            self.owner = owner
            self.kind = kind
            self.setObjectName("companionPanel")
            self.setWindowTitle("SC2TOOLS · " + kind.title())
            self.setAttribute(QtCore.Qt.WA_ShowWithoutActivating)
            self.setAttribute(QtCore.Qt.WA_QuitOnClose, False)
            self.setStyleSheet(_STYLE)
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(16, 16, 16, 16)
            self.title = label("Waiting for a match", "Heading")
            self.subtitle = label("", "Accent")
            layout.addWidget(self.title)
            layout.addWidget(self.subtitle)
            self.detail = label("", "Muted")
            layout.addWidget(self.detail)
            if kind == "scouting":
                self.games = QtWidgets.QComboBox()
                self.games.currentIndexChanged.connect(self._game_changed)
                layout.addWidget(self.games)
                self.builds = label("", "Accent")
                layout.addWidget(self.builds)
                self.tree = timeline()
                self.tree.setHeaderLabels(["HISTORICAL TECH STEP", "TIME", "EVENT"])
                layout.addWidget(self.tree)
            self.resize(650 if kind == "scouting" else 330, 450 if kind == "scouting" else 220)
            self._signature = None
            self._games = []

        def closeEvent(self, event):
            if not self.owner._closed:
                self.owner.set_preference(self.kind + "Overlay", False)
            event.accept()

        def update_context(self, context):
            self.title.setText(_name(context) if context else "Preview · choose an opponent")
            record = context.get("headToHead") or context.get("totals") or context
            parts = [str(value) for value in [context.get("race") or context.get("oppRace"), context.get("league"), context.get("region")] if value]
            if context.get("mmr") is not None:
                parts.append(f"{context['mmr']} MMR")
            self.subtitle.setText("  ·  ".join(parts) or "Opponent profile not available yet")
            notes = context.get("opponentNotes") or {}
            text = notes.get("text") if isinstance(notes, dict) else ""
            if self.kind == "opponent":
                wins, losses = record.get("wins"), record.get("losses")
                summary = f"Your head-to-head: {wins}W · {losses}L" if wins is not None and losses is not None else "First meeting or no shared replay history"
                self.detail.setText(summary + ("\n\n" + str(text or context.get("notes")) if text or context.get("notes") else ""))
                return
            self.detail.setText("Previous games against this opponent · replay timings")
            games = context.get("last5GamesScouting") or []
            if games != self._games:
                selected = self.games.currentData()
                self._games = games
                blocked = QtCore.QSignalBlocker(self.games)
                self.games.clear()
                for index, game in enumerate(games):
                    self.games.addItem(_game_title(game, index), game.get("gameId") or str(index))
                match = self.games.findData(selected)
                if match >= 0:
                    self.games.setCurrentIndex(match)
                del blocked
                self._game_changed()
            if not games:
                self.builds.setText("No previous replay scouting available")
                fill_timeline(self.tree, [])

        def _game_changed(self):
            index = self.games.currentIndex()
            if index < 0 or index >= len(self._games):
                return
            game = self._games[index]
            self.builds.setText(_builds(game))
            events = [{**event, "iconName": event["name"], "name": ("YOU · " if side == "my" else "OPP · ") + event["name"]}
                      for side in ("my", "opp") for event in _events(game, side)]
            events.sort(key=lambda event: event["timeSec"] if _time(event["timeSec"]) != "—" else float("inf"))
            fill_timeline(self.tree, events)

    def _game_title(game, index):
        return f"{index + 1}. {str(game.get('result') or 'Game').upper()} · {_time(game.get('durationSec'))} · {game.get('map') or 'Unknown map'} · {str(game.get('date') or '')[:10]}"

    def _builds(game):
        return f"YOU · {game.get('myBuild') or 'Unclassified build'}\nVS\nOPPONENT · {game.get('oppStrategy') or game.get('oppBuild') or 'Unclassified build'}"

    class CompanionPage(QtWidgets.QWidget):
        completed = QtCore.Signal(dict)
        assistanceChanged = QtCore.Signal(bool)
        modesChanged = QtCore.Signal(dict)
        hotkeyEnabledChanged = QtCore.Signal(bool)

        def __init__(self):
            super().__init__(parent)
            self.setObjectName("companionDesk")
            self.setStyleSheet(_STYLE)
            self._closed = False
            self._sequence = 0
            self._requests = {}
            self._preferences_revision = 0
            self._preference_busy = False
            self._preferences_queued = False
            self._modes = normalize_modes({})
            self._saved_modes = deepcopy(self._modes)
            self._modes_loaded = False
            self._mode_revision = 0
            self._mode_busy = False
            self._modes_queued = False
            self._paired = False
            self._directory_loaded = False
            self._opponents = []
            self._cursor = None
            self._selected_id = None
            self._detail = {}
            self._drafts = {}
            self._snapshot = {}
            self._snapshot_healthy = False
            self._preferences = {"overlaysEnabled": False, "opponentOverlay": False, "scoutingOverlay": False}
            self._rendering_notes = False
            self._games = []
            self._ghost_references = {}
            self._build_ui()
            self.overlays = {kind: CompanionPanel(self, kind) for kind in ("opponent", "scouting")}
            self._position_overlays()
            self.completed.connect(self._completed)
            self.timer = QtCore.QTimer(self)
            self.timer.setInterval(3000)
            self.timer.timeout.connect(self.refresh)
            if callable(handler):
                self._job("modes_load", {"action": "companion_modes"})
                self.timer.start()
                self.refresh()
            else:
                self.live_label.setText("Companion unavailable · start the agent service to connect.")
                self.notice.setText("Your scouting desk will be available when the agent service is connected.")
                self.refresh_button.setEnabled(False)
                self.preview_button.setEnabled(False)
                for checkbox in self.preference_checks.values():
                    checkbox.setEnabled(False)

        def _build_ui(self):
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(22, 18, 22, 18)
            layout.setSpacing(12)
            heading = QtWidgets.QHBoxLayout()
            heading.addWidget(label("Companion", "Title"))
            heading.addStretch()
            self.refresh_button = QtWidgets.QPushButton("Refresh library")
            self.refresh_button.clicked.connect(self.refresh_library)
            heading.addWidget(self.refresh_button)
            layout.addLayout(heading)
            layout.addWidget(label("Your scouting desk. Browse opponents, compare openings, and pin only what you need in game.", "Muted"))
            self.live_label = label("Connecting to your agent…", "Accent")
            layout.addWidget(self.live_label)
            controls = QtWidgets.QHBoxLayout()
            self.preference_checks = {}
            for key, title in [("overlaysEnabled", "Game assistance enabled"), ("opponentOverlay", "Pin opponent"), ("scoutingOverlay", "Pin scouting")]:
                checkbox = QtWidgets.QCheckBox(title)
                checkbox.setChecked(self._preferences[key])
                checkbox.toggled.connect(lambda value, preference=key: self.set_preference(preference, value))
                self.preference_checks[key] = checkbox
                checkbox.setEnabled(False)
                controls.addWidget(checkbox)
            controls.addStretch()
            self.preview_button = QtWidgets.QPushButton("Preview panels")
            self.preview_button.setCheckable(True)
            self.preview_button.toggled.connect(self._update_overlays)
            controls.addWidget(self.preview_button)
            layout.addLayout(controls)
            self.mode_controls = build_companion_modes(self, QtCore=QtCore, QtWidgets=QtWidgets)
            self.mode_controls.setEnabled(False)
            self.mode_controls.changed.connect(self._modes_changed)
            layout.addWidget(self.mode_controls)
            self.notice = label("Loading your opponent library…", "Muted")
            layout.addWidget(self.notice)

            splitter = QtWidgets.QSplitter(QtCore.Qt.Horizontal)
            library = QtWidgets.QWidget()
            library_layout = QtWidgets.QVBoxLayout(library)
            library_layout.setContentsMargins(0, 0, 6, 0)
            library_layout.addWidget(label("OPPONENT LIBRARY", "Accent"))
            self.search = QtWidgets.QLineEdit()
            self.search.setPlaceholderText("Search loaded opponents or race…")
            self.search.textChanged.connect(self._filter_opponents)
            library_layout.addWidget(self.search)
            self.library_count = label("No opponents loaded", "Muted")
            library_layout.addWidget(self.library_count)
            self.opponent_list = QtWidgets.QListWidget()
            self.opponent_list.setMinimumWidth(210)
            self.opponent_list.currentItemChanged.connect(self._opponent_selected)
            library_layout.addWidget(self.opponent_list, 1)
            self.load_more_button = QtWidgets.QPushButton("Load more opponents")
            self.load_more_button.clicked.connect(self.load_more)
            self.load_more_button.setEnabled(False)
            library_layout.addWidget(self.load_more_button)
            splitter.addWidget(library)
            scroll = QtWidgets.QScrollArea()
            scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
            scroll.setWidgetResizable(True)
            body = QtWidgets.QWidget()
            body.setObjectName("companionContent")
            body_layout = QtWidgets.QVBoxLayout(body)
            body_layout.setContentsMargins(8, 0, 0, 0)
            body_layout.setSpacing(12)
            profile = QtWidgets.QFrame()
            profile.setObjectName("companionCard")
            profile_layout = QtWidgets.QVBoxLayout(profile)
            profile_layout.setContentsMargins(18, 16, 18, 16)
            self.profile_title = label("Choose an opponent", "Heading")
            self.profile_summary = label("Your imported replay history appears here.", "Muted")
            profile_layout.addWidget(self.profile_title)
            profile_layout.addWidget(self.profile_summary)
            self.tendencies = label("", "Accent")
            profile_layout.addWidget(self.tendencies)
            body_layout.addWidget(profile)
            body_layout.addWidget(label("PREVIOUS ENCOUNTERS", "Accent"))
            self.game_select = QtWidgets.QComboBox()
            self.game_select.currentIndexChanged.connect(self._game_selected)
            self.game_select.setEnabled(False)
            body_layout.addWidget(self.game_select)
            ghost_actions = QtWidgets.QHBoxLayout()
            self.ghost_reference_buttons = {}
            for side, title in [("you", "Use my build as Ghost"), ("opponent", "Use opponent's build as Ghost")]:
                button = QtWidgets.QPushButton("☆ " + title)
                button.setEnabled(False)
                button.clicked.connect(lambda _checked=False, chosen_side=side: self._save_ghost_reference(chosen_side))
                self.ghost_reference_buttons[side] = button
                ghost_actions.addWidget(button)
            body_layout.addLayout(ghost_actions)
            self.build_labels = label("Choose a replay to compare both build orders.", "Heading")
            body_layout.addWidget(self.build_labels)
            self.game_summary = label("", "Muted")
            body_layout.addWidget(self.game_summary)
            self.tabs = QtWidgets.QTabWidget()
            self.trees = {}
            for key, title in [("tech", "Tech milestones"), ("build", "Full opening"), ("upgrades", "Upgrades")]:
                tab = QtWidgets.QWidget()
                tab_layout = QtWidgets.QVBoxLayout(tab)
                tab_layout.addWidget(label("Started and completed are replay observations; recorded means the older replay has no event-type label.", "Muted"))
                columns = QtWidgets.QHBoxLayout()
                self.trees[key] = {}
                for side, caption in [("my", "YOUR TIMELINE"), ("opp", "OPPONENT TIMELINE")]:
                    column = QtWidgets.QVBoxLayout()
                    column.addWidget(label(caption, "Accent"))
                    tree = timeline()
                    self.trees[key][side] = tree
                    fill_timeline(tree, [])
                    column.addWidget(tree)
                    columns.addLayout(column, 1)
                tab_layout.addLayout(columns)
                self.tabs.addTab(tab, title)
            body_layout.addWidget(self.tabs)
            self.phase_summary = label("", "Muted")
            body_layout.addWidget(self.phase_summary)
            body_layout.addWidget(label("PRIVATE SCOUTING NOTES", "Accent"))
            self.notes = QtWidgets.QPlainTextEdit()
            self.notes.setPlaceholderText("What should you remember next time you meet this opponent?")
            self.notes.setFixedHeight(82)
            self.notes.setEnabled(False)
            self.notes.textChanged.connect(self._notes_changed)
            body_layout.addWidget(self.notes)
            notes_actions = QtWidgets.QHBoxLayout()
            self.read_aloud = QtWidgets.QCheckBox("Include notes in voice readout")
            self.read_aloud.setEnabled(False)
            self.read_aloud.toggled.connect(self._notes_changed)
            notes_actions.addWidget(self.read_aloud)
            self.note_count = label("0 / 500", "Muted")
            notes_actions.addWidget(self.note_count)
            notes_actions.addStretch()
            self.save_notes_button = QtWidgets.QPushButton("Save notes")
            self.save_notes_button.clicked.connect(self.save_notes)
            self.save_notes_button.setEnabled(False)
            notes_actions.addWidget(self.save_notes_button)
            body_layout.addLayout(notes_actions)
            body_layout.addStretch()
            scroll.setWidget(body)
            splitter.addWidget(scroll)
            splitter.setStretchFactor(1, 1)
            splitter.setSizes([230, 800])
            self.workspace_tabs = QtWidgets.QTabWidget()
            self.workspace_tabs.addTab(splitter, "Scouting")
            from .companion_builds import build_companion_builds
            from .companion_randomizer import build_companion_randomizer
            from .companion_ghost import build_companion_ghost
            self.build_selectors = build_companion_builds(
                self.workspace_tabs, controller_provider=checkin_controller_provider or (lambda: None),
                QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
            )
            self.randomizer_page = build_companion_randomizer(
                self.workspace_tabs, handler=handler, QtCore=QtCore,
                QtGui=QtGui, QtWidgets=QtWidgets,
            )
            self.build_selectors.roll_now.clicked.connect(self.randomizer_page.request_roll_now)
            self.ghost_page = build_companion_ghost(
                self.workspace_tabs, handler=handler, QtCore=QtCore,
                QtGui=QtGui, QtWidgets=QtWidgets,
            )
            self.ghost_page.referencesChanged.connect(self._ghost_references_changed)
            self.workspace_tabs.addTab(self.build_selectors, "Build selectors")
            self.workspace_tabs.addTab(self.randomizer_page, "Randomizer")
            self.workspace_tabs.addTab(self.ghost_page, "Build Order Ghost")
            layout.addWidget(self.workspace_tabs, 1)

        def _position_overlays(self):
            screen = self.screen()
            if screen is None:
                return
            area = screen.availableGeometry()
            opponent = self.overlays["opponent"]
            scouting = self.overlays["scouting"]
            opponent.move(area.right() - opponent.width() - 20, area.top() + 60)
            scouting.move(area.right() - scouting.width() - 20, area.top() + 300)

        def _job(self, channel, payload):
            if self._closed or not callable(handler):
                return
            self._sequence += 1
            request = self._sequence
            self._requests[channel] = request
            revision = self._preferences_revision
            mode_revision = self._mode_revision

            def work():
                try:
                    result = handler(payload)
                    if not isinstance(result, dict):
                        raise ValueError("The companion service returned an invalid response.")
                    response = {"result": result}
                except Exception as error:
                    response = {"error": str(error)}
                if self._closed:
                    return
                try:
                    self.completed.emit({"channel": channel, "request": request, "payload": payload,
                                         "revision": revision, "modeRevision": mode_revision, **response})
                except RuntimeError:
                    pass

            threading.Thread(target=work, name="companion-" + channel, daemon=True).start()

        def refresh(self):
            if "snapshot" not in self._requests:
                self._job("snapshot", {"action": "snapshot"})

        def refresh_library(self):
            self.refresh()
            self.build_selectors.refresh()
            self.randomizer_page.refresh()
            self.ghost_page.refresh()
            if self._paired and "directory" not in self._requests:
                self._job("directory", {"action": "opponents"})
            if self._paired and self._selected_id and "opponent" not in self._requests:
                self._job("opponent", {"action": "opponent", "pulseId": self._selected_id})

        def load_more(self):
            if self._paired and self._cursor and "directory" not in self._requests:
                self.load_more_button.setEnabled(False)
                self._job("directory", {"action": "opponents", "before": self._cursor})

        def _completed(self, response):
            if self._closed:
                return
            channel = response.get("channel")
            if self._requests.get(channel) != response.get("request"):
                return
            self._requests.pop(channel, None)
            payload = response["payload"]
            if channel == "modes_load":
                self.mode_controls.setEnabled(callable(handler))
                if not self._preference_busy:
                    for checkbox in self.preference_checks.values():
                        checkbox.setEnabled(callable(handler))
                if not response.get("error"):
                    result = response["result"]
                    if response.get("revision") == self._preferences_revision and not self._preference_busy:
                        self._apply_preferences(result.get("preferences") or {})
                    if response.get("modeRevision") == self._mode_revision and not self._mode_busy:
                        self._apply_modes(result.get("modes", self._modes), saved=True)
                    self._update_overlays()
                return
            if channel == "modes":
                self._mode_busy = False
                self._mode_revision += 1
                if not response.get("error"):
                    self._saved_modes = normalize_modes(response["result"].get("modes"))
                if self._modes_queued:
                    self._modes_queued = False
                    self._dispatch_modes()
                elif response.get("error"):
                    self._apply_modes(self._saved_modes)
                    self.mode_controls.save_status.setText("Mode settings were not saved. " + response["error"])
                    self.mode_controls.save_status.show()
                else:
                    self._apply_modes(self._saved_modes)
                    self.mode_controls.save_status.hide()
                return
            if channel == "preferences":
                self._preference_busy = False
                self._preferences_revision += 1
                if self._preferences_queued:
                    self._preferences_queued = False
                    self._dispatch_preferences()
                    return
                for checkbox in self.preference_checks.values():
                    checkbox.setEnabled(True)
            if response.get("error"):
                self.notice.setText("Could not update companion: " + response["error"])
                if channel == "snapshot":
                    self._snapshot_healthy = False
                    self.live_label.setText("Connection unavailable · retrying")
                    self._update_overlays()
                    self.randomizer_page.update_snapshot({"paired": False})
                    self.ghost_page.update_snapshot({"paired": False})
                if channel == "preferences":
                    self.notice.setText("Panel settings were not saved. Refresh to restore saved settings or try again. " + response["error"])
                if channel == "directory":
                    self.load_more_button.setEnabled(bool(self._cursor))
                if channel == "notes":
                    self._notes_changed()
                if channel == "ghost_reference":
                    self._update_ghost_reference_buttons()
                return
            result = response["result"]
            if channel == "snapshot":
                self._snapshot = result
                self._snapshot_healthy = True
                paired = bool(result.get("paired"))
                if self._paired and not paired:
                    self._clear_library()
                self._paired = paired
                self.refresh_button.setEnabled(paired)
                if response.get("revision") == self._preferences_revision and not self._preference_busy:
                    self._apply_preferences(result.get("preferences") or {})
                if response.get("modeRevision") == self._mode_revision and not self._mode_busy:
                    self._apply_modes(result.get("modes", self._modes), saved=True)
                active, context = _live_context(result)
                if not paired:
                    self.live_label.setText("Pair your agent on Dashboard to open your scouting library.")
                    self.notice.setText("Your companion uses the same account and replay library as this agent.")
                elif active:
                    self.live_label.setText(f"LIVE · {_name(context)} · {_time(context.get('elapsed'))} · historical scouting ready")
                else:
                    self.live_label.setText("Ready for your next match · browse your replay history below")
                if paired and not self._directory_loaded and "directory" not in self._requests:
                    self._job("directory", {"action": "opponents"})
                self._update_overlays()
                self.randomizer_page.update_snapshot(result)
                self.ghost_page.update_snapshot(result)
            elif channel == "directory":
                self._directory_loaded = True
                rows = result.get("items") or []
                if payload.get("before"):
                    known = {str(row.get("pulseId")) for row in self._opponents}
                    self._opponents.extend(row for row in rows if str(row.get("pulseId")) not in known)
                else:
                    self._opponents = rows
                self._cursor = result.get("nextCursor") or result.get("nextBefore")
                self.load_more_button.setEnabled(bool(self._cursor))
                self._filter_opponents()
                self.notice.setText(f"{len(self._opponents)} opponents loaded · search filters this library" if rows or self._opponents else "No opponents yet. Import replays with this agent to build your scouting library.")
            elif channel == "opponent":
                if str(payload.get("pulseId")) != self._selected_id:
                    return
                self._detail = result
                self._render_detail()
            elif channel == "notes":
                opponent_id = str(payload["pulseId"])
                draft = {"text": payload["text"], "readAloud": payload["readAloud"]}
                if self._drafts.get(opponent_id) == draft:
                    self._drafts.pop(opponent_id, None)
                if opponent_id == self._selected_id:
                    self._detail["notes"] = payload["text"]
                    self._detail["notesReadAloud"] = payload["readAloud"]
                    self.notice.setText("Scouting notes saved.")
                    self._notes_changed(track=False)
            elif channel == "preferences":
                self._apply_preferences(result.get("preferences", result))
                self.notice.setText("In-game panel preferences saved. Panels appear during matches; Preview lets you position them now.")
                self._update_overlays()
            elif channel == "ghost_reference":
                self.ghost_page.apply_account_result(result)
                self.ghost_page.refresh()
                self._update_ghost_reference_buttons()
                if payload.get("gameId") == self.game_select.currentData():
                    side = "Your build" if payload.get("side") == "you" else "Opponent's build"
                    self.notice.setText(side + (" reference cleared." if payload.get("clear") else " selected as the Ghost reference for this matchup."))

        def _clear_library(self):
            self._requests.pop("directory", None)
            self._requests.pop("opponent", None)
            self._requests.pop("notes", None)
            self._directory_loaded = False
            self._opponents = []
            self._selected_id = None
            self._detail = {}
            self._drafts.clear()
            self.opponent_list.clear()
            self._render_detail()

        def _filter_opponents(self):
            query = self.search.text().casefold().strip()
            blocked = QtCore.QSignalBlocker(self.opponent_list)
            self.opponent_list.clear()
            selected = None
            for row in self._opponents:
                if query and query not in (_name(row) + " " + str(row.get("race") or "")).casefold():
                    continue
                wins, losses = row.get("wins", 0), row.get("losses", 0)
                item = QtWidgets.QListWidgetItem(f"{_name(row)}\n{row.get('race') or 'Unknown race'}   ·   {wins}W / {losses}L")
                item.setData(QtCore.Qt.UserRole, str(row.get("pulseId") or ""))
                item.setIcon(icon(str(row.get("race") or ""), "race"))
                self.opponent_list.addItem(item)
                if item.data(QtCore.Qt.UserRole) == self._selected_id:
                    selected = item
            if selected:
                self.opponent_list.setCurrentItem(selected)
            del blocked
            visible = self.opponent_list.count()
            self.library_count.setText(f"{visible} of {len(self._opponents)} shown" if visible else "No opponents match this search" if self._opponents else "No opponents loaded")
            if self._selected_id is None and self.opponent_list.count():
                self.opponent_list.setCurrentRow(0)

        def _opponent_selected(self, item, previous=None):
            if item is None:
                return
            opponent_id = item.data(QtCore.Qt.UserRole)
            if not opponent_id or opponent_id == self._selected_id:
                return
            self._selected_id = opponent_id
            self._detail = {}
            self._render_detail()
            self.profile_title.setText(item.text().split("\n")[0])
            self.profile_summary.setText("Loading replay history…")
            self.notice.setText("Loading opponent scouting…")
            self._job("opponent", {"action": "opponent", "pulseId": opponent_id})

        def _render_detail(self):
            detail = self._detail
            self.profile_title.setText(_name(detail) if detail else "Choose an opponent")
            totals = detail.get("totals") or detail
            wins, losses = totals.get("wins"), totals.get("losses")
            pieces = [str(value) for value in [detail.get("race") or detail.get("oppRaceModal"), detail.get("region")] if value]
            if detail.get("mmr") is not None:
                pieces.append(str(detail["mmr"]) + " MMR")
            if wins is not None and losses is not None:
                pieces.append(f"Your record: {wins}W · {losses}L")
            self.profile_summary.setText("  ·  ".join(pieces) or "Select an opponent to browse shared replay history.")
            predictions = detail.get("predictedStrategies") or detail.get("topStrategies") or []
            self.tendencies.setText("Observed openings: " + " · ".join(str(row.get("name") or row.get("strategy") or "") for row in predictions[:3]) if predictions else "")
            self._games = detail.get("gamesScouting") or detail.get("last5GamesScouting") or []
            blocked = QtCore.QSignalBlocker(self.game_select)
            self.game_select.clear()
            for index, game in enumerate(self._games):
                self.game_select.addItem(_game_title(game, index), game.get("gameId"))
            self.game_select.setEnabled(bool(self._games))
            del blocked
            self._game_selected()
            self._rendering_notes = True
            draft = self._drafts.get(self._selected_id) or {"text": detail.get("notes") or "", "readAloud": bool(detail.get("notesReadAloud"))}
            self.notes.setPlainText(draft["text"])
            self.read_aloud.setChecked(draft["readAloud"])
            self.notes.setEnabled(bool(detail))
            self.read_aloud.setEnabled(bool(detail))
            self._rendering_notes = False
            self._notes_changed(track=False)
            if detail:
                self.notice.setText("Historical scouting · select a game to compare both sides. Timings become available after replay analysis.")
            self._update_overlays()

        def _game_selected(self):
            index = self.game_select.currentIndex()
            game = self._games[index] if 0 <= index < len(self._games) else {}
            self.build_labels.setText(_builds(game) if game else "No prior replay scouting available")
            self.game_summary.setText(f"{game.get('myRace') or 'You'} vs {game.get('oppRace') or 'Opponent'} · {_time(game.get('durationSec'))} · {game.get('map') or 'Unknown map'}" if game else "Import and analyze replays to see build orders, important tech steps, and their timings.")
            for key, sides in self.trees.items():
                for side, tree in sides.items():
                    fill_timeline(tree, _events(game, side, full=key == "build", upgrades=key == "upgrades"))
            transitions = []
            for side, title in [("my", "You"), ("opp", "Opponent")]:
                values = game.get(side + "Transitions") or {}
                text = " · ".join(f"{phase} {_time(values.get(field))}" for field, phase in [("earlyMidAt", "Early-mid"), ("midAt", "Mid"), ("midLateAt", "Mid-late"), ("lateAt", "Late")] if _time(values.get(field)) != "—")
                if text:
                    transitions.append(title + ": " + text)
            self.phase_summary.setText("\n".join(transitions))
            self._update_ghost_reference_buttons()

        def _ghost_references_changed(self, references):
            self._ghost_references = references if isinstance(references, dict) else {}
            self._update_ghost_reference_buttons()

        def _is_ghost_reference(self, side):
            game_id = self.game_select.currentData()
            return bool(game_id) and any(isinstance(reference, dict) and reference.get("side", "you") == side
                                        and (reference.get("gameId") or (reference.get("target") or {}).get("sourceGameId")) == game_id
                                        for reference in self._ghost_references.values())

        def _update_ghost_reference_buttons(self):
            game_id = self.game_select.currentData()
            for side, button in self.ghost_reference_buttons.items():
                title = "Use my build as Ghost" if side == "you" else "Use opponent's build as Ghost"
                button.setText(("★ " if self._is_ghost_reference(side) else "☆ ") + title)
                button.setEnabled(bool(game_id) and "ghost_reference" not in self._requests)

        def _save_ghost_reference(self, side):
            game_id = self.game_select.currentData()
            if game_id and "ghost_reference" not in self._requests:
                self._job("ghost_reference", {"action": "ghost_reference", "gameId": game_id,
                                               "side": side, "clear": self._is_ghost_reference(side)})
                self._update_ghost_reference_buttons()

        def _notes_changed(self, *_args, track=True):
            if self._rendering_notes:
                return
            text = self.notes.toPlainText()
            self.note_count.setText(f"{_note_length(text)} / 500")
            if track and self._selected_id and self._detail:
                self._drafts[self._selected_id] = {"text": text, "readAloud": self.read_aloud.isChecked()}
            self.save_notes_button.setEnabled(bool(self._detail) and _note_length(text) <= 500 and "notes" not in self._requests)

        def save_notes(self):
            if self._selected_id and self._detail and _note_length(self.notes.toPlainText()) <= 500 and "notes" not in self._requests:
                self.save_notes_button.setEnabled(False)
                self._job("notes", {"action": "save_notes", "pulseId": self._selected_id, "text": self.notes.toPlainText(), "readAloud": self.read_aloud.isChecked()})

        def _apply_preferences(self, preferences):
            for key in self._preferences:
                if isinstance(preferences.get(key), bool):
                    self._preferences[key] = preferences[key]
                blocked = QtCore.QSignalBlocker(self.preference_checks[key])
                self.preference_checks[key].setChecked(self._preferences[key])
                del blocked

        def set_preference(self, key, value):
            if self._closed or not callable(handler) or key not in self._preferences:
                return
            self._preferences[key] = bool(value)
            self._apply_preferences(self._preferences)
            self._preferences_revision += 1
            self._update_overlays()
            if self._preference_busy:
                self._preferences_queued = True
                return
            self._dispatch_preferences()

        def _dispatch_preferences(self):
            self._preference_busy = True
            for checkbox in self.preference_checks.values():
                checkbox.setEnabled(False)
            self._job("preferences", {"action": "preferences", "preferences": dict(self._preferences)})

        def _apply_modes(self, modes, *, saved=False):
            previous_hotkey = self._modes["hotkeyEnabled"]
            self._modes = normalize_modes(modes)
            self.mode_controls.set_state(self._modes)
            if saved:
                self._saved_modes = deepcopy(self._modes)
            if not self._modes_loaded or previous_hotkey != self._modes["hotkeyEnabled"]:
                self.hotkeyEnabledChanged.emit(self._modes["hotkeyEnabled"])
            self._modes_loaded = True
            self._update_overlays()

        def _modes_changed(self, modes):
            if self._closed or not callable(handler):
                return
            self._mode_revision += 1
            self._apply_modes(modes)
            if self._mode_busy:
                self._modes_queued = True
            else:
                self._dispatch_modes()

        def _dispatch_modes(self):
            self._mode_busy = True
            self.mode_controls.save_status.hide()
            self._job("modes", {"action": "companion_modes", "modes": deepcopy(self._modes)})

        def mode_gates(self):
            return effective_mode_features(self._modes, self._snapshot)

        def set_hotkey_status(self, status):
            self.mode_controls.hotkey_status.setText(str(status))
            self.mode_controls.hotkey_check.setToolTip(str(status))

        def _update_overlays(self, *_args):
            if not hasattr(self, "overlays"):
                return
            enabled = self.assistance_enabled()
            gates = self.mode_gates()
            caption = str(gates["mode"]).capitalize()
            self.build_selectors.set_assistance_enabled(enabled)
            self.build_selectors.set_feature_gates(gates)
            self.randomizer_page.set_assistance_enabled(enabled and gates["randomizer"],
                reason=f"{caption} preset keeps Randomizer guidance hidden; account settings stay saved." if enabled and not gates["randomizer"] else None)
            self.ghost_page.set_assistance_enabled(enabled and gates["ghost"],
                reason=f"{caption} preset hides 1v1 Ghost guidance; reference settings stay saved." if enabled and not gates["ghost"] else None)
            self.assistanceChanged.emit(enabled)
            self.modesChanged.emit(gates)
            blocked_pins = [kind for kind in ("opponent", "scouting")
                            if self._preferences[kind + "Overlay"] and not gates[kind + "Overlay"]]
            summary = self.mode_controls.summary()
            if blocked_pins:
                summary += " Pinned but hidden by preset: " + ", ".join(blocked_pins) + "."
            self.mode_controls.explanation.setText(summary)
            active, context = _live_context(self._snapshot)
            preview = self.preview_button.isChecked()
            if preview and not active:
                context = self._detail
            for kind, panel in self.overlays.items():
                visible = enabled and self._preferences[kind + "Overlay"] and gates[kind + "Overlay"] and (active or preview)
                if visible:
                    panel.update_context(context)
                    if not panel.isVisible():
                        panel.show()
                else:
                    panel.hide()

        def set_active(self, active):
            if active:
                self.refresh()
                self.build_selectors.refresh()

        def assistance_enabled(self):
            return bool(not self._closed and self._paired and self._snapshot_healthy
                        and self._preferences["overlaysEnabled"])

        def dispatch_build_checkin(self, method, args=()):
            if not self._closed:
                self.build_selectors.dispatch(method, args)

        def shutdown(self):
            if self._closed:
                return
            self._closed = True
            self.timer.stop()
            self._requests.clear()
            self.build_selectors.set_assistance_enabled(False)
            self.randomizer_page.shutdown()
            self.ghost_page.shutdown()
            for panel in self.overlays.values():
                panel.close()
                panel.deleteLater()

    return CompanionPage()

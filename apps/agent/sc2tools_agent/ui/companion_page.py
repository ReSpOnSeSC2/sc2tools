"""Interactive native scouting desk and optional in-game companion panels."""
from __future__ import annotations

from copy import deepcopy
import math
from pathlib import Path
import re
import threading
import time

from ..companion_modes import build_companion_modes, effective_mode_features, normalize_modes, verified_one_on_one
from .opponent_card import opponent_record


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
    if type(timestamp) not in {int, float} or not math.isfinite(timestamp) or not -5 <= time.time() - timestamp <= 30:
        active = False
    history = envelope.get("streamerHistory") or {}
    post = snapshot.get("live") or {}
    if active:
        if envelope.get("gameKey") and post.get("gameKey") == envelope.get("gameKey"):
            history = {**history, **post}
        opponent = envelope.get("opponent") or {}
        history_name = history.get("oppName")
        current_name = opponent.get("name")
        if not isinstance(current_name, str) or not current_name.strip():
            current_name = opponent.get("revealedName")
        mismatched_name = isinstance(history_name, str) and history_name.strip() and (not isinstance(current_name, str) or history_name.strip().casefold() != current_name.strip().casefold())
        if history.get("opponentIdentityMatched") is False or mismatched_name:
            history = {"opponentIdentityMatched": False}
        profile = opponent.get("profile") or {}
        return active, {
            **history,
            "name": opponent.get("revealedName") or opponent.get("name") or "Opponent resolving…",
            "race": opponent.get("race"),
            "mmr": profile.get("mmr"),
            "league": profile.get("league"), "region": profile.get("region"),
            "elapsed": envelope.get("displayTime"),
        }
    return False, post


def _icon_root():
    packaged = Path(__file__).resolve().parent / "assets" / "sc2"
    return packaged if packaged.is_dir() else Path(__file__).resolve().parents[3] / "web" / "public" / "icons" / "sc2"


def build_companion_page(parent, *, handler, QtCore, QtGui, QtWidgets,
                         checkin_controller_provider=None, speech_factory=None):
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
            if kind == "opponent":
                from .opponent_card import build_opponent_card
                layout.setContentsMargins(0, 0, 0, 0)
                self.identity_card = build_opponent_card(self, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, icon_root=icon_root)
                self.identity_card.enlargeRequested.connect(owner._enlarge_from_panel)
                layout.addWidget(self.identity_card)
                self.title.hide()
                self.subtitle.hide()
                self.detail.hide()
            if kind == "scouting":
                self.games = QtWidgets.QComboBox()
                self.games.currentIndexChanged.connect(self._game_changed)
                layout.addWidget(self.games)
                self.builds = label("", "Accent")
                layout.addWidget(self.builds)
                self.tree = timeline()
                self.tree.setHeaderLabels(["HISTORICAL TECH STEP", "TIME", "EVENT"])
                layout.addWidget(self.tree)
            self.resize(650 if kind == "scouting" else 360, 450 if kind == "scouting" else 190)
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
                self.identity_card.set_identity(name=_name(context) if context else None,
                                                race=context.get("race") or context.get("oppRace"),
                                                mmr=context.get("mmr", context.get("oppMmr")),
                                                wins=record.get("wins"), losses=record.get("losses"))
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
        densityChanged = QtCore.Signal(str)
        windowSizeRequested = QtCore.Signal(str)
        agentPageRequested = QtCore.Signal(str)

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
            self._preferences = {"overlaysEnabled": False, "opponentOverlay": False, "scoutingOverlay": False, "scoutingReadAloud": False}
            self._rendering_notes = False
            self._games = []
            self._game_selections = {}
            self._ghost_references = {}
            self._density = "full"
            self._return_density = None
            self._spoken_game_keys = []
            self._speech_game_key = None
            self._speech_pending_key = None
            self._speech_pending_at = None
            self._build_ui()
            from .companion_speech import build_scouting_speech
            self.scouting_speech = (speech_factory or build_scouting_speech)(self, QtCore=QtCore)
            self.scouting_speech.statusChanged.connect(self.voice_status.setText)
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
            layout.setContentsMargins(10, 10, 10, 10)
            layout.setSpacing(6)
            self.controls_page = QtWidgets.QScrollArea()
            self.controls_page.setWidgetResizable(True)
            self.controls_page.setFrameShape(QtWidgets.QFrame.NoFrame)
            controls_body = QtWidgets.QWidget()
            controls_layout = QtWidgets.QVBoxLayout(controls_body)
            controls_layout.setContentsMargins(12, 12, 12, 12)
            controls_layout.setSpacing(14)
            controls_layout.addWidget(label("ASSISTANCE SETTINGS", "Heading"))
            controls_layout.addWidget(label("Turn features on or off whenever you need. Your saved choices stay separate from the active mode.", "Muted"))
            self.window_size = QtWidgets.QComboBox()
            self.window_size.setObjectName("companionWindowSize")
            self.window_size.setAccessibleName("Window size")
            self.window_size.setToolTip("Choose an information layout and window size. Sizes fit your current screen; manual resizing keeps the current information layout.")
            from .window_sizes import WINDOW_SIZE_PRESETS
            for title, _density, _size in WINDOW_SIZE_PRESETS:
                self.window_size.addItem(title, title)
            self.window_size.addItem("Custom", "Custom")
            self.window_size.model().item(self.window_size.count() - 1).setEnabled(False)
            self.window_size.setCurrentIndex(self.window_size.findData("Custom"))
            self.window_size.activated.connect(lambda index: self.windowSizeRequested.emit(self.window_size.itemData(index)))
            self.refresh_button = QtWidgets.QPushButton("Refresh library")
            self.refresh_button.clicked.connect(self.refresh_library)
            self.window_size_notice = label("", "Muted")
            self.window_size_notice.hide()
            layout.addWidget(self.window_size_notice)
            self.live_label = label("Connecting to your agent…", "Accent")
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
            controls_layout.addLayout(controls)
            voice = QtWidgets.QCheckBox("Read scouting report aloud in Companion")
            voice.setEnabled(False)
            voice.toggled.connect(lambda value: self.set_preference("scoutingReadAloud", value))
            self.preference_checks["scoutingReadAloud"] = voice
            controls_layout.addWidget(voice)
            controls_layout.addWidget(label("Uses your Windows system voice without OBS. Reads current opponent information and notes marked for readout. Keep only one scouting voice enabled if you also use OBS.", "Muted"))
            voice_actions = QtWidgets.QHBoxLayout()
            self.read_report_button = QtWidgets.QPushButton("Read report now")
            self.read_report_button.setEnabled(False)
            self.read_report_button.clicked.connect(self._read_report_now)
            voice_actions.addWidget(self.read_report_button)
            self.stop_report_button = QtWidgets.QPushButton("Stop reading")
            self.stop_report_button.clicked.connect(self._stop_report)
            voice_actions.addWidget(self.stop_report_button)
            controls_layout.addLayout(voice_actions)
            self.voice_status = label("Spoken scouting is off.", "Muted")
            controls_layout.addWidget(self.voice_status)
            self.mode_controls = build_companion_modes(self, QtCore=QtCore, QtWidgets=QtWidgets)
            self.mode_controls.setEnabled(False)
            self.mode_controls.changed.connect(self._modes_changed)
            controls_layout.addWidget(self.mode_controls)
            self.notice = label("Loading your opponent library…", "Muted")
            controls_layout.addWidget(self.notice)
            controls_layout.addWidget(self.refresh_button)
            controls_layout.addStretch()
            self.controls_page.setWidget(controls_body)

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
            self.library_page = library
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
            profile.hide()
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
            self.notes_toggle = QtWidgets.QToolButton()
            self.notes_toggle.setText("Private scouting notes")
            self.notes_toggle.setCheckable(True)
            self.notes_toggle.setChecked(True)
            self.notes_toggle.setToolButtonStyle(QtCore.Qt.ToolButtonTextBesideIcon)
            self.notes_toggle.setArrowType(QtCore.Qt.DownArrow)
            body_layout.addWidget(self.notes_toggle)
            self.notes_section = QtWidgets.QWidget()
            notes_layout = QtWidgets.QVBoxLayout(self.notes_section)
            notes_layout.setContentsMargins(0, 0, 0, 0)
            self.notes_toggle.toggled.connect(self._toggle_notes_section)
            self.notes = QtWidgets.QPlainTextEdit()
            self.notes.setPlaceholderText("What should you remember next time you meet this opponent?")
            self.notes.setFixedHeight(82)
            self.notes.setEnabled(False)
            self.notes.textChanged.connect(self._notes_changed)
            notes_layout.addWidget(self.notes)
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
            notes_layout.addLayout(notes_actions)
            body_layout.addWidget(self.notes_section)
            body_layout.addStretch()
            scroll.setWidget(body)
            self.dossier = scroll
            self.workspace_tabs = QtWidgets.QTabWidget()
            self.scouting_stack = QtWidgets.QStackedWidget()
            self.scouting_stack.addWidget(self.dossier)
            self.workspace_tabs.addTab(self.scouting_stack, "Scouting")
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
            self._build_density_ui(layout)

        def _build_density_ui(self, layout):
            def children(source):
                result = []
                for index in range(source.count()):
                    item = source.itemAt(index)
                    if item.widget() is not None and item.widget() is not self.workspace_tabs:
                        result.append(item.widget())
                    elif item.layout() is not None:
                        result.extend(children(item.layout()))
                return result

            from .opponent_card import build_opponent_card
            self._normal_chrome = children(layout)
            self.compact_card = build_opponent_card(self, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, icon_root=icon_root)
            self.compact_name = self.compact_card.name_label
            self.compact_race = self.compact_card.race_label
            self.compact_mmr = self.compact_card.mmr_label
            self.compact_enlarge = self.compact_card.enlarge_button
            self.compact_card.enlargeRequested.connect(lambda: self.windowSizeRequested.emit("standard"))
            layout.addWidget(self.compact_card, 1)

            self.overview = QtWidgets.QScrollArea()
            self.overview.setWidgetResizable(True)
            self.overview.setFrameShape(QtWidgets.QFrame.NoFrame)
            self.overview.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
            overview_body = QtWidgets.QWidget()
            overview_body.setObjectName("companionContent")
            overview_layout = QtWidgets.QVBoxLayout(overview_body)
            overview_layout.setContentsMargins(0, 0, 0, 0)
            self.overview_recent = QtWidgets.QTreeWidget()
            self.overview_recent.setColumnCount(3)
            self.overview_recent.setHeaderLabels(["RECENT GAME", "YOUR BUILD", "OPPONENT BUILD"])
            self.overview_recent.setRootIsDecorated(False)
            self.overview_recent.header().setSectionResizeMode(0, QtWidgets.QHeaderView.Stretch)
            self.overview_recent.setMinimumHeight(160)
            self.plan_summary = QtWidgets.QWidget()
            plan_layout = QtWidgets.QVBoxLayout(self.plan_summary)
            plan_layout.setContentsMargins(0, 4, 0, 4)
            self.overview_plan = label("Current plan unavailable", "Accent")
            self.overview_ghost = label("Ghost is waiting for live telemetry", "Muted")
            self.overview_ghost.setMaximumHeight(36)
            plan_layout.addWidget(self.overview_plan)
            plan_layout.addWidget(self.overview_ghost)
            overview_layout.addWidget(self.plan_summary)
            open_details = QtWidgets.QPushButton("Open full details")
            open_details.clicked.connect(self.open_full_details)
            overview_layout.addWidget(open_details)
            self.overview.setWidget(overview_body)
            from .companion_build_chain import build_build_chain
            self.overview_dossier_title = label("SELECTED GAME · BUILD VS BUILD", "Heading")
            overview_layout.insertWidget(0, self.overview_dossier_title)
            self.build_chains = {}
            self.upgrade_chains = {}
            self.upgrade_headings = {}
            self.chain_labels = {}
            self.chain_reference_buttons = {}
            self.chain_cards = []
            chain_cards_body = QtWidgets.QWidget()
            self.chain_cards_layout = QtWidgets.QGridLayout(chain_cards_body)
            self.chain_cards_layout.setContentsMargins(0, 0, 0, 0)
            self.chain_cards_layout.setSpacing(10)
            overview_layout.insertWidget(1, chain_cards_body, 1)
            for position, (side, title) in enumerate((("my", "YOUR OPENING"), ("opp", "OPPONENT OPENING"))):
                card = QtWidgets.QFrame()
                card.setObjectName("companionCard")
                card_layout = QtWidgets.QVBoxLayout(card)
                card_layout.setContentsMargins(12, 12, 12, 12)
                card_layout.setSpacing(8)
                card_layout.addWidget(label(title, "Accent"))
                build_name = label("Unclassified build", "Heading")
                card_layout.addWidget(build_name)
                chain = build_build_chain(card, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, icon_provider=icon)
                card_layout.addWidget(chain, 1)
                upgrade_heading = label("UPGRADES · OBSERVED TIMINGS", "Accent")
                upgrade_chain = build_build_chain(card, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, icon_provider=icon)
                card_layout.addWidget(upgrade_heading)
                upgrade_chain.setMaximumHeight(180)
                card_layout.addWidget(upgrade_chain)
                self.upgrade_headings[side] = upgrade_heading
                self.upgrade_chains[side] = upgrade_chain
                star = QtWidgets.QPushButton("☆ Use this build as Ghost")
                chosen_side = "you" if side == "my" else "opponent"
                star.clicked.connect(lambda _checked=False, selected_side=chosen_side: self._save_ghost_reference(selected_side))
                card_layout.addWidget(star)
                self.build_chains[side] = chain
                self.chain_labels[side] = build_name
                self.chain_reference_buttons[chosen_side] = star
                self.chain_cards.append(card)
                self.chain_cards_layout.addWidget(card, position, 0)
            overview_layout.insertWidget(2, label("Replay observations · Started and Completed keep their original meaning.", "Muted"))
            self.scouting_stack.addWidget(self.overview)

            self.details_bar = QtWidgets.QWidget()
            details_layout = QtWidgets.QHBoxLayout(self.details_bar)
            details_layout.setContentsMargins(0, 0, 0, 0)
            self.details_caption = label("Detailed · both tech trees, upgrades and replay comparison", "Muted")
            details_layout.addWidget(self.details_caption, 1)
            self.full_details_button = QtWidgets.QPushButton("Open full details")
            self.full_details_button.clicked.connect(self.open_full_details)
            details_layout.addWidget(self.full_details_button)
            self.return_overview_button = QtWidgets.QPushButton("Return to overview")
            self.return_overview_button.clicked.connect(self._return_to_overview)
            details_layout.addWidget(self.return_overview_button)
            self.details_bar.hide()
            profile_body = QtWidgets.QWidget()
            profile_layout = QtWidgets.QVBoxLayout(profile_body)
            profile_layout.setContentsMargins(0, 0, 0, 0)
            self.profile_card = build_opponent_card(profile_body, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, icon_root=icon_root, layout="profile")
            self.profile_card.enlarge_button.hide()
            profile_layout.addWidget(self.profile_card)
            library_button = QtWidgets.QPushButton("Opponent library  ›")
            profile_layout.addWidget(library_button)
            encounters_button = QtWidgets.QPushButton("Previous encounters  ›")
            profile_layout.addWidget(encounters_button)
            profile_layout.addStretch()
            from .companion_console import build_companion_console
            self.console = build_companion_console(
                self, profile_widget=profile_body, workspace_tabs=self.workspace_tabs,
                opponents_widget=self.library_page, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
            )
            self.console.register_page("settings", self.controls_page, "Assistance settings")
            self.console.register_page("history", self.overview_recent, "Previous encounters")
            library_button.clicked.connect(lambda: self.console.navigate("opponents"))
            encounters_button.clicked.connect(lambda: self.console.navigate("history"))
            self.overview_recent.itemActivated.connect(lambda item, _column: self.console.navigate("scouting", opponent_id=self._selected_id, game_id=item.data(0, QtCore.Qt.UserRole)))
            self.overview_recent.itemClicked.connect(lambda item, _column: self.console.navigate("scouting", opponent_id=self._selected_id, game_id=item.data(0, QtCore.Qt.UserRole)))
            self.console.gameStepRequested.connect(self._step_game)
            self.console.playerStepRequested.connect(self._step_opponent)
            self.console.navigationChanged.connect(self._console_navigation_changed)
            self.opponent_list.itemClicked.connect(lambda item: self.console.navigate("scouting", opponent_id=item.data(QtCore.Qt.UserRole)))
            self.console.brand_actions.addWidget(self.window_size)
            self.voice_shortcut = QtWidgets.QPushButton("Voice off")
            self.voice_shortcut.setAccessibleName("Spoken scouting report")
            self.voice_shortcut.setCheckable(True)
            self.voice_shortcut.toggled.connect(lambda checked: self.set_preference("scoutingReadAloud", checked))
            self.voice_shortcut.setEnabled(callable(handler))
            self.console.brand_actions.addWidget(self.voice_shortcut)
            assistance_button = QtWidgets.QPushButton("Assistance")
            assistance_button.clicked.connect(lambda: self.console.navigate("settings"))
            self.console.brand_actions.addWidget(assistance_button)
            self.agent_menu_button = QtWidgets.QToolButton()
            self.agent_menu_button.setText("Agent")
            self.agent_menu_button.setAccessibleName("Agent pages and settings")
            self.agent_menu_button.setPopupMode(QtWidgets.QToolButton.InstantPopup)
            menu = QtWidgets.QMenu(self.agent_menu_button)
            for title, route in (("Dashboard", "dashboard"), ("Recent games", "recent"), ("Settings", "settings"), ("Streams", "streams"), ("Logs", "log")):
                menu.addAction(title, lambda _checked=False, destination=route: self.agentPageRequested.emit(destination))
            self.agent_menu_button.setMenu(menu)
            self.console.brand_actions.addWidget(self.agent_menu_button)
            layout.addWidget(self.console, 1)
            layout.addWidget(self.details_bar)
            layout.addWidget(self.live_label)
            self.console.navigate("scouting")
            self.set_density("full")

        def current_density(self):
            return self._density

        def set_density(self, level, *, temporary=False):
            if level not in ("compact", "standard", "detailed", "full"):
                level = "standard"
            changed = level != self._density
            self._density = level
            if not temporary:
                self._return_density = None
            compact = level == "compact"
            for widget in self._normal_chrome:
                widget.setVisible(not compact and (widget is not self.window_size_notice or bool(self.window_size_notice.text())))
            self.layout().setContentsMargins(0, 0, 0, 0) if compact else self.layout().setContentsMargins(8, 8, 8, 8)
            self.layout().setSpacing(6)
            self.compact_card.setVisible(compact)
            self.console.setVisible(not compact)
            self.live_label.setVisible(not compact)
            self.plan_summary.setVisible(level == "standard")
            self.scouting_stack.setCurrentWidget(self.dossier if level == "full" else self.overview)
            for index, card in enumerate(self.chain_cards):
                self.chain_cards_layout.addWidget(card, index if level == "standard" else 0, 0 if level == "standard" else index)
            for side in self.upgrade_chains:
                self.upgrade_chains[side].setVisible(level == "detailed")
                self.upgrade_headings[side].setVisible(level == "detailed")
                self.build_chains[side].setMinimumHeight(166)
            self.console.set_density(level)
            self.details_bar.setVisible(not compact and bool(self._return_density))
            self.full_details_button.hide()
            self.return_overview_button.setVisible(bool(self._return_density))
            self.details_caption.setText("Full details · your overview stays available" if self._return_density else
                                         "Detailed · both tech trees, upgrades and replay comparison")
            self.tabs.setTabVisible(1, level == "full")
            self.notes_toggle.setChecked(level == "full")
            self._toggle_notes_section(level == "full")
            self.ghost_page.set_density(level)
            self._render_information_layout()
            if changed:
                self.densityChanged.emit(level)

        def open_full_details(self):
            self._return_density = self._density if self._density in ("standard", "detailed") else None
            self.set_density("full", temporary=True)

        def _return_to_overview(self):
            self.set_density(self._return_density or "standard")

        def _toggle_notes_section(self, opened):
            self.notes_toggle.setArrowType(QtCore.Qt.DownArrow if opened else QtCore.Qt.RightArrow)
            self.notes_section.setVisible(opened)

        def _render_information_layout(self):
            if not hasattr(self, "compact_card"):
                return
            active, context = _live_context(self._snapshot)
            if not self._snapshot_healthy:
                active = False
            envelope = self._snapshot.get("liveGame") if isinstance(self._snapshot, dict) else None
            in_game = isinstance(envelope, dict) and envelope.get("phase") in {"match_loading", "match_started", "match_in_progress"} and envelope.get("isReplay") is not True
            stamp = envelope.get("receivedAt") if isinstance(envelope, dict) else None
            stamp = stamp / 1000 if type(stamp) in {int, float} else envelope.get("capturedAt") if isinstance(envelope, dict) else None
            if type(stamp) not in {int, float} or not math.isfinite(stamp) or not -5 <= time.time() - stamp <= 30:
                active = False
            if not active:
                context = {} if in_game else self._detail
            context = context if isinstance(context, dict) else {}
            direct = envelope.get("opponent") if active and isinstance(envelope.get("opponent"), dict) else None
            name = str(direct.get("revealedName") or direct.get("name") or "—") if direct is not None else str(context.get("revealedName") or context.get("name") or context.get("displayName") or context.get("displayNameSample") or "—")
            race = context.get("race") or context.get("oppRace") or context.get("oppRaceModal") or "—"
            mmr = context.get("mmr", context.get("oppMmr"))
            if direct is not None:
                race = direct.get("race") or "—"
                profile = direct.get("profile") if isinstance(direct.get("profile"), dict) else {}
                mmr = profile.get("mmr")
            race = {"p": "Protoss", "protoss": "Protoss", "t": "Terran", "terran": "Terran", "z": "Zerg", "zerg": "Zerg", "r": "Random", "random": "Random"}.get(str(race).strip().lower(), "—")
            record = context.get("headToHead") or context.get("totals") or {}
            record = record if isinstance(record, dict) else {}
            self.compact_card.set_identity(name=name, race=race, mmr=mmr, wins=record.get("wins"), losses=record.get("losses"))
            self.compact_card.setToolTip("Current live opponent" if active else "Opponent telemetry unavailable" if in_game else "Selected opponent profile")
            games = self._games
            selected = self.game_select.currentData()
            game = next((row for row in games if isinstance(row, dict) and row.get("gameId") == selected), games[0] if games else {})
            for side, key in (("my", "myBuild"), ("opp", "oppStrategy")):
                build_name = game.get(key) or (game.get("oppBuild") if side == "opp" else None)
                self.chain_labels[side].setText(str(build_name or "Unclassified build"))
                self.build_chains[side].set_events(_events(game, side), limit=4 if self._density == "standard" else 8)
                self.build_chains[side].set_density(self._density)
                self.upgrade_chains[side].set_events(_events(game, side, upgrades=True), limit=8)
            self.overview_dossier_title.setText("BUILD VS BUILD · " + (str(game.get("map") or "Unknown map") if game else "SELECT A REPLAY"))
            recent_rows = []
            for index, recent in enumerate(games):
                if isinstance(recent, dict):
                    recent_rows.append((recent.get("gameId"), _game_title(recent, index), str(recent.get("myBuild") or "Unclassified"), str(recent.get("oppStrategy") or "Unclassified")))
            recent_signature = tuple(recent_rows)
            if recent_signature != getattr(self, "_recent_signature", None):
                current_item = self.overview_recent.currentItem()
                current_id = current_item.data(0, QtCore.Qt.UserRole) if current_item is not None else selected
                vertical_position = self.overview_recent.verticalScrollBar().value()
                horizontal_position = self.overview_recent.horizontalScrollBar().value()
                blocked = QtCore.QSignalBlocker(self.overview_recent)
                self.overview_recent.clear()
                previous_item = None
                selected_item = None
                for game_id, *columns in recent_rows:
                    item = QtWidgets.QTreeWidgetItem(columns)
                    item.setData(0, QtCore.Qt.UserRole, game_id)
                    self.overview_recent.addTopLevelItem(item)
                    if game_id == current_id:
                        previous_item = item
                    if game_id == selected:
                        selected_item = item
                if previous_item is not None or selected_item is not None:
                    self.overview_recent.setCurrentItem(previous_item if previous_item is not None else selected_item)
                self.overview_recent.doItemsLayout()
                self.overview_recent.verticalScrollBar().setValue(vertical_position)
                self.overview_recent.horizontalScrollBar().setValue(horizontal_position)
                self._recent_signature = recent_signature
                del blocked
            loading = self.build_selectors.loading_model
            key = envelope.get("gameKey") if isinstance(envelope, dict) else None
            plan = (getattr(loading, "locked_label", None) or getattr(loading, "current_pick_label", None)) if active and loading is not None and loading.game_key == key else None
            self.overview_plan.setText("Current plan · " + str(plan) if plan else "No current plan selected")
            ghost_summary = self.ghost_page.overview_summary(1)
            self.overview_ghost.setText(ghost_summary)
            self.overview_ghost.setToolTip(ghost_summary)
            if hasattr(self, "console"):
                self.console.set_game_navigation(self.game_select.currentIndex(), len(self._games), self.game_select.currentText())
                self.console.set_player_navigation(self.opponent_list.currentRow(), self.opponent_list.count())
                self.console.set_breadcrumb(opponent_name=_name(self._detail) if self._detail else "", game_title=str(game.get("map") or ""))

        def _step_game(self, step):
            index = self.game_select.currentIndex() + step
            if 0 <= index < self.game_select.count():
                self.console.navigate("scouting", opponent_id=self._selected_id, game_id=self.game_select.itemData(index))

        def _enlarge_from_panel(self):
            self.windowSizeRequested.emit("standard")
            self.console.navigate("scouting")
            self.window().showNormal()
            self.window().raise_()
            self.window().activateWindow()

        def _step_opponent(self, step):
            index = self.opponent_list.currentRow() + step
            if 0 <= index < self.opponent_list.count():
                item = self.opponent_list.item(index)
                self.console.navigate("scouting", opponent_id=item.data(QtCore.Qt.UserRole))

        def _console_navigation_changed(self, entry):
            opponent_id = entry.get("opponentId")
            game_id = entry.get("gameId")
            if opponent_id and game_id:
                self._game_selections[opponent_id] = game_id
            if opponent_id and opponent_id != self._selected_id:
                for index in range(self.opponent_list.count()):
                    item = self.opponent_list.item(index)
                    if item.data(QtCore.Qt.UserRole) == opponent_id:
                        self.opponent_list.setCurrentItem(item)
                        return
                self.console.set_context(opponent_id=self._selected_id, game_id=self.game_select.currentData())
            elif game_id:
                index = self.game_select.findData(game_id)
                if index >= 0:
                    self.game_select.setCurrentIndex(index)

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

        def set_window_size_label(self, title):
            index = self.window_size.findData(title)
            blocked = QtCore.QSignalBlocker(self.window_size)
            self.window_size.setCurrentIndex(index if index >= 0 else self.window_size.findData("Custom"))
            del blocked

        def set_window_size_notice(self, message):
            self.window_size_notice.setText(message)
            compact = hasattr(self, "current_density") and self.current_density() == "compact"
            self.window_size_notice.setVisible(bool(message) and not compact)
            self.window_size.setToolTip(message or "Choose an information layout and window size. Sizes fit your current screen; manual resizing keeps the current information layout.")
            if hasattr(self, "compact_enlarge"):
                self.compact_enlarge.setToolTip(message or "Enlarge Companion · Standard view")
                if compact and message:
                    QtWidgets.QToolTip.showText(self.compact_enlarge.mapToGlobal(QtCore.QPoint(0, self.compact_enlarge.height())), message, self.compact_enlarge)

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
                self._render_information_layout()
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
            self._game_selections.clear()
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
                record = opponent_record(row.get("wins"), row.get("losses"))
                item = QtWidgets.QListWidgetItem(f"{_name(row)}\n{row.get('race') or 'Unknown race'}   ·   {record['text']}")
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
            selected_row = next((row for row in self._opponents if str(row.get("pulseId")) == self._selected_id), {})
            self.profile_card.set_identity(name=_name(detail) if detail else _name(selected_row) if selected_row else None,
                                           race=detail.get("race") or detail.get("oppRaceModal") or selected_row.get("race"),
                                           mmr=detail.get("mmr"), wins=wins, losses=losses)
            predictions = detail.get("predictedStrategies") or detail.get("topStrategies") or []
            self.tendencies.setText("Observed openings: " + " · ".join(str(row.get("name") or row.get("strategy") or "") for row in predictions[:3]) if predictions else "")
            self._games = detail.get("gamesScouting") or detail.get("last5GamesScouting") or []
            blocked = QtCore.QSignalBlocker(self.game_select)
            self.game_select.clear()
            for index, game in enumerate(self._games):
                self.game_select.addItem(_game_title(game, index), game.get("gameId"))
            selected_game = self.game_select.findData(self._game_selections.get(self._selected_id))
            if selected_game >= 0:
                self.game_select.setCurrentIndex(selected_game)
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
            if self._selected_id and game.get("gameId"):
                self._game_selections[self._selected_id] = game["gameId"]
            if hasattr(self, "console"):
                self.console.set_context(opponent_id=self._selected_id, game_id=game.get("gameId"))
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
            self._render_information_layout()
            self._update_speech()

        def _update_speech(self):
            if not hasattr(self, "scouting_speech"):
                return
            active, context = _live_context(self._snapshot)
            envelope = self._snapshot.get("liveGame") or {}
            game_key = envelope.get("gameKey")
            permitted = self.assistance_enabled() and self._preferences["scoutingReadAloud"] and self.mode_gates()["scoutingReadAloud"]
            opponent = envelope.get("opponent") or {}
            known_identity = any(isinstance(value, str) and value.strip() for value in (opponent.get("revealedName"), opponent.get("name")))
            current = bool(active and known_identity and isinstance(game_key, str) and game_key.strip() and verified_one_on_one(self._snapshot))
            self.read_report_button.setEnabled(permitted and current)
            self.voice_shortcut.setToolTip("Desktop scouting voice. Turn off to stop reading immediately. OBS speech is a separate setting." if permitted else
                                           "Desktop scouting voice is off or hidden by the master switch or active mode. Open Assistance to change it.")
            if not permitted or not current:
                if self._speech_game_key is not None or self._speech_pending_key is not None:
                    self._stop_report()
                self.voice_status.setText("Spoken scouting is off." if not self._preferences["scoutingReadAloud"] else
                                          "Spoken scouting is hidden by the master switch or active mode." if not permitted else
                                          "Waiting for a fresh human 1v1 opponent. Browsing history does not trigger speech.")
                return
            if self._speech_game_key is not None and self._speech_game_key != game_key:
                self._stop_report()
            if envelope.get("phase") not in {"match_started", "match_in_progress"}:
                self.voice_status.setText("Spoken scouting is ready for the game to start.")
                return
            if game_key not in self._spoken_game_keys:
                if self._speech_pending_key != game_key:
                    self._speech_pending_key = game_key
                    self._speech_pending_at = time.monotonic()
                history = envelope.get("streamerHistory")
                enriched = isinstance(history, dict) and (isinstance(history.get("headToHead"), dict) or type(history.get("opponentIdentityMatched")) is bool)
                if not enriched and time.monotonic() - self._speech_pending_at < 6:
                    self.voice_status.setText("Preparing the scouting report · waiting briefly for your opponent history.")
                    return
                self._spoken_game_keys = (self._spoken_game_keys + [game_key])[-128:]
                self._speech_pending_key = None
                self._speech_pending_at = None
                self._speak_report(context, game_key)

        def _speak_report(self, context, game_key):
            from .companion_speech import build_scouting_report
            if self.scouting_speech.speak(build_scouting_report(context)):
                self._speech_game_key = game_key

        def _read_report_now(self):
            active, context = _live_context(self._snapshot)
            envelope = self._snapshot.get("liveGame") or {}
            opponent = envelope.get("opponent") or {}
            game_key = envelope.get("gameKey")
            identity_ready = any(isinstance(value, str) and value.strip() for value in (opponent.get("revealedName"), opponent.get("name")))
            allowed = self.assistance_enabled() and self._preferences["scoutingReadAloud"] and self.mode_gates()["scoutingReadAloud"]
            if allowed and active and identity_ready and isinstance(game_key, str) and game_key.strip() and verified_one_on_one(self._snapshot):
                if game_key not in self._spoken_game_keys:
                    self._spoken_game_keys = (self._spoken_game_keys + [game_key])[-128:]
                self._speech_pending_key = None
                self._speech_pending_at = None
                self._speak_report(context, game_key)

        def _stop_report(self):
            if hasattr(self, "scouting_speech"):
                self.scouting_speech.stop()
            if self._speech_pending_key is not None and self._speech_pending_key not in self._spoken_game_keys:
                self._spoken_game_keys = (self._spoken_game_keys + [self._speech_pending_key])[-128:]
            self._speech_pending_key = None
            self._speech_pending_at = None
            self._speech_game_key = None

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
                chain_button = self.chain_reference_buttons[side]
                chain_button.setText(("★ " if self._is_ghost_reference(side) else "☆ ") + "Use this build as Ghost")
                chain_button.setEnabled(button.isEnabled())

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
            blocked = QtCore.QSignalBlocker(self.voice_shortcut)
            self.voice_shortcut.setChecked(self._preferences["scoutingReadAloud"])
            self.voice_shortcut.setText("Voice on" if self._preferences["scoutingReadAloud"] else "Voice off")
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
            self._render_information_layout()
            self._update_speech()

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
                self._render_information_layout()

        def shutdown(self):
            if self._closed:
                return
            self._closed = True
            self.timer.stop()
            self.scouting_speech.shutdown()
            self._requests.clear()
            self.build_selectors.set_assistance_enabled(False)
            self.randomizer_page.shutdown()
            self.ghost_page.shutdown()
            for panel in self.overlays.values():
                panel.close()
                panel.deleteLater()

    return CompanionPage()

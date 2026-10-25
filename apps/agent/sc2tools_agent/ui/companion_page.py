"""Interactive native scouting desk and optional in-game companion panels."""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
import math
import re
import threading
import time

from ..companion_modes import build_companion_modes, effective_mode_features, normalize_modes, verified_one_on_one
from ..team_roster import TeamRoster, TEAM_FEATURES, roster_candidate
from .opponent_card import opponent_record
from .companion_build_chain import TIME_RANGES
from .sc2_icons import icon_root as _icon_root, icon_token as _icon_token, load_icon
from . import theme


_STYLE = f"""
QWidget#companionDesk, QWidget#companionContent, QWidget#companionPanel {{ background: {theme.BG}; color: {theme.TEXT}; }}
QWidget#companionDesk[textOverlay="true"], QWidget#companionPanel[textOverlay="true"] {{ background: transparent; border: none; }}
QWidget#companionDesk QLabel, QWidget#companionPanel QLabel {{ color: {theme.TEXT}; background: transparent; }}
QFrame#companionCard {{ background: {theme.SURFACE}; border: 1px solid {theme.BORDER_STRONG}; border-radius: 12px; }}
QLabel#companionTitle {{ font-size: 25px; font-weight: 700; color: {theme.TEXT}; }}
QLabel#companionHeading {{ font-size: 17px; font-weight: 650; color: {theme.TEXT}; }}
QLabel#companionMuted {{ color: {theme.TEXT_MUTED}; font-size: 12px; }}
QLabel#companionAccent {{ color: {theme.ACCENT_CYAN}; font-size: 12px; font-weight: 600; }}
QWidget#companionDesk QLineEdit, QWidget#companionDesk QPlainTextEdit,
QWidget#companionDesk QComboBox, QWidget#companionPanel QComboBox {{
    background: {theme.ELEVATED}; color: {theme.TEXT}; border: 1px solid {theme.BORDER_STRONG}; border-radius: 6px; padding: 7px;
}}
QWidget#companionDesk QPushButton, QWidget#companionPanel QPushButton {{
    background: {theme.BUTTON}; color: {theme.TEXT}; border: 1px solid {theme.BORDER_STRONG}; border-radius: 6px; padding: 7px 12px;
}}
QWidget#companionDesk QPushButton:hover, QWidget#companionPanel QPushButton:hover {{ background: {theme.BUTTON_HOVER}; border-color: {theme.ACCENT_HOVER}; }}
QWidget#companionDesk QPushButton:checked {{ background: {theme.BUTTON_CHECKED}; border-color: {theme.ACCENT_HOVER}; }}
QWidget#companionDesk QPushButton:focus, QWidget#companionPanel QPushButton:focus {{ border-color: {theme.FOCUS}; }}
QWidget#companionDesk QPushButton:disabled {{ color: {theme.TEXT_DIM}; border-color: {theme.BORDER}; background: {theme.ELEVATED}; }}
QWidget#companionDesk QCheckBox, QWidget#companionPanel QCheckBox {{ color: {theme.TEXT}; spacing: 8px; }}
QWidget#companionDesk QTreeWidget, QWidget#companionDesk QListWidget, QWidget#companionPanel QTreeWidget {{
    background: {theme.SURFACE}; alternate-background-color: {theme.ELEVATED}; color: {theme.TEXT};
    border: 1px solid {theme.BORDER_STRONG}; border-radius: 7px; outline: none;
}}
QWidget#companionDesk QTreeWidget::item, QWidget#companionPanel QTreeWidget::item {{ padding: 6px 3px; }}
QWidget#companionDesk QListWidget::item {{ padding: 12px 7px; border-bottom: 1px solid {theme.BORDER}; }}
QWidget#companionDesk QListWidget::item:selected {{ background: {theme.BUTTON_CHECKED}; color: {theme.TEXT}; }}
QWidget#companionDesk QHeaderView::section, QWidget#companionPanel QHeaderView::section {{
    background: {theme.SUBTLE}; color: {theme.TEXT_MUTED}; padding: 7px; border: none; font-size: 11px;
}}
QWidget#companionDesk QTabWidget::pane {{ border: 1px solid {theme.BORDER_STRONG}; border-radius: 6px; }}
QWidget#companionDesk QTabBar::tab {{ background: {theme.SURFACE}; color: {theme.TEXT_MUTED}; padding: 9px 14px; }}
QWidget#companionDesk QTabBar::tab:selected {{ background: {theme.BUTTON_CHECKED}; color: {theme.TEXT}; }}
"""

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


_WORKER_SUPPLY_NAMES = {
    "drone", "scv", "probe", "mule", "larva", "overlord", "overlordtransport",
    "overlordcocoon", "pylon", "supplydepot", "supplydepotlowered",
}
_MORPH_BUILDING_NAMES = {"lair", "hive", "greaterspire", "orbitalcommand", "planetaryfortress", "warpgate", "warpgateresearch"}


def _stored_build_events(payload, side):
    events = []
    for row in payload["events" if side == "my" else "opp_events"]:
        if not isinstance(row, dict) or not isinstance(row.get("name"), str) or not row["name"].strip():
            continue
        category = row.get("category")
        kind = "building" if row.get("is_building") is True else category if category in {"building", "unit", "upgrade"} else "unknown"
        if "complete_time" in row:
            stamp, timing = row["complete_time"], "completed"
        else:
            stamp = row.get("time")
            morph = re.sub(r"[^a-z0-9]", "", row["name"].lower()) in _MORPH_BUILDING_NAMES
            timing = "started" if kind == "building" and not morph else "recorded"
        events.append({
            "name": row["name"], "kind": kind, "timing": timing,
            "timeSec": stamp if _time(stamp) != "—" else None,
        })
    return sorted(events, key=lambda row: row["timeSec"] if row["timeSec"] is not None else float("inf"))


def _filter_build_events(events, *, include_workers_supply, horizon=None):
    return [event for event in events
            if (include_workers_supply or re.sub(r"[^a-z0-9]", "", event["name"].lower()) not in _WORKER_SUPPLY_NAMES)
            and (horizon is None or (_time(event.get("timeSec")) != "—" and event["timeSec"] <= horizon))]


def _history_exposed(widget):
    return widget.isVisible() and not widget.window().isMinimized()


def _history_source_signature(game, stored):
    if stored is not None:
        return ("stored", id(stored))
    def rows_for(name):
        rows = game.get(name)
        return rows if isinstance(rows, (list, tuple)) else ()
    return ("preview", tuple(tuple(tuple(row.get(field) for field in
            ("name", "timeSec", "time", "kind", "category", "timing"))
            for row in rows_for(name) if isinstance(row, dict))
            for name in ("myTechMilestones", "oppTechMilestones", "myBuildOrder", "oppBuildOrder")))


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


def build_companion_page(parent, *, handler, QtCore, QtGui, QtWidgets,
                         checkin_controller_provider=None, speech_factory=None,
                         panel_positions=None, on_panel_positions=None, agent_menu=None):
    """Build a lazy-Qt page; all handler calls run in daemon workers."""
    icon_root = _icon_root()

    def label(text, kind="", parent=None):
        widget = QtWidgets.QLabel(text, parent)
        widget.setTextFormat(QtCore.Qt.PlainText)
        widget.setWordWrap(True)
        if kind:
            widget.setObjectName("companion" + kind)
        return widget

    class SourceStatus(QtWidgets.QLabel):
        def __init__(self):
            super().__init__()
            self.setObjectName("companionMuted")
            self.setTextFormat(QtCore.Qt.PlainText)
            self.setWordWrap(False)
            self.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Fixed)
            self.setFixedHeight(18)
            self.full_text = ""

        def setText(self, text):
            self.full_text = text
            self.setToolTip(text)
            self.setAccessibleDescription(text)
            self._elide()

        def _elide(self):
            super().setText(self.fontMetrics().elidedText(self.full_text, QtCore.Qt.ElideRight, max(1, self.width())))

        def resizeEvent(self, event):
            super().resizeEvent(event)
            self._elide()

    def icon(name, kind):
        return load_icon(name, kind, QtGui=QtGui, root=icon_root)

    def timeline(minimum_height=245):
        tree = QtWidgets.QTreeWidget()
        tree.setColumnCount(3)
        tree.setHeaderLabels(["TECH / UNIT", "TIME", "EVENT"])
        tree.setRootIsDecorated(False)
        tree.setAlternatingRowColors(True)
        tree.setIconSize(QtCore.QSize(30, 30))
        tree.setMinimumHeight(minimum_height)
        tree.header().setSectionResizeMode(0, QtWidgets.QHeaderView.Stretch)
        tree.header().setSectionResizeMode(1, QtWidgets.QHeaderView.ResizeToContents)
        tree.header().setSectionResizeMode(2, QtWidgets.QHeaderView.ResizeToContents)
        return tree

    def fill_timeline(tree, events):
        signature = tuple((event["name"], event.get("timeSec"), event["kind"], event["timing"]) for event in events)
        if getattr(tree, "_companion_signature", None) == signature:
            return
        tree._companion_signature = signature
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
            flags = QtCore.Qt.Tool | QtCore.Qt.WindowStaysOnTopHint | QtCore.Qt.FramelessWindowHint
            super().__init__(None, flags)
            self.owner = owner
            self.kind = kind
            self.setProperty("textOverlay", kind == "opponent")
            if kind == "opponent":
                self.setAttribute(QtCore.Qt.WA_TranslucentBackground)
            self._context = {}
            self._scope = None
            self._source_id = None
            self._key = None
            self._games = []
            self._render_signature = None
            self._render_source = None
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
                self.identity_card.scoutingRequested.connect(owner._toggle_scouting_panel)
                if hasattr(self.identity_card, "minimizeRequested"):
                    self.identity_card.minimizeRequested.connect(self.showMinimized)
                if hasattr(self.identity_card, "closeRequested"):
                    self.identity_card.closeRequested.connect(self.close)
                layout.addWidget(self.identity_card)
                self.title.hide()
                self.subtitle.hide()
                self.detail.hide()
            if kind == "scouting":
                from .window_chrome import build_window_controls
                layout.setContentsMargins(32, 30, 32, 28)
                layout.removeWidget(self.title)
                self.header = QtWidgets.QFrame(self)
                header_layout = QtWidgets.QHBoxLayout(self.header)
                header_layout.setContentsMargins(0, 0, 0, 0)
                header_layout.addWidget(self.title, 1)
                self.window_controls = build_window_controls(self.header, window=self, QtCore=QtCore, QtWidgets=QtWidgets)
                self.window_controls.maximize_button.hide()
                header_layout.addWidget(self.window_controls)
                layout.insertWidget(0, self.header)
                layout.removeWidget(self.subtitle)
                layout.removeWidget(self.detail)
                self.scouting_scroll = QtWidgets.QScrollArea()
                self.scouting_scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
                self.scouting_scroll.setWidgetResizable(True)
                self.scouting_scroll.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
                self.scouting_scroll.setAccessibleName("Historical scouting builds and tech steps")
                body = QtWidgets.QWidget()
                body.setObjectName("companionContent")
                body_layout = QtWidgets.QVBoxLayout(body)
                body_layout.setContentsMargins(0, 0, 0, 0)
                body_layout.setSizeConstraint(QtWidgets.QLayout.SetMinimumSize)
                body_layout.addWidget(self.subtitle)
                body_layout.addWidget(self.detail)
                self.games = QtWidgets.QComboBox()
                self.games.currentIndexChanged.connect(self._game_changed)
                body_layout.addWidget(self.games)
                from .qt_helpers import build_flow_layout
                controls = QtWidgets.QWidget()
                actions = build_flow_layout(controls, QtCore=QtCore, QtWidgets=QtWidgets)
                actions.addWidget(label("Range", "Muted"))
                self.build_time_range = QtWidgets.QComboBox()
                self.build_time_range.setAccessibleName("Scouting panel build order time range")
                for title, seconds in TIME_RANGES:
                    self.build_time_range.addItem(title, seconds)
                self.build_time_range.currentIndexChanged.connect(self._range_changed)
                actions.addWidget(self.build_time_range)
                self.options_button = QtWidgets.QToolButton()
                self.options_button.setText("Options")
                self.options_button.setPopupMode(QtWidgets.QToolButton.InstantPopup)
                options = QtWidgets.QMenu(self.options_button)
                self.include_workers_supply = QtWidgets.QCheckBox("Include workers and supply")
                option = QtWidgets.QWidgetAction(options)
                option.setDefaultWidget(self.include_workers_supply)
                options.addAction(option)
                self.options_button.setMenu(options)
                self.include_workers_supply.toggled.connect(self._range_changed)
                actions.addWidget(self.options_button)
                self.retry = QtWidgets.QPushButton("Retry")
                self.retry.clicked.connect(lambda: owner._retry_build_order(self._key))
                self.retry.hide()
                actions.addWidget(self.retry)
                body_layout.addWidget(controls)
                self.source_status = SourceStatus()
                body_layout.addWidget(self.source_status)
                self.comparison_title = label("BUILD VS BUILD", "Heading")
                body_layout.addWidget(self.comparison_title)
                from .companion_scouting import build_scouting_comparison
                self.comparison = build_scouting_comparison(body, QtCore=QtCore, QtGui=QtGui,
                                                            QtWidgets=QtWidgets, icon_provider=icon)
                self.comparison.ghostRequested.connect(self._save_reference)
                body_layout.addWidget(self.comparison, 1)
                self.observation_note = label("Replay observations · Started and Completed keep their original meaning.", "Muted")
                body_layout.addWidget(self.observation_note)
                self.scouting_scroll.setWidget(body)
                layout.addWidget(self.scouting_scroll, 1)
                from .qt_helpers import guard_value_widgets
                guard_value_widgets(self.scouting_scroll, QtCore, QtWidgets)
            if kind == "opponent":
                from .window_sizes import minimum_window_size
                self.setMinimumSize(*minimum_window_size("compact"))
                self.resize(self.identity_card.sizeHint().expandedTo(self.minimumSize()))
            else:
                self.setMinimumSize(420, 300)
                self.resize(650, 450)
            from .race_visuals import create_race_effects
            from .window_chrome import install_window_interactions
            self._race_effects = create_race_effects(self, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
            self._window_interactions = install_window_interactions(
                self, drag_widgets=[self.identity_card if kind == "opponent" else self.header],
                QtCore=QtCore, QtWidgets=QtWidgets, can_maximize=lambda: False,
            )
            self._signature = None

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
            if self.kind == "opponent":
                self.identity_card.set_skin(skin)
            self._race_effects.apply_skin(skin)
            self._race_effects.set_motion_enabled(animations)

        def closeEvent(self, event):
            if not self.owner._closed:
                if self.kind == "scouting":
                    self.owner._manual_scouting_open = False
                    self.owner._manual_scouting_dismissed = True
                self.owner.set_preference(self.kind + "Overlay", False)
            event.accept()

        def showEvent(self, event):
            super().showEvent(event)
            if self.kind == "scouting":
                QtCore.QTimer.singleShot(0, self._hydrate_history)

        def changeEvent(self, event):
            super().changeEvent(event)
            if self.kind == "scouting" and event.type() == QtCore.QEvent.WindowStateChange:
                QtCore.QTimer.singleShot(0, self._hydrate_history)

        def _hydrate_history(self):
            if not self.owner._closed and _history_exposed(self):
                self.render_build_data()
                self.owner._ensure_build_order()

        def clear_history(self):
            self._render_signature = self._render_source = None
            for side in ("my", "opp"):
                self.comparison.set_side(side, None, [], self.build_time_range.currentData())

        def update_context(self, context, *, scope=None):
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
            self._context = context
            scope = scope if scope is not None else (context.get("pulseId"), _name(context))
            changed = scope != self._scope
            self._scope = scope
            self._source_id = str(context.get("pulseId") or ("live:" + repr(scope)))
            self.detail.setText("Previous games against this opponent · replay timings")
            games = context.get("last5GamesScouting") or []
            if changed or games != self._games:
                selected = None if changed else self.games.currentData()
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
            self.render_build_data()

        def _game_changed(self):
            index = self.games.currentIndex()
            game = self._games[index] if 0 <= index < len(self._games) else {}
            self._key = (self._source_id, str(game["gameId"])) if game.get("gameId") else None
            self.render_build_data()
            self.owner._ensure_build_order()

        def _range_changed(self, *_args):
            horizon = self.build_time_range.currentData()
            self.owner.build_time_range.setCurrentIndex(self.owner.build_time_range.findData(horizon))
            self.owner.include_workers_supply.setChecked(self.include_workers_supply.isChecked())
            self.render_build_data()

        def sync_options(self, horizon, include_supply):
            blocked_range = QtCore.QSignalBlocker(self.build_time_range)
            blocked_supply = QtCore.QSignalBlocker(self.include_workers_supply)
            self.build_time_range.setCurrentIndex(self.build_time_range.findData(horizon))
            self.include_workers_supply.setChecked(include_supply)
            del blocked_range, blocked_supply
            self.render_build_data()

        def _save_reference(self, side):
            if self._key:
                self.owner._save_ghost_reference_for(self._key[1], side)

        def render_build_data(self):
            if self.kind != "scouting":
                return
            index = self.games.currentIndex()
            game = self._games[index] if 0 <= index < len(self._games) else {}
            stored = self.owner._build_order_cache.get(self._key)
            self.comparison_title.setText("BUILD VS BUILD · " + str(game.get("map") or "Previous encounter") if game else "No previous replay scouting available")
            if _history_exposed(self):
                signature = (self.owner._account_key, self._key, _history_source_signature(game, stored),
                             self.build_time_range.currentData(), self.include_workers_supply.isChecked(),
                             game.get("myBuild"), game.get("oppStrategy"), game.get("oppBuild"))
                if signature != self._render_signature:
                    for side, field in (("my", "myBuild"), ("opp", "oppStrategy")):
                        source = stored[side] if stored is not None else _events(game, side)
                        source = _filter_build_events(source, include_workers_supply=self.include_workers_supply.isChecked())
                        name = game.get(field) or (game.get("oppBuild") if side == "opp" else None)
                        self.comparison.set_side(side, name, source, self.build_time_range.currentData())
                    self._render_signature, self._render_source = signature, stored
            failed = self._key in self.owner._build_order_failures
            self.retry.setVisible(bool(self._key and failed))
            self.retry.setEnabled(self.owner._build_order_inflight is None)
            if not game:
                status = "No earlier encounter is available for this opponent."
            elif stored is None:
                status = "Scouting preview · stored replay load failed. Retry to load all steps." if failed else "Scouting preview · loading stored replay events. Later and repeated steps may be omitted."
            else:
                status = "Stored replay events · You: " + str(len(stored["my"])) + " · Opponent: " + str(len(stored["opp"])) + ". Older uploads may be incomplete."
            self.source_status.setText(status)
            for side, button in self.comparison.chain_reference_buttons.items():
                selected = bool(self._key and self.owner._is_ghost_reference_for(self._key[1], side))
                self.comparison.set_reference(side, selected=selected,
                    enabled=bool(self._key and self.owner._paired and "ghost_reference" not in self.owner._requests))

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
        appearanceChanged = QtCore.Signal(str, bool)
        windowSizeRequested = QtCore.Signal(str)
        agentPageRequested = QtCore.Signal(str)
        inputTargetsChanged = QtCore.Signal()

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
            self._library_last_refresh = 0.0
            self._opponents = []
            self._cursor = None
            self._selected_id = None
            self._detail = {}
            self._drafts = {}
            self._snapshot = {}
            self._snapshot_healthy = False
            self._account_key = None
            self.team_roster_state = TeamRoster()
            self._team_details = {}
            self._preferences = {"overlaysEnabled": False, "opponentOverlay": False, "scoutingOverlay": False, "scoutingReadAloud": False}
            self._rendering_notes = False
            self._games = []
            self._game_selections = {}
            self._build_order_cache = OrderedDict()
            self._build_order_failures = OrderedDict()
            self._build_order_inflight = None
            self._history_signatures = {}
            self._history_sources = {}
            self._history_refresh_pending = False
            self._history_window = None
            self._panel_restore_requests = set()
            self._manual_scouting_open = False
            self._manual_scouting_dismissed = False
            self._scouting_game_scope = None
            self._ghost_references = {}
            self._density = "full"
            self._appearance_skin = "default"
            self._appearance_animations = True
            self._return_density = None
            self._spoken_game_keys = []
            self._session_enabled = False
            self._session_saved = False
            self._session_busy = False
            self._session_queued = False
            self._session_loaded = False
            self._session_last_fetch = 0.0
            self._speech_game_key = None
            self._speech_pending_key = None
            self._speech_pending_at = None
            self._build_ui()
            from .qt_helpers import guard_value_widgets
            guard_value_widgets(self, QtCore, QtWidgets)
            from .companion_speech import build_scouting_speech
            self.scouting_speech = (speech_factory or build_scouting_speech)(self, QtCore=QtCore)
            self.scouting_speech.statusChanged.connect(self.voice_status.setText)
            self.overlays = {kind: CompanionPanel(self, kind) for kind in ("opponent", "scouting")}
            self._history_views = [self.scouting_comparison,
                                   *(tree for trees in self.trees.values() for tree in trees.values())]
            for view in self._history_views:
                view.installEventFilter(self)
            from .companion_session import build_companion_session
            self.session_panel = build_companion_session(QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
            self.session_panel.userClosed.connect(lambda: self.session_check.setChecked(False))
            for card in (self.compact_card, self.overlays["opponent"].identity_card):
                card.set_scouting_state(opened=False, enabled=False, allow_expand=True)
                card.setContextMenuPolicy(QtCore.Qt.CustomContextMenu)
                card.customContextMenuRequested.connect(lambda position, target=card: self._team_context_menu(target, position))
            self._position_overlays()
            from ..panel_positions import build_panel_position_manager
            self._panel_positions = build_panel_position_manager(
                self, panels={**self.overlays, "session": self.session_panel, "ghost": self.ghost_page.panel},
                positions=panel_positions, defaults_provider=self._default_panel_positions,
                preview_provider=lambda kind: kind in {"opponent", "scouting"} and self.preview_button.isChecked(),
                on_positions=on_panel_positions, QtCore=QtCore, QtWidgets=QtWidgets,
            )
            self.reset_panel_positions.clicked.connect(self._panel_positions.reset)
            self._panel_positions.statusChanged.connect(self._panel_position_status)
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
            controls = QtWidgets.QVBoxLayout()
            self.preference_checks = {}
            assistance_tooltips = {
                "overlaysEnabled": "Master switch for native pinned panels, spoken scouting, build selectors and Ghost. Off hides or stops native assistance; replay syncing and browsing continue. Randomize selects a shared build from check-in. Its animation and audio stay in the separate overlay widget, controlled by its own settings.",
                "opponentOverlay": "Keep the current opponent card above other windows during a game, even when the main window is minimized. Requires In-game assistance and a mode that allows the opponent panel.",
                "scoutingOverlay": "Keep previous encounters, build-vs-build and recorded replay timings above other windows during a game. Historical scouting only—not live enemy tracking. Requires In-game assistance and an allowed mode.",
            }
            for key, title in [("overlaysEnabled", "In-game assistance"), ("opponentOverlay", "Keep opponent on top"), ("scoutingOverlay", "Keep scouting on top")]:
                checkbox = QtWidgets.QCheckBox(title)
                checkbox.setToolTip(assistance_tooltips[key])
                checkbox.setChecked(self._preferences[key])
                checkbox.toggled.connect(lambda value, preference=key: self.set_preference(preference, value))
                self.preference_checks[key] = checkbox
                checkbox.setEnabled(False)
                controls.addWidget(checkbox)
            self.preview_button = QtWidgets.QPushButton("Preview panels")
            self.preview_button.setCheckable(True)
            self.preview_button.toggled.connect(self._preview_panels_changed)
            controls.addWidget(self.preview_button, 0, QtCore.Qt.AlignLeft)
            self.reset_panel_positions = QtWidgets.QPushButton("Reset panel positions")
            self.reset_panel_positions.setToolTip("Restore Opponent, Scouting, Session and Ghost to their default positions on this PC. Sizes and enabled choices stay unchanged.")
            controls.addWidget(self.reset_panel_positions, 0, QtCore.Qt.AlignLeft)
            self.panel_position_notice = label("", "Muted")
            self.panel_position_notice.hide()
            controls.addWidget(self.panel_position_notice)
            controls_layout.addLayout(controls)
            self.session_check = QtWidgets.QCheckBox("Keep session record on top")
            self.session_check.setAccessibleName("Keep session record on top")
            self.session_check.setToolTip("Show session wins, losses, elapsed time and your latest-known rating between games. In-game assistance off hides this panel too, without resetting the record.")
            self.session_check.setEnabled(False)
            self.session_check.toggled.connect(self._session_setting_changed)
            controls_layout.addWidget(self.session_check)
            controls_layout.addWidget(label("Uses the same four-hour-inactivity session as the OBS session widget, not a calendar-day total.", "Muted"))
            self.session_setup_button = QtWidgets.QPushButton("Connect Session stats…")
            self.session_setup_button.setEnabled(False)
            self.session_setup_button.setToolTip("Use your private stats connection, or create one after you confirm. No OBS or browser source is needed.")
            self.session_setup_button.clicked.connect(self._setup_session)
            controls_layout.addWidget(self.session_setup_button, 0, QtCore.Qt.AlignLeft)
            self.session_notice = label("", "Muted")
            self.session_notice.hide()
            controls_layout.addWidget(self.session_notice)
            self.assistance_help = label("Master switch for panels, voice and build guidance—not replay syncing or browsing. Turning it off keeps your choices. Pinned panels stay on top when your mode allows; scouting is past replay information, not live enemy tracking.", "Muted")
            self.assistance_help.setObjectName("companionAssistanceHelp")
            controls_layout.addWidget(self.assistance_help)
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
            self.appearance_controls = QtWidgets.QFrame()
            self.appearance_controls.setObjectName("companionCard")
            appearance_layout = QtWidgets.QVBoxLayout(self.appearance_controls)
            appearance_layout.setContentsMargins(12, 10, 12, 10)
            appearance_layout.addWidget(label("Appearance", "Heading"))
            appearance_layout.addWidget(label("Border appearance is saved on this computer, separately from assistance modes.", "Muted"))
            appearance_row = QtWidgets.QHBoxLayout()
            appearance_row.addWidget(label("Border", "Muted"))
            self.appearance_skin = QtWidgets.QComboBox()
            self.appearance_skin.setAccessibleName("Companion border appearance")
            for title, skin in (("Default", "default"), ("Protoss", "protoss"), ("Terran", "terran"), ("Zerg", "zerg")):
                self.appearance_skin.addItem(title, skin)
            self.appearance_skin.setToolTip("Default preserves the current purple border. This is a visual choice, not your race or your opponent's race.")
            appearance_row.addWidget(self.appearance_skin, 1)
            appearance_layout.addLayout(appearance_row)
            self.appearance_animations = QtWidgets.QCheckBox("Animate expanding the Companion")
            self.appearance_animations.setChecked(True)
            self.appearance_animations.setToolTip("Animate only when you explicitly expand the window. Turn this off for instant size changes.")
            appearance_layout.addWidget(self.appearance_animations)
            self.appearance_notice = label("", "Muted")
            self.appearance_notice.hide()
            appearance_layout.addWidget(self.appearance_notice)
            self.appearance_skin.currentIndexChanged.connect(self._appearance_controls_changed)
            self.appearance_animations.toggled.connect(self._appearance_controls_changed)
            controls_layout.addWidget(self.appearance_controls)
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
            for key, title in [("tech", "Tech milestones"), ("build", "Stored build order"), ("upgrades", "Upgrades")]:
                tab = QtWidgets.QWidget()
                tab_layout = QtWidgets.QVBoxLayout(tab)
                tab_layout.addWidget(label("Started and completed keep their recorded observation time; recorded has no confirmed event type.", "Muted"))
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
            self.scouting_page = QtWidgets.QWidget()
            scouting_layout = QtWidgets.QVBoxLayout(self.scouting_page)
            scouting_layout.setContentsMargins(0, 0, 0, 0)
            scouting_layout.setSpacing(3)
            build_controls = QtWidgets.QWidget()
            build_controls_layout = QtWidgets.QVBoxLayout(build_controls)
            build_controls_layout.setContentsMargins(0, 0, 0, 0)
            build_controls_layout.setSpacing(2)
            build_options = QtWidgets.QHBoxLayout()
            build_options.setSpacing(6)
            build_options.addWidget(label("Range", "Muted"))
            self.build_time_range = QtWidgets.QComboBox()
            self.build_time_range.setAccessibleName("Build order time range")
            self.build_time_range.setToolTip("Choose the time window for both build and upgrade icon chains. Full details tables retain all available events.")
            for title, seconds in TIME_RANGES:
                self.build_time_range.addItem(title, seconds)
            self.build_time_range.currentIndexChanged.connect(self._build_range_changed)
            build_options.addWidget(self.build_time_range)
            self.include_workers_supply = QtWidgets.QCheckBox("Include workers and supply")
            self.include_workers_supply.toggled.connect(self._build_range_changed)
            self.build_options_button = QtWidgets.QToolButton()
            self.build_options_button.setText("Options")
            self.build_options_button.setAccessibleName("Build order display options")
            self.build_options_button.setPopupMode(QtWidgets.QToolButton.InstantPopup)
            self.build_options_menu = QtWidgets.QMenu(self.build_options_button)
            option_action = QtWidgets.QWidgetAction(self.build_options_menu)
            option_body = QtWidgets.QWidget()
            option_layout = QtWidgets.QVBoxLayout(option_body)
            option_layout.setContentsMargins(10, 8, 10, 8)
            option_layout.addWidget(self.include_workers_supply)
            option_action.setDefaultWidget(option_body)
            self.build_options_menu.addAction(option_action)
            self.build_options_menu.addSeparator()
            self.build_options_menu.addAction("Appearance…", self.show_appearance_settings)
            self.build_options_button.setMenu(self.build_options_menu)
            build_options.addWidget(self.build_options_button)
            build_options.addStretch()
            self.build_retry = QtWidgets.QPushButton("Retry")
            self.build_retry.setAccessibleName("Retry stored build order")
            self.build_retry.clicked.connect(self._retry_build_order)
            self.build_retry.hide()
            build_options.addWidget(self.build_retry)
            build_controls_layout.addLayout(build_options)
            self.build_source_status = SourceStatus()
            self.build_source_status.setText("Choose a replay to load its stored build order.")
            build_controls_layout.addWidget(self.build_source_status)
            scouting_layout.addWidget(build_controls)
            scouting_layout.addWidget(self.scouting_stack, 1)
            self.workspace_tabs.addTab(self.scouting_page, "Scouting")
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
            self.ghost_page = build_companion_ghost(
                self.workspace_tabs, handler=handler, QtCore=QtCore,
                QtGui=QtGui, QtWidgets=QtWidgets,
            )
            self.ghost_page.referencesChanged.connect(self._ghost_references_changed)
            self.workspace_tabs.addTab(self.build_selectors, "Build selectors")
            self.workspace_tabs.addTab(self.randomizer_page, "Randomizer settings")
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
            self.compact_card.scoutingRequested.connect(self._toggle_scouting_panel)
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
            from .companion_scouting import build_scouting_comparison
            self.overview_dossier_title = label("SELECTED GAME · BUILD VS BUILD", "Heading")
            overview_layout.insertWidget(0, self.overview_dossier_title)
            self.scouting_comparison = build_scouting_comparison(
                overview_body, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, icon_provider=icon)
            for name in ("build_chains", "upgrade_chains", "upgrade_headings", "chain_labels", "chain_headings",
                         "chain_reference_buttons", "chain_cards", "chain_cards_layout"):
                setattr(self, name, getattr(self.scouting_comparison, name))
            self.scouting_comparison.ghostRequested.connect(self._save_ghost_reference)
            overview_layout.insertWidget(1, self.scouting_comparison, 1)
            self.chain_observation_note = label("Replay observations · Started and Completed keep their original meaning.", "Muted")
            overview_layout.insertWidget(2, self.chain_observation_note)
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
            menu = agent_menu
            if menu is None:
                menu = QtWidgets.QMenu(self.agent_menu_button)
                for title, route in (("Dashboard", "dashboard"), ("Recent games", "recent"), ("Settings", "settings"), ("Streams", "streams"), ("Logs", "log")):
                    menu.addAction(title, lambda _checked=False, destination=route: self.agentPageRequested.emit(destination))
                menu.addSeparator()
                menu.addAction("Border & animations…", self.show_appearance_settings)
            self.agent_menu_button.setMenu(menu)
            self.console.brand_actions.addWidget(self.agent_menu_button)
            from .team_roster import build_team_roster
            self.team_roster_widget = build_team_roster(self, QtCore=QtCore, QtWidgets=QtWidgets)
            self.team_roster_widget.selected.connect(self._select_team_enemy)
            self.team_roster_widget.configureRequested.connect(self._configure_teams)
            self.team_roster_widget.identityRequested.connect(self._choose_team_history)
            self.team_roster_widget.openRequested.connect(lambda: self.console.navigate("team-roster"))
            self.team_roster_summary = build_team_roster(self.plan_summary, QtCore=QtCore, QtWidgets=QtWidgets)
            self.team_roster_summary.set_density("standard")
            self.team_roster_summary.configureRequested.connect(self._configure_teams)
            self.team_roster_summary.openRequested.connect(lambda: self.console.navigate("team-roster"))
            self.plan_summary.layout().insertWidget(0, self.team_roster_summary)
            self.team_roster_summary.hide()
            self.team_roster_page = build_team_roster(self, QtCore=QtCore, QtWidgets=QtWidgets)
            self.team_roster_page.set_density("full")
            self.team_roster_page.selected.connect(self._select_team_enemy)
            self.team_roster_page.configureRequested.connect(self._configure_teams)
            self.team_roster_page.identityRequested.connect(self._choose_team_history)
            self.console.register_page("team-roster", self.team_roster_page, "Live enemy roster")
            self.console.layout().insertWidget(1, self.team_roster_widget)
            self.team_roster_widget.hide()
            layout.addWidget(self.console, 1)
            layout.addWidget(self.details_bar)
            layout.addWidget(self.live_label)
            self.console.navigate("scouting")
            self.set_density("full")

        def current_density(self):
            return self._density

        def live_context(self):
            envelope = self._snapshot.get("liveGame") or {}
            players = envelope.get("players")
            if isinstance(players, list) and len(players) > 2:
                if self._snapshot_healthy and self.team_roster_state.ready and roster_candidate(self._snapshot):
                    return True, self.team_roster_state.context(self._team_details)
                return False, {}
            return _live_context(self._snapshot)

        def team_ghost_context(self):
            if not self._snapshot_healthy or not self.team_roster_state.ready or not roster_candidate(self._snapshot):
                return None
            roster = self.team_roster_state
            return {"gameKey": roster.candidate["gameKey"], "accountKey": roster.candidate["accountKey"],
                    "ownKey": roster.own_key, "user": roster.player(roster.own_key),
                    "rosterSignature": roster.signature, "selectedEnemyKey": roster.selected_key,
                    "confirmed": True, "enemyKeys": list(roster.enemy_keys)}

        def _refresh_team_roster(self, *, update=True):
            previous = self.team_roster_state.signature
            changed = self.team_roster_state.update(self._snapshot)
            if changed:
                self._team_details.clear()
                for channel in list(self._requests):
                    if channel.startswith("team_history:"):
                        self._requests.pop(channel, None)
                if previous is not None:
                    self._selected_id = None
                    self._detail = {}
                    self._render_detail()
            self.team_roster_state.bind_directory(self._opponents)
            for pulse_id in set(self.team_roster_state.bindings.values()):
                channel = "team_history:" + pulse_id
                if pulse_id not in self._team_details and channel not in self._requests:
                    self._job(channel, {"action": "opponent", "pulseId": pulse_id,
                                       "teamGameKey": self.team_roster_state.candidate["gameKey"],
                                       "teamSignature": self.team_roster_state.signature})
            self._team_selection_changed(update=update)

        def _finish_team_history(self, response):
            payload = response["payload"]
            roster = self.team_roster_state
            if not roster.ready or payload.get("teamSignature") != roster.signature:
                return
            pulse_id = payload.get("pulseId")
            if pulse_id not in roster.bindings.values():
                return
            if response.get("error"):
                self._team_details[pulse_id] = {}
                self.notice.setText("Team scouting history could not load. Refresh the library to retry.")
                return
            self._team_details[pulse_id] = response["result"]
            self._team_selection_changed()

        def _team_selection_changed(self, *, update=True):
            roster = self.team_roster_state
            if roster.ready:
                pulse_id = roster.bindings.get(roster.selected_key)
                detail = self._team_details.get(pulse_id, {})
                if self._selected_id != pulse_id:
                    self._stop_report()
                if self._selected_id != pulse_id or self._detail != detail:
                    self._selected_id = pulse_id
                    self._detail = deepcopy(detail)
                    self._render_detail()
                self.console.set_context(opponent_id=pulse_id, game_id=self.game_select.currentData())
            if update:
                if hasattr(self, "overlays"):
                    self._update_overlays()
                else:
                    self._render_information_layout()

        def _select_team_enemy(self, key):
            if self.team_roster_state.select(key):
                self._stop_report()
                self._team_selection_changed()
                self.console.navigate("scouting", opponent_id=self._selected_id, game_id=self.game_select.currentData())

        def _team_context_menu(self, target, position):
            menu = self._build_team_context_menu(target)
            if menu is not None:
                try:
                    menu.exec(target.mapToGlobal(position))
                finally:
                    menu.deleteLater()

        def _build_team_context_menu(self, target):
            roster = self.team_roster_state
            menu = QtWidgets.QMenu(target)
            menu.addAction("Expand Companion", target.enlarge_button.click)
            menu.addAction("Minimize", target.minimize_button.click)
            menu.addAction("Close", target.close_button.click)
            menu.addMenu(self.agent_menu_button.menu()).setText("Agent")
            if not roster.candidate:
                return menu
            menu.addSeparator()
            if roster.ready:
                menu.addAction("Previous enemy", lambda: self._step_opponent(-1))
                menu.addAction("Next enemy", lambda: self._step_opponent(1))
                menu.addSeparator()
                for enemy in roster.enemies:
                    action = menu.addAction(enemy["name"], lambda _checked=False, key=enemy["key"]: self._select_team_enemy(key))
                    action.setCheckable(True)
                    action.setChecked(enemy["key"] == roster.selected_key)
                menu.addSeparator()
                menu.addAction("Choose selected enemy's history identity…", lambda: self._choose_team_history(roster.selected_key))
            menu.addAction("Confirm teams…", self._configure_teams)
            return menu

        def _configure_teams(self):
            roster = self.team_roster_state
            if not roster.candidate:
                return
            signature = roster.signature
            dialog = QtWidgets.QDialog(self)
            dialog.setWindowTitle("Confirm live teams")
            dialog.setMinimumWidth(400)
            body = QtWidgets.QVBoxLayout(dialog)
            explanation = label("SC2 does not always report team membership. Choose yourself and mark each other player as teammate or enemy. These choices apply only to this game. No sides are inferred from player order or race.", "Muted")
            body.addWidget(explanation)
            form = QtWidgets.QFormLayout()
            own = QtWidgets.QComboBox()
            own.setAccessibleName("Your live team player")
            own.addItem("Choose your player…", None)
            for player in roster.players:
                own.addItem(player["name"] + " · " + (player["race"] or "Race unknown"), player["key"])
            own.setCurrentIndex(max(0, own.findData(roster.own_key)))
            form.addRow("This is me", own)
            roles = {}
            for player in roster.players:
                role = QtWidgets.QComboBox()
                role.setAccessibleName("Team role for " + player["name"])
                role.addItem("Choose side…", None)
                role.addItem("Teammate", "ally")
                role.addItem("Enemy", "enemy")
                if roster.confirmed:
                    role.setCurrentIndex(role.findData("enemy" if player["key"] in roster.enemy_keys else "ally"))
                roles[player["key"]] = role
                form.addRow(player["name"], role)
            def update_own(*_args):
                for key, role in roles.items():
                    role.setEnabled(key != own.currentData())
            own.currentIndexChanged.connect(update_own)
            update_own()
            body.addLayout(form)
            error = label("", "Muted")
            body.addWidget(error)
            buttons = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Ok | QtWidgets.QDialogButtonBox.Cancel)
            buttons.rejected.connect(dialog.reject)
            def confirm():
                if signature != roster.signature:
                    error.setText("The live game or roster changed. Close this dialog and confirm the new roster.")
                    return
                if any(role.currentData() is None for key, role in roles.items() if key != own.currentData()):
                    error.setText("Choose teammate or enemy for every other player.")
                    return
                try:
                    roster.confirm(own.currentData(), [key for key, role in roles.items() if role.currentData() == "enemy" and key != own.currentData()])
                except ValueError as problem:
                    error.setText(str(problem))
                    return
                dialog.accept()
            buttons.accepted.connect(confirm)
            body.addWidget(buttons)
            if dialog.exec() == QtWidgets.QDialog.Accepted:
                self._refresh_team_roster()

        def _choose_team_history(self, key):
            roster = self.team_roster_state
            if key not in roster.enemy_keys:
                return
            rows = [row for row in self._opponents if row.get("pulseId")]
            if not rows:
                self.notice.setText("Load your opponent library first. No public identities are linked automatically.")
                return
            signature = roster.signature
            titles = [f"{_name(row)} · {row.get('race') or 'Race unknown'} · {row['pulseId']}" for row in rows]
            chosen, accepted = QtWidgets.QInputDialog.getItem(self, "Choose owned replay identity", "Match this enemy to an identity from your own replay history. Cancel to keep unknown values.", titles, 0, False)
            if accepted and signature == roster.signature and chosen in titles:
                roster.bind(key, str(rows[titles.index(chosen)]["pulseId"]), self._opponents)
                self._refresh_team_roster()

        def current_appearance(self):
            return {"skin": self._appearance_skin, "animations": self._appearance_animations}

        def set_appearance(self, skin, animations):
            self._appearance_skin = skin if isinstance(skin, str) and skin in {"default", "protoss", "terran", "zerg"} else "default"
            self._appearance_animations = animations if type(animations) is bool else True
            skin_blocker = QtCore.QSignalBlocker(self.appearance_skin)
            animation_blocker = QtCore.QSignalBlocker(self.appearance_animations)
            self.appearance_skin.setCurrentIndex(self.appearance_skin.findData(self._appearance_skin))
            self.appearance_animations.setChecked(self._appearance_animations)
            del skin_blocker, animation_blocker

        def set_appearance_notice(self, text):
            self.appearance_notice.setText(str(text))
            self.appearance_notice.setVisible(bool(text))

        def _appearance_controls_changed(self, *_args):
            skin, animations = self.appearance_skin.currentData(), self.appearance_animations.isChecked()
            if skin not in {"default", "protoss", "terran", "zerg"}:
                return
            if (skin, animations) == (self._appearance_skin, self._appearance_animations):
                return
            self._appearance_skin, self._appearance_animations = skin, animations
            self.appearanceChanged.emit(skin, animations)

        def show_appearance_settings(self):
            self.console.navigate("settings")
            self.controls_page.ensureWidgetVisible(self.appearance_controls)
            self.appearance_skin.setFocus()

        def set_density(self, level, *, temporary=False):
            if level not in ("compact", "standard", "detailed", "full"):
                level = "standard"
            changed = level != self._density
            self._density = level
            if not temporary:
                self._return_density = None
            compact = level == "compact"
            if self.property("textOverlay") != compact:
                self.setProperty("textOverlay", compact)
                self.style().unpolish(self)
                self.style().polish(self)
            for widget in self._normal_chrome:
                widget.setVisible(not compact and (widget is not self.window_size_notice or bool(self.window_size_notice.text())))
            margin = 0 if compact else 4 if level == "standard" else 8
            self.layout().setContentsMargins(margin, margin, margin, margin)
            self.layout().setSpacing(6)
            self.compact_card.setVisible(compact)
            self.team_roster_widget.set_density(level)
            self.console.setVisible(not compact)
            self.live_label.setVisible(not compact)
            self.plan_summary.setVisible(level == "standard")
            self.scouting_stack.setCurrentWidget(self.dossier if level == "full" else self.overview)
            self.overview_dossier_title.setVisible(level != "standard")
            self.chain_observation_note.setVisible(level != "standard")
            self.scouting_comparison.set_density(level)
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
            self._update_ghost_reference_buttons()
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

        def _current_build_key(self):
            game_id = self.game_select.currentData()
            return (str(self._selected_id), str(game_id)) if self._selected_id and game_id else None

        def _build_range_changed(self, *_args):
            horizon = self.build_time_range.currentData()
            if hasattr(self, "overlays"):
                self.overlays["scouting"].sync_options(horizon, self.include_workers_supply.isChecked())
            self._render_information_layout()

        def _ensure_build_order(self):
            if not self._paired or not callable(handler) or self._build_order_inflight is not None:
                return
            panel = self.overlays.get("scouting") if hasattr(self, "overlays") else None
            keys = [panel._key if panel is not None and panel.isVisible() else None, self._current_build_key()]
            for key in keys:
                if key in self._build_order_cache:
                    self._build_order_cache.move_to_end(key)
                    continue
                if not key or key in self._build_order_failures:
                    continue
                self._build_order_inflight = key
                request = {"action": "game_build_order", "gameId": key[1], "opponentId": key[0]}
                if self._account_key:
                    request["accountKey"] = self._account_key
                self._job("game_build_order", request)
                return

        def _retry_build_order(self, key=None):
            key = key if isinstance(key, tuple) else self._current_build_key()
            if key:
                self._build_order_failures.pop(key, None)
            self._ensure_build_order()
            self._render_information_layout()
            if hasattr(self, "overlays"):
                self.overlays["scouting"].render_build_data()

        def _finish_build_order(self, response):
            payload = response["payload"]
            key = (str(payload.get("opponentId")), str(payload.get("gameId")))
            self._build_order_inflight = None
            result = response.get("result")
            valid = (not response.get("error") and isinstance(result, dict)
                     and result.get("game_id") == key[1] and result.get("ok") is True
                     and isinstance(result.get("events"), list) and isinstance(result.get("opp_events"), list))
            if valid:
                self._build_order_cache[key] = {
                    side: _stored_build_events(result, side) for side in ("my", "opp")
                }
                self._build_order_cache[key]["statuses"] = {
                    side: result.get(side + "_status") for side in ("my", "opp")
                }
                self._build_order_cache.move_to_end(key)
                while len(self._build_order_cache) > 12:
                    self._build_order_cache.popitem(last=False)
                self._build_order_failures.pop(key, None)
            else:
                self._build_order_failures[key] = True
                self._build_order_failures.move_to_end(key)
                while len(self._build_order_failures) > 12:
                    self._build_order_failures.popitem(last=False)
            if key == self._current_build_key():
                self._render_information_layout()
            if hasattr(self, "overlays"):
                self.overlays["scouting"].render_build_data()
            self._ensure_build_order()

        def _render_build_data(self, game):
            key = self._current_build_key()
            stored = self._build_order_cache.get(key)
            horizon = self.build_time_range.currentData()
            include_supply = self.include_workers_supply.isChecked()
            visible_trees = [(kind, side, tree) for kind, trees in self.trees.items()
                             for side, tree in trees.items() if _history_exposed(tree)]
            comparison = _history_exposed(self.scouting_comparison)
            if comparison or visible_trees:
                base = (self._account_key, key, _history_source_signature(game, stored), include_supply)
                comparison_signature = (*base, horizon, self._density,
                                        game.get("myBuild"), game.get("oppStrategy"), game.get("oppBuild"))
                comparison_dirty = comparison and self._history_signatures.get("comparison") != comparison_signature
                sources = {}
                def source_for(side):
                    if side not in sources:
                        source = stored[side] if stored is not None else _events(game, side)
                        sources[side] = _filter_build_events(source, include_workers_supply=include_supply)
                    return sources[side]
                if comparison_dirty:
                    for side, build_key in (("my", "myBuild"), ("opp", "oppStrategy")):
                        build_name = game.get(build_key) or (game.get("oppBuild") if side == "opp" else None)
                        self.scouting_comparison.set_side(side, build_name, source_for(side), horizon)
                    self._history_signatures["comparison"] = comparison_signature
                    self._history_sources["comparison"] = stored
                for kind, side, tree in visible_trees:
                    view = (kind, side)
                    if self._history_signatures.get(view) == base:
                        continue
                    if stored is None:
                        timeline_events = _events(game, side, full=kind == "build", upgrades=kind == "upgrades")
                    elif kind == "upgrades":
                        timeline_events = [event for event in source_for(side) if event["kind"] == "upgrade"]
                    elif kind == "tech":
                        seen = set()
                        timeline_events = []
                        for event in source_for(side):
                            identity = (event["kind"], event["name"].casefold())
                            if identity not in seen or event["name"] in {"Nexus", "Hatchery", "CommandCenter"}:
                                timeline_events.append(event)
                                seen.add(identity)
                    else:
                        timeline_events = source_for(side)
                    fill_timeline(tree, timeline_events)
                    self._history_signatures[view] = base
                    self._history_sources[view] = stored
            failed = key in self._build_order_failures
            self.build_retry.setVisible(bool(key and failed))
            self.build_retry.setEnabled(self._build_order_inflight is None and self._paired)
            if not key:
                self.build_source_status.setText("Choose a replay to load its stored build order.")
            elif stored is None:
                state = "load failed · Retry to load stored events" if failed else "loading stored events"
                self.build_source_status.setText("Scouting preview · " + state + ". Preview may omit later and repeated steps.")
            else:
                descriptions = []
                for side, title in (("my", "You"), ("opp", "Opponent")):
                    status = stored["statuses"].get(side)
                    text = "not extracted" if status == "not_extracted" else "no recorded events" if not stored[side] else str(len(stored[side])) + " recorded events"
                    descriptions.append(title + ": " + text)
                self.build_source_status.setText("Stored replay events · " + " · ".join(descriptions) + ". Older uploads may be incomplete.")

        def _queue_history_render(self):
            if not self._closed and not self._history_refresh_pending:
                self._history_refresh_pending = True
                QtCore.QTimer.singleShot(0, self._flush_history_render)

        def _flush_history_render(self):
            self._history_refresh_pending = False
            if not self._closed:
                self._render_information_layout()

        def showEvent(self, event):
            super().showEvent(event)
            window = self.window()
            if window is not self._history_window:
                if self._history_window is not None:
                    self._history_window.removeEventFilter(self)
                self._history_window = window
                window.installEventFilter(self)
            self._queue_history_render()

        def eventFilter(self, watched, event):
            if ((watched in getattr(self, "_history_views", ()) and event.type() == QtCore.QEvent.Show)
                    or (watched is self._history_window and event.type() == QtCore.QEvent.WindowStateChange)):
                self._queue_history_render()
            return super().eventFilter(watched, event)

        def _clear_history_render_cache(self, *, clear_widgets=False):
            self._history_signatures.clear()
            self._history_sources.clear()
            if not hasattr(self, "overlays"):
                return
            panel = self.overlays["scouting"]
            panel._render_signature = panel._render_source = None
            if clear_widgets:
                for trees in self.trees.values():
                    for tree in trees.values():
                        fill_timeline(tree, [])
                for side in ("my", "opp"):
                    self.scouting_comparison.set_side(side, None, [], self.build_time_range.currentData())
                panel.clear_history()

        def _render_selected_summary(self):
            if not hasattr(self, "console") or not hasattr(self.console, "set_opponent_summary"):
                return
            detail = self._detail
            row = next((entry for entry in self._opponents if str(entry.get("pulseId")) == self._selected_id), {})
            totals = detail.get("totals") if isinstance(detail.get("totals"), dict) else detail
            self.console.set_opponent_summary(
                name=_name(detail) if detail else _name(row) if row else None,
                race=detail.get("race") or detail.get("oppRaceModal") or row.get("race"),
                mmr=detail.get("mmr") if detail.get("mmr") is not None else row.get("mmr"),
                wins=totals.get("wins", row.get("wins")), losses=totals.get("losses", row.get("losses")),
            )

        def _render_information_layout(self):
            if not hasattr(self, "compact_card"):
                return
            self._render_selected_summary()
            active, context = self.live_context()
            if not self._snapshot_healthy:
                active = False
            envelope = self._snapshot.get("liveGame") if isinstance(self._snapshot, dict) else None
            in_game = isinstance(envelope, dict) and envelope.get("phase") in {"match_loading", "match_started", "match_in_progress"} and envelope.get("isReplay") is not True
            stamp = envelope.get("receivedAt") if isinstance(envelope, dict) else None
            stamp = stamp / 1000 if type(stamp) in {int, float} else envelope.get("capturedAt") if isinstance(envelope, dict) else None
            if type(stamp) not in {int, float} or not math.isfinite(stamp) or not -5 <= time.time() - stamp <= 30:
                active = False
            if not active:
                context = {}
            context = context if isinstance(context, dict) else {}
            direct = envelope.get("opponent") if active and not context.get("teamHybrid") and isinstance(envelope.get("opponent"), dict) else None
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
            if not active:
                self.compact_card.set_waiting(in_game=in_game)
            self._set_team_mmr_source(self.compact_card, context)
            self.compact_card.setToolTip((("Selected live enemy · right-click to switch enemies or confirm teams. " + context.get("mmrSource", "")) if context.get("teamHybrid") else "Current live opponent" if active else "Opponent telemetry unavailable" if in_game else "Waiting for next match") + " · Alt+Tab, then right-click for window and Agent options.")
            self.team_roster_widget.render(self.team_roster_state, self._opponents, self._team_details)
            self.team_roster_page.render(self.team_roster_state, self._opponents, self._team_details)
            self.team_roster_summary.render(self.team_roster_state, self._opponents, self._team_details)
            team = bool(self.team_roster_state.candidate)
            self.team_roster_widget.setVisible(team and self._density in {"detailed", "full"})
            self.team_roster_summary.setVisible(team and self._density == "standard")
            self.overview_plan.setVisible(not team)
            self.overview_ghost.setVisible(not team)
            games = self._games
            selected = self.game_select.currentData()
            game = next((row for row in games if isinstance(row, dict) and row.get("gameId") == selected), games[0] if games else {})
            self._render_build_data(game)
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

        def _set_team_mmr_source(self, card, context):
            team = bool(context.get("teamHybrid"))
            historical = team and context.get("mmr") is not None
            card.mmr_caption.setText("1v1 MMR" if historical else "MMR")
            card.mmr_label.setToolTip(context.get("mmrSource") or "Team MMR unavailable" if team else "Matchmaking rating" if card.mmr_label.text() != "—" else "MMR unavailable")
            card.mmr_caption.setToolTip(card.mmr_label.toolTip())

        def _enlarge_from_panel(self):
            self.windowSizeRequested.emit("standard")
            self.console.navigate("scouting")
            self.window().showNormal()
            self.window().raise_()
            self.window().activateWindow()

        def _scouting_toggle_allowed(self):
            active, _context = self.live_context()
            return bool(self._snapshot_healthy and self._paired and active and self.assistance_enabled()
                        and self.mode_gates()["scoutingOverlay"])

        def _toggle_scouting_panel(self):
            if not self._scouting_toggle_allowed():
                return
            opened = self.overlays["scouting"].isVisible()
            self._manual_scouting_open = not opened
            self._manual_scouting_dismissed = opened
            if not opened:
                self._panel_restore_requests.add("scouting")
            self._update_overlays()

        def scouting_buttons(self):
            opponent = self.overlays["opponent"]
            if opponent.isVisible() and not opponent.isMinimized():
                return [opponent.identity_card.scouting_button]
            return [self.compact_card.scouting_button]

        def _step_opponent(self, step):
            if self.team_roster_state.ready:
                self.team_roster_state.step(step)
                self._stop_report()
                self._team_selection_changed()
                self.console.navigate("scouting", opponent_id=self._selected_id, game_id=self.game_select.currentData())
                return
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
            positions = self._default_panel_positions()
            for kind, panel in self.overlays.items():
                panel.move(*positions[kind])

        def _default_panel_positions(self):
            screen = self.screen()
            if screen is None:
                return {kind: [0, 0] for kind in ("opponent", "scouting", "session", "ghost")}
            area = screen.availableGeometry()
            opponent = self.overlays["opponent"]
            scouting = self.overlays["scouting"]
            return {"opponent": [area.right() - opponent.width() - 20, area.top() + 60],
                    "scouting": [area.right() - scouting.width() - 20, area.top() + 300],
                    "session": [0, 0], "ghost": [0, 0]}

        def _panel_position_status(self, text):
            self.panel_position_notice.setText(text)
            self.panel_position_notice.setVisible(bool(text))

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
            self._sync_session_panel()

        def _apply_session_setting(self, enabled):
            self._session_enabled = enabled is True
            blocker = QtCore.QSignalBlocker(self.session_check)
            self.session_check.setChecked(self._session_enabled)
            del blocker
            self._sync_session_panel()

        def _session_setting_changed(self, enabled):
            self._session_enabled = enabled is True
            self._session_last_fetch = 0.0
            self._requests.pop("session_stats", None)
            self.session_panel.update_session({})
            self._sync_session_panel()
            if self._session_busy:
                self._session_queued = True
            else:
                self._save_session_setting()

        def _save_session_setting(self):
            self._session_busy = True
            self._job("session_save", {"action": "session_settings", "enabled": self._session_enabled})

        def _setup_session(self):
            if (not self._paired or not self._snapshot_healthy or not self._account_key or not callable(handler)
                    or "session_setup" in self._requests):
                return
            owner = self._account_key
            answer = QtWidgets.QMessageBox.question(
                self, "Connect Session stats",
                "Use your account's private Session stats connection? If none exists, this creates one named Native Companion Session. "
                "It lets this agent read your session record without OBS. You can revoke it in your overlay settings.",
                QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No, QtWidgets.QMessageBox.No,
            )
            if answer != QtWidgets.QMessageBox.Yes or self._closed:
                return
            if owner != self._account_key or not self._paired or not self._snapshot_healthy:
                self.session_notice.setText("Your pairing changed. Refresh before connecting Session stats.")
                self.session_notice.show()
                return
            self.session_setup_button.setEnabled(False)
            self.session_setup_button.setText("Connecting…")
            self.session_notice.setText("Checking your private Session connection…")
            self.session_notice.show()
            self._job("session_setup", {"action": "session_setup", "confirmed": True, "accountKey": owner})

        def _sync_session_panel(self):
            if not hasattr(self, "session_panel"):
                return
            self.session_setup_button.setEnabled(bool(self._paired and self._snapshot_healthy and self._account_key and callable(handler)
                                                      and "session_setup" not in self._requests))
            visible = self._session_enabled and self.assistance_enabled()
            self.session_panel.set_enabled(visible)
            if not self._session_enabled or not self._snapshot_healthy:
                self._requests.pop("session_stats", None)
                self._session_last_fetch = 0.0
                self.session_panel.update_session({})
            if not visible or not self._account_key or not callable(handler):
                return
            now = time.monotonic()
            if "session_stats" not in self._requests and now - self._session_last_fetch >= 10:
                self._session_last_fetch = now
                self._job("session_stats", {"action": "session_stats", "accountKey": self._account_key})

        def refresh_library(self):
            self.refresh()
            self._team_details.clear()
            self._refresh_team_roster()
            self._requests.pop("game_build_order", None)
            self._build_order_inflight = None
            self._build_order_cache.clear()
            self._build_order_failures.clear()
            self._clear_history_render_cache()
            self._render_information_layout()
            self.build_selectors.refresh()
            self.randomizer_page.refresh()
            self.ghost_page.refresh()
            if self._paired and "directory" not in self._requests:
                self._library_last_refresh = time.monotonic()
                self._job("directory", {"action": "opponents"})
            if self._paired and self._selected_id and "opponent" not in self._requests:
                self._job("opponent", {"action": "opponent", "pulseId": self._selected_id})

        def _refresh_idle_library(self):
            envelope = self._snapshot.get("liveGame")
            phase = envelope.get("phase") if isinstance(envelope, dict) else None
            if (not self._paired or not self.isVisible() or self._density == "compact"
                    or phase in {"match_loading", "match_started", "match_in_progress"}
                    or "directory" in self._requests
                    or time.monotonic() - self._library_last_refresh < 30):
                return
            self._library_last_refresh = time.monotonic()
            self._job("directory", {"action": "opponents", "autoRefresh": True})
            if self._selected_id and "opponent" not in self._requests:
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
            if channel == "session_setup":
                self.session_setup_button.setText("Connect Session stats…")
                result = response.get("result")
                if not self._paired or payload.get("accountKey") != self._account_key:
                    self._sync_session_panel()
                    return
                if response.get("error") or not isinstance(result, dict) or result.get("ready") is not True or result.get("accountKey") != self._account_key:
                    self.session_notice.setText("Session stats could not be connected. Check your pairing and connection, then try again.")
                else:
                    self.session_notice.setText("Session connection ready. Enable the Session panel; stats may take a few moments to arrive.")
                    self._session_last_fetch = 0.0
                self.session_notice.show()
                self._sync_session_panel()
                return
            if channel == "session_stats":
                result = response.get("result")
                if (self._session_enabled and self._snapshot_healthy and payload.get("accountKey") == self._account_key
                        and isinstance(result, dict) and result.get("accountKey") == self._account_key):
                    self.session_panel.update_session(result)
                else:
                    self.session_panel.update_session({})
                return
            if channel == "session_save":
                self._session_busy = False
                if not response.get("error"):
                    self._session_saved = response["result"].get("enabled") is True
                if self._session_queued:
                    self._session_queued = False
                    self._save_session_setting()
                elif response.get("error"):
                    self._apply_session_setting(self._session_saved)
                    self.session_notice.setText("Session panel setting was not saved. Check your disk, then try again.")
                    self.session_notice.show()
                else:
                    self._session_last_fetch = 0.0
                    self._apply_session_setting(self._session_saved)
                    self.session_notice.hide()
                return
            if channel == "game_build_order":
                self._finish_build_order(response)
                return
            if isinstance(channel, str) and channel.startswith("team_history:"):
                self._finish_team_history(response)
                return
            if channel == "modes_load":
                self.mode_controls.setEnabled(callable(handler))
                self.session_check.setEnabled(callable(handler))
                if not self._preference_busy:
                    for checkbox in self.preference_checks.values():
                        checkbox.setEnabled(callable(handler))
                if not response.get("error"):
                    result = response["result"]
                    if not self._session_loaded:
                        self._session_loaded = True
                        self._session_saved = result.get("sessionEnabled") is True
                        self._apply_session_setting(self._session_saved)
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
                    self.team_roster_state.reset()
                    self._team_details.clear()
                    for pending_channel in list(self._requests):
                        if pending_channel.startswith("team_history:"):
                            self._requests.pop(pending_channel, None)
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
                account_key = result.get("accountKey")
                if self._account_key is not None and account_key != self._account_key:
                    self._clear_library()
                self._account_key = account_key
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
                    self._apply_modes(result.get("modes", self._modes), saved=True, update=False)
                self._refresh_team_roster(update=False)
                active, context = self.live_context()
                if not paired:
                    self.live_label.setText("Pair your agent on Dashboard to open your scouting library.")
                    self.notice.setText("Your companion uses the same account and replay library as this agent.")
                elif active:
                    self.live_label.setText(f"LIVE · {_name(context)} · {_time(context.get('elapsed'))} · historical scouting ready")
                else:
                    self.live_label.setText("Ready for your next match · browse your replay history below")
                if paired and not self._directory_loaded and "directory" not in self._requests:
                    self._library_last_refresh = time.monotonic()
                    self._job("directory", {"action": "opponents"})
                elif paired and self._directory_loaded:
                    self._refresh_idle_library()
                self._update_overlays()
                self.randomizer_page.update_snapshot(result)
                self.ghost_page.update_snapshot(result)
            elif channel == "directory":
                self._directory_loaded = True
                self._library_last_refresh = time.monotonic()
                rows = result.get("items") or []
                if payload.get("before"):
                    known = {str(row.get("pulseId")) for row in self._opponents}
                    self._opponents.extend(row for row in rows if str(row.get("pulseId")) not in known)
                elif payload.get("autoRefresh"):
                    known = {str(row.get("pulseId")) for row in rows}
                    self._opponents = rows + [row for row in self._opponents if str(row.get("pulseId")) not in known]
                else:
                    self._opponents = rows
                if not payload.get("autoRefresh"):
                    self._cursor = result.get("nextCursor") or result.get("nextBefore")
                self.load_more_button.setEnabled(bool(self._cursor))
                self._filter_opponents(preserve_scroll=bool(payload.get("autoRefresh")))
                self._refresh_team_roster()
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
                    if opponent_id in self._team_details:
                        self._team_details[opponent_id] = deepcopy(self._detail)
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
            self._snapshot_healthy = False
            self._panel_positions.cancel_pending()
            self._requests.pop("session_stats", None)
            self._requests.pop("session_setup", None)
            self.session_setup_button.setEnabled(False)
            self.session_setup_button.setText("Connect Session stats…")
            self.session_notice.hide()
            self._session_last_fetch = 0.0
            self.session_panel.update_session({})
            self.session_panel.set_enabled(False)
            self._stop_report()
            self._spoken_game_keys.clear()
            self.team_roster_state.reset()
            self._team_details.clear()
            for channel in list(self._requests):
                if channel.startswith("team_history:"):
                    self._requests.pop(channel, None)
            self._requests.pop("directory", None)
            self._requests.pop("opponent", None)
            self._requests.pop("notes", None)
            self._requests.pop("ghost_reference", None)
            self._ghost_references = {}
            self._requests.pop("game_build_order", None)
            self._build_order_inflight = None
            self._build_order_cache.clear()
            self._build_order_failures.clear()
            self._clear_history_render_cache(clear_widgets=True)
            self._directory_loaded = False
            self._library_last_refresh = 0.0
            self._opponents = []
            self._selected_id = None
            self._detail = {}
            self._drafts.clear()
            self._game_selections.clear()
            self.opponent_list.clear()
            self._render_detail()

        def _filter_opponents(self, *, preserve_scroll=False):
            query = self.search.text().casefold().strip()
            scroll = self.opponent_list.verticalScrollBar().value()
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
            if preserve_scroll:
                self.opponent_list.verticalScrollBar().setValue(scroll)

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
            transitions = []
            for side, title in [("my", "You"), ("opp", "Opponent")]:
                values = game.get(side + "Transitions") or {}
                text = " · ".join(f"{phase} {_time(values.get(field))}" for field, phase in [("earlyMidAt", "Early-mid"), ("midAt", "Mid"), ("midLateAt", "Mid-late"), ("lateAt", "Late")] if _time(values.get(field)) != "—")
                if text:
                    transitions.append(title + ": " + text)
            self.phase_summary.setText("\n".join(transitions))
            self._update_ghost_reference_buttons()
            self._ensure_build_order()
            self._render_information_layout()
            self._update_speech()

        def _update_speech(self):
            if not hasattr(self, "scouting_speech"):
                return
            active, context = self.live_context()
            envelope = self._snapshot.get("liveGame") or {}
            game_key = envelope.get("gameKey")
            permitted = self.assistance_enabled() and self._preferences["scoutingReadAloud"] and self.mode_gates()["scoutingReadAloud"]
            opponent = context if context.get("teamHybrid") else envelope.get("opponent") or {}
            known_identity = any(isinstance(value, str) and value.strip() for value in (opponent.get("revealedName"), opponent.get("name")))
            team = bool(context.get("teamHybrid") and self.team_roster_state.ready)
            current = bool(active and known_identity and isinstance(game_key, str) and game_key.strip() and (verified_one_on_one(self._snapshot) or team))
            if team:
                enemy_key = self.team_roster_state.selected_key
                game_key = game_key + ":team:" + enemy_key + ":identity:" + str(self.team_roster_state.bindings.get(enemy_key) or "unmatched")
            self.read_report_button.setEnabled(permitted and current)
            self.voice_shortcut.setToolTip("Desktop scouting voice. Turn off to stop reading immediately. OBS speech is a separate setting." if permitted else
                                           "Desktop scouting voice is off or hidden by the master switch or active mode. Open Assistance to change it.")
            if not permitted or not current:
                if self._speech_game_key is not None or self._speech_pending_key is not None:
                    self._stop_report()
                self.voice_status.setText("Spoken scouting is off." if not self._preferences["scoutingReadAloud"] else
                                          "Spoken scouting is hidden by the master switch or active mode." if not permitted else
                                          "Waiting for a fresh human opponent or confirmed team enemy. Browsing history does not trigger speech.")
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
                history = context if team else envelope.get("streamerHistory")
                enriched = (not context.get("pulseId") or context.get("opponentIdentityMatched") is True) if team else isinstance(history, dict) and (isinstance(history.get("headToHead"), dict) or type(history.get("opponentIdentityMatched")) is bool)
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
            active, context = self.live_context()
            envelope = self._snapshot.get("liveGame") or {}
            opponent = context if context.get("teamHybrid") else envelope.get("opponent") or {}
            game_key = envelope.get("gameKey")
            identity_ready = any(isinstance(value, str) and value.strip() for value in (opponent.get("revealedName"), opponent.get("name")))
            allowed = self.assistance_enabled() and self._preferences["scoutingReadAloud"] and self.mode_gates()["scoutingReadAloud"]
            team = bool(context.get("teamHybrid") and self.team_roster_state.ready)
            if allowed and active and identity_ready and isinstance(game_key, str) and game_key.strip() and (verified_one_on_one(self._snapshot) or team):
                if team:
                    enemy_key = self.team_roster_state.selected_key
                    game_key = game_key + ":team:" + enemy_key + ":identity:" + str(self.team_roster_state.bindings.get(enemy_key) or "unmatched")
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
            return self._is_ghost_reference_for(self.game_select.currentData(), side)

        def _is_ghost_reference_for(self, game_id, side):
            return bool(game_id) and any(isinstance(reference, dict) and reference.get("side", "you") == side
                                        and (reference.get("gameId") or (reference.get("target") or {}).get("sourceGameId")) == game_id
                                        for reference in self._ghost_references.values())

        def _update_ghost_reference_buttons(self):
            game_id = self.game_select.currentData()
            for side, button in self.ghost_reference_buttons.items():
                title = "Use my build as Ghost" if side == "you" else "Use opponent's build as Ghost"
                button.setText(("★ " if self._is_ghost_reference(side) else "☆ ") + title)
                button.setEnabled(bool(game_id) and "ghost_reference" not in self._requests)
                self.scouting_comparison.set_reference(side, selected=self._is_ghost_reference(side), enabled=button.isEnabled())
            if hasattr(self, "overlays"):
                self.overlays["scouting"].render_build_data()

        def _save_ghost_reference(self, side):
            self._save_ghost_reference_for(self.game_select.currentData(), side)

        def _save_ghost_reference_for(self, game_id, side):
            if self._paired and game_id and "ghost_reference" not in self._requests:
                request = {"action": "ghost_reference", "gameId": game_id,
                           "side": side, "clear": self._is_ghost_reference_for(game_id, side)}
                if isinstance(self._account_key, str) and self._account_key:
                    request["accountKey"] = self._account_key
                self._job("ghost_reference", request)
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
            if key == "scoutingOverlay":
                self._manual_scouting_open = False
                self._manual_scouting_dismissed = False
            if value and key in {"overlaysEnabled", "opponentOverlay", "scoutingOverlay"}:
                self._panel_restore_requests.update({"opponent", "scouting"} if key == "overlaysEnabled" else {key.removesuffix("Overlay")})
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

        def _apply_modes(self, modes, *, saved=False, update=True):
            previous_hotkey = self._modes["hotkeyEnabled"]
            self._modes = normalize_modes(modes)
            self.mode_controls.set_state(self._modes)
            if saved:
                self._saved_modes = deepcopy(self._modes)
            if not self._modes_loaded or previous_hotkey != self._modes["hotkeyEnabled"]:
                self.hotkeyEnabledChanged.emit(self._modes["hotkeyEnabled"])
            self._modes_loaded = True
            if update:
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
            features = effective_mode_features(self._modes, self._snapshot)
            envelope = self._snapshot.get("liveGame") or {}
            players = envelope.get("players")
            if isinstance(players, list) and len(players) > 2:
                profile = self._modes["profiles"][self._modes["active"]]
                ready = self._snapshot_healthy and self.team_roster_state.ready and bool(roster_candidate(self._snapshot))
                for feature in features:
                    if feature != "mode":
                        features[feature] = bool(ready and feature in TEAM_FEATURES | {"ghost"} and profile.get(feature))
            return features

        def set_hotkey_status(self, status):
            self.mode_controls.hotkey_status.setText(str(status))
            self.mode_controls.hotkey_check.setToolTip(str(status))

        def _preview_panels_changed(self, enabled):
            if enabled:
                self._panel_restore_requests.update({"opponent", "scouting"})
            self._update_overlays()

        def _update_overlays(self, *_args):
            if not hasattr(self, "overlays"):
                return
            enabled = self.assistance_enabled()
            gates = self.mode_gates()
            caption = str(gates["mode"]).capitalize()
            envelope = self._snapshot.get("liveGame") or {}
            players = envelope.get("players")
            team_game = isinstance(players, list) and len(players) > 2
            self.build_selectors.set_assistance_enabled(enabled)
            self.build_selectors.set_feature_gates(gates)
            if team_game:
                self.build_selectors.hint.setText("Team Hybrid uses selected-enemy history and an explicitly chosen Ghost target. Automatic 1v1 pre/post-game build check-ins are unavailable in team games.")
            self.randomizer_page.set_assistance_enabled(enabled and gates["randomizer"],
                reason="Team games have no native 1v1 widget-pick guidance. Pool settings remain available; the overlay widget runs separately." if team_game else f"{caption} preset hides native widget-pick guidance only; overlay draws, sounds and voice use the widget's own settings." if enabled and not gates["randomizer"] else None)
            if hasattr(self.ghost_page, "set_team_context"):
                self.ghost_page.set_team_context(self.team_ghost_context())
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
            active, context = self.live_context()
            active = bool(active and self._snapshot_healthy and self._paired)
            preview = self.preview_button.isChecked()
            if preview and not active:
                context = self._detail
            scope = (self._account_key, envelope.get("gameKey"), self.team_roster_state.selected_key) if active else None
            if scope != self._scouting_game_scope:
                self._scouting_game_scope = scope
                self._manual_scouting_open = False
                self._manual_scouting_dismissed = False
            allowed = self._scouting_toggle_allowed()
            if not allowed:
                self._manual_scouting_open = False
                self._manual_scouting_dismissed = False
            for kind, panel in self.overlays.items():
                selected = self._preferences[kind + "Overlay"]
                if kind == "scouting" and active:
                    selected = (selected and not self._manual_scouting_dismissed) or self._manual_scouting_open
                visible = enabled and selected and gates[kind + "Overlay"] and (active or preview)
                if visible:
                    panel.update_context(context, scope=scope)
                    if kind == "opponent":
                        self._set_team_mmr_source(panel.identity_card, context)
                    if kind in self._panel_restore_requests:
                        panel.showNormal()
                    elif not panel.isVisible():
                        panel.show()
                else:
                    panel.hide()
                    if not active and not preview:
                        panel.update_context({})
            self._panel_restore_requests.clear()
            for card in (self.compact_card, self.overlays["opponent"].identity_card):
                card.set_scouting_state(opened=self.overlays["scouting"].isVisible(), enabled=allowed, allow_expand=True)
            self._ensure_build_order()
            self._sync_session_panel()
            self._render_information_layout()
            self._update_speech()
            self.inputTargetsChanged.emit()

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
            self._panel_positions.shutdown()
            self.timer.stop()
            self.session_panel.shutdown()
            self.session_panel.deleteLater()
            self.scouting_speech.shutdown()
            self._requests.clear()
            self._build_order_inflight = None
            self._build_order_cache.clear()
            self._build_order_failures.clear()
            self._history_signatures.clear()
            self._history_sources.clear()
            if self._history_window is not None:
                self._history_window.removeEventFilter(self)
            self.build_selectors.set_assistance_enabled(False)
            self.randomizer_page.shutdown()
            self.ghost_page.shutdown()
            for panel in self.overlays.values():
                panel.close()
                panel.deleteLater()

    return CompanionPage()

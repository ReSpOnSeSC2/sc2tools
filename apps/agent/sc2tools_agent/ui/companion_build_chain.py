"""Responsive replay-observation icon chains for native Companion views."""

from __future__ import annotations

import math
import re

from . import theme


TIME_RANGES = (("3 minutes", 180), ("6 minutes", 360), ("10 minutes", 600), ("Full build order", None))
BATCH_SIZE = 100


def _normalized_time(value):
    return value if type(value) in {int, float} and math.isfinite(value) and value >= 0 else None


def _event_time(value):
    if _normalized_time(value) is None:
        return "—"
    seconds = int(value)
    return f"{seconds // 60}:{seconds % 60:02d}"


def _entity_name(name):
    token = re.sub(r"[^a-z0-9]", "", name.lower())
    aliases = {
        "blinktech": "Blink", "zerglingmovementspeed": "Metabolic Boost",
        "zerglingmetabolicboost": "Metabolic Boost", "shieldwall": "Combat Shield",
        "punishergrenades": "Concussive Shells", "psistormtech": "Psionic Storm",
        "adeptpiercingattack": "Resonating Glaives", "stimpack": "Stimpack",
    }
    if token in aliases:
        return aliases[token]
    readable = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name)
    return re.sub(r"(?<=[A-Za-z])(?=[0-9])", " ", readable).replace("_", " ").strip()


def build_build_chain(parent, *, QtCore, QtGui, QtWidgets, icon_provider):
    """Build an icon chain; icon_provider receives the raw name and event kind."""

    class BuildChain(QtWidgets.QWidget):
        def __init__(self):
            super().__init__(parent)
            self.setObjectName("companionBuildChain")
            self.setAccessibleName("Replay build chain")
            self.setSizePolicy(QtWidgets.QSizePolicy.Expanding, QtWidgets.QSizePolicy.Preferred)
            self.setMinimumWidth(0)
            self.events = []
            self.steps = []
            self._event_signature = None
            self._event_limit = None
            self._time_range = 180
            self._batch_limit = BATCH_SIZE
            self._density = "standard"
            self._columns = 0
            self._tile_width = 112
            self._tile_width_override = None
            self.setStyleSheet(f"""
                QWidget#companionBuildChain {{ background: transparent; }}
                QLabel#chainIcon {{ background: {theme.ELEVATED}; border: 2px solid #83cc63; border-radius: 4px; color: #b9f293; }}
                QLabel#chainName {{ color: {theme.TEXT}; font-size: 11px; }}
                QLabel#chainTime {{ color: {theme.ACCENT_CYAN}; font-size: 12px; font-weight: 600; }}
                QLabel#chainTiming {{ background: {theme.SUBTLE}; border: 1px solid {theme.BORDER_STRONG}; border-radius: 3px; color: {theme.TEXT_MUTED}; font-size: 10px; padding: 1px 3px; }}
                QLabel#chainArrow {{ color: #90d56c; font-size: 18px; font-weight: 700; }}
                QLabel#chainSummary, QLabel#chainEmpty {{ color: {theme.TEXT_MUTED}; font-size: 11px; background: transparent; }}
                QPushButton#chainMore {{ background: {theme.BUTTON}; color: {theme.TEXT}; border: 1px solid {theme.BORDER_STRONG}; border-radius: 5px; padding: 5px 8px; }}
                QPushButton#chainMore:hover {{ background: {theme.BUTTON_HOVER}; border-color: {theme.ACCENT_HOVER}; }}
                QPushButton#chainMore:focus {{ border-color: {theme.FOCUS}; }}
            """)
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(0, 0, 0, 0)
            layout.setSpacing(4)
            self.scroll = QtWidgets.QScrollArea()
            self.scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
            self.scroll.setWidgetResizable(True)
            self.scroll.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
            self.scroll.setVerticalScrollBarPolicy(QtCore.Qt.ScrollBarAsNeeded)
            self.scroll.setMinimumSize(0, 0)
            self.content = QtWidgets.QWidget()
            self.content.setMinimumWidth(0)
            self.grid = QtWidgets.QGridLayout(self.content)
            self.grid.setContentsMargins(2, 2, 2, 2)
            self.grid.setHorizontalSpacing(8)
            self.grid.setVerticalSpacing(8)
            self.grid.setAlignment(QtCore.Qt.AlignTop | QtCore.Qt.AlignLeft)
            self.scroll.setWidget(self.content)
            layout.addWidget(self.scroll, 1)
            self.summary = self._label("", "chainSummary")
            self.summary.setWordWrap(True)
            layout.addWidget(self.summary)
            self.more_button = QtWidgets.QPushButton()
            self.more_button.setObjectName("chainMore")
            self.more_button.clicked.connect(self._show_next_batch)
            layout.addWidget(self.more_button, 0, QtCore.Qt.AlignLeft)
            self.empty = self._label("Replay steps unavailable", "chainEmpty")
            self.empty.setWordWrap(True)
            layout.addWidget(self.empty)
            self._reflow_timer = QtCore.QTimer(self)
            self._reflow_timer.setSingleShot(True)
            self._reflow_timer.timeout.connect(self._reflow)
            self.scroll.viewport().installEventFilter(self)
            self.set_events([])

        def _label(self, text, name):
            widget = QtWidgets.QLabel(text)
            widget.setObjectName(name)
            widget.setTextFormat(QtCore.Qt.PlainText)
            widget.setAlignment(QtCore.Qt.AlignCenter)
            widget.setMinimumWidth(0)
            return widget

        def _step(self, event):
            widget = QtWidgets.QWidget(self.content)
            widget.observation = dict(event)
            layout = QtWidgets.QHBoxLayout(widget)
            layout.setContentsMargins(0, 0, 0, 0)
            layout.setSpacing(3)
            body = QtWidgets.QVBoxLayout()
            body.setSpacing(3)
            title = _entity_name(event["name"])
            timing = event["timing"].title()
            stamp = _event_time(event["timeSec"]) if event["timeSec"] is not None else "Time unknown"
            description = f"{title} · {stamp} · {timing}"
            widget.setAccessibleName(description)
            widget.setToolTip(description + "\n" + event["name"])
            widget.icon_label = self._label("", "chainIcon")
            widget.icon_label.setFixedSize(44, 44)
            icon = icon_provider(event["name"], event["kind"]) if callable(icon_provider) and event["kind"] in {"building", "unit", "upgrade"} else None
            pixmap = icon.pixmap(QtCore.QSize(38, 38)) if isinstance(icon, QtGui.QIcon) else icon if isinstance(icon, QtGui.QPixmap) else None
            if pixmap is not None and not pixmap.isNull():
                widget.icon_label.setPixmap(pixmap.scaled(38, 38, QtCore.Qt.KeepAspectRatio, QtCore.Qt.SmoothTransformation))
            else:
                widget.icon_label.setText("".join(word[0] for word in title.split()[:2]))
            body.addWidget(widget.icon_label, 0, QtCore.Qt.AlignHCenter)
            widget.name_label = self._label(title if len(title) <= 30 else title[:29].rstrip() + "…", "chainName")
            widget.name_label.full_title = title
            widget.name_label.setWordWrap(True)
            widget.name_label.setFixedHeight(34)
            widget.name_label.setToolTip(title)
            body.addWidget(widget.name_label)
            widget.time_label = self._label(stamp, "chainTime")
            body.addWidget(widget.time_label)
            widget.timing_label = self._label(timing, "chainTiming")
            body.addWidget(widget.timing_label, 0, QtCore.Qt.AlignHCenter)
            layout.addLayout(body, 1)
            widget.arrow = self._label("›", "chainArrow")
            widget.arrow.setFixedWidth(12)
            layout.addWidget(widget.arrow, 0, QtCore.Qt.AlignTop)
            layout.setAlignment(widget.arrow, QtCore.Qt.AlignTop)
            widget.setFixedWidth(self._tile_width)
            return widget

        def set_events(self, events, limit=None):
            source = events if isinstance(events, (list, tuple)) else []
            normalized = []
            for event in source:
                if not isinstance(event, dict) or not isinstance(event.get("name"), str) or not event["name"].strip():
                    continue
                normalized.append({
                    "name": event["name"], "timeSec": _normalized_time(event.get("timeSec")),
                    "kind": event.get("kind") if event.get("kind") in {"building", "unit", "upgrade"} else "unknown",
                    "timing": event.get("timing") if event.get("timing") in {"started", "completed"} else "recorded",
                })
            normalized_limit = max(0, limit) if type(limit) is int else None
            signature = (tuple((event["name"], event["timeSec"], event["kind"], event["timing"])
                               for event in normalized), normalized_limit, self._time_range)
            if signature == self._event_signature:
                return
            self._event_signature = signature
            self.events = normalized
            self._event_limit = normalized_limit
            self._batch_limit = BATCH_SIZE
            self._render_events()

        def _show_next_batch(self):
            self._batch_limit += BATCH_SIZE
            self._render_events()

        def _render_events(self):
            normalized = self.events
            unknown_count = sum(event["timeSec"] is None for event in normalized)
            eligible = normalized if self._time_range is None else [event for event in normalized
                       if event["timeSec"] is not None and event["timeSec"] <= self._time_range]
            later_count = sum(event["timeSec"] is not None and event["timeSec"] > self._time_range
                              for event in normalized) if self._time_range is not None else 0
            available = eligible[:self._event_limit] if self._event_limit is not None else eligible
            visible = available[:self._batch_limit]
            scroll_position = self.scroll.verticalScrollBar().value()
            reuse = len(self.steps) <= len(visible) and all(widget.observation == event
                    for widget, event in zip(self.steps, visible))
            while self.grid.count():
                self.grid.takeAt(0)
            if reuse:
                self.steps.extend(self._step(event) for event in visible[len(self.steps):])
            else:
                for widget in self.steps:
                    widget.hide()
                    widget.deleteLater()
                self.steps = [self._step(event) for event in visible]
            remaining = len(normalized) - len(visible)
            details = []
            if later_count:
                details.append(f"{later_count} after {_event_time(self._time_range)}")
            if unknown_count:
                details.append(f"{unknown_count} with unknown timing")
            limited_count = len(eligible) - len(available)
            if limited_count:
                details.append(f"{limited_count} hidden by step limit")
            batch_remaining = len(available) - len(visible)
            if batch_remaining:
                details.append(f"{batch_remaining} not loaded yet")
            summary = f"+{remaining} more replay steps" if remaining else ""
            if len(available) > BATCH_SIZE:
                summary = f"Showing {len(visible)} of {len(available)} replay steps" + (" · " + summary if summary else "")
            if details:
                summary += (" · " if summary else "") + " · ".join(details)
            if later_count or (unknown_count and self._time_range is not None):
                summary += " · Select Full build order to view all steps"
            self.summary.setText(summary)
            self.summary.setVisible(bool(summary))
            next_count = min(BATCH_SIZE, batch_remaining)
            self.more_button.setText(f"Show next {next_count} steps")
            self.more_button.setAccessibleName(f"Show next {next_count} replay steps")
            self.more_button.setToolTip("Load the next recorded steps in this time range. The full source remains available without a hidden cutoff.")
            self.more_button.setVisible(batch_remaining > 0)
            empty_text = "Replay steps unavailable" if not normalized else (
                f"No timed replay steps through {_event_time(self._time_range)}" if not eligible else "No replay steps shown")
            self.empty.setText(empty_text)
            self.empty.setVisible(not visible)
            self.scroll.setVisible(bool(visible))
            range_label = "Full build order" if self._time_range is None else f"Through {_event_time(self._time_range)}"
            self.setAccessibleDescription(f"{range_label}. {len(visible)} of {len(normalized)} replay steps shown. {summary}")
            self._columns = 0
            self._reflow()
            if reuse:
                self.scroll.verticalScrollBar().setValue(scroll_position)

        def time_range(self):
            return self._time_range

        def set_time_range(self, seconds):
            if seconds is not None and (type(seconds) is not int or seconds not in {180, 360, 600}):
                raise ValueError("Choose 180, 360, 600 seconds or None for the full build order")
            if seconds == self._time_range:
                return
            self._time_range = seconds
            self.set_events(self.events, limit=self._event_limit)

        def set_density(self, level):
            density = level if level in {"compact", "standard", "detailed", "full"} else "standard"
            if density == self._density:
                return
            self._density = density
            self._tile_width = self._preferred_tile_width()
            self._columns = 0
            self._reflow()

        def _preferred_tile_width(self):
            if self._density == "standard" and self._tile_width_override is not None:
                return self._tile_width_override
            return 112 if self._density in {"compact", "standard"} else 120

        def set_tile_width(self, width=None):
            if width is not None and (type(width) is not int or not 72 <= width <= 240):
                raise ValueError("Tile width must be an integer from 72 to 240, or None")
            if width == self._tile_width_override:
                return
            self._tile_width_override = width
            self._tile_width = self._preferred_tile_width()
            self._columns = 0
            self._reflow()

        def _reflow(self):
            if not self.steps:
                self.updateGeometry()
                return
            available = max(1, self.scroll.viewport().width() - 4)
            tile_width = min(self._tile_width, available)
            columns = min(len(self.steps), max(1, (available + 8) // (tile_width + 8)))
            while self.grid.count():
                self.grid.takeAt(0)
            for index, widget in enumerate(self.steps):
                row, column = divmod(index, columns)
                widget.setFixedWidth(tile_width)
                short_names = self._density == "standard" and self._tile_width <= 90
                widget.name_label.setWordWrap(not short_names)
                widget.name_label.setFixedHeight(18 if short_names else 34)
                title = widget.name_label.full_title
                widget.name_label.setText(widget.name_label.fontMetrics().elidedText(title, QtCore.Qt.ElideRight, max(1, tile_width - 20))
                                          if short_names else title if len(title) <= 30 else title[:29].rstrip() + "…")
                widget.arrow.setText("↳" if column == columns - 1 and index < len(self.steps) - 1 else "›")
                widget.arrow.setVisible(index < len(self.steps) - 1)
                widget.arrow.setToolTip("Next row" if column == columns - 1 else "Next observed step")
                self.grid.addWidget(widget, row, column, QtCore.Qt.AlignTop)
                widget.show()
            self._columns = columns
            self.content.adjustSize()
            self.updateGeometry()

        def eventFilter(self, watched, event):
            if watched is self.scroll.viewport() and event.type() == QtCore.QEvent.Resize:
                self._reflow_timer.start(0)
            return super().eventFilter(watched, event)

        def sizeHint(self):
            rows = math.ceil(len(self.steps) / max(1, self._columns))
            row_height = 120 if self._density == "standard" and self._tile_width <= 90 else 136
            return QtCore.QSize(560, min(280, max(32, rows * row_height + (20 if self.summary.text() else 0))))

        def minimumSizeHint(self):
            return QtCore.QSize(100, 36)

    return BuildChain()

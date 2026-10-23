"""Responsive replay-observation icon chains for native Companion views."""

from __future__ import annotations

import math
import re


def _event_time(value):
    if type(value) not in {int, float} or not math.isfinite(value) or value < 0:
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
            self._density = "standard"
            self._columns = 0
            self._tile_width = 112
            self.setStyleSheet("""
                QWidget#companionBuildChain { background: transparent; }
                QLabel#chainIcon { background: #13291f; border: 2px solid #83cc63; border-radius: 4px; color: #b9f293; }
                QLabel#chainName { color: #e4ebdc; font-size: 11px; }
                QLabel#chainTime { color: #b9ef8e; font-size: 12px; font-weight: 600; }
                QLabel#chainTiming { background: #1b2b24; border: 1px solid #466140; border-radius: 3px; color: #c1d9b0; font-size: 10px; padding: 1px 3px; }
                QLabel#chainArrow { color: #90d56c; font-size: 18px; font-weight: 700; }
                QLabel#chainSummary, QLabel#chainEmpty { color: #afbdad; font-size: 11px; background: transparent; }
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
            stamp = _event_time(event["timeSec"])
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
                    "name": event["name"], "timeSec": event.get("timeSec"),
                    "kind": event.get("kind") if event.get("kind") in {"building", "unit", "upgrade"} else "unknown",
                    "timing": event.get("timing") if event.get("timing") in {"started", "completed"} else "recorded",
                })
            normalized_limit = max(0, limit) if type(limit) is int else None
            signature = (tuple((event["name"],
                                event["timeSec"] if type(event["timeSec"]) in {int, float} and math.isfinite(event["timeSec"]) and event["timeSec"] >= 0 else None,
                                event["kind"], event["timing"]) for event in normalized), normalized_limit)
            if signature == self._event_signature:
                return
            self._event_signature = signature
            visible = normalized[:normalized_limit] if normalized_limit is not None else normalized
            self.events = normalized
            while self.grid.count():
                self.grid.takeAt(0)
            for widget in self.steps:
                widget.hide()
                widget.deleteLater()
            self.steps = [self._step(event) for event in visible]
            remaining = len(normalized) - len(visible)
            self.summary.setText(f"+{remaining} more replay steps" if remaining else "")
            self.summary.setVisible(remaining > 0)
            self.empty.setVisible(not normalized)
            self.scroll.setVisible(bool(visible))
            self._columns = 0
            self._reflow()

        def set_density(self, level):
            density = level if level in {"compact", "standard", "detailed", "full"} else "standard"
            if density == self._density:
                return
            self._density = density
            self._tile_width = 112 if self._density in {"compact", "standard"} else 120
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
            return QtCore.QSize(560, min(280, max(32, rows * 136 + (20 if self.summary.text() else 0))))

        def minimumSizeHint(self):
            return QtCore.QSize(100, 36)

    return BuildChain()

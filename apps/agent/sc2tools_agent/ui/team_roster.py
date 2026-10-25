from __future__ import annotations

from . import theme
from .qt_helpers import build_flow_layout


def build_team_roster(parent, *, QtCore, QtWidgets):
    class EnemyButton(QtWidgets.QPushButton):
        def __init__(self, text):
            super().__init__(text)
            self._full_text = text
            self.setToolTip(text)
            self.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Fixed)

        def resizeEvent(self, event):
            super().resizeEvent(event)
            option = QtWidgets.QStyleOptionButton()
            self.initStyleOption(option)
            contents = self.style().subElementRect(QtWidgets.QStyle.SE_PushButtonContents, option, self)
            self.setText(self.fontMetrics().elidedText(self._full_text, QtCore.Qt.ElideRight, contents.width()))

    class RosterWidget(QtWidgets.QWidget):
        selected = QtCore.Signal(str)
        configureRequested = QtCore.Signal()
        identityRequested = QtCore.Signal(str)
        openRequested = QtCore.Signal()

        def __init__(self):
            super().__init__(parent)
            self.setObjectName("companionTeamRoster")
            self._signature = None
            self._buttons = []
            self._frames = []
            self._columns = None
            self._layout = QtWidgets.QVBoxLayout(self)
            self._layout.setContentsMargins(0, 0, 0, 0)
            self._layout.setSpacing(3)
            heading = self._heading = build_flow_layout(QtCore=QtCore, QtWidgets=QtWidgets, spacing=6)
            self.status = QtWidgets.QLabel()
            self.status.setWordWrap(True)
            self.status.setObjectName("companionMuted")
            heading.addWidget(self.status)
            self.open_roster = QtWidgets.QPushButton("Enemy roster")
            self.open_roster.clicked.connect(self.openRequested)
            heading.addWidget(self.open_roster)
            self.configure = QtWidgets.QPushButton("Confirm teams…")
            self.configure.clicked.connect(self.configureRequested)
            heading.addWidget(self.configure)
            self._layout.addLayout(heading)
            self.cards = QtWidgets.QWidget()
            self.grid = QtWidgets.QGridLayout(self.cards)
            self.grid.setContentsMargins(0, 0, 0, 0)
            self.grid.setSpacing(4)
            self.scroll = QtWidgets.QScrollArea()
            self.scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
            self.scroll.setWidgetResizable(True)
            self.scroll.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
            self.scroll.setWidget(self.cards)
            self.scroll.setMinimumHeight(40)
            self.scroll.viewport().installEventFilter(self)
            self._layout.addWidget(self.scroll, 1)

        def set_density(self, density):
            self._density = density
            compact = density == "standard"
            self.scroll.setVisible(not compact)
            self.open_roster.setVisible(compact)
            self.status.setWordWrap(not compact)
            self.setMinimumHeight(0 if compact else 165)
            self.setMaximumHeight(16777215 if compact else 200)
            self.setSizePolicy(QtWidgets.QSizePolicy.Preferred,
                               QtWidgets.QSizePolicy.Maximum if compact else QtWidgets.QSizePolicy.Preferred)
            self._update_standard_height()
            self.updateGeometry()

        def render(self, roster, directory, details):
            candidate = roster.candidate
            if not candidate:
                return
            self.status.setText((f"TEAM · {len(roster.enemies)} enemies" if roster.ready else "CONFIRM TEAMS") if getattr(self, "_density", "full") == "standard" else "TEAM HYBRID · Historical 1v1 records, not the current team rating."
                                if roster.ready else "Team roster detected. Confirm yourself, teammates and enemies; no sides are guessed from player order or race.")
            self.configure.setText("Edit teams…" if roster.ready else "Confirm teams…")
            self._update_standard_height()
            signature = (roster.signature, roster.selected_key, tuple(sorted(roster.bindings.items())),
                         tuple((key, str(value.get("mmr")), str(value.get("totals"))) for key, value in sorted(details.items())))
            if signature == self._signature:
                return
            self._signature = signature
            while self.grid.count():
                item = self.grid.takeAt(0)
                if item.widget():
                    item.widget().deleteLater()
            self._buttons = []
            self._frames = []
            self._columns = None
            for enemy in roster.enemies:
                frame = QtWidgets.QFrame()
                frame.setObjectName("companionCard")
                card = QtWidgets.QVBoxLayout(frame)
                card.setContentsMargins(5, 4, 5, 4)
                card.setSpacing(2)
                choose = EnemyButton(enemy["name"] + " · " + (enemy["race"] or "Race unknown"))
                choose.setCheckable(True)
                choose.setChecked(enemy["key"] == roster.selected_key)
                choose.setAccessibleName("Select enemy " + enemy["name"])
                choose.clicked.connect(lambda _checked=False, key=enemy["key"]: self.selected.emit(key))
                card.addWidget(choose)
                pulse_id = roster.bindings.get(enemy["key"])
                detail = details.get(pulse_id, {})
                totals = detail.get("totals") if isinstance(detail.get("totals"), dict) else {}
                wins, losses = totals.get("wins"), totals.get("losses")
                record = f"{wins}W · {losses}L" if type(wins) is int and type(losses) is int else "No matched history"
                mmr = detail.get("mmr")
                note = QtWidgets.QLabel(record + (f" · {mmr} historical 1v1 MMR" if type(mmr) in {int, float} else " · MMR —"))
                note.setWordWrap(True)
                note.setStyleSheet(f"color: {theme.TEXT_MUTED}; font-size: 10px;")
                card.addWidget(note)
                link = QtWidgets.QPushButton("Change history identity…" if pulse_id else "Choose history identity…")
                link.setAccessibleName("Choose history identity for " + enemy["name"])
                link.clicked.connect(lambda _checked=False, key=enemy["key"]: self.identityRequested.emit(key))
                card.addWidget(link)
                self._frames.append(frame)
                self._buttons.append(choose)
            self._reflow_cards()

        def _update_standard_height(self):
            if getattr(self, "_density", None) == "standard":
                self.setFixedHeight(self._heading.heightForWidth(self.width()))

        def _reflow_cards(self):
            if not self._frames:
                return
            minimum_width = max(200, *(frame.minimumSizeHint().width() for frame in self._frames))
            spacing = self.grid.horizontalSpacing()
            columns = max(1, min(4, (self.scroll.viewport().width() + spacing) // (minimum_width + spacing)))
            if columns == self._columns:
                return
            self._columns = columns
            for frame in self._frames:
                self.grid.removeWidget(frame)
            for index, frame in enumerate(self._frames):
                self.grid.addWidget(frame, index // columns, index % columns)
            for column in range(4):
                self.grid.setColumnStretch(column, 1 if column < columns else 0)

        def resizeEvent(self, event):
            super().resizeEvent(event)
            self._update_standard_height()
            self._reflow_cards()

        def eventFilter(self, watched, event):
            if watched is self.scroll.viewport() and event.type() == QtCore.QEvent.Resize:
                self._reflow_cards()
            return super().eventFilter(watched, event)

    return RosterWidget()

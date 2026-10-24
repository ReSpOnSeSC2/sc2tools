from __future__ import annotations

from . import theme


def build_team_roster(parent, *, QtCore, QtWidgets):
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
            self._layout = QtWidgets.QVBoxLayout(self)
            self._layout.setContentsMargins(0, 0, 0, 0)
            self._layout.setSpacing(3)
            heading = QtWidgets.QHBoxLayout()
            self.status = QtWidgets.QLabel()
            self.status.setWordWrap(True)
            self.status.setObjectName("companionMuted")
            heading.addWidget(self.status, 1)
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
            self._layout.addWidget(self.scroll, 1)

        def set_density(self, density):
            self._density = density
            compact = density == "standard"
            self.scroll.setVisible(not compact)
            self.open_roster.setVisible(compact)
            self.status.setWordWrap(not compact)
            self.setMinimumHeight(32 if compact else 165)
            self.setMaximumHeight(32 if compact else 200)

        def render(self, roster, directory, details):
            candidate = roster.candidate
            if not candidate:
                return
            self.status.setText((f"TEAM · {len(roster.enemies)} enemies" if roster.ready else "CONFIRM TEAMS") if getattr(self, "_density", "full") == "standard" else "TEAM HYBRID · Historical 1v1 records, not the current team rating."
                                if roster.ready else "Team roster detected. Confirm yourself, teammates and enemies; no sides are guessed from player order or race.")
            self.configure.setText("Edit teams…" if roster.ready else "Confirm teams…")
            signature = (roster.signature, roster.selected_key, tuple(sorted(roster.bindings.items())),
                         tuple((key, str(value.get("mmr")), str(value.get("totals"))) for key, value in sorted(details.items())), self.width())
            if signature == self._signature:
                return
            self._signature = signature
            while self.grid.count():
                item = self.grid.takeAt(0)
                if item.widget():
                    item.widget().deleteLater()
            self._buttons = []
            columns = max(1, min(4, self.width() // 200))
            for index, enemy in enumerate(roster.enemies):
                frame = QtWidgets.QFrame()
                frame.setObjectName("companionCard")
                card = QtWidgets.QVBoxLayout(frame)
                card.setContentsMargins(5, 4, 5, 4)
                card.setSpacing(2)
                choose = QtWidgets.QPushButton(enemy["name"] + " · " + (enemy["race"] or "Race unknown"))
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
                self.grid.addWidget(frame, index // columns, index % columns)
                self._buttons.append(choose)

        def resizeEvent(self, event):
            super().resizeEvent(event)
            self._signature = None

    return RosterWidget()

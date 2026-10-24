"""Small dashboard game/import cards; rendering only, no IO or threads."""
from __future__ import annotations

from .recent_games import relative_time
from ..recent_games import parse_time


def build_game_dashboard(parent, *, QtCore, QtWidgets, open_game, pause, current_season, open_website, open_help):
    from .qt_helpers import build_flow_layout

    class GameDashboard(QtWidgets.QWidget):
        def __init__(self):
            super().__init__(parent)
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(0, 0, 0, 0)
            layout.setSpacing(12)
            self.last_id = None
            self.last_card, last = self._card("Last game")
            self.last = QtWidgets.QLabel("Your next synced game will appear here.")
            self.last.setTextFormat(QtCore.Qt.PlainText)
            self.last.setWordWrap(True)
            last.addWidget(self.last)
            self.last_button = QtWidgets.QPushButton("Open analysis")
            self.last_button.clicked.connect(lambda: open_game(self.last_id) if self.last_id else None)
            self.last_button.setEnabled(False)
            last.addWidget(self.last_button)
            layout.addWidget(self.last_card)
            self.today_card, today = self._card("Today")
            self.today = QtWidgets.QLabel("No game details tracked today yet.")
            self.today.setWordWrap(True)
            today.addWidget(self.today)
            self.history_note = QtWidgets.QLabel("")
            self.history_note.setObjectName("muted")
            self.history_note.setWordWrap(True)
            today.addWidget(self.history_note)
            layout.addWidget(self.today_card)
            self.import_card, progress = self._card("Importing your replay history")
            self.import_phase = QtWidgets.QLabel("Scanning…")
            progress.addWidget(self.import_phase)
            self.bar = QtWidgets.QProgressBar()
            self.bar.setAccessibleName("Replay history import progress")
            progress.addWidget(self.bar)
            self.import_detail = QtWidgets.QLabel("")
            self.import_detail.setWordWrap(True)
            progress.addWidget(self.import_detail)
            actions = build_flow_layout(QtCore=QtCore, QtWidgets=QtWidgets)
            self.pause = QtWidgets.QPushButton("Pause")
            self.pause.clicked.connect(pause)
            actions.addWidget(self.pause)
            self.season = QtWidgets.QPushButton("Only import this season")
            self.season.clicked.connect(current_season)
            actions.addWidget(self.season)
            self.website = QtWidgets.QPushButton("View on website")
            self.website.clicked.connect(open_website)
            actions.addWidget(self.website)
            progress.addLayout(actions)
            help_button = QtWidgets.QPushButton("Import help")
            help_button.clicked.connect(lambda: open_help("desktop-app-import"))
            progress.addWidget(help_button)
            layout.addWidget(self.import_card)
            self.import_card.hide()
            self.local_error = QtWidgets.QLabel("")
            self.local_error.setWordWrap(True)
            self.local_error.setObjectName("error")
            layout.addWidget(self.local_error)

        def _card(self, title):
            frame = QtWidgets.QFrame()
            frame.setObjectName("card")
            layout = QtWidgets.QVBoxLayout(frame)
            layout.setContentsMargins(18, 14, 18, 14)
            heading = QtWidgets.QLabel(title)
            heading.setObjectName("h2")
            layout.addWidget(heading)
            return frame, layout

        def set_snapshot(self, snapshot):
            rows = snapshot.get("rows", [])
            known = [row for row in rows if parse_time(row.get("dateIso")) and row.get("gameId")
                     and not row.get("isResumed") and row.get("result")]
            last = max(known, key=lambda row: parse_time(row["dateIso"]), default=None)
            self.last_id = last.get("gameId") if last else None
            self.last_button.setEnabled(bool(self.last_id))
            if last:
                race = (last.get("races") or {}).get("opponent")
                against = f"vs {last.get('oppName') or 'Unknown opponent'}" + (f" ({race[0]})" if race else "")
                self.last.setText(f"{last.get('result')} {against} on {last.get('map') or 'Unknown map'} · {relative_time(last['dateIso'])}")
            else:
                self.last.setText("Your next synced game will appear here.")
            today = snapshot.get("today", {})
            net = today.get("netMmr")
            delta = f" · {net:+d} MMR" if isinstance(net, int) else ""
            self.today.setText(f"{today.get('wins', 0)}W–{today.get('losses', 0)}L · {today.get('games', 0)} games tracked today{delta}")
            self.history_note.setText("Older upload entries lack game details. This record includes locally tracked games only."
                                      if any(row.get("seeded") for row in rows) else "Local day; MMR compares consecutive games on the same ladder.")
            self.local_error.setText(snapshot.get("localError", ""))

        def set_progress(self, value, *, paused=False, connection="online"):
            phase = value.get("phase", "idle")
            self.import_card.setVisible(phase != "idle")
            held = paused or connection != "online"
            label = "Paused" if paused else "Waiting for connection" if connection != "online" else {
                "scanning": "Scanning", "importing": "Importing", "done": "Done"}.get(phase, "Scanning")
            self.import_phase.setText(label)
            total = max(0, int(value.get("total", 0)))
            processed = max(0, int(value.get("completed", 0)) + int(value.get("errors", 0)))
            self.bar.setRange(0, max(1, total) if phase == "done" else total)
            self.bar.setValue(max(1, total) if phase == "done" else min(processed, total))
            detail = f"{processed:,} of {total:,} replays" if total or phase == "done" else "Counting eligible replays…"
            if not held and phase == "importing":
                rate, eta = value.get("ratePerMinute"), value.get("etaSeconds")
                if isinstance(rate, (int, float)) and rate > 0:
                    detail += f" · {rate:.1f}/min"
                if isinstance(eta, (int, float)):
                    detail += f" · about {max(1, int(eta / 60 + .5))} min remaining"
            self.import_detail.setText(detail)
            self.pause.setText("Resume" if paused else "Pause")
            self.pause.setEnabled(phase != "done")

    return GameDashboard()

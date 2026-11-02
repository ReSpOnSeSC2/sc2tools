"""The status card's health view: a headline, one line per row and a grey footer.

Rendering only: the window decides what each action and help link does. Each
snapshot repaints the view, at most twice a second. A row keeps its line while
its id stays, so a live count never replaces a button mid-click.
"""
from ..health import GAMES_HELP, SYNC_HELP, HealthFacts, evaluate
from . import palette
from .help_links import help_button

# What the monitor says before any subsystem has reported.
STARTING = evaluate(HealthFacts(), 0.0)
ACTION_LABELS = {
    "link_pc": "Link PC", "retry_now": "Retry now", "add_folder": "Add folder",
    "set_player_name": "Set player name", "resume": "Resume", "open_obs_settings": "Open OBS settings",
    "install_update": "Install update", "restart_agent": "Restart agent", "copy_details": "Copy details",
    "open_log": "Open log",
}
_DOTS = {"error": (palette.RED, "Error"), "warn": (palette.AMBER, "Needs attention"),
         "info": (palette.CYAN, "Info"), "ok": (palette.GREEN, "OK")}
# A row with its own article gets a "?"; the headline's "?" covers the rest.
_ROW_HELP = {SYNC_HELP: "Sync problems", GAMES_HELP: "Why didn't my game show up?"}


def build_health_view(parent, *, QtCore, QtWidgets, status_help, run_action, open_row_help, row_tooltip):
    class Line(QtWidgets.QWidget):
        """A dot, the sentence, at most one action button and the row's own "?"."""

        def __init__(self):
            super().__init__()
            self.row = self.action_button = self.help_button = None
            self._layout = QtWidgets.QHBoxLayout(self)
            self._layout.setContentsMargins(0, 0, 0, 0)
            text = QtWidgets.QWidget()
            text_layout = QtWidgets.QHBoxLayout(text)
            text_layout.setContentsMargins(0, 0, 0, 0)
            self.dot = QtWidgets.QLabel("●")
            text_layout.addWidget(self.dot, 0, QtCore.Qt.AlignTop)
            self.sentence = QtWidgets.QLabel()
            self.sentence.setTextFormat(QtCore.Qt.PlainText)
            self.sentence.setWordWrap(True)
            text_layout.addWidget(self.sentence, 1)
            # Centred beside a taller button, with the dot on the sentence's first line.
            self._layout.addWidget(text, 1, QtCore.Qt.AlignVCenter)

        def show_row(self, row):
            """Paint ``row`` in place. The buttons are rebuilt only when its action or help changes."""
            old, self.row = self.row, row
            if old is None or old.level != row.level:
                color, level = _DOTS[row.level]
                self.dot.setStyleSheet("color: " + color)
                self.dot.setAccessibleName(level)
            self.sentence.setText(row.sentence)
            self.sentence.setToolTip(row_tooltip(row))
            if old is None or (old.action, old.help_slug) != (row.action, row.help_slug):
                self._build_buttons()

        def _build_buttons(self):
            for button in (self.action_button, self.help_button):
                if button is not None:
                    self._layout.removeWidget(button)
                    button.hide()
                    button.deleteLater()  # later, since its own click may still be running
            self.action_button = self.help_button = None
            # The handlers read the line's row when clicked, so they always act on what it shows.
            if self.row.action:
                self.action_button = QtWidgets.QPushButton(ACTION_LABELS[self.row.action])
                self.action_button.clicked.connect(lambda: run_action(self.row.action))
                self._layout.addWidget(self.action_button)
            if self.row.help_slug in _ROW_HELP:
                self.help_button = help_button(QtWidgets, _ROW_HELP[self.row.help_slug],
                                               lambda: open_row_help(self.row))
                self._layout.addWidget(self.help_button)

    class HealthView(QtWidgets.QWidget):
        def __init__(self):
            super().__init__(parent)
            self.lines = []
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(0, 0, 0, 0)
            layout.setSpacing(8)
            top = QtWidgets.QHBoxLayout()
            self.headline = QtWidgets.QLabel()
            self.headline.setObjectName("h2")
            self.headline.setWordWrap(True)
            self.headline.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
            top.addWidget(self.headline, 1)
            top.addWidget(status_help, 0, QtCore.Qt.AlignTop)
            layout.addLayout(top)
            self.rows = QtWidgets.QVBoxLayout()
            self.rows.setSpacing(6)
            layout.addLayout(self.rows)
            self.footer = QtWidgets.QLabel()
            self.footer.setObjectName("dim")
            self.footer.setTextFormat(QtCore.Qt.PlainText)
            self.footer.setWordWrap(True)
            layout.addWidget(self.footer)
            self.apply(STARTING)

        def apply(self, snapshot):
            self.snapshot = snapshot
            self.headline.setText(snapshot.headline)
            # Lines are keyed by row id, so a changing count keeps the line, its buttons and their focus.
            old = {line.row.id: line for line in self.lines}
            for line in self.lines:
                self.rows.removeWidget(line)
            self.lines = [old.pop(row.id) if row.id in old else Line() for row in snapshot.rows]
            for line in old.values():
                line.hide()
                line.deleteLater()  # later, since its own click may still be running
            for line, row in zip(self.lines, snapshot.rows):
                line.show_row(row)
                self.rows.addWidget(line)
            self.footer.setText(" ".join(row.sentence for row in snapshot.footer))
            self.footer.setVisible(bool(snapshot.footer))

    return HealthView()

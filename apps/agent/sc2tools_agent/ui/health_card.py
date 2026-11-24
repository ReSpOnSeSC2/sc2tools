"""The status card's health view: a headline, one line per row and a grey footer.

Rendering only: the window decides what each action and help link does. Each
snapshot repaints the view, at most twice a second. A row keeps its line while
its id stays, so a live count never replaces a button mid-click.
"""
from ..health import GAMES_HELP, SYNC_HELP, HealthFacts, evaluate
from . import palette, theme
from .help_links import help_button

# What the monitor says before any subsystem has reported.
STARTING = evaluate(HealthFacts(), 0.0)
ACTION_LABELS = {
    "link_pc": "Link PC", "finish_setup": "Finish setup", "retry_now": "Retry now", "add_folder": "Add folder",
    "set_player_name": "Set player name", "resume": "Resume", "open_obs_settings": "Open OBS settings",
    "restart_agent": "Restart agent", "copy_details": "Copy details",
    "open_log": "Open log",
}
_DOTS = {"error": (palette.RED, "Error"), "warn": (palette.AMBER, "Needs attention"),
         "info": (palette.CYAN, "Info"), "ok": (palette.GREEN, "OK")}
# A row with its own article gets a "?"; the headline's "?" covers the rest.
_ROW_HELP = {SYNC_HELP: "Sync problems", GAMES_HELP: "Why didn't my game show up?"}


def build_health_view(parent, *, QtCore, QtWidgets, status_help, run_action, open_row_help, row_tooltip,
                      header_actions=None):
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
        """The status hero: an orb, the headline and summary, the page's main actions, then the checklist."""

        def __init__(self):
            super().__init__(parent)
            self.lines = []
            self.snapshot = None
            self._expanded = False
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(0, 0, 0, 0)
            layout.setSpacing(theme.SPACE_M)
            # Side by side while the card is wide; the window flips it to a column when it is not.
            self.header = QtWidgets.QBoxLayout(QtWidgets.QBoxLayout.LeftToRight)
            self.header.setSpacing(theme.SPACE_L)
            identity = QtWidgets.QHBoxLayout()
            identity.setSpacing(theme.SPACE_M)
            self.orb = QtWidgets.QLabel("●")
            self.orb.setObjectName("statusOrb")
            identity.addWidget(self.orb, 0, QtCore.Qt.AlignTop)
            text = QtWidgets.QVBoxLayout()
            text.setSpacing(theme.SPACE_2XS)
            self.headline = QtWidgets.QLabel()
            self.headline.setObjectName("h2")
            self.headline.setWordWrap(True)
            self.headline.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
            text.addWidget(self.headline)
            self.summary = QtWidgets.QLabel()
            self.summary.setObjectName("muted")
            self.summary.setTextFormat(QtCore.Qt.PlainText)
            self.summary.setWordWrap(True)
            self.summary.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
            text.addWidget(self.summary)
            identity.addLayout(text, 1)
            identity.addWidget(status_help, 0, QtCore.Qt.AlignTop)
            self.header.addLayout(identity, 1)
            self.actions = header_actions
            if header_actions is not None:
                self.header.addWidget(header_actions, 0, QtCore.Qt.AlignTop | QtCore.Qt.AlignRight)
            layout.addLayout(self.header)
            # Everything that is fine tucks behind this; anything that needs you stays in view.
            self.details_toggle = QtWidgets.QPushButton()
            self.details_toggle.setObjectName("quietButton")
            self.details_toggle.setCheckable(True)
            self.details_toggle.setSizePolicy(QtWidgets.QSizePolicy.Maximum, QtWidgets.QSizePolicy.Fixed)
            self.details_toggle.toggled.connect(self._toggle_details)
            layout.addWidget(self.details_toggle, 0, QtCore.Qt.AlignLeft)
            self.details = QtWidgets.QWidget()
            details = QtWidgets.QVBoxLayout(self.details)
            details.setContentsMargins(0, 0, 0, 0)
            details.setSpacing(theme.SPACE_S)
            self.rows = QtWidgets.QVBoxLayout()
            self.rows.setSpacing(6)
            details.addLayout(self.rows)
            self.footer = QtWidgets.QLabel()
            self.footer.setObjectName("dim")
            self.footer.setTextFormat(QtCore.Qt.PlainText)
            self.footer.setWordWrap(True)
            layout.addWidget(self.details)
            layout.addWidget(self.footer)  # a note about what is off stays in view
            self.apply(STARTING)

        def set_stacked(self, stacked):
            """Put the main actions under the headline (a narrow card) or beside it."""
            self.header.setDirection(QtWidgets.QBoxLayout.TopToBottom if stacked else QtWidgets.QBoxLayout.LeftToRight)
            if self.actions is not None:
                self.header.setAlignment(self.actions, QtCore.Qt.AlignLeft if stacked else QtCore.Qt.AlignRight | QtCore.Qt.AlignTop)

        def _toggle_details(self, expanded):
            self._expanded = expanded
            self._sync_details()

        def _sync_details(self):
            fine = self.snapshot is not None and self.snapshot.level == "ok" and bool(self.snapshot.rows)
            self.details_toggle.setVisible(fine)
            self.details_toggle.setText("Hide details" if self._expanded else "Show details")
            self.details_toggle.setAccessibleName("Hide status details" if self._expanded else "Show status details")
            self.details.setVisible(not fine or self._expanded)

        def apply(self, snapshot):
            self.snapshot = snapshot
            self.headline.setText(snapshot.headline)
            color, level = _DOTS.get(snapshot.level, _DOTS["ok"])
            self.orb.setStyleSheet("color: " + color)
            self.orb.setAccessibleName(level)
            total = len(snapshot.rows)
            passing = sum(row.level == "ok" for row in snapshot.rows)
            self.summary.setText("" if not total else f"All {total} checks are passing." if passing == total
                                 else f"{passing} of {total} checks are passing.")
            self.summary.setVisible(bool(total))
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
            self._sync_details()

    return HealthView()

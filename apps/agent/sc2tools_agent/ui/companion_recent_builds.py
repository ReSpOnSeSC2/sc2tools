"""Each player's recent games in the Companion's floating scouting report.

Imports PySide6 at load time; the scouting panel imports this module only
when it builds its window.
"""
from __future__ import annotations

from PySide6 import QtCore, QtWidgets

from . import theme
from .build_checkin_widgets import set_tone
from .private_scouting import ElidedText

# Two readable columns need about 230 px each. Narrower than that they stack,
# the opponent's games first: at the smallest window they are what a player
# opens the report for, and their own games are one scroll further down.
STACK_BELOW_WIDTH = 472
SIDE_BY_SIDE = ("my", "opp")
STACKED = ("opp", "my")
RESULT_COLUMN_WIDTH = 30


def _plain_label(name: str, text: str = "") -> QtWidgets.QLabel:
    label = QtWidgets.QLabel(text)
    label.setObjectName(name)
    label.setTextFormat(QtCore.Qt.PlainText)
    label.setWordWrap(True)
    label.setMinimumWidth(0)
    return label


def _elided_label(name: str, text: str) -> ElidedText:
    label = ElidedText()
    label.setObjectName(name)
    label.set_full_text(text)
    return label


class GameRow(QtWidgets.QPushButton):
    """One earlier game: the owner's result, the build, then map and age."""

    def __init__(self, model) -> None:
        super().__init__()
        self.model = model
        self.setObjectName("recentBuildRow")
        self.setCheckable(True)
        self.setCursor(QtCore.Qt.PointingHandCursor)
        self.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Fixed)
        self.setAccessibleName(model.summary)
        self.setToolTip(model.summary)
        self.marker = QtWidgets.QFrame()
        self.marker.setObjectName("recentBuildMarker")
        self.marker.setFixedWidth(3)
        self.result = _plain_label("recentBuildResult", model.result)
        self.result.setProperty("result", model.result)
        self.build = _elided_label("recentBuildName", model.build)
        self.details = _elided_label("recentBuildDetails", model.details)
        grid = QtWidgets.QGridLayout(self)
        grid.setContentsMargins(theme.SPACE_XS, theme.SPACE_XS, theme.SPACE_S, theme.SPACE_XS)
        grid.setHorizontalSpacing(6)
        grid.setVerticalSpacing(0)
        grid.setColumnMinimumWidth(1, RESULT_COLUMN_WIDTH)
        grid.setColumnStretch(2, 1)
        grid.addWidget(self.marker, 0, 0, 2, 1)
        grid.addWidget(self.result, 0, 1)
        grid.addWidget(self.build, 0, 2)
        grid.addWidget(self.details, 1, 2)
        # The row is the control; its parts must not swallow the click.
        for part in (self.marker, self.result, self.build, self.details):
            part.setAttribute(QtCore.Qt.WA_TransparentForMouseEvents)
        self.toggled.connect(self._mark_chosen)

    def _mark_chosen(self, chosen: bool) -> None:
        # A marker and the build name reinforce the selected row.
        for part in (self.marker, self.build):
            set_tone(part, "selected", "true" if chosen else "false")

    def sizeHint(self) -> QtCore.QSize:  # noqa: N802 (Qt API)
        # A push button sizes itself from its own (empty) text otherwise.
        return self.layout().sizeHint()

    def minimumSizeHint(self) -> QtCore.QSize:  # noqa: N802 (Qt API)
        return QtCore.QSize(0, self.layout().sizeHint().height())


class GameColumn(QtWidgets.QWidget):
    """One player's heading and games; ``picked`` fires when the player chooses one."""

    picked = QtCore.Signal()

    def __init__(self) -> None:
        super().__init__()
        self.model = None
        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(3)
        self.heading = _plain_label("companionAccent")
        self.empty = _plain_label("companionMuted")
        layout.addWidget(self.heading)
        layout.addWidget(self.empty)
        self.rows_layout = QtWidgets.QVBoxLayout()
        self.rows_layout.setSpacing(theme.SPACE_2XS)
        layout.addLayout(self.rows_layout)
        layout.addStretch(1)
        self.group = QtWidgets.QButtonGroup(self)
        self.group.buttonClicked.connect(lambda _row: self.picked.emit())

    def rows(self) -> list:
        return self.group.buttons()

    def selected(self):
        row = self.group.checkedButton()
        return row.model if row is not None else None

    def set_model(self, model, *, keep_selection: bool) -> None:
        kept = self.selected() if keep_selection else None
        self.model = model
        self.heading.setText(model.heading)
        self.empty.setText(model.empty_text)
        self.empty.setVisible(bool(model.empty_text))
        self._replace_rows(model.rows)
        rows = self.rows()
        same_game = [row for row in rows if kept is not None and kept.game_id and row.model.game_id == kept.game_id]
        # The newest game opens first; a pick survives a refresh of the same list.
        for row in (same_game or rows)[:1]:
            row.setChecked(True)

    def _replace_rows(self, models) -> None:
        for row in self.rows():
            self.group.removeButton(row)
            # Detach now: a deferred delete alone leaves the old row drawn
            # over the new ones until the event loop gets to it.
            row.setParent(None)
            row.deleteLater()
        for model in models:
            row = GameRow(model)
            self.group.addButton(row)
            self.rows_layout.addWidget(row)


class RecentBuilds(QtWidgets.QWidget):
    """Two columns of selectable games; ``gameSelected(side)`` follows a pick."""

    gameSelected = QtCore.Signal(str)

    def __init__(self, parent: QtWidgets.QWidget) -> None:
        super().__init__(parent)
        self.setObjectName("companionRecentBuilds")
        self.setAccessibleName("Each player's last five games")
        self.setStyleSheet(theme.RECENT_BUILDS_STYLE)
        self.setMinimumWidth(0)
        self._stacked = None
        self.grid = QtWidgets.QGridLayout(self)
        self.grid.setContentsMargins(0, 0, 0, 0)
        self.grid.setSpacing(theme.SPACE_S)
        self.grid.setColumnStretch(0, 1)
        self.columns = {side: GameColumn() for side in SIDE_BY_SIDE}
        for side, column in self.columns.items():
            column.picked.connect(lambda chosen=side: self.gameSelected.emit(chosen))
        self._reflow()

    def set_columns(self, models, *, keep_selection: bool = True) -> None:
        """Draw both columns. ``models`` maps ``my`` and ``opp`` to a column model."""
        for side, column in self.columns.items():
            if models[side] != column.model or not keep_selection:
                column.set_model(models[side], keep_selection=keep_selection)

    def selected(self, side: str):
        """The chosen game's row model, or None when the side has no games."""
        return self.columns[side].selected()

    def resizeEvent(self, event) -> None:  # noqa: N802 (Qt API)
        super().resizeEvent(event)
        self._reflow()

    def _reflow(self) -> None:
        stacked = self.width() < STACK_BELOW_WIDTH
        if stacked == self._stacked:
            return
        self._stacked = stacked
        for column in self.columns.values():
            self.grid.removeWidget(column)
        for index, side in enumerate(STACKED if stacked else SIDE_BY_SIDE):
            self.grid.addWidget(self.columns[side], index if stacked else 0, 0 if stacked else index)
        self.grid.setColumnStretch(1, 0 if stacked else 1)

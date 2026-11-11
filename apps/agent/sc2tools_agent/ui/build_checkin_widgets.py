"""Widgets shared by the build check-in cards.

* :class:`BuildRow` — one pickable build, painted as plain text. Compact
  rows elide names; expanded rows wrap the full name above the record
  and the Rolled / Usual / Suggested chips.
* :class:`BuildList` — the "Your builds" rows, a **More builds…**
  expander with a scrollable list of every other option, and on the end
  card a search box. Rows keep their first-paint order for the life of
  one card: later models update rows in place and only ever append. The
  section titles and search copy are parameters, so the end card's
  opponent list ("Faced before" / "All builds") reuses it.

Imports PySide6 at load time; only the GUI path imports this module.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

from PySide6 import QtCore, QtGui, QtWidgets

from . import theme

ROW_HEIGHT = theme.CHECKIN_ROW_HEIGHT
ROW_SPACING = theme.SPACE_2XS
MORE_VISIBLE_ROWS = 6
"""Rows the **More builds…** list shows before it scrolls."""

ROLLED_CHIP = "Rolled"
USUAL_CHIP = "Usual"
SUGGESTED_CHIP = "Suggested"
MAX_ROW_CHIPS = 2

FEATURED_TITLE = "YOUR BUILDS"
MORE_TITLE = "BUILDS"
MORE_TOGGLE = "More builds…"
FEWER_TOGGLE = "Fewer builds"
SEARCH_PLACEHOLDER = "Search builds"
NO_MATCH = "No builds match your search."


def plain_label(
    text: str = "",
    name: Optional[str] = None,
    *,
    wrap: bool = False,
) -> QtWidgets.QLabel:
    """A label that never interprets its text as rich text."""
    label = QtWidgets.QLabel()
    label.setTextFormat(QtCore.Qt.PlainText)
    label.setText(text)
    label.setWordWrap(wrap)
    if name:
        label.setObjectName(name)
    return label


def set_tone(widget: QtWidgets.QWidget, prop: str, value: str) -> None:
    """Change a style-sheet property and repolish only when it changed."""
    if widget.property(prop) == value:
        return
    widget.setProperty(prop, value)
    style = widget.style()
    style.unpolish(widget)
    style.polish(widget)


def button(
    text: str,
    name: Optional[str] = None,
    *,
    focusable: bool = True,
) -> QtWidgets.QPushButton:
    widget = QtWidgets.QPushButton(text)
    if name:
        widget.setObjectName(name)
    widget.setCursor(QtCore.Qt.PointingHandCursor)
    widget.setAutoDefault(False)
    if not focusable:
        widget.setFocusPolicy(QtCore.Qt.NoFocus)
    return widget


def link(text: str, *, focusable: bool = True) -> QtWidgets.QPushButton:
    """A text-only button styled as an inline link."""
    widget = button(text, "checkinLink", focusable=focusable)
    widget.setFlat(True)
    widget.setSizePolicy(QtWidgets.QSizePolicy.Maximum, QtWidgets.QSizePolicy.Fixed)
    return widget


def row_chips(
    option,
    *,
    reason_label: Optional[str] = None,
    reason: Optional[str] = None,
) -> List[Tuple[str, str]]:
    """``(text, tone)`` chips for one row, strongest first, at most two.

    ``reason_label`` is set on the row the card pre-selected (why it is
    selected); it makes the matching Rolled / Usual / Suggested chip
    redundant.
    """
    chips: List[Tuple[str, str]] = []
    if reason_label:
        chips.append((reason_label, "reason"))
    if option.rolled and reason != "randomizer":
        chips.append((ROLLED_CHIP, "rolled"))
    if option.suggested and not reason_label:
        chips.append((SUGGESTED_CHIP, "suggested"))
    if option.usual and reason != "usual":
        chips.append((USUAL_CHIP, "usual"))
    return chips[:MAX_ROW_CHIPS]


class BuildRow(QtWidgets.QAbstractButton):
    """One build. Painted by hand so every string stays plain text."""

    height_changed = QtCore.Signal()

    def __init__(
        self,
        option,
        *,
        selectable: bool,
        focusable: bool,
        parent: Optional[QtWidgets.QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self.key: str = option.key
        self.name = ""
        self.record = ""
        self.chips: List[Tuple[str, str]] = []
        self._names_expanded = False
        self._selectable = selectable
        self.setObjectName("checkinRow")
        self.setCheckable(selectable)
        self.setCursor(QtCore.Qt.PointingHandCursor)
        self.setFocusPolicy(QtCore.Qt.StrongFocus if focusable else QtCore.Qt.NoFocus)
        self.setSizePolicy(QtWidgets.QSizePolicy.Expanding, QtWidgets.QSizePolicy.Fixed)
        self.setFixedHeight(ROW_HEIGHT)
        self.setAttribute(QtCore.Qt.WA_Hover, True)
        self.set_option(option)

    def set_option(
        self,
        option,
        *,
        reason_label: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> None:
        chips = row_chips(option, reason_label=reason_label, reason=reason)
        if (option.name, option.record, chips) == (self.name, self.record, self.chips):
            return
        self.name = option.name
        self.record = option.record
        self.chips = chips
        # ``text`` feeds accessibility and tests; painting never uses it
        # as markup.
        self.setText(option.name)
        description = option.accessible_name
        if reason_label:
            description = f"{description}, {reason_label}"
        self.setAccessibleName(description)
        self._refresh_tooltip()
        self._refresh_height()
        self.update()

    # ------------------------------------------------------------ paint

    def sizeHint(self) -> QtCore.QSize:  # noqa: N802 — Qt API
        return QtCore.QSize(220, self.height())

    def set_names_expanded(self, expanded: bool) -> None:
        self._names_expanded = expanded
        self._refresh_height()
        self._refresh_tooltip()
        self.update()

    def _name_layout(self) -> QtGui.QTextLayout:
        """Use the same line breaks when measuring and painting, even for
        names without spaces. QTextLayout always treats names as plain text.
        """
        name_font, _chip = self._fonts()
        text = QtGui.QTextLayout(self.name, name_font)
        options = QtGui.QTextOption()
        options.setWrapMode(QtGui.QTextOption.WrapAtWordBoundaryOrAnywhere)
        text.setTextOption(options)
        left = 30 if self._selectable else 10
        width = max(1, self.width() - left - 10)
        text.beginLayout()
        y = 0.0
        while True:
            line = text.createLine()
            if not line.isValid():
                break
            line.setLineWidth(width)
            line.setPosition(QtCore.QPointF(0, y))
            y += line.height()
        text.endLayout()
        return text

    def _refresh_height(self) -> None:
        height = ROW_HEIGHT
        if self._names_expanded:
            text_height = self._name_layout().boundingRect().height()
            metadata_height = 22 if self.chips or self.record else 0
            height = max(ROW_HEIGHT, int(text_height + 0.999) + 12 + metadata_height)
        if self.height() != height:
            self.setFixedHeight(height)
            self.height_changed.emit()

    def resizeEvent(self, event: QtGui.QResizeEvent) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._refresh_height()
        self._refresh_tooltip()

    def enterEvent(self, event: QtGui.QEnterEvent) -> None:  # noqa: N802
        super().enterEvent(event)
        self.update()

    def leaveEvent(self, event: QtCore.QEvent) -> None:  # noqa: N802
        super().leaveEvent(event)
        self.update()

    def _fonts(self) -> Tuple[QtGui.QFont, QtGui.QFont]:
        name_font = QtGui.QFont(self.font())
        name_font.setPixelSize(theme.TYPE_BODY)
        chip_font = QtGui.QFont(self.font())
        chip_font.setPixelSize(theme.TYPE_CAPTION)
        chip_font.setWeight(QtGui.QFont.DemiBold)
        return name_font, chip_font

    def _layout(self) -> Tuple[int, int, List[Tuple[QtCore.QRect, str, str]], QtCore.QRect]:
        """``(name_left, name_right, chip rects, record rect)``."""
        name_font, chip_font = self._fonts()
        rect = self.rect().adjusted(10, 0, -10, 0)
        right = rect.right()
        record_rect = QtCore.QRect()
        if self.record:
            width = QtGui.QFontMetrics(name_font).horizontalAdvance(self.record)
            record_rect = QtCore.QRect(
                right - width + 1, self.height() - 25 if self._names_expanded else 0,
                width, 22 if self._names_expanded else self.height(),
            )
            right -= width + 8
        chips: List[Tuple[QtCore.QRect, str, str]] = []
        metrics = QtGui.QFontMetrics(chip_font)
        for text, tone in reversed(self.chips):
            width = metrics.horizontalAdvance(text) + 12
            chip_rect = QtCore.QRect(
                right - width + 1,
                self.height() - 23 if self._names_expanded else (self.height() - 16) // 2,
                width, 16,
            )
            chips.insert(0, (chip_rect, text, tone))
            right -= width + 4
        left = rect.left() + (20 if self._selectable else 0)
        return left, right - 4, chips, record_rect

    def _refresh_tooltip(self) -> None:
        if self._names_expanded:
            self.setToolTip("")
            return
        name_font, _chip = self._fonts()
        left, right, _chips, _record = self._layout()
        fits = QtGui.QFontMetrics(name_font).horizontalAdvance(self.name) <= max(0, right - left)
        self.setToolTip("" if fits else self.name)

    def _row_colours(self, skin: theme.Skin) -> Tuple[str, Optional[str]]:
        if self.isChecked():
            return skin.selected, skin.accent
        if self.isDown():
            return theme.BUTTON_PRESSED, theme.BORDER_STRONG
        if self.isEnabled() and self.underMouse():
            return theme.SUBTLE, theme.BORDER_STRONG
        return theme.ELEVATED, None

    def _skin(self) -> theme.Skin:
        parent = self.parentWidget()
        while parent is not None:
            name = parent.property("checkinSkin")
            if name in theme.SKINS:
                return theme.SKINS[name]
            parent = parent.parentWidget()
        return theme.DEFAULT_SKIN

    def paintEvent(self, _event: QtGui.QPaintEvent) -> None:  # noqa: N802
        skin = self._skin()
        painter = QtGui.QPainter(self)
        painter.setRenderHint(QtGui.QPainter.Antialiasing, True)
        rect = QtCore.QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        fill, border = self._row_colours(skin)
        if self.hasFocus():
            border = skin.focus
        painter.setPen(QtGui.QPen(QtGui.QColor(border), 1) if border else QtCore.Qt.NoPen)
        painter.setBrush(QtGui.QColor(fill))
        painter.drawRoundedRect(rect, theme.RADIUS_M, theme.RADIUS_M)
        if self._selectable:
            self._paint_choice(painter, skin)
        self._paint_labels(painter, skin)
        painter.end()

    def _paint_choice(self, painter, skin):
        dot = QtCore.QRectF(10.5, 8 if self._names_expanded else (self.height() - 12) / 2, 12, 12)
        color = QtGui.QColor(skin.accent if self.isChecked() else theme.TEXT_DIM)
        painter.setPen(QtGui.QPen(color, 1.4))
        painter.setBrush(QtCore.Qt.NoBrush)
        painter.drawEllipse(dot)
        if self.isChecked():
            painter.setPen(QtCore.Qt.NoPen)
            painter.setBrush(color)
            painter.drawEllipse(dot.adjusted(3, 3, -3, -3))

    def _paint_labels(self, painter, skin):
        name_font, chip_font = self._fonts()
        left, right, chips, record_rect = self._layout()
        painter.setFont(name_font)
        painter.setPen(QtGui.QColor(theme.TEXT if self.isEnabled() else theme.TEXT_DIM))
        if self._names_expanded:
            self._name_layout().draw(painter, QtCore.QPointF(left, 6))
        else:
            metrics = QtGui.QFontMetrics(name_font)
            name_rect = QtCore.QRect(left, 0, max(0, right - left), self.height())
            elided = metrics.elidedText(self.name, QtCore.Qt.ElideRight, name_rect.width())
            painter.drawText(name_rect, QtCore.Qt.AlignVCenter | QtCore.Qt.AlignLeft, elided)

        painter.setFont(chip_font)
        for chip_rect, text, tone in chips:
            background, foreground = theme.checkin_chip_colours(skin, tone)
            painter.setPen(QtCore.Qt.NoPen)
            painter.setBrush(QtGui.QColor(background))
            painter.drawRoundedRect(QtCore.QRectF(chip_rect), theme.RADIUS_L, theme.RADIUS_L)
            painter.setPen(QtGui.QColor(foreground))
            painter.drawText(chip_rect, QtCore.Qt.AlignCenter, text)

        if self.record:
            painter.setFont(name_font)
            painter.setPen(QtGui.QColor(theme.TEXT_MUTED if self.isEnabled() else theme.TEXT_DIM))
            painter.drawText(record_rect, QtCore.Qt.AlignVCenter | QtCore.Qt.AlignRight, self.record)


class BuildList(QtWidgets.QWidget):
    """Featured rows + **More builds…** + (end card) search.

    ``picked(key)`` fires when the player clicks a row. On the end card
    rows are exclusive radio-style choices; :meth:`selection` returns
    the checked key.
    """

    picked = QtCore.Signal(str)
    searched = QtCore.Signal(str)
    expanded = QtCore.Signal(bool)
    names_expanded = QtCore.Signal(bool)

    def __init__(
        self,
        *,
        selectable: bool,
        searchable: bool,
        focusable: bool,
        featured_title: str = FEATURED_TITLE,
        more_title: str = MORE_TITLE,
        more_toggle: str = MORE_TOGGLE,
        search_placeholder: str = SEARCH_PLACEHOLDER,
        no_match: str = NO_MATCH,
        parent: Optional[QtWidgets.QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self._selectable = selectable
        self._focusable = focusable
        self._more_text = more_toggle
        self._no_match = no_match
        self._rows: Dict[str, BuildRow] = {}
        self._featured: List[str] = []
        self._more: List[str] = []
        self._filter = ""
        self._group: Optional[QtWidgets.QButtonGroup] = None
        if selectable:
            self._group = QtWidgets.QButtonGroup(self)
            self._group.setExclusive(True)

        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(theme.SPACE_XS)

        self.names_toggle = button("Expand build names", "checkinMoreToggle", focusable=focusable)
        self.names_toggle.setCheckable(True)
        self.names_toggle.setFlat(True)
        self.names_toggle.setSizePolicy(QtWidgets.QSizePolicy.Maximum, QtWidgets.QSizePolicy.Fixed)
        self.names_toggle.setToolTip("Show complete build names with badges and records below")
        self.names_toggle.toggled.connect(self._on_names_toggled)
        layout.addWidget(self.names_toggle)

        self.search: Optional[QtWidgets.QLineEdit] = None
        if searchable:
            self.search = QtWidgets.QLineEdit()
            self.search.setObjectName("checkinSearch")
            self.search.setPlaceholderText(search_placeholder)
            self.search.setAccessibleName(search_placeholder)
            self.search.setClearButtonEnabled(True)
            self.search.textEdited.connect(self._on_search_edited)
            self.search.returnPressed.connect(self._pick_first_visible)
            self.search.installEventFilter(self)
            layout.addWidget(self.search)

        self.featured_label = plain_label(featured_title, "checkinSection")
        layout.addWidget(self.featured_label)
        self._featured_box = QtWidgets.QWidget()
        self._featured_layout = QtWidgets.QVBoxLayout(self._featured_box)
        self._featured_layout.setContentsMargins(0, 0, 0, 0)
        self._featured_layout.setSpacing(ROW_SPACING)
        layout.addWidget(self._featured_box)

        self.more_toggle = button(more_toggle, "checkinMoreToggle", focusable=focusable)
        self.more_toggle.setCheckable(True)
        self.more_toggle.setFlat(True)
        self.more_toggle.setSizePolicy(QtWidgets.QSizePolicy.Maximum, QtWidgets.QSizePolicy.Fixed)
        self.more_toggle.toggled.connect(self._on_more_toggled)
        layout.addWidget(self.more_toggle)

        self.more_label = plain_label(more_title, "checkinSection")
        layout.addWidget(self.more_label)
        self.more_area = QtWidgets.QScrollArea()
        self.more_area.setWidgetResizable(True)
        self.more_area.setFrameShape(QtWidgets.QFrame.NoFrame)
        self.more_area.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
        if not focusable:
            self.more_area.setFocusPolicy(QtCore.Qt.NoFocus)
        more_box = QtWidgets.QWidget()
        self._more_layout = QtWidgets.QVBoxLayout(more_box)
        self._more_layout.setContentsMargins(0, 0, theme.SPACE_XS, 0)
        self._more_layout.setSpacing(ROW_SPACING)
        self._more_layout.addStretch(1)
        self.more_area.setWidget(more_box)
        layout.addWidget(self.more_area)

        self.empty_label = plain_label("", "checkinMuted", wrap=True)
        layout.addWidget(self.empty_label)
        self._sync_sections()

    # ------------------------------------------------------------ rows

    def reset(self) -> None:
        """Forget every row (a different game or card)."""
        for row in self._rows.values():
            if self._group is not None:
                self._group.removeButton(row)
            row.setParent(None)
            row.deleteLater()
        self._rows.clear()
        self._featured.clear()
        self._more.clear()
        self._filter = ""
        if self.search is not None:
            self.search.clear()
        self.more_toggle.blockSignals(True)
        self.more_toggle.setChecked(False)
        self.more_toggle.blockSignals(False)
        self._sync_sections()

    def set_rows(
        self,
        featured: Sequence,
        more: Sequence,
        *,
        reason_key: Optional[str] = None,
        reason_label: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> None:
        """Paint ``featured`` / ``more``. Known keys update in place and
        keep their position; new keys are appended to their section."""
        for options, keys, box in (
            (featured, self._featured, self._featured_layout),
            (more, self._more, self._more_layout),
        ):
            for option in options:
                row = self._rows.get(option.key)
                label = reason_label if option.key == reason_key else None
                if row is None:
                    row = BuildRow(
                        option, selectable=self._selectable, focusable=self._focusable,
                    )
                    row.set_option(option, reason_label=label, reason=reason)
                    row.set_names_expanded(self.names_toggle.isChecked())
                    row.height_changed.connect(self._sync_sections)
                    row.clicked.connect(lambda _checked=False, k=option.key: self._on_row_clicked(k))
                    if self._group is not None:
                        self._group.addButton(row)
                    row.installEventFilter(self)
                    self._rows[option.key] = row
                    keys.append(option.key)
                    if box is self._more_layout:
                        box.insertWidget(box.count() - 1, row)
                    else:
                        box.addWidget(row)
                else:
                    row.set_option(option, reason_label=label, reason=reason)
        self._apply_filter()
        self._sync_sections()

    def keys(self) -> Tuple[List[str], List[str]]:
        """``(featured, more)`` keys in on-screen order."""
        return list(self._featured), list(self._more)

    def row(self, key: str) -> Optional[BuildRow]:
        return self._rows.get(key)

    def has_rows(self) -> bool:
        return bool(self._rows)

    def set_rows_enabled(self, enabled: bool) -> None:
        for row in self._rows.values():
            row.setEnabled(enabled)
        if self.search is not None:
            self.search.setEnabled(enabled)

    # ------------------------------------------------------- selection

    def selection(self) -> Optional[str]:
        for key, row in self._rows.items():
            if row.isChecked():
                return key
        return None

    def set_selection(self, key: Optional[str]) -> None:
        if self._group is None:
            return
        row = self._rows.get(key) if key else None
        if row is not None:
            row.setChecked(True)
            if key in self._more and not self.more_toggle.isChecked() and self._featured:
                self.set_expanded(True)
            return
        # An exclusive group refuses to uncheck its last button.
        self._group.setExclusive(False)
        for each in self._rows.values():
            each.setChecked(False)
        self._group.setExclusive(True)

    def ensure_visible(self, key: Optional[str]) -> None:
        row = self._rows.get(key) if key else None
        if row is not None and key in self._more:
            self.more_area.ensureWidgetVisible(row, 0, 4)

    # ------------------------------------------------------ full names

    def set_names_expanded(self, expanded: bool) -> None:
        self.names_toggle.setChecked(expanded)

    def _on_names_toggled(self, checked: bool) -> None:
        self.names_toggle.setText("Compact build names" if checked else "Expand build names")
        for row in self._rows.values():
            row.set_names_expanded(checked)
        self._sync_sections()
        self.names_expanded.emit(checked)

    # ----------------------------------------------------------- more

    def is_expanded(self) -> bool:
        return self.more_toggle.isChecked()

    def set_expanded(self, expanded: bool) -> None:
        self.more_toggle.setChecked(expanded)

    def _on_more_toggled(self, checked: bool) -> None:
        self._sync_sections()
        self.expanded.emit(checked)

    # --------------------------------------------------------- search

    def set_filter(self, text: str) -> None:
        self._filter = text.strip().casefold()
        self._apply_filter()
        self._sync_sections()

    def _on_search_edited(self, text: str) -> None:
        self.set_filter(text)
        self.searched.emit(text)

    def _first_visible_row(self):
        keys = self.visible_keys()
        return self._rows[keys[0]] if keys else None

    def _focus_first_visible(self) -> None:
        row = self._first_visible_row()
        if row is not None and row.isEnabled():
            row.setFocus(QtCore.Qt.TabFocusReason)
            self.ensure_visible(row.key)

    def _pick_first_visible(self) -> None:
        row = self._first_visible_row()
        if row is not None and row.isEnabled():
            row.click()
            # A preview action can close the card; do not steal focus back.
            if self.isVisible():
                self._focus_first_visible()

    def eventFilter(self, watched, event) -> bool:  # noqa: N802
        if event.type() == QtCore.QEvent.KeyPress and not event.modifiers():
            if watched is self.search and event.key() == QtCore.Qt.Key_Down:
                self._focus_first_visible()
                return True
            if watched is self._first_visible_row() and event.key() == QtCore.Qt.Key_Up and self.search is not None:
                self.search.setFocus(QtCore.Qt.TabFocusReason)
                return True
        return super().eventFilter(watched, event)

    def _matches(self, key: str) -> bool:
        return not self._filter or self._filter in self._rows[key].name.casefold()

    def _apply_filter(self) -> None:
        for key, row in self._rows.items():
            row.setVisible(self._matches(key))

    def visible_keys(self) -> List[str]:
        """Keys a player can currently see or scroll to, in order."""
        featured = [key for key in self._featured if self._matches(key)]
        more = [key for key in self._more if self._matches(key)]
        if self._filter:
            return featured + more
        if self._featured and not self.more_toggle.isChecked():
            return featured
        return featured + more

    # ------------------------------------------------------- sections

    def _sync_sections(self) -> None:
        searching = bool(self._filter)
        featured_hits = sum(1 for key in self._featured if self._matches(key))
        more_hits = sum(1 for key in self._more if self._matches(key))
        show_featured = featured_hits > 0
        self.names_toggle.setVisible(bool(featured_hits or more_hits))
        # Without featured rows the full list is the list: no expander.
        expander = bool(self._featured) and bool(self._more) and not searching
        show_more = more_hits > 0 and (
            searching or not self._featured or self.more_toggle.isChecked()
        )
        self.featured_label.setVisible(show_featured and not searching)
        self._featured_box.setVisible(show_featured)
        self.more_toggle.setVisible(expander)
        if expander:
            self.more_toggle.setText(
                (FEWER_TOGGLE if self.more_toggle.isChecked() else self._more_text)
                + f"  ({len(self._more)})"
            )
        self.more_label.setVisible(show_more and not self._featured and not searching)
        self.more_area.setVisible(show_more)
        heights = [self._rows[key].height() for key in self._more if self._matches(key)]
        content_height = sum(heights) + max(0, len(heights) - 1) * ROW_SPACING
        # Keep a bounded viewport; every expanded row remains scrollable.
        max_height = MORE_VISIBLE_ROWS * (60 if self.names_toggle.isChecked() else ROW_HEIGHT + ROW_SPACING) - ROW_SPACING
        self.more_area.setFixedHeight(
            min(content_height, max_height),
        )
        if searching and not featured_hits and not more_hits:
            self.empty_label.setText(self._no_match)
            self.empty_label.setVisible(True)
        else:
            self.empty_label.setVisible(False)

    def _on_row_clicked(self, key: str) -> None:
        self.picked.emit(key)


__all__ = [
    "BuildList",
    "BuildRow",
    "MORE_VISIBLE_ROWS",
    "ROW_HEIGHT",
    "button",
    "link",
    "plain_label",
    "row_chips",
    "set_tone",
]

"""Widgets shared by the build check-in cards.

* :func:`card_stylesheet` — the cards' self-contained dark style, built
  from the shared Companion theme. It is set on each card window,
  so it wins over the application style sheet inside the card.
* :class:`BuildRow` — one pickable build, painted by hand: the name is
  drawn as plain text (never rich text), elided to fit, with the record
  and the Rolled / Usual / Suggested chips on the right.
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

from .theme import (
    ACCENT as _ACCENT,
    ACCENT_CYAN as _ACCENT_CYAN,
    ACCENT_HOVER as _ACCENT_HOVER,
    BORDER as _BORDER,
    BORDER_STRONG as _BORDER_STRONG,
    BUTTON as _BUTTON,
    BUTTON_CHECKED as _BUTTON_CHECKED,
    BUTTON_HOVER as _BUTTON_HOVER,
    DANGER as _DANGER,
    ELEVATED as _ELEVATED,
    FOCUS as _FOCUS,
    SUBTLE as _SUBTLE,
    SUCCESS as _SUCCESS,
    SURFACE as _SURFACE,
    TEXT as _TEXT,
    TEXT_DIM as _TEXT_DIM,
    TEXT_MUTED as _TEXT_MUTED,
    WARNING as _WARNING,
)

ROW_HEIGHT = 30
ROW_SPACING = 2
MORE_VISIBLE_ROWS = 6
"""Rows the **More builds…** list shows before it scrolls."""

CHIP_TONES: Dict[str, Tuple[str, str]] = {
    # tone → (background, foreground)
    "rolled": ("rgba(230, 180, 80, 0.18)", _WARNING),
    "usual": (_SUBTLE, _ACCENT),
    "reason": ("rgba(62, 192, 199, 0.18)", _ACCENT_CYAN),
    "suggested": ("rgba(62, 192, 199, 0.12)", _ACCENT_CYAN),
}

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


def card_stylesheet() -> str:
    """The cards' style sheet (Companion palette, compact sizes)."""
    return f"""
QWidget {{
    background-color: transparent;
    color: {_TEXT};
    font-family: 'Segoe UI', 'Inter', system-ui, -apple-system, Arial, sans-serif;
    font-size: 12px;
}}
QFrame#card {{
    background-color: {_SURFACE};
    border: 1px solid {_BORDER_STRONG};
    border-radius: 14px;
}}
QLabel {{
    background-color: transparent;
    border: none;
}}
QLabel#checkinPreview {{
    color: {_ACCENT_CYAN};
    background-color: {_SUBTLE};
    border: 1px solid {_BORDER_STRONG};
    border-radius: 6px;
    padding: 3px 6px;
}}
QLabel#checkinEyebrow {{
    color: {_TEXT_MUTED};
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1px;
}}
QLabel#checkinTitle {{
    font-size: 14px;
    font-weight: 600;
}}
QLabel#checkinResult {{
    font-size: 14px;
    font-weight: 700;
    color: {_TEXT_MUTED};
}}
QLabel#checkinResult[tone="success"] {{ color: {_SUCCESS}; }}
QLabel#checkinResult[tone="danger"] {{ color: {_DANGER}; }}
QLabel#checkinGrip {{
    color: {_TEXT_DIM};
    font-size: 14px;
}}
QLabel#checkinMuted, QLabel#checkinSection, QLabel#checkinCounter {{
    color: {_TEXT_MUTED};
}}
QLabel#checkinSection {{
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1px;
}}
QLabel#checkinCounter {{ font-size: 11px; }}
QLabel#checkinCounter[tone="warning"] {{ color: {_WARNING}; }}
QLabel#checkinCounter[tone="danger"] {{ color: {_DANGER}; }}
QLabel#checkinStatus {{ color: {_TEXT_MUTED}; }}
QLabel#checkinStatus[tone="warning"] {{ color: {_WARNING}; }}
QLabel#checkinIntro {{ color: {_TEXT}; font-size: 11px; }}
QLabel#checkinLocked {{ font-weight: 600; }}
QLabel#checkinOpponent {{ color: {_TEXT}; }}
QLabel#checkinChanged {{ color: {_ACCENT_CYAN}; font-size: 11px; font-weight: 600; }}
QLabel#checkinLocked[saving="true"] {{ color: {_TEXT_MUTED}; }}
QLabel#checkinPrompt {{ font-size: 13px; }}
QFrame#checkinStrip {{
    background-color: {_SUBTLE};
    border: 1px solid {_BORDER_STRONG};
    border-radius: 8px;
}}
QFrame#checkinIntroBox {{
    background-color: {_ELEVATED};
    border: 1px solid {_BORDER_STRONG};
    border-radius: 8px;
}}
QPushButton {{
    background-color: {_BUTTON};
    color: {_TEXT};
    border: 1px solid {_BORDER_STRONG};
    border-radius: 7px;
    padding: 5px 12px;
    min-height: 18px;
    font-weight: 500;
}}
QPushButton:hover {{
    background-color: {_BUTTON_HOVER};
    border-color: {_ACCENT_HOVER};
}}
QPushButton:pressed {{ background-color: {_BORDER_STRONG}; }}
QPushButton:focus {{ border-color: {_FOCUS}; }}
QPushButton#checkinPrimary {{
    background-color: {_BUTTON_CHECKED};
    color: {_TEXT};
    border-color: {_ACCENT};
    font-weight: 600;
}}
QPushButton#checkinPrimary:hover {{
    background-color: {_BUTTON_HOVER};
    border-color: {_ACCENT_HOVER};
}}
QPushButton#checkinPrimary:focus {{ border-color: {_FOCUS}; }}
QPushButton#checkinQuiet {{
    background-color: transparent;
    border-color: transparent;
    color: {_TEXT_MUTED};
}}
QPushButton#checkinQuiet:hover {{
    background-color: {_SUBTLE};
    border-color: {_BORDER_STRONG};
    color: {_TEXT};
}}
QPushButton#checkinSmall {{
    padding: 2px 10px;
    min-height: 16px;
    font-size: 11px;
}}
QPushButton#checkinLink, QPushButton#checkinMoreToggle {{
    background-color: transparent;
    border: none;
    padding: 0;
    min-height: 0;
    color: {_ACCENT};
    font-size: 11px;
    text-align: left;
}}
QPushButton#checkinLink:hover, QPushButton#checkinMoreToggle:hover {{
    color: {_TEXT};
    text-decoration: underline;
}}
QPushButton#checkinLink:focus, QPushButton#checkinMoreToggle:focus {{
    text-decoration: underline;
}}
QPushButton#checkinMoreToggle {{ color: {_TEXT_MUTED}; font-weight: 600; }}
QPushButton:disabled, QPushButton#checkinPrimary:disabled {{
    background-color: {_ELEVATED};
    color: {_TEXT_DIM};
    border-color: {_BORDER};
}}
QPushButton#checkinLink:disabled, QPushButton#checkinQuiet:disabled {{
    background-color: transparent;
    border-color: transparent;
}}
QPushButton#checkinLink:disabled {{ color: {_TEXT_DIM}; text-decoration: none; }}
QLineEdit#checkinSearch, QPlainTextEdit#checkinNotes {{
    background-color: {_ELEVATED};
    color: {_TEXT};
    border: 1px solid {_BORDER_STRONG};
    border-radius: 7px;
    padding: 4px 8px;
    selection-background-color: {_ACCENT};
    selection-color: {_TEXT};
}}
QLineEdit#checkinSearch:focus, QPlainTextEdit#checkinNotes:focus {{
    border-color: {_ACCENT_CYAN};
}}
QScrollArea, QScrollArea > QWidget > QWidget {{
    background-color: transparent;
    border: none;
}}
QScrollBar:vertical {{
    background: transparent;
    width: 8px;
    margin: 2px;
}}
QScrollBar::handle:vertical {{
    background: {_BORDER_STRONG};
    border-radius: 3px;
    min-height: 20px;
}}
QScrollBar::handle:vertical:hover {{ background: {_ACCENT}; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QProgressBar#checkinBusy {{
    background-color: {_BORDER};
    border: none;
    border-radius: 1px;
    max-height: 2px;
    min-height: 2px;
}}
QProgressBar#checkinBusy::chunk {{
    background-color: {_ACCENT_CYAN};
    border-radius: 1px;
}}
"""


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
        self.update()

    # ------------------------------------------------------------ paint

    def sizeHint(self) -> QtCore.QSize:  # noqa: N802 — Qt API
        return QtCore.QSize(220, ROW_HEIGHT)

    def resizeEvent(self, event: QtGui.QResizeEvent) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._refresh_tooltip()

    def enterEvent(self, event: QtGui.QEnterEvent) -> None:  # noqa: N802
        super().enterEvent(event)
        self.update()

    def leaveEvent(self, event: QtCore.QEvent) -> None:  # noqa: N802
        super().leaveEvent(event)
        self.update()

    def _fonts(self) -> Tuple[QtGui.QFont, QtGui.QFont]:
        name_font = QtGui.QFont(self.font())
        name_font.setPixelSize(13)
        chip_font = QtGui.QFont(self.font())
        chip_font.setPixelSize(10)
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
            record_rect = QtCore.QRect(right - width + 1, 0, width, self.height())
            right -= width + 8
        chips: List[Tuple[QtCore.QRect, str, str]] = []
        metrics = QtGui.QFontMetrics(chip_font)
        for text, tone in reversed(self.chips):
            width = metrics.horizontalAdvance(text) + 12
            chip_rect = QtCore.QRect(right - width + 1, (self.height() - 16) // 2, width, 16)
            chips.insert(0, (chip_rect, text, tone))
            right -= width + 4
        left = rect.left() + (20 if self._selectable else 0)
        return left, right - 4, chips, record_rect

    def _refresh_tooltip(self) -> None:
        name_font, _chip = self._fonts()
        left, right, _chips, _record = self._layout()
        fits = QtGui.QFontMetrics(name_font).horizontalAdvance(self.name) <= max(0, right - left)
        self.setToolTip("" if fits else self.name)

    def paintEvent(self, _event: QtGui.QPaintEvent) -> None:  # noqa: N802
        painter = QtGui.QPainter(self)
        painter.setRenderHint(QtGui.QPainter.Antialiasing, True)
        enabled = self.isEnabled()
        hovered = enabled and self.underMouse()
        rect = QtCore.QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)

        if self.isChecked():
            fill = QtGui.QColor(62, 192, 199, 36)
            border = QtGui.QColor(_ACCENT_CYAN)
        elif self.isDown():
            fill = QtGui.QColor(_BORDER_STRONG)
            border = QtGui.QColor(_BORDER_STRONG)
        elif hovered:
            fill = QtGui.QColor(_SUBTLE)
            border = QtGui.QColor(_BORDER_STRONG)
        else:
            fill = QtGui.QColor(255, 255, 255, 8)
            border = QtGui.QColor(0, 0, 0, 0)
        if self.hasFocus():
            border = QtGui.QColor(_ACCENT)
        painter.setPen(QtGui.QPen(border, 1))
        painter.setBrush(fill)
        painter.drawRoundedRect(rect, 7, 7)

        name_font, chip_font = self._fonts()
        left, right, chips, record_rect = self._layout()
        text_color = QtGui.QColor(_TEXT if enabled else _TEXT_DIM)
        muted = QtGui.QColor(_TEXT_MUTED if enabled else _TEXT_DIM)

        if self._selectable:
            dot = QtCore.QRectF(10.5, (self.height() - 12) / 2, 12, 12)
            painter.setPen(QtGui.QPen(
                QtGui.QColor(_ACCENT_CYAN if self.isChecked() else _TEXT_DIM), 1.4,
            ))
            painter.setBrush(QtCore.Qt.NoBrush)
            painter.drawEllipse(dot)
            if self.isChecked():
                painter.setPen(QtCore.Qt.NoPen)
                painter.setBrush(QtGui.QColor(_ACCENT_CYAN))
                painter.drawEllipse(dot.adjusted(3, 3, -3, -3))

        painter.setFont(name_font)
        painter.setPen(text_color)
        metrics = QtGui.QFontMetrics(name_font)
        name_rect = QtCore.QRect(left, 0, max(0, right - left), self.height())
        elided = metrics.elidedText(self.name, QtCore.Qt.ElideRight, name_rect.width())
        painter.drawText(name_rect, QtCore.Qt.AlignVCenter | QtCore.Qt.AlignLeft, elided)

        painter.setFont(chip_font)
        for chip_rect, text, tone in chips:
            background, foreground = CHIP_TONES.get(tone, CHIP_TONES["suggested"])
            painter.setPen(QtCore.Qt.NoPen)
            painter.setBrush(_css_color(background))
            painter.drawRoundedRect(QtCore.QRectF(chip_rect), 8, 8)
            painter.setPen(QtGui.QColor(foreground))
            painter.drawText(chip_rect, QtCore.Qt.AlignCenter, text)

        if self.record:
            painter.setFont(name_font)
            painter.setPen(muted)
            painter.drawText(record_rect, QtCore.Qt.AlignVCenter | QtCore.Qt.AlignRight, self.record)
        painter.end()


def _css_color(value: str) -> QtGui.QColor:
    """``rgba(r, g, b, a)`` (alpha 0–1) or ``#rrggbb`` → ``QColor``."""
    if value.startswith("rgba("):
        parts = [part.strip() for part in value[5:-1].split(",")]
        red, green, blue = (int(part) for part in parts[:3])
        return QtGui.QColor(red, green, blue, round(float(parts[3]) * 255))
    return QtGui.QColor(value)


class BuildList(QtWidgets.QWidget):
    """Featured rows + **More builds…** + (end card) search.

    ``picked(key)`` fires when the player clicks a row. On the end card
    rows are exclusive radio-style choices; :meth:`selection` returns
    the checked key.
    """

    picked = QtCore.Signal(str)
    searched = QtCore.Signal(str)
    expanded = QtCore.Signal(bool)

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
        layout.setSpacing(6)

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
        self._more_layout.setContentsMargins(0, 0, 4, 0)
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
        visible_rows = min(more_hits, MORE_VISIBLE_ROWS)
        self.more_area.setFixedHeight(
            max(0, visible_rows * (ROW_HEIGHT + ROW_SPACING) - ROW_SPACING),
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
    "CHIP_TONES",
    "MORE_VISIBLE_ROWS",
    "ROW_HEIGHT",
    "button",
    "card_stylesheet",
    "link",
    "plain_label",
    "row_chips",
    "set_tone",
]

"""Plain-text private scouting widgets shared by the real and preview cards."""

from __future__ import annotations

from typing import Optional

from PySide6 import QtCore, QtGui, QtWidgets

from ..build_checkin.models import PostgameCardModel
from ..build_checkin.scouting import ScoutingStripModel, plain_text
from .build_checkin_widgets import button, link, plain_label


class ElidedText(QtWidgets.QLabel):
    def __init__(self, *, lines: int = 1) -> None:
        super().__init__()
        self._raw = ""
        self._lines = lines
        self.setTextFormat(QtCore.Qt.PlainText)
        self.setObjectName("checkinMuted")
        self.setMinimumWidth(0)
        self.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)

    def set_full_text(self, text: str) -> None:
        self._raw = text
        self.setAccessibleName(text)
        self._elide()

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._elide()

    def _elide(self) -> None:
        value = " ".join(self._raw.split())
        width = max(1, self.contentsRect().width())
        metrics = self.fontMetrics()
        if self._lines == 2:
            layout = QtGui.QTextLayout(value, self.font())
            layout.beginLayout()
            first = layout.createLine()
            if first.isValid(): first.setLineWidth(width)
            length = first.textLength() if first.isValid() else len(value)
            layout.endLayout()
            if length < len(value):
                value = value[:length].rstrip() + "\n" + metrics.elidedText(value[length:].lstrip(), QtCore.Qt.ElideRight, width)
        else:
            value = metrics.elidedText(value, QtCore.Qt.ElideRight, width)
        if value != self.text(): self.setText(value)
        self.setMaximumHeight(metrics.lineSpacing() * self._lines + 4)


class ScoutingStrip(QtWidgets.QFrame):
    open_requested = QtCore.Signal()

    def __init__(self) -> None:
        super().__init__()
        self.setObjectName("checkinStrip")
        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(10, 8, 10, 8)
        layout.setSpacing(4)
        self.record = ElidedText()
        self.opening = ElidedText()
        self.note = ElidedText(lines=2)
        self.dossier = link("Open dossier", focusable=False)
        self.dossier.clicked.connect(self.open_requested.emit)
        for widget in (self.record, self.opening, self.note, self.dossier):
            layout.addWidget(widget)

    def set_model(self, model: Optional[ScoutingStripModel]) -> None:
        self.record.set_full_text(model.record_line if model else "Scouting isn't available yet.")
        self.opening.set_full_text(model.opening_line if model else "")
        self.opening.setVisible(model is not None)
        self.note.set_full_text(model.note if model else "")
        self.note.setVisible(bool(model and model.note))
        self.dossier.setVisible(model is not None)


class OpponentNoteEditor(QtWidgets.QWidget):
    edited = QtCore.Signal(str)
    save_requested = QtCore.Signal(str)
    expanded = QtCore.Signal(bool)

    def __init__(self) -> None:
        super().__init__()
        self._card_id: Optional[str] = None
        self._pulse_id: Optional[str] = None
        self._dirty = False
        outer = QtWidgets.QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(4)
        self.toggle = button("Note for next time", "checkinMoreToggle")
        self.toggle.setCheckable(True)
        self.toggle.setAccessibleDescription("Private opponent note; saved separately from this game's check-in notes.")
        outer.addWidget(self.toggle)
        self.body = QtWidgets.QWidget()
        layout = QtWidgets.QVBoxLayout(self.body)
        layout.setContentsMargins(0, 4, 0, 0)
        layout.setSpacing(4)
        self.editor = QtWidgets.QPlainTextEdit()
        self.editor.setObjectName("checkinNotes")
        self.editor.setAccessibleName("Note for next time")
        self.editor.setPlaceholderText("Private note about this opponent")
        self.editor.setFixedHeight(54)
        self.editor.setTabChangesFocus(True)
        self.editor.textChanged.connect(self._changed)
        layout.addWidget(self.editor)
        row = QtWidgets.QHBoxLayout()
        self.save = button("Save note", "checkinSmall")
        self.save.clicked.connect(lambda: self.save_requested.emit(self.editor.toPlainText()))
        row.addWidget(self.save)
        self.counter = plain_label("0 / 500", "checkinCounter")
        row.addStretch(1); row.addWidget(self.counter)
        layout.addLayout(row)
        self.status = plain_label("", "checkinMuted", wrap=True)
        layout.addWidget(self.status)
        outer.addWidget(self.body)
        self.body.hide()
        self.toggle.toggled.connect(self._expanded)

    def _expanded(self, opened: bool) -> None:
        self.body.setVisible(opened)
        self.expanded.emit(opened)

    def _changed(self) -> None:
        text = self.editor.toPlainText()
        kept = plain_text(text, 500, trim=False)
        if text != kept:
            cursor = self.editor.textCursor(); position = cursor.position()
            self.editor.blockSignals(True); self.editor.setPlainText(kept); self.editor.blockSignals(False)
            cursor = self.editor.textCursor(); cursor.setPosition(min(position, len(kept.encode("utf-16-le")) // 2)); self.editor.setTextCursor(cursor)
        self._dirty = True
        self.counter.setText(f"{len(kept.encode('utf-16-le')) // 2} / 500")
        self.status.setText("")
        self.edited.emit(kept)

    def set_model(self, model: PostgameCardModel) -> None:
        fresh = self._card_id != model.card_id or self._pulse_id != model.opponent_pulse_id
        if fresh:
            self.toggle.setChecked(model.opponent_note_touched)
        if fresh or not self._dirty:
            self.editor.blockSignals(True)
            self.editor.setPlainText(model.opponent_note)
            self.editor.blockSignals(False)
            self._dirty = model.opponent_note_touched
        self._card_id = model.card_id
        self._pulse_id = model.opponent_pulse_id
        ready = bool(model.opponent_pulse_id and model.game_id)
        self.editor.setEnabled(ready)
        self.save.setEnabled(ready and not model.opponent_note_busy)
        self.counter.setText(f"{len(self.editor.toPlainText().encode('utf-16-le')) // 2} / 500")
        hint = (model.opponent_note_status or "Use Save note to keep this opponent note.") if ready else (
            "Available after this replay syncs." if model.opponent_pulse_id else "Opponent identity isn't available for a private note."
        )
        self.status.setText(hint)
        self.setVisible(bool(model.opponent_pulse_id))

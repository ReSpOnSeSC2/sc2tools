"""Activity-log widget factory, with lazy Qt imports through injected namespaces."""
from __future__ import annotations

import codecs
from collections import deque

from .help_links import help_button
from .log_records import LogRecord, matches, parse_chunk, read_tail


def build_activity_log(parent, *, log_file, QtCore, QtGui, QtWidgets,
                       open_folder, open_help, palette):
    class ActivityLog(QtWidgets.QWidget):
        def __init__(self):
            super().__init__(parent)
            self.records = deque(maxlen=3000)
            self.offset = 0
            self.seeded = False
            self.carry = ""
            self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
            self._mutating = False
            self.new_lines = 0
            self.search_hits = []
            self.search_index = 0
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(28, 24, 28, 24)
            top = QtWidgets.QHBoxLayout()
            title = QtWidgets.QLabel("Activity log")
            title.setObjectName("h1")
            top.addWidget(title)
            top.addWidget(help_button(QtWidgets, "Activity log", open_help))
            top.addStretch(1)
            self.filter_combo = QtWidgets.QComboBox()
            for label, value in [("Everything", "all"), ("Info and above", "info"),
                                 ("Warnings and errors", "warnings"), ("Errors only", "errors")]:
                self.filter_combo.addItem(label, value)
            self.filter_combo.currentIndexChanged.connect(self.rebuild)
            top.addWidget(self.filter_combo)
            open_button = QtWidgets.QPushButton("Open log folder")
            open_button.clicked.connect(open_folder)
            top.addWidget(open_button)
            layout.addLayout(top)

            toolbar = QtWidgets.QHBoxLayout()
            self.search = QtWidgets.QLineEdit()
            self.search.setPlaceholderText("Search log")
            self.search.setAccessibleName("Search log")
            self.search.textChanged.connect(self._search_changed)
            toolbar.addWidget(self.search, 1)
            self.match_count = QtWidgets.QLabel("")
            toolbar.addWidget(self.match_count)
            self.follow = QtWidgets.QCheckBox("Follow new lines")
            self.follow.setChecked(True)
            self.follow.toggled.connect(lambda value: self.jump_to_latest() if value else None)
            toolbar.addWidget(self.follow)
            self.copy_button = QtWidgets.QToolButton()
            self.copy_button.setText("Copy")
            self.copy_button.setPopupMode(QtWidgets.QToolButton.InstantPopup)
            self.copy_menu = QtWidgets.QMenu(self.copy_button)
            self.copy_selection_action = self.copy_menu.addAction("Copy selection", self.copy_selection)
            self.copy_menu.addAction("Copy last 200 lines", self.copy_tail)
            self.copy_menu.aboutToShow.connect(lambda: self.copy_selection_action.setEnabled(self.view.textCursor().hasSelection()))
            self.copy_button.setMenu(self.copy_menu)
            toolbar.addWidget(self.copy_button)
            layout.addLayout(toolbar)
            self.jump_button = QtWidgets.QPushButton()
            self.jump_button.setVisible(False)
            self.jump_button.clicked.connect(self.jump_to_latest)
            layout.addWidget(self.jump_button)
            self.empty = QtWidgets.QLabel("Nothing logged yet")
            self.empty.setObjectName("muted")
            layout.addWidget(self.empty)
            self.older_notice = QtWidgets.QLabel("… older entries are in the log file - Open log folder")
            self.older_notice.setObjectName("muted")
            self.older_notice.setWordWrap(True)
            self.older_notice.hide()
            layout.addWidget(self.older_notice)
            self.view = QtWidgets.QPlainTextEdit()
            self.view.setObjectName("log")
            self.view.setReadOnly(True)
            self.view.setLineWrapMode(QtWidgets.QPlainTextEdit.NoWrap)
            self.view.setMaximumBlockCount(6000)
            self.view.selectionChanged.connect(self._selection_changed)
            self.view.verticalScrollBar().valueChanged.connect(self._scroll_changed)
            layout.addWidget(self.view, 1)
            self._copy_timer = QtCore.QTimer(self)
            self._copy_timer.setSingleShot(True)
            self._copy_timer.timeout.connect(lambda: self.copy_button.setText("Copy"))
            for key, delta in [("Return", 1), ("Shift+Return", -1), ("F3", 1), ("Shift+F3", -1)]:
                shortcut = QtGui.QShortcut(QtGui.QKeySequence(key), self)
                shortcut.setContext(QtCore.Qt.WidgetWithChildrenShortcut)
                shortcut.activated.connect(lambda amount=delta: self.navigate(amount))
            escape = QtGui.QShortcut(QtGui.QKeySequence("Escape"), self)
            escape.setContext(QtCore.Qt.WidgetWithChildrenShortcut)
            escape.activated.connect(self.search.clear)

        def _selection_changed(self):
            if not self._mutating and self.view.textCursor().hasSelection():
                self.follow.setChecked(False)

        def _scroll_changed(self, value):
            if self._mutating:
                return
            at_bottom = value >= self.view.verticalScrollBar().maximum() - 4
            if not at_bottom:
                self.follow.setChecked(False)
            elif not self.view.textCursor().hasSelection():
                self.follow.setChecked(True)

        def jump_to_latest(self):
            self._mutating = True
            cursor = self.view.textCursor()
            cursor.clearSelection()
            self.view.setTextCursor(cursor)
            self.view.verticalScrollBar().setValue(self.view.verticalScrollBar().maximum())
            self.follow.setChecked(True)
            self._mutating = False
            self.new_lines = 0
            self.jump_button.hide()

        def _append_lines(self, lines, level, *, refresh_search=True):
            if not lines:
                return
            was_following = self.follow.isChecked()
            original_cursor = self.view.textCursor()
            original_cursor.setKeepPositionOnInsert(True)
            vertical = self.view.verticalScrollBar().value()
            horizontal = self.view.horizontalScrollBar().value()
            self._mutating = True
            cursor = QtGui.QTextCursor(self.view.document())
            cursor.movePosition(QtGui.QTextCursor.End)
            fmt = QtGui.QTextCharFormat()
            color = palette["error"] if level in {"ERROR", "CRITICAL"} else palette["warning"] if level == "WARNING" else palette["muted"] if level in {"DEBUG", "notice"} else palette["text"]
            fmt.setForeground(QtGui.QColor(color))
            cursor.insertText(("\n" if not self.view.document().isEmpty() else "") + "\n".join(lines), fmt)
            if was_following:
                self.view.verticalScrollBar().setValue(self.view.verticalScrollBar().maximum())
            else:
                self.view.setTextCursor(original_cursor)
                self.view.verticalScrollBar().setValue(vertical)
                self.view.horizontalScrollBar().setValue(horizontal)
                self.new_lines += len(lines)
                self.jump_button.setText(f"{self.new_lines} new line{'s' if self.new_lines != 1 else ''} - Jump to latest")
                self.jump_button.show()
            self._mutating = False
            if refresh_search:
                self.highlight_search()

        def tail(self):
            try:
                data, self.offset, skipped, rotated = read_tail(log_file, self.offset, self.seeded)
            except OSError:
                return
            self.seeded = True
            if not data and not skipped and not rotated:
                return
            if skipped or rotated:
                self.carry = ""
                self.decoder.reset()
            if skipped:
                # This notice remains visible even if the document's block
                # cap trims its initial marker during a busy catch-up.
                self.older_notice.show()
                marker = LogRecord("notice", ["… older entries are in the log file - Open log folder"])
                self.records.append(marker)
                self._append_lines(marker.lines, marker.level)
            records, self.carry = parse_chunk(self.carry, self.decoder.decode(data))
            for record in records:
                if record.level is None and self.records:
                    previous = self.records[-1]
                    previous.lines.extend(record.lines)
                    level = previous.level
                else:
                    self.records.append(record)
                    level = record.level
                if matches(LogRecord(level, []), self.filter_combo.currentData()):
                    self._append_lines(record.lines, level, refresh_search=False)
            self.empty.setVisible(not self.records)
            self.highlight_search()

        def rebuild(self):
            if not hasattr(self, "view"):
                return
            self._mutating = True
            self.view.clear()
            for record in self.records:
                if matches(record, self.filter_combo.currentData()):
                    self._append_lines(record.lines, record.level, refresh_search=False)
            self._mutating = False
            self.new_lines = 0
            self.jump_button.hide()
            self.empty.setVisible(not self.records)
            self.highlight_search()

        def highlight_search(self):
            text = self.search.text()
            hits = []
            cursor = QtGui.QTextCursor(self.view.document())
            while text:
                cursor = self.view.document().find(text, cursor)
                if cursor.isNull():
                    break
                hits.append((cursor.selectionStart(), cursor.selectionEnd()))
            self.search_hits = hits
            self.search_index = min(self.search_index, max(0, len(hits) - 1))
            selections = []
            for index, (start, end) in enumerate(hits):
                selection = QtWidgets.QTextEdit.ExtraSelection()
                selection.cursor = QtGui.QTextCursor(self.view.document())
                selection.cursor.setPosition(start)
                selection.cursor.setPosition(end, QtGui.QTextCursor.KeepAnchor)
                color = QtGui.QColor(palette["warning"] if index == self.search_index else palette["accent"])
                color.setAlpha(90)
                selection.format.setBackground(color)
                selections.append(selection)
            self.view.setExtraSelections(selections)
            self.match_count.setText(f"{self.search_index + 1} of {len(hits)}" if hits else "0 matches")

        def _search_changed(self, _text):
            self.search_index = 0
            self.highlight_search()
            self.navigate(0)

        def navigate(self, delta):
            if not self.search_hits:
                return
            self.follow.setChecked(False)
            self.search_index = (self.search_index + delta) % len(self.search_hits)
            start, end = self.search_hits[self.search_index]
            cursor = QtGui.QTextCursor(self.view.document())
            cursor.setPosition(start)
            cursor.setPosition(end, QtGui.QTextCursor.KeepAnchor)
            self.view.setTextCursor(cursor)
            self.view.ensureCursorVisible()
            self.highlight_search()

        def _copied(self):
            self.copy_button.setText("Copied ✓")
            self._copy_timer.start(2000)

        def copy_selection(self):
            if self.view.textCursor().hasSelection():
                QtWidgets.QApplication.clipboard().setText(self.view.textCursor().selectedText().replace("\u2029", "\n"))
                self._copied()

        def copy_tail(self):
            QtWidgets.QApplication.clipboard().setText("\n".join(self.view.toPlainText().splitlines()[-200:]))
            self._copied()

    return ActivityLog()

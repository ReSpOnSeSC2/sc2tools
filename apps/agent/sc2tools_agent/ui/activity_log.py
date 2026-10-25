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
            self.header_panel = QtWidgets.QWidget()
            self.header_panel.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
            self._header_layout = QtWidgets.QGridLayout(self.header_panel)
            self._header_layout.setContentsMargins(0, 0, 0, 0)
            self.header_title = QtWidgets.QLabel("Activity log")
            self.header_title.setObjectName("h1")
            self.header_help = help_button(QtWidgets, "Activity log", open_help)
            self.filter_combo = QtWidgets.QComboBox()
            for label, value in [("Everything", "all"), ("Info and above", "info"),
                                 ("Warnings and errors", "warnings"), ("Errors only", "errors")]:
                self.filter_combo.addItem(label, value)
            self.filter_combo.currentIndexChanged.connect(self.rebuild)
            self.open_folder_button = QtWidgets.QPushButton("Open log folder")
            self.open_folder_button.clicked.connect(open_folder)
            layout.addWidget(self.header_panel)

            self.toolbar_panel = QtWidgets.QWidget()
            self.toolbar_panel.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
            self._toolbar_layout = QtWidgets.QGridLayout(self.toolbar_panel)
            self._toolbar_layout.setContentsMargins(0, 0, 0, 0)
            self._controls_signature = None
            self.search = QtWidgets.QLineEdit()
            self.search.setPlaceholderText("Search log")
            self.search.setAccessibleName("Search log")
            self.search.textChanged.connect(self._search_changed)
            self.match_count = QtWidgets.QLabel("")
            self.follow = QtWidgets.QCheckBox("Follow new lines")
            self.follow.setChecked(True)
            self.follow.toggled.connect(lambda value: self.jump_to_latest() if value else None)
            self.copy_button = QtWidgets.QToolButton()
            self.copy_button.setText("Copy")
            self.copy_button.setPopupMode(QtWidgets.QToolButton.InstantPopup)
            self.copy_menu = QtWidgets.QMenu(self.copy_button)
            self.copy_selection_action = self.copy_menu.addAction("Copy selection", self.copy_selection)
            self.copy_menu.addAction("Copy last 200 lines", self.copy_tail)
            self.copy_menu.aboutToShow.connect(lambda: self.copy_selection_action.setEnabled(self.view.textCursor().hasSelection()))
            self.copy_button.setMenu(self.copy_menu)
            layout.addWidget(self.toolbar_panel)
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
            self._reflow_controls()

        def _reflow_controls(self):
            if not hasattr(self, "copy_button"):
                return
            available = max(1, self.width() - self.layout().contentsMargins().left() - self.layout().contentsMargins().right())
            header = [self.header_title, self.header_help, self.filter_combo, self.open_folder_button]
            toolbar = [self.search, self.match_count, self.follow, self.copy_button]
            header_width = sum(widget.minimumSizeHint().width() for widget in header) + 4 * max(0, self._header_layout.horizontalSpacing())
            toolbar_width = sum(widget.minimumSizeHint().width() for widget in toolbar) + 3 * max(0, self._toolbar_layout.horizontalSpacing())
            signature = (available < header_width, available < toolbar_width)
            if signature == self._controls_signature:
                return
            self._controls_signature = signature
            for controls in (self._header_layout, self._toolbar_layout):
                while controls.count():
                    controls.takeAt(0)
                for column in range(5):
                    controls.setColumnStretch(column, 0)
            if signature[0]:
                self._header_layout.addWidget(self.header_title, 0, 0, 1, 2)
                self._header_layout.addWidget(self.header_help, 0, 2)
                self._header_layout.addWidget(self.filter_combo, 1, 0, 1, 2)
                self._header_layout.addWidget(self.open_folder_button, 1, 2)
                self._header_layout.setColumnStretch(0, 1)
            else:
                for widget, column in zip(header, (0, 1, 3, 4)):
                    self._header_layout.addWidget(widget, 0, column)
                self._header_layout.setColumnStretch(2, 1)
            if signature[1]:
                self._toolbar_layout.addWidget(self.search, 0, 0, 1, 2)
                self._toolbar_layout.addWidget(self.match_count, 0, 2)
                self._toolbar_layout.addWidget(self.follow, 1, 0, 1, 2)
                self._toolbar_layout.addWidget(self.copy_button, 1, 2)
            else:
                for column, widget in enumerate(toolbar):
                    self._toolbar_layout.addWidget(widget, 0, column)
            self._toolbar_layout.setColumnStretch(0, 1)

        def resizeEvent(self, event):
            super().resizeEvent(event)
            self._reflow_controls()

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
            self._reflow_controls()

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

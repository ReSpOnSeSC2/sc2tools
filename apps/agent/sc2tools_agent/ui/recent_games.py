"""Recent-game model/view, loaded lazily with the supplied Qt namespaces."""
from __future__ import annotations

from datetime import datetime, timedelta
from difflib import SequenceMatcher
import html

from ..recent_games import MAX_RECENT_GAMES, parse_time

COLUMNS = ("When", "Result", "Matchup", "Opponent", "Map", "Length", "MMR", "Status")


def relative_time(raw, *, now=None):
    instant = parse_time(raw)
    if instant is None:
        return "Unknown"
    now = now or datetime.now().astimezone()
    seconds = max(0, int((now - instant).total_seconds()))
    if seconds < 60:
        return "Just now"
    if seconds < 3600:
        return f"{seconds // 60} min ago"
    if seconds < 86400:
        return f"{seconds // 3600} hr ago"
    return f"{seconds // 86400} days ago"


def _length(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
        return "—"
    seconds = int(value)
    return f"{seconds // 3600}:{seconds // 60 % 60:02}:{seconds % 60:02}" if seconds >= 3600 else f"{seconds // 60}:{seconds % 60:02}"


def build_recent_games(parent, *, QtCore, QtGui, QtWidgets, open_game, reveal, retry, open_help):
    class GamesModel(QtCore.QAbstractTableModel):
        def __init__(self):
            super().__init__(parent)
            self.rows = []
            self.visible = []
            self.status = "all"
            self.days = None
            self.history_expanded = False

        def rowCount(self, _parent=QtCore.QModelIndex()):
            return 0 if _parent.isValid() else len(self.visible)

        def columnCount(self, _parent=QtCore.QModelIndex()):
            return len(COLUMNS)

        def headerData(self, section, orientation, role=QtCore.Qt.DisplayRole):
            if orientation == QtCore.Qt.Horizontal and role == QtCore.Qt.DisplayRole:
                return COLUMNS[section]
            return None

        def data(self, index, role=QtCore.Qt.DisplayRole):
            if not index.isValid() or index.row() >= len(self.visible):
                return None
            row = self.visible[index.row()]
            if role == QtCore.Qt.UserRole:
                return dict(row)
            column = index.column()
            if row.get("_group"):
                if role == QtCore.Qt.DisplayRole:
                    return f"History import · {row['count']} games" if column == 0 else ""
                if role == QtCore.Qt.DecorationRole and column == 0:
                    icon = QtWidgets.QApplication.style().standardIcon(
                        QtWidgets.QStyle.SP_ArrowDown if self.history_expanded else QtWidgets.QStyle.SP_ArrowRight)
                    pixmap = icon.pixmap(16, 16)
                    painter = QtGui.QPainter(pixmap)
                    painter.setCompositionMode(QtGui.QPainter.CompositionMode_SourceIn)
                    palette = parent.palette() if parent else QtWidgets.QApplication.palette()
                    painter.fillRect(pixmap.rect(), palette.color(QtGui.QPalette.WindowText))
                    painter.end()
                    return QtGui.QIcon(pixmap)
                return None
            if role == QtCore.Qt.ToolTipRole:
                at = parse_time(row.get("dateIso") or row.get("updatedAt"))
                if column == 0:
                    return at.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z") if at else "Date unavailable"
                return html.escape(str(row.get("error") or row.get("path") or ""))
            if role == QtCore.Qt.ForegroundRole and column in (1, 7):
                success = row.get("result") == "Victory" if column == 1 else row.get("status") == "uploaded"
                failure = row.get("result") == "Defeat" if column == 1 else row.get("status") == "problem"
                return QtGui.QColor("#57c793") if success else QtGui.QColor("#e77777") if failure else None
            if role != QtCore.Qt.DisplayRole:
                return None
            races = row.get("races") or {}
            own, opponent = races.get("own"), races.get("opponent")
            matchup = own[0] + "v" + opponent[0] if own and opponent else "—"
            status = {"uploaded": "Uploaded", "problem": "Needs attention", "skipped": "Skipped"}.get(row.get("status"), "—")
            if row.get("status") in {"problem", "skipped"} and row.get("errorTitle"):
                status = row["errorTitle"]
            return (relative_time(row.get("dateIso") or row.get("updatedAt")), row.get("result") or "—", matchup,
                    row.get("oppName") or "—", row.get("map") or "—", _length(row.get("durationSec")),
                    str(row["mmr"]) if row.get("mmr") is not None else "—", status)[column]

        def _dated_rows(self):
            if self.days is None:
                return self.rows
            cutoff = datetime.now().astimezone() - timedelta(days=self.days)
            return [row for row in self.rows if (at := parse_time(row.get("dateIso") or row.get("updatedAt"))) and at >= cutoff]

        def counts(self):
            rows = self._dated_rows()
            return {"all": len(rows), **{status: sum(row.get("status") == status for row in rows)
                                         for status in ("uploaded", "problem", "skipped")}}

        def _view(self):
            rows = [row for row in self._dated_rows() if self.status == "all" or row.get("status") == self.status]
            live = [row for row in rows if not row.get("isHistory")]
            history = [row for row in rows if row.get("isHistory")]
            if history:
                live.append({"_group": True, "count": len(history)})
                if self.history_expanded:
                    live.extend(history)
            return live

        @staticmethod
        def _key(row):
            return "__history__" if row.get("_group") else row.get("path") or row.get("gameId")

        def _update_view(self):
            desired = self._view()
            before, after = [self._key(row) for row in self.visible], [self._key(row) for row in desired]
            # Incremental insert/remove preserves existing QModelIndexes and
            # delegates during a large import, including when the 200-row cap trims.
            for operation, start, end, wanted_start, wanted_end in reversed(SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes()):
                if operation in {"delete", "replace"} and end > start:
                    self.beginRemoveRows(QtCore.QModelIndex(), start, end - 1)
                    del self.visible[start:end]
                    self.endRemoveRows()
                if operation in {"insert", "replace"} and wanted_end > wanted_start:
                    self.beginInsertRows(QtCore.QModelIndex(), start, start + wanted_end - wanted_start - 1)
                    self.visible[start:start] = desired[wanted_start:wanted_end]
                    self.endInsertRows()
                elif operation == "equal" and end > start:
                    changed = self.visible[start:end] != desired[wanted_start:wanted_end]
                    self.visible[start:end] = desired[wanted_start:wanted_end]
                    if changed:
                        self.dataChanged.emit(self.index(start, 0), self.index(end - 1, len(COLUMNS) - 1))

        def set_rows(self, rows):
            self.rows = [dict(row) for row in rows[:MAX_RECENT_GAMES]]
            self._update_view()

        def append(self, row):
            self.rows = [dict(row)] + [old for old in self.rows if self._key(old) != self._key(row)]
            self.rows = self.rows[:MAX_RECENT_GAMES]
            self._update_view()

    class RecentGames(QtWidgets.QWidget):
        def __init__(self):
            super().__init__(parent)
            self.model = GamesModel()
            self.unknown_skipped = 0
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(28, 24, 28, 24)
            title = QtWidgets.QLabel("Recent games")
            title.setObjectName("h1")
            layout.addWidget(title)
            explanation = QtWidgets.QLabel("Double-click a game to open its analysis. Right-click for the replay file, error details or Retry.")
            explanation.setWordWrap(True)
            explanation.setObjectName("muted")
            layout.addWidget(explanation)
            self.controls_panel = QtWidgets.QWidget()
            self.controls_panel.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
            self._controls_layout = QtWidgets.QGridLayout(self.controls_panel)
            self._controls_layout.setContentsMargins(0, 0, 0, 0)
            self._controls_narrow = None
            self.filters = {}
            self.group = QtWidgets.QButtonGroup(self)
            self.group.setExclusive(True)
            for key, label in (("all", "All"), ("uploaded", "Uploaded"), ("problem", "Problems"), ("skipped", "Skipped")):
                button = QtWidgets.QPushButton(label)
                button.setCheckable(True)
                button.setProperty("filterLabel", label)
                button.clicked.connect(lambda _checked=False, status=key: self.set_filter(status))
                self.group.addButton(button)
                self.filters[key] = button
            self.filters["all"].setChecked(True)
            self.date = QtWidgets.QComboBox()
            self.date.setAccessibleName("Recent games date range")
            for label, days in (("All dates", None), ("Last 24 hours", 1), ("Last 7 days", 7)):
                self.date.addItem(label, days)
            self.date.currentIndexChanged.connect(self._date_changed)
            layout.addWidget(self.controls_panel)
            self.table = QtWidgets.QTableView()
            self.table.setModel(self.model)
            class ResultDelegate(QtWidgets.QStyledItemDelegate):
                def paint(delegate, painter, option, index):
                    row = index.data(QtCore.Qt.UserRole) or {}
                    result = row.get("result")
                    if result not in {"Victory", "Defeat", "Tie"} or row.get("_group"):
                        return super().paint(painter, option, index)
                    background = QtWidgets.QStyleOptionViewItem(option)
                    delegate.initStyleOption(background, index)
                    background.text = ""
                    option.widget.style().drawControl(QtWidgets.QStyle.CE_ItemViewItem, background, painter, option.widget)
                    color = QtGui.QColor("#57c793" if result == "Victory" else "#e77777" if result == "Defeat" else "#c4c9d4")
                    fill = QtGui.QColor(color)
                    fill.setAlpha(32)
                    rect = option.rect.adjusted(4, 3, -4, -3)
                    painter.save()
                    painter.setRenderHint(QtGui.QPainter.Antialiasing)
                    painter.setPen(QtCore.Qt.NoPen)
                    painter.setBrush(fill)
                    painter.drawRoundedRect(rect, 5, 5)
                    painter.setPen(color)
                    painter.drawText(rect, QtCore.Qt.AlignCenter, result)
                    painter.restore()
            self.table.setItemDelegateForColumn(1, ResultDelegate(self.table))
            self.table.setAccessibleName("Recent games")
            self.table.setSelectionBehavior(QtWidgets.QAbstractItemView.SelectRows)
            self.table.setSelectionMode(QtWidgets.QAbstractItemView.ExtendedSelection)
            self.table.setEditTriggers(QtWidgets.QAbstractItemView.NoEditTriggers)
            self.table.setShowGrid(False)
            self.table.verticalHeader().hide()
            self.table.horizontalHeader().setSectionResizeMode(QtWidgets.QHeaderView.ResizeToContents)
            # Keep opponent names usable at the supported minimum window size;
            # the remaining columns can scroll instead of squeezing this to 30px.
            self.table.horizontalHeader().setSectionResizeMode(3, QtWidgets.QHeaderView.Interactive)
            self.table.setColumnWidth(3, 150)
            self.table.horizontalHeader().setStretchLastSection(True)
            self.table.doubleClicked.connect(self._activate)
            self.table.setContextMenuPolicy(QtCore.Qt.CustomContextMenu)
            self.table.customContextMenuRequested.connect(self._context)
            layout.addWidget(self.table, 1)
            self.empty = QtWidgets.QLabel("No recent games yet. Synced games appear here and remain after restarting the app.")
            self.empty.setWordWrap(True)
            self.empty.setAlignment(QtCore.Qt.AlignCenter)
            layout.addWidget(self.empty)
            self.skip_panel = QtWidgets.QWidget()
            self.skip_layout = QtWidgets.QVBoxLayout(self.skip_panel)
            self.skip_layout.setContentsMargins(0, 0, 0, 0)
            layout.addWidget(self.skip_panel)
            self.refresh_counts()

        def _reflow_controls(self):
            if not hasattr(self, "date"):
                return
            widgets = [*self.filters.values(), self.date]
            spacing = max(0, self._controls_layout.horizontalSpacing())
            required = sum(widget.minimumSizeHint().width() for widget in widgets) + spacing * (len(widgets) - 1)
            available = max(1, self.width() - self.layout().contentsMargins().left() - self.layout().contentsMargins().right())
            narrow = available < required
            if narrow == self._controls_narrow:
                return
            self._controls_narrow = narrow
            while self._controls_layout.count():
                self._controls_layout.takeAt(0)
            for column in range(5):
                self._controls_layout.setColumnStretch(column, 0)
            for index, widget in enumerate(widgets):
                if narrow:
                    self._controls_layout.addWidget(widget, index // 3, index % 3, 1, 2 if index == 4 else 1)
                else:
                    self._controls_layout.addWidget(widget, 0, index)
            self._controls_layout.setColumnStretch(2 if narrow else 4, 1)

        def resizeEvent(self, event):
            super().resizeEvent(event)
            self._reflow_controls()

        def refresh_counts(self):
            counts = self.model.counts()
            if self.model.days is None:
                counts["all"] += self.unknown_skipped
                counts["skipped"] += self.unknown_skipped
            for key, button in self.filters.items():
                button.setText(f"{button.property('filterLabel')} ({counts[key]})")
            self._reflow_controls()
            self.empty.setVisible(self.model.rowCount() == 0 and not (
                self.unknown_skipped and self.model.days is None and self.model.status in {"all", "skipped"}))
            self.table.setVisible(self.model.rowCount() > 0)
            self.skip_panel.setVisible(self.model.status in {"all", "skipped"} and self.model.days is None)

        def set_filter(self, status):
            self.model.status = status
            self.filters[status].setChecked(True)
            self.model._update_view()
            self.refresh_counts()

        def _date_changed(self):
            self.model.days = self.date.currentData()
            self.model._update_view()
            self.refresh_counts()

        def set_rows(self, rows, skipped=()):
            self.model.set_rows(rows)
            known_paths = {row.get("path") for row in self.model.rows}
            skipped = [{**group, "count": len([path for path in group.get("paths", []) if path not in known_paths])}
                       for group in skipped]
            skipped = [group for group in skipped if group["count"]]
            self.unknown_skipped = sum(group["count"] for group in skipped)
            self.refresh_counts()
            while self.skip_layout.count():
                item = self.skip_layout.takeAt(0)
                if item.widget():
                    item.widget().deleteLater()
            for group in skipped:
                line = QtWidgets.QWidget()
                row = QtWidgets.QHBoxLayout(line)
                label = QtWidgets.QLabel(f"{group['count']} skipped (date unknown) · {group['title']} → {group['action']}")
                label.setTextFormat(QtCore.Qt.PlainText)
                label.setWordWrap(True)
                row.addWidget(label, 1)
                if group.get("retryable"):
                    button = QtWidgets.QPushButton("Retry these")
                    button.clicked.connect(lambda _checked=False, reason=group["reason"]: retry([], reason))
                    row.addWidget(button)
                help_button = QtWidgets.QPushButton("Help")
                help_button.clicked.connect(lambda: open_help("desktop-app-import"))
                row.addWidget(help_button)
                self.skip_layout.addWidget(line)

        def append(self, row):
            self.model.append(row)
            self.refresh_counts()

        def _activate(self, index):
            row = self.model.data(index, QtCore.Qt.UserRole)
            if not row:
                return
            if row.get("_group"):
                self.model.history_expanded = not self.model.history_expanded
                self.model._update_view()
            elif row.get("gameId"):
                open_game(row["gameId"])
            else:
                reveal(row.get("path"))

        def selected_rows(self):
            return [self.model.visible[index.row()] for index in self.table.selectionModel().selectedRows()
                    if not self.model.visible[index.row()].get("_group")]

        def menu_for(self, row):
            menu = QtWidgets.QMenu(self)
            if row.get("path"):
                menu.addAction("Show in Explorer", lambda: reveal(row["path"]))
                menu.addAction("Copy path", lambda: QtWidgets.QApplication.clipboard().setText(row["path"]))
                menu.addAction("Retry" if row.get("status") == "problem" else "Re-analyze",
                               lambda: retry([row["path"]], None))
            if row.get("error"):
                menu.addAction("Copy error", lambda: QtWidgets.QApplication.clipboard().setText(row["error"]))
            failures = [item["path"] for item in self.selected_rows() if item.get("status") == "problem" and item.get("path")]
            if len(failures) > 1:
                menu.addAction("Retry failed", lambda: retry(failures, None))
            menu.addAction("Help", lambda: open_help("desktop-app-sync-problems", row.get("errorKind", "rejected")))
            return menu

        def _context(self, point):
            index = self.table.indexAt(point)
            if index.isValid():
                row = self.model.visible[index.row()]
                if not row.get("_group"):
                    self.menu_for(row).exec(self.table.viewport().mapToGlobal(point))

    return RecentGames()

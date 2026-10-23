"""Rich replay-folder rows; filesystem metadata is gathered off the Qt thread."""
import time
from pathlib import Path
from ..folder_info import describe_folder, folder_label
from ..replay_finder import detected_replay_folders, path_key


def build_folder_rows(list_widget, *, QtCore, QtGui, QtWidgets, open_folder):
    class Rows(QtCore.QObject):
        ready = QtCore.Signal(str, object)

        def __init__(self):
            super().__init__(list_widget)
            self.pool = QtCore.QThreadPool(self)
            self.pool.setMaxThreadCount(1)
            self.cache = {}
            self.pending = set()
            self.ready.connect(self.finish)

        def render(self):
            detected = {path_key(path) for path in detected_replay_folders()}
            for index in range(list_widget.count()):
                item = list_widget.item(index)
                raw = item.text()
                item.setToolTip(raw)
                row = QtWidgets.QWidget()
                layout = QtWidgets.QHBoxLayout(row)
                layout.setContentsMargins(6, 5, 6, 5)
                text = QtWidgets.QVBoxLayout()
                label = QtWidgets.QLabel()
                label.setObjectName("folderSummary")
                label.setWordWrap(True)
                label.setText(folder_label(self.cache[raw][1]) if raw in self.cache else Path(raw).name + " · Scanning…")
                label.setToolTip(raw)
                text.addWidget(label)
                origin = QtWidgets.QLabel("Auto-detected" if path_key(Path(raw)) in detected else "Added by you")
                origin.setObjectName("dim")
                text.addWidget(origin)
                layout.addLayout(text, 1)
                button = QtWidgets.QPushButton("Open in Explorer")
                button.setToolTip(raw)
                button.clicked.connect(lambda _checked=False, raw=raw: open_folder(Path(raw)))
                layout.addWidget(button)
                item.setSizeHint(row.sizeHint())
                list_widget.setItemWidget(item, row)
                self.schedule(raw)

        def schedule(self, raw):
            if raw in self.pending or raw in self.cache and time.monotonic()-self.cache[raw][0] < 60:
                return
            self.pending.add(raw)
            done = self.ready
            class Read(QtCore.QRunnable):
                def run(self):
                    done.emit(raw, describe_folder(raw))
            self.pool.start(Read())

        def finish(self, raw, info):
            self.pending.discard(raw)
            self.cache[raw] = (time.monotonic(), info)
            for index in range(list_widget.count()):
                item = list_widget.item(index)
                if item.text() == raw:
                    row = list_widget.itemWidget(item)
                    if row:
                        label = row.findChild(QtWidgets.QLabel, "folderSummary")
                        label.setText(folder_label(info))
                        label.setStyleSheet("color: #e9b24a" if not info.exists else "")
                        item.setSizeHint(row.sizeHint())
    return Rows()


def confirm_empty_folder(parent, path, QtWidgets):
    # Stop at the first replay rather than counting a large import twice.
    import os
    for _directory, _folders, files in os.walk(path):
        if any(name.lower().endswith(".sc2replay") for name in files):
            return True
    dialog = QtWidgets.QMessageBox(parent)
    dialog.setWindowTitle("No replays found")
    dialog.setText(r"This folder has no replays. Pick …\Replays\Multiplayer?")
    another = dialog.addButton("Pick another", QtWidgets.QMessageBox.RejectRole)
    use = dialog.addButton("Use anyway", QtWidgets.QMessageBox.AcceptRole)
    dialog.setDefaultButton(another)
    dialog.exec()
    return dialog.clickedButton() is use

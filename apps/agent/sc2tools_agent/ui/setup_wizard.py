"""Choose replay history and preferences after the existing Link card."""

from __future__ import annotations

import math
from pathlib import Path
from threading import Thread

from ..first_run import IMPORT_CHOICES, SetupChoices, describe_setup_folder
from ..folder_info import folder_label
from ..replay_finder import path_key


def build_setup_wizard(parent, request, *, QtCore, QtWidgets, describe=describe_setup_folder, open_help=None):
    class SetupWizard(QtWidgets.QWizard):
        scanDone = QtCore.Signal(str, object)
        saveDone = QtCore.Signal(object)
        completed = QtCore.Signal(object)

        def __init__(self):
            super().__init__(parent)
            self.setWindowTitle("Set up replay sync")
            self.setWindowModality(QtCore.Qt.ApplicationModal)
            self.setButtonText(QtWidgets.QWizard.FinishButton, "Start syncing")
            self.setButtonText(QtWidgets.QWizard.CancelButton, "Quit setup")
            if open_help:
                self.setOption(QtWidgets.QWizard.HaveHelpButton)
                self.helpRequested.connect(open_help)
            self._rows = {}
            self._counts = {}
            self._saving = False
            self.scanDone.connect(self._scan_finished, QtCore.Qt.QueuedConnection)
            self.saveDone.connect(self._saved, QtCore.Qt.QueuedConnection)
            self.addPage(self._folders_page())
            self.addPage(self._import_page())
            self.addPage(self._preferences_page())
            self.resize(560, 400)
            for folder in request.folders:
                self.add_folder(folder)
            self._update_import_options()

        def _page(self, title, subtitle):
            page = QtWidgets.QWizardPage(self)
            page.setTitle(title)
            page.setSubTitle(subtitle)
            return page, QtWidgets.QVBoxLayout(page)

        def _folders_page(self):
            page, layout = self._page("1. Choose replay folders", "Choose the StarCraft II folders this PC should watch.")
            self.folders = QtWidgets.QListWidget(page)
            self.folders.setAccessibleName("Replay folders to watch")
            self.folders.itemChanged.connect(lambda _: self._update_import_options())
            layout.addWidget(self.folders)
            add = QtWidgets.QPushButton("Add folder…")
            add.clicked.connect(self._pick_folder)
            layout.addWidget(add)
            hint = QtWidgets.QLabel("If you have no replays yet, you can continue. New StarCraft II replay folders are found automatically.")
            hint.setWordWrap(True)
            layout.addWidget(hint)
            return page

        def _import_page(self):
            page, layout = self._page("2. Choose what to import", "These estimates use replay file dates. Import time varies with the size of each replay and your PC.")
            self._options = {}
            for index, (key, label) in enumerate(IMPORT_CHOICES):
                choice = QtWidgets.QRadioButton(label)
                choice.setChecked(index == 0)
                self._options[key] = choice
                layout.addWidget(choice)
            layout.addStretch()
            return page

        def _preferences_page(self):
            page, layout = self._page("3. Set your preferences", "Start syncing saves the selected folders, import range and start-up preference together.")
            self.startup = QtWidgets.QCheckBox("Start SC2 Tools with Windows")
            self.startup.setEnabled(request.start_with_windows is not None)
            self.startup.setChecked(request.start_with_windows is True)
            layout.addWidget(self.startup)
            self.status = QtWidgets.QLabel("")
            self.status.setWordWrap(True)
            layout.addWidget(self.status)
            layout.addStretch()
            return page

        def add_folder(self, path):
            key = path_key(Path(path))
            if key in self._rows:
                self._rows[key].setCheckState(QtCore.Qt.Checked)
                return
            item = QtWidgets.QListWidgetItem(str(path))
            item.setFlags(item.flags() | QtCore.Qt.ItemIsUserCheckable)
            item.setCheckState(QtCore.Qt.Checked)
            item.setToolTip(str(path))
            self._rows[key] = item
            self.folders.addItem(item)
            self._update_import_options()

            def scan():
                try:
                    result = describe(path)
                except Exception:
                    result = None
                try:
                    self.scanDone.emit(key, result)
                except RuntimeError:
                    pass

            Thread(target=scan, name="sc2tools-setup-count", daemon=True).start()

        def _pick_folder(self):
            folder = QtWidgets.QFileDialog.getExistingDirectory(self, "Choose a replay folder")
            if folder:
                self.add_folder(folder)

        def _scan_finished(self, key, result):
            item = self._rows[key]
            self._counts[key] = result[1] if result else None
            if result:
                item.setText(folder_label(result[0]))
            self._update_import_options()

        def _selected(self):
            return {key: item.toolTip() for key, item in self._rows.items()
                    if item.checkState() == QtCore.Qt.Checked}

        def _update_import_options(self):
            if not hasattr(self, "_options"):
                return
            selected = self._selected()
            complete = all(key in self._counts for key in selected)
            known = complete and all(self._counts[key] is not None for key in selected)
            for key, label in IMPORT_CHOICES:
                if key == "since_setup":
                    label += " · no history"
                elif known:
                    count = sum(self._counts[folder][key] for folder in selected)
                    label += f" · {count:,} " + ("replay" if count == 1 else "replays")
                    if count:
                        label += f" · about {math.ceil(count / 60):,} min"
                else:
                    label += " · counting…" if not complete else " · count unavailable"
                self._options[key].setText(label)

        def accept(self):
            if self._saving:
                return
            preset = next(key for key, choice in self._options.items() if choice.isChecked())
            choices = SetupChoices(tuple(self._selected().values()), preset,
                                   self.startup.isChecked() if self.startup.isEnabled() else None)
            self._saving = True
            self.status.setText("Saving setup…")
            for role in (QtWidgets.QWizard.FinishButton, QtWidgets.QWizard.BackButton, QtWidgets.QWizard.CancelButton):
                self.button(role).setEnabled(False)

            def save():
                try:
                    result = request.complete(choices)
                except Exception:
                    result = None
                try:
                    self.saveDone.emit(result)
                except RuntimeError:
                    pass

            Thread(target=save, name="sc2tools-setup-save", daemon=False).start()

        def reject(self):
            if not self._saving:
                super().reject()

        def _saved(self, result):
            self._saving = False
            if result is not None:
                self.completed.emit(result)
                super().accept()
            else:
                self.status.setText("Couldn't save setup. Try again.")
                for role in (QtWidgets.QWizard.FinishButton, QtWidgets.QWizard.BackButton, QtWidgets.QWizard.CancelButton):
                    self.button(role).setEnabled(True)

    return SetupWizard()

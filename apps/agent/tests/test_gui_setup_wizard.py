import os
import time

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6")
from PySide6 import QtCore, QtWidgets

from sc2tools_agent.first_run import FirstRunSetup, setup_range
from sc2tools_agent.ui.setup_wizard import build_setup_wizard


def test_setup_wizard_updates_counts_and_commits_once_on_finish(tmp_path):
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    folder = tmp_path / "1-S2-1-1" / "Replays"
    folder.mkdir(parents=True)
    (folder / "Game.SC2Replay").write_bytes(b"fixture")
    saved = []
    def save(choices):
        saved.append(choices)
        return setup_range(choices.preset)
    request = FirstRunSetup(folders=[folder], start_with_windows=False, save=save)
    wizard = build_setup_wizard(None, request, QtCore=QtCore, QtWidgets=QtWidgets)
    done = []
    wizard.completed.connect(done.append)
    wizard.show()
    try:
        deadline = time.monotonic() + 2
        while not wizard._counts and time.monotonic() < deadline:
            app.processEvents()
            time.sleep(0.01)
        assert "1 replay" in wizard._options["all"].text()
        assert "1-S2-1-1" in wizard.folders.item(0).text()
        assert wizard.currentId() == 0
        wizard.next()
        wizard._options["since_setup"].setChecked(True)
        wizard.next()
        assert wizard.currentId() == 2
        assert saved == []
        wizard.startup.setChecked(True)
        wizard.button(QtWidgets.QWizard.FinishButton).click()
        deadline = time.monotonic() + 2
        while not done and time.monotonic() < deadline:
            app.processEvents()
            time.sleep(0.01)
        assert len(saved) == 1 and done[0][0] == saved[0]
        assert saved[0].preset == "since_setup"
        assert saved[0].folders == (str(folder),)
        assert saved[0].start_with_windows is True
    finally:
        wizard.close()

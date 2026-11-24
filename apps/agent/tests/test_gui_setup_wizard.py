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


def test_finish_later_closes_without_quitting_and_a_save_in_progress_holds_it(tmp_path):
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    request = FirstRunSetup(folders=[], start_with_windows=None, save=lambda choices: setup_range(choices.preset))
    wizard = build_setup_wizard(None, request, QtCore=QtCore, QtWidgets=QtWidgets)
    rejected = []
    wizard.rejected.connect(lambda: rejected.append(True))
    wizard.show()
    try:
        assert wizard.button(QtWidgets.QWizard.CancelButton).text() == "Finish later"
        wizard._saving = True
        wizard.reject()  # Esc or X while saving is ignored
        app.processEvents()
        assert rejected == [] and wizard.isVisible()
        wizard._saving = False
        wizard.button(QtWidgets.QWizard.CancelButton).click()
        app.processEvents()
        assert rejected == [True] and not wizard.isVisible()
    finally:
        wizard.close()


def test_closing_setup_keeps_sc2_tools_running_and_finish_setup_reopens_it(tmp_path):
    from tests._gui_offscreen import run_gui_check

    run_gui_check(tmp_path, r'''
from sc2tools_agent.first_run import FirstRunSetup, SetupChoices, setup_range
from sc2tools_agent.health import HealthFacts, evaluate
quits = []
ui, win = make_window(on_quit=lambda: quits.append(True))
win.show(); app.processEvents()
added = base / "Added Replays"
added.mkdir()
refreshes = []
def refresh():
    refreshes.append(True)
    if len(refreshes) == 2:
        raise OSError("folder scan failed")
    return [str(added)], True
request = FirstRunSetup(folders=[], start_with_windows=None, save=lambda choices: setup_range(choices.preset),
                        refresh=refresh)
win._show_first_run(request)
first = win._first_run_wizard
assert first.folders.count() == 0 and not first.startup.isEnabled()
assert first.isVisible() and first.button(QtWidgets.QWizard.CancelButton).text() == "Finish later"
QtTest.QTest.keyClick(first, QtCore.Qt.Key_Escape)
app.processEvents()
assert quits == [] and not first.isVisible() and win.isVisible()
assert win._transient_notice.text() == "Setup is waiting. Choose Finish setup when you're ready."
assert win._PAGE_KEYS[win._stack.currentIndex()] == "dashboard"
ui.on_health(evaluate(HealthFacts(phase="connecting", paired=True, setup_pending=True), 0.0))
QtTest.QTest.qWait(30)
line = next(line for line in win._health_view.lines if line.row.id == "setup")
assert line.sentence.text() == "Finish setup to start syncing your replays."
assert line.action_button.text() == "Finish setup"
line.action_button.click()
app.processEvents()
second = win._first_run_wizard
assert second is not first and second.isVisible() and refreshes == [True]
# The folder added and the start-up choice made while setup waited are shown, not undone.
assert second.folders.count() == 1 and second.folders.item(0).toolTip() == str(added)
assert second.startup.isEnabled() and second.startup.isChecked()
win._run_health_action("finish_setup")  # already open: raised, not duplicated
assert win._first_run_wizard is second and refreshes == [True]
second.close()  # the title-bar X
app.processEvents()
assert quits == [] and not second.isVisible()
win._run_health_action("finish_setup")  # a failed re-read reopens with the last snapshot
third = win._first_run_wizard
assert third is not second and third.isVisible() and third.folders.item(0).toolTip() == str(added)
third.close()
app.processEvents()
request.complete(SetupChoices((), "all", None))
win._run_health_action("finish_setup")  # nothing left to finish
assert win._first_run_wizard is third and not third.isVisible() and len(refreshes) == 2
win._companion_page.shutdown()
win._race_effects.shutdown()
win._really_quit = True
win.close()
''', timeout=60)

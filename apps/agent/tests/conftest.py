"""Suite-wide fixtures."""

from __future__ import annotations

import sys

import pytest

from sc2tools_agent import replay_finder


@pytest.fixture(autouse=True)
def _flush_qt_deferred_deletes():
    yield
    core = sys.modules.get("PySide6.QtCore")
    widgets = sys.modules.get("PySide6.QtWidgets")
    application_type = getattr(widgets, "QApplication", None)
    if core is not None and application_type is not None:
        application = application_type.instance()
        if application is not None:
            core.QCoreApplication.sendPostedEvents(None, core.QEvent.DeferredDelete)


@pytest.fixture(autouse=True)
def _no_real_documents_folders(monkeypatch):
    """Keep replay-folder discovery away from the developer's own replays.

    The watcher re-runs discovery on every sweep, so without this a test
    run on a PC with StarCraft II installed would sweep, and try to parse,
    the real ``Documents/StarCraft II`` library. Tests that exercise
    discovery point ``candidate_documents_dirs`` at a temp folder.
    """
    monkeypatch.delenv("SC2TOOLS_REPLAY_FOLDER", raising=False)
    monkeypatch.setattr(
        replay_finder, "candidate_documents_dirs", lambda: iter(()),
    )

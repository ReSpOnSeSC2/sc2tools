"""Suite-wide fixtures."""

from __future__ import annotations

import pytest

from sc2tools_agent import replay_finder


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

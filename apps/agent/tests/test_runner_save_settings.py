"""Tests for sc2tools_agent.runner._handle_save_settings — focused
on the date-range filter plumbing.

The full save-settings path touches autostart, the player-handle
cache, and the upload queue's resync trigger. These tests pin down
the new behaviour the date-range filter introduces:

  * Saving a different filter preset clears every ``"filtered"``
    entry from ``state.uploaded`` so the next sweep re-evaluates
    against the new window.
  * Saving the SAME filter preset is a no-op — the filtered entries
    stay (otherwise the watcher re-parses 12k irrelevant replays
    every time the user opens Settings and clicks Save without
    changing anything).
  * Filter changes do NOT touch entries marked ``"skipped"`` /
    ``"rejected"`` / a real timestamp. Those represent durable
    parse / upload outcomes that the filter has no bearing on.
"""

from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

import pytest

from sc2tools_agent.config import AgentConfig
from sc2tools_agent.runner import _handle_save_settings
from sc2tools_agent.state import AgentState
from sc2tools_agent.ui import SettingsPayload


def _cfg(tmp_path: Path) -> AgentConfig:
    return AgentConfig(
        api_base="http://localhost:0",
        state_dir=tmp_path,
        replay_folder=None,
        poll_interval_sec=10,
        parse_concurrency=1,
    )


class _StubUpload:
    def __init__(self) -> None:
        self.resync_calls = 0

    def request_full_resync(self) -> None:
        self.resync_calls += 1


def _cell(upload: Optional[_StubUpload] = None) -> SimpleNamespace:
    """Minimal runtime cell — only the pieces _handle_save_settings touches."""
    return SimpleNamespace(
        upload=upload,
        tray=None,
        gui=None,
    )


@pytest.fixture
def caplog_info(caplog):
    caplog.set_level(logging.INFO)
    return caplog


def test_filter_change_clears_filtered_entries(tmp_path: Path) -> None:
    """Switching from 'all' to a season scope must clear every entry
    the previous sweep marked 'filtered' so the next sweep
    re-evaluates them. Other markers (uploaded, skipped, rejected)
    must survive."""
    state = AgentState(
        device_token="t",
        sync_filter_preset=None,
        uploaded={
            "/replays/old.SC2Replay": "filtered",
            "/replays/older.SC2Replay": "filtered",
            "/replays/skipped.SC2Replay": "skipped",
            "/replays/rejected.SC2Replay": "rejected",
            "/replays/uploaded.SC2Replay": "2026-05-08T10:00:00Z",
        },
    )
    upload = _StubUpload()
    payload = SettingsPayload(
        sync_filter_preset="season:67",
        sync_filter_since=None,
        sync_filter_until=None,
    )
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload), logging.getLogger("test"),
    )
    assert state.sync_filter_preset == "season:67"
    # Filtered entries gone, others intact.
    assert "/replays/old.SC2Replay" not in state.uploaded
    assert "/replays/older.SC2Replay" not in state.uploaded
    assert state.uploaded["/replays/skipped.SC2Replay"] == "skipped"
    assert state.uploaded["/replays/rejected.SC2Replay"] == "rejected"
    assert state.uploaded["/replays/uploaded.SC2Replay"].startswith("2026-")
    # Resync was requested so the watcher re-evaluates immediately.
    assert upload.resync_calls == 1


def test_filter_unchanged_does_not_clear_or_resync(tmp_path: Path) -> None:
    """User opens Settings, clicks Save without touching the filter →
    no churn. Otherwise re-saving on a 12k-replay PC re-parses every
    irrelevant replay."""
    state = AgentState(
        device_token="t",
        sync_filter_preset="season:67",
        uploaded={
            "/replays/a.SC2Replay": "filtered",
        },
    )
    upload = _StubUpload()
    payload = SettingsPayload(
        sync_filter_preset="season:67",
    )
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload), logging.getLogger("test"),
    )
    # Filtered entry stays — saved a no-op, no churn.
    assert state.uploaded["/replays/a.SC2Replay"] == "filtered"
    assert upload.resync_calls == 0


def test_switching_to_all_clears_filtered_entries(tmp_path: Path) -> None:
    """User opens the filter wide ('all'); we MUST clear filtered
    entries so previously-hidden replays get a fresh chance to
    upload."""
    state = AgentState(
        device_token="t",
        sync_filter_preset="season:67",
        uploaded={
            "/replays/a.SC2Replay": "filtered",
            "/replays/b.SC2Replay": "filtered",
        },
    )
    upload = _StubUpload()
    payload = SettingsPayload(sync_filter_preset="all")
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload), logging.getLogger("test"),
    )
    # 'all' is normalised to None on the state — the legacy
    # upload-everything path.
    assert state.sync_filter_preset is None
    assert state.uploaded == {}
    assert upload.resync_calls == 1


def test_custom_range_persists_since_and_until(tmp_path: Path) -> None:
    state = AgentState(device_token="t")
    upload = _StubUpload()
    payload = SettingsPayload(
        sync_filter_preset="custom",
        sync_filter_since="2026-04-15",
        sync_filter_until="2026-05-01",
    )
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload), logging.getLogger("test"),
    )
    assert state.sync_filter_preset == "custom"
    assert state.sync_filter_since == "2026-04-15"
    assert state.sync_filter_until == "2026-05-01"


def test_payload_with_no_filter_field_does_not_change_state(tmp_path: Path) -> None:
    """A SettingsPayload from an older GUI build (no filter fields)
    must leave the existing filter alone."""
    state = AgentState(
        device_token="t",
        sync_filter_preset="season:67",
        sync_filter_since=None,
        sync_filter_until=None,
    )
    upload = _StubUpload()
    payload = SettingsPayload()  # no filter fields set
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload), logging.getLogger("test"),
    )
    assert state.sync_filter_preset == "season:67"
    assert upload.resync_calls == 0

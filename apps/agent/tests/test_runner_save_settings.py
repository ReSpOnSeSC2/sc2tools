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


# --- v0.5.8 upload-pipeline knobs persist via the save handler -------


def test_upload_concurrency_payload_persists_to_state(tmp_path: Path) -> None:
    """The Settings tab's Upload concurrency slider value must land
    in ``state.upload_concurrency_override`` so the next agent boot
    promotes it into the env var via ``_bootstrap``."""
    state = AgentState(device_token="t")
    payload = SettingsPayload(upload_concurrency=3)
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(), logging.getLogger("test"),
    )
    assert state.upload_concurrency_override == 3


def test_upload_batch_size_payload_persists_to_state(tmp_path: Path) -> None:
    state = AgentState(device_token="t")
    payload = SettingsPayload(upload_batch_size=42)
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(), logging.getLogger("test"),
    )
    assert state.upload_batch_size_override == 42


def test_save_clamps_upload_concurrency_into_useful_range(
    tmp_path: Path,
) -> None:
    """A hand-edited or stale-state value above the useful max must
    be clamped on save, so a 99 in the JSON file becomes 4 (the
    ``UPLOAD_CONCURRENCY_USEFUL_MAX``) and never reaches the
    runtime config."""
    from sc2tools_agent.config import UPLOAD_CONCURRENCY_USEFUL_MAX

    state = AgentState(device_token="t")
    payload = SettingsPayload(upload_concurrency=99)
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(), logging.getLogger("test"),
    )
    assert state.upload_concurrency_override == UPLOAD_CONCURRENCY_USEFUL_MAX


def test_save_clamps_upload_batch_size_into_useful_range(
    tmp_path: Path,
) -> None:
    from sc2tools_agent.config import UPLOAD_BATCH_SIZE_USEFUL_MAX

    state = AgentState(device_token="t")
    payload = SettingsPayload(upload_batch_size=999)
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(), logging.getLogger("test"),
    )
    assert state.upload_batch_size_override == UPLOAD_BATCH_SIZE_USEFUL_MAX


def test_save_clamps_upload_settings_floor_at_one(tmp_path: Path) -> None:
    """A negative or zero value (only reachable via a hand-edited
    JSON file — the slider's QSlider.minimum() is 1) must clamp up
    to 1, never persist 0 or negative."""
    state = AgentState(device_token="t")
    payload = SettingsPayload(upload_concurrency=0, upload_batch_size=-5)
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(), logging.getLogger("test"),
    )
    assert state.upload_concurrency_override == 1
    assert state.upload_batch_size_override == 1


# --- Hot-swap dispatch from save handler -----------------------------


class _HotSwapStubUpload:
    """Captures hot-swap calls so the save-handler test can verify
    that a Settings change is forwarded to the live ``UploadQueue``,
    not just persisted to disk. Includes ``set_concurrency`` and
    ``set_batch_size`` so the production code path that auto-detects
    those methods via ``hasattr`` exercises the dispatch."""

    def __init__(self) -> None:
        self.resync_calls = 0
        self.concurrency_swaps: list[int] = []
        self.batch_size_swaps: list[int] = []

    def request_full_resync(self) -> None:
        self.resync_calls += 1

    def set_concurrency(self, n: int) -> None:
        self.concurrency_swaps.append(int(n))

    def set_batch_size(self, n: int) -> None:
        self.batch_size_swaps.append(int(n))


def test_save_hot_swaps_upload_concurrency_when_payload_carries_it(
    tmp_path: Path,
) -> None:
    """The Settings tab's 1-or-2 button group fires a partial
    ``SettingsPayload`` with only ``upload_concurrency`` set. The
    save handler must persist AND immediately call
    ``UploadQueue.set_concurrency`` so the change takes effect
    without an agent restart — that's the contract the GUI's
    auto-save click-to-apply UX depends on."""
    state = AgentState(device_token="t")
    upload = _HotSwapStubUpload()
    payload = SettingsPayload(upload_concurrency=2)
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload), logging.getLogger("test"),
    )
    assert state.upload_concurrency_override == 2
    assert upload.concurrency_swaps == [2], (
        f"expected hot-swap to value 2, got swaps: {upload.concurrency_swaps}"
    )


def test_save_hot_swaps_upload_batch_size_when_payload_carries_it(
    tmp_path: Path,
) -> None:
    """Same contract as upload_concurrency: a ``upload_batch_size``
    payload must persist and hot-swap. Workers re-read the new
    value at the top of their next iteration; the dispatch from
    the save handler is what kicks the chain."""
    state = AgentState(device_token="t")
    upload = _HotSwapStubUpload()
    payload = SettingsPayload(upload_batch_size=30)
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload), logging.getLogger("test"),
    )
    assert state.upload_batch_size_override == 30
    assert upload.batch_size_swaps == [30]


def test_save_skips_hot_swap_when_field_not_in_payload(
    tmp_path: Path,
) -> None:
    """A payload without ``upload_concurrency`` (e.g. user changed
    only the date-range filter) must NOT fire a spurious hot-swap.
    The contract is "only the fields the user actually edited get
    pushed downstream"."""
    state = AgentState(device_token="t")
    upload = _HotSwapStubUpload()
    payload = SettingsPayload(sync_filter_preset="all")  # unrelated change
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload), logging.getLogger("test"),
    )
    assert upload.concurrency_swaps == []
    assert upload.batch_size_swaps == []


def test_save_hot_swap_failure_does_not_break_persistence(
    tmp_path: Path,
) -> None:
    """If ``set_concurrency`` raises (e.g. the upload thread is in
    a weird state), the save itself must still succeed — the user's
    setting is persisted to state so the next agent restart gets
    the change even if the live hot-swap couldn't be applied."""

    class _FlakyUpload:
        def __init__(self) -> None:
            self.resync_calls = 0

        def request_full_resync(self) -> None:
            self.resync_calls += 1

        def set_concurrency(self, _n: int) -> None:
            raise RuntimeError("simulated stop/start race")

        def set_batch_size(self, _n: int) -> None:
            raise RuntimeError("simulated stop/start race")

    state = AgentState(device_token="t")
    upload = _FlakyUpload()
    payload = SettingsPayload(upload_concurrency=2, upload_batch_size=30)
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload), logging.getLogger("test"),
    )
    # Persistence succeeded despite the hot-swap exception.
    assert state.upload_concurrency_override == 2
    assert state.upload_batch_size_override == 30

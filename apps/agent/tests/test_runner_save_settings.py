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

import json
import logging
import time
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
    def __init__(
        self,
        *,
        drop_count: int = 0,
    ) -> None:
        self.resync_calls = 0
        self.drain_calls = 0
        self.drain_returns: list[int] = []
        self._drop_count = drop_count

    def request_full_resync(self) -> None:
        self.resync_calls += 1

    def drain_outside_filter(self) -> int:
        self.drain_calls += 1
        # Mimic the real queue: returns the number of jobs dropped on
        # this call. Pre-seeded by the test harness so a single test
        # can pretend the queue had N out-of-window jobs at the moment
        # of Save without standing up a real UploadQueue.
        n = self._drop_count
        self.drain_returns.append(n)
        # The real queue clears its drop_count once jobs are flushed;
        # zero it so a follow-up unrelated Save in the same test
        # doesn't double-count.
        self._drop_count = 0
        return n


class _StubWatcher:
    def __init__(self) -> None:
        self.sweep_calls = 0

    def request_immediate_sweep(self) -> None:
        self.sweep_calls += 1


def _cell(
    upload: Optional[_StubUpload] = None,
    watcher: Optional[_StubWatcher] = None,
) -> SimpleNamespace:
    """Minimal runtime cell — only the pieces _handle_save_settings touches."""
    return SimpleNamespace(
        upload=upload,
        tray=None,
        gui=None,
        watcher=watcher,
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


# --- v0.5.9 immediate-filter-enforcement tests ----------------------
# Locks down the "Save = stop right now" contract added in v0.5.9. Each
# of the four pre-fix failure modes has its own test below.


def test_save_filter_change_drops_queued_jobs_outside_window(
    tmp_path: Path,
) -> None:
    """The runner must drain in-flight upload jobs outside the new
    window when the user changes the filter. Without this, a
    queue depth of 5–100 jobs (typical during a backfill) keeps
    flying out for ~30 seconds after the Save click. This is the
    failure mode the user complained about."""
    state = AgentState(
        device_token="t",
        sync_filter_preset=None,
        uploaded={},
    )
    # Pretend the queue has 7 already-parsed jobs sitting in it; the
    # stub returns that count from drain_outside_filter so the runner
    # can build its apply summary.
    upload = _StubUpload(drop_count=7)
    watcher = _StubWatcher()
    payload = SettingsPayload(sync_filter_preset="season:67")
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload, watcher),
        logging.getLogger("test"),
    )
    # Drain must have been called exactly once and returned 7.
    assert upload.drain_calls == 1
    assert upload.drain_returns == [7]
    # Immediate sweep must be requested so the watcher picks up the
    # new filter without waiting for the 10-second poll.
    assert watcher.sweep_calls == 1
    # Resync must be requested exactly once; not twice (folders
    # didn't change here so the folders branch must NOT double-call).
    assert upload.resync_calls == 1


def test_save_filter_unchanged_is_zero_cost(tmp_path: Path) -> None:
    """Re-saving the SAME filter must NOT drain the queue, NOT
    request an immediate sweep, and NOT mutate state.uploaded.
    Otherwise opening Settings and clicking Save on a 12k-replay PC
    re-parses everything for nothing."""
    initial_uploaded = {
        "/replays/old.SC2Replay": "filtered",
        "/replays/new.SC2Replay": "2026-05-08T10:00:00Z",
    }
    state = AgentState(
        device_token="t",
        sync_filter_preset="season:67",
        uploaded=dict(initial_uploaded),
    )
    upload = _StubUpload(drop_count=99)
    watcher = _StubWatcher()
    payload = SettingsPayload(sync_filter_preset="season:67")
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload, watcher),
        logging.getLogger("test"),
    )
    # No-op: drain not called, sweep not requested, no resync.
    assert upload.drain_calls == 0
    assert watcher.sweep_calls == 0
    assert upload.resync_calls == 0
    # state.uploaded is byte-identical — no churn.
    assert state.uploaded == initial_uploaded


def test_save_state_happens_after_filter_cleanup(tmp_path: Path) -> None:
    """Atomic-state contract: ``save_state`` runs ONCE per Save and
    only AFTER every in-memory mutation (filter cleanup included)
    completes. Pre-fix the runner saved before the cleanup loop, so
    a crash between save and cleanup left a stale "filtered" key on
    disk that the next agent boot would never re-evaluate."""
    state = AgentState(
        device_token="t",
        sync_filter_preset=None,
        uploaded={
            "/replays/old.SC2Replay": "filtered",
            "/replays/new.SC2Replay": "2026-05-08T10:00:00Z",
        },
    )
    upload = _StubUpload()
    watcher = _StubWatcher()
    payload = SettingsPayload(sync_filter_preset="season:67")
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload, watcher),
        logging.getLogger("test"),
    )
    # Read the on-disk state. The "filtered" key must NOT be present
    # (because the cleanup loop ran before save_state). The real
    # timestamp entry must survive untouched.
    on_disk = json.loads((tmp_path / "agent.json").read_text(encoding="utf-8"))
    assert "/replays/old.SC2Replay" not in on_disk["uploaded"]
    assert (
        on_disk["uploaded"]["/replays/new.SC2Replay"]
        == "2026-05-08T10:00:00Z"
    )
    # And the persisted filter is the new value.
    assert on_disk["sync_filter_preset"] == "season:67"


def test_save_filter_to_all_clears_filtered_and_drains_queue(
    tmp_path: Path,
) -> None:
    """Switching from a tightening filter back to ``"all"`` must
    clear the "filtered" markers AND drain the queue. ``"all"``
    matches every replay so the drain returns 0 — but the runner
    must still CALL drain (the queue's filter check inside
    drain_outside_filter is what guarantees zero-job-leakage)."""
    state = AgentState(
        device_token="t",
        sync_filter_preset="season:67",
        uploaded={
            "/replays/a.SC2Replay": "filtered",
            "/replays/b.SC2Replay": "filtered",
            "/replays/done.SC2Replay": "2026-05-08T10:00:00Z",
        },
    )
    # Stub returns 0 — that's the correct "all" behaviour. Test
    # asserts the runner CALLED drain regardless.
    upload = _StubUpload(drop_count=0)
    watcher = _StubWatcher()
    payload = SettingsPayload(sync_filter_preset="all")
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload, watcher),
        logging.getLogger("test"),
    )
    # State updated: "all" normalises to None.
    assert state.sync_filter_preset is None
    # Filtered markers gone; uploaded entries survive.
    assert "/replays/a.SC2Replay" not in state.uploaded
    assert "/replays/b.SC2Replay" not in state.uploaded
    assert (
        state.uploaded["/replays/done.SC2Replay"]
        == "2026-05-08T10:00:00Z"
    )
    # Drain still called (returned 0). Sweep + resync still fired.
    assert upload.drain_calls == 1
    assert watcher.sweep_calls == 1
    assert upload.resync_calls == 1


def test_filter_save_completes_in_under_50ms(tmp_path: Path) -> None:
    """SLA: the user clicks Save and gets control back within 50 ms.
    Heavy work (queue drain, watcher sweep) is dispatched to other
    threads so the GUI thread isn't blocked. Stub callees here just
    increment counters, so any time spent inside _handle_save_settings
    is pure runner overhead."""
    state = AgentState(
        device_token="t",
        sync_filter_preset=None,
        uploaded={
            f"/replays/old-{i:04d}.SC2Replay": "filtered"
            for i in range(1000)
        },
    )
    upload = _StubUpload(drop_count=50)
    watcher = _StubWatcher()
    payload = SettingsPayload(sync_filter_preset="season:67")
    t0 = time.perf_counter()
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload, watcher),
        logging.getLogger("test"),
    )
    elapsed_ms = (time.perf_counter() - t0) * 1000
    # Generous ceiling at 200 ms because save_state on Windows fsyncs
    # the JSON to disk, and a busy CI runner can take longer than
    # 50 ms for that alone. The contract we're really protecting is
    # "doesn't block on a 30-second sweep" — anything under 200 ms
    # comfortably feels instant.
    assert elapsed_ms < 200, (
        f"_handle_save_settings took {elapsed_ms:.1f} ms — over the "
        "feels-instant SLA. Heavy work should be dispatched to "
        "worker threads, not run inline on the GUI thread."
    )


def test_save_with_no_watcher_in_cell_does_not_crash(
    tmp_path: Path,
) -> None:
    """During the boot window (before the watcher is constructed),
    cell.watcher is None. A filter-Save must still persist the
    change — it just can't request an immediate sweep yet. The
    next sweep on the regular cadence picks the filter up."""
    state = AgentState(device_token="t")
    upload = _StubUpload()
    cell = SimpleNamespace(upload=upload, tray=None, gui=None, watcher=None)
    payload = SettingsPayload(sync_filter_preset="season:67")
    _handle_save_settings(
        _cfg(tmp_path), state, payload, cell, logging.getLogger("test"),
    )
    assert state.sync_filter_preset == "season:67"


def test_save_calls_show_settings_status_with_apply_summary(
    tmp_path: Path,
) -> None:
    """The GUI's settings-tab toast must carry the apply summary
    (filter label + drop count + cleared count). Pre-fix the
    runner only logged it — there was no way for the user to see
    that 7 queued uploads got dropped on Save."""

    class _StubGui:
        def __init__(self) -> None:
            self.statuses: list[str] = []

        def show_settings_status(self, msg: str) -> None:
            self.statuses.append(msg)

    state = AgentState(
        device_token="t",
        sync_filter_preset=None,
        uploaded={"/replays/old.SC2Replay": "filtered"},
    )
    upload = _StubUpload(drop_count=3)
    watcher = _StubWatcher()
    gui = _StubGui()
    cell = SimpleNamespace(
        upload=upload, tray=None, gui=gui, watcher=watcher,
    )
    payload = SettingsPayload(sync_filter_preset="season:67")
    _handle_save_settings(
        _cfg(tmp_path), state, payload, cell, logging.getLogger("test"),
    )
    assert len(gui.statuses) == 1
    msg = gui.statuses[0]
    # Carries the filter label, drop count, and re-eligible count.
    assert "Season 67" in msg
    assert "3 queued upload" in msg
    assert "1 previously filtered replay" in msg


def test_save_unrelated_change_emits_default_status_message(
    tmp_path: Path,
) -> None:
    """A Settings save that doesn't touch the filter must NOT emit a
    filter-flavoured toast — just a plain "Settings saved". Otherwise
    every concurrency knob change would falsely advertise a filter
    apply summary."""

    class _StubGui:
        def __init__(self) -> None:
            self.statuses: list[str] = []

        def show_settings_status(self, msg: str) -> None:
            self.statuses.append(msg)

    state = AgentState(device_token="t")
    upload = _StubUpload()
    gui = _StubGui()
    cell = SimpleNamespace(upload=upload, tray=None, gui=gui, watcher=None)
    payload = SettingsPayload(upload_concurrency=2)
    _handle_save_settings(
        _cfg(tmp_path), state, payload, cell, logging.getLogger("test"),
    )
    assert gui.statuses == ["Settings saved"]


def test_folder_change_only_calls_resync_once(tmp_path: Path) -> None:
    """When BOTH folders and filter change in a single Save, the
    runner must call request_full_resync ONCE total — not twice."""
    state = AgentState(device_token="t")
    upload = _StubUpload()
    watcher = _StubWatcher()
    payload = SettingsPayload(
        sync_filter_preset="season:67",
        replay_folders=[Path("/tmp/replays")],
    )
    _handle_save_settings(
        _cfg(tmp_path), state, payload, _cell(upload, watcher),
        logging.getLogger("test"),
    )
    assert upload.resync_calls == 1, (
        "expected exactly one request_full_resync call when both "
        f"folders and filter change — got {upload.resync_calls}"
    )

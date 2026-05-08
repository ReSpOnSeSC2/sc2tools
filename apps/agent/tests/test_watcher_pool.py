"""Tests for the parse-pool resolution + runtime-fallback machinery.

These tests lock down the v0.5.8 behaviour change: the watcher
re-enables ``ProcessPoolExecutor`` mode by default, with a boot-time
probe and a runtime fallback so a broken spawn path on one user's
install never crashes the agent.

What's exercised:

  * ``SC2TOOLS_PARSE_USE_PROCESSES=0`` → threads, no probe attempted.
  * Probe success → process pool. Real ``ProcessPoolExecutor`` is
    constructed and immediately shut down (we don't actually run a
    child here — that's covered by the parse pipeline's e2e tests).
  * Probe failure → threads, with the failure reason logged.
  * Mid-session ``BrokenProcessPool`` on submit → live executor swap
    to threads, and the replay re-submits via the threading path.
  * The post-parse ``replay_in_range`` filter still runs in process
    mode (regression check — date-range filtering must NOT be a
    threading-only feature).
  * The inflight set is cleared after a process worker finishes,
    INCLUDING when the future raises (otherwise a worker crash
    leaks the inflight entry and the file never re-submits on the
    next sweep).
"""

from __future__ import annotations

import concurrent.futures
import os
import threading
from concurrent.futures import Future, ProcessPoolExecutor, ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple
from unittest.mock import patch

import pytest

from sc2tools_agent.config import AgentConfig
from sc2tools_agent.replay_pipeline import CloudGame
from sc2tools_agent.state import AgentState
from sc2tools_agent.uploader.queue import UploadJob


# --- Test doubles -----------------------------------------------------


class _FakeUploadQueue:
    """Captures submitted jobs without running a real upload thread."""

    def __init__(self) -> None:
        self.submitted: List[UploadJob] = []
        self._resync = False

    def submit(self, job: UploadJob) -> bool:
        self.submitted.append(job)
        return True

    def is_resync_requested(self) -> bool:
        return self._resync

    def acknowledge_resync(self) -> None:
        self._resync = False


def _cfg(tmp_path: Path, *, parse_concurrency: int = 2) -> AgentConfig:
    return AgentConfig(
        api_base="http://localhost:0",
        state_dir=tmp_path,
        replay_folder=None,
        poll_interval_sec=10,
        parse_concurrency=parse_concurrency,
    )


def _make_cloud_game(date_iso: str = "2026-04-01T12:00:00Z") -> CloudGame:
    return CloudGame(
        game_id="g1",
        date_iso=date_iso,
        result="Victory",
        my_race="Protoss",
        my_build="P - Stargate",
        map_name="Goldenaura",
        duration_sec=600,
        macro_score=80.0,
        apm=140.0,
        spq=10.0,
        opponent={"displayName": "Foo", "race": "Z"},
        build_log=[],
        early_build_log=[],
        opp_early_build_log=[],
        opp_build_log=[],
    )


def _make_watcher(tmp_path: Path) -> Any:
    """Construct a ReplayWatcher with stubs the tests can drive directly.

    Imported inside the helper rather than at module top so each test
    sees a fresh import — important because the watcher module's
    ``_make_parse_executor`` runs the probe at construction time, and
    we want each test to control whether process mode is selected via
    its own monkeypatch.
    """
    from sc2tools_agent.watcher import ReplayWatcher

    state = AgentState(device_token="t")
    upload = _FakeUploadQueue()
    watcher = ReplayWatcher(cfg=_cfg(tmp_path), state=state, upload=upload)
    # Attach to the test object so tests can inspect post-hoc — and
    # so the test's teardown can shut the executor down even if the
    # test itself raised.
    watcher._test_state = state
    watcher._test_upload = upload
    return watcher


@pytest.fixture
def watcher_factory(tmp_path: Path):
    """Yield a callable that builds a ReplayWatcher; clean up afterwards.

    Crucial for process-mode tests: a real ProcessPoolExecutor leaks
    a child process if not shut down, and pytest will hang at
    teardown. We track every instance the test built and call stop()
    on each.
    """
    built: List[Any] = []

    def _factory() -> Any:
        watcher = _make_watcher(tmp_path)
        built.append(watcher)
        return watcher

    yield _factory

    for watcher in built:
        try:
            # ``stop()`` shuts the executor down with cancel_futures=True
            # — we don't have an observer or sweeper running because we
            # never called ``start()``, so this is a no-op for those.
            watcher.stop()
        except Exception:  # noqa: BLE001
            pass


# --- env-var resolution ------------------------------------------------


@pytest.mark.parametrize("value", ["0", "false", "False", "OFF", "no", " 0 "])
def test_threading_mode_default_when_env_disabled(
    monkeypatch, watcher_factory, value: str,
) -> None:
    """SC2TOOLS_PARSE_USE_PROCESSES=<falsy> short-circuits before the probe."""
    monkeypatch.setenv("SC2TOOLS_PARSE_USE_PROCESSES", value)
    # Spy: the env-opt-out path MUST NOT call the probe (it would pay
    # 1–3 s of spawn time we know is going to be thrown away).
    with patch("sc2tools_agent.watcher._probe_process_pool") as probe:
        watcher = watcher_factory()
    probe.assert_not_called()
    assert watcher._uses_processes is False
    assert isinstance(watcher._executor, ThreadPoolExecutor)


# --- probe success path -----------------------------------------------


def test_process_mode_when_probe_succeeds(
    monkeypatch, watcher_factory,
) -> None:
    """Probe returns ``(True, None)`` → ProcessPoolExecutor is constructed."""
    monkeypatch.delenv("SC2TOOLS_PARSE_USE_PROCESSES", raising=False)
    with patch(
        "sc2tools_agent.watcher._probe_process_pool",
        return_value=(True, None),
    ):
        watcher = watcher_factory()
    assert watcher._uses_processes is True
    assert isinstance(watcher._executor, ProcessPoolExecutor)


# --- probe failure path -----------------------------------------------


def test_falls_back_to_threading_when_probe_fails(
    monkeypatch, watcher_factory, caplog,
) -> None:
    """Probe failure: ThreadPoolExecutor + WARNING log carrying the reason."""
    monkeypatch.delenv("SC2TOOLS_PARSE_USE_PROCESSES", raising=False)
    caplog.set_level("WARNING", logger="sc2tools_agent.watcher")
    with patch(
        "sc2tools_agent.watcher._probe_process_pool",
        return_value=(False, "broken_process_pool repr=BrokenProcessPool()"),
    ):
        watcher = watcher_factory()
    assert watcher._uses_processes is False
    assert isinstance(watcher._executor, ThreadPoolExecutor)
    # The reason string from the probe MUST appear in the log so
    # support has something to triage with.
    failure_logs = [
        rec for rec in caplog.records if "parse_pool_probe_failed" in rec.message
    ]
    assert failure_logs, "expected a parse_pool_probe_failed warning"
    assert "broken_process_pool" in failure_logs[0].message


# --- runtime mid-session fallback -------------------------------------


class _ExplodingProcessPool:
    """Stub that mimics a ProcessPoolExecutor whose spawn just died.

    Used to drive the runtime-fallback path in ``_submit_parse`` without
    needing to actually crash a real child. The first ``submit`` raises
    ``BrokenProcessPool``; subsequent calls (which shouldn't happen if
    the swap works) raise a distinct error so the test would notice.
    """

    def __init__(self) -> None:
        self.submit_calls = 0

    def submit(self, *args, **kwargs):
        self.submit_calls += 1
        if self.submit_calls == 1:
            raise BrokenProcessPool("simulated mid-session spawn death")
        raise AssertionError("submit called after fallback should have swapped pool")

    def shutdown(self, wait: bool = True, cancel_futures: bool = False) -> None:
        # Match the ProcessPoolExecutor signature so the fallback's
        # shutdown call doesn't TypeError.
        return None


def test_runtime_brokenprocesspool_falls_back_mid_session(
    monkeypatch, watcher_factory, caplog,
) -> None:
    """Mid-session BrokenProcessPool → live swap to threads + retry."""
    monkeypatch.delenv("SC2TOOLS_PARSE_USE_PROCESSES", raising=False)
    caplog.set_level("WARNING", logger="sc2tools_agent.watcher")
    with patch(
        "sc2tools_agent.watcher._probe_process_pool",
        return_value=(True, None),
    ):
        watcher = watcher_factory()
    # Replace the live process pool with the exploding stub. Lock the
    # swap the same way the production code does so the assertion
    # mirrors the runtime contract.
    real_pool = watcher._executor
    bad_pool = _ExplodingProcessPool()
    with watcher._executor_lock:
        watcher._executor = bad_pool
    try:
        # Mark the path inflight up front (matching what the sweep
        # loop does) so we can verify the inflight set still gets
        # cleared along the fallback path.
        path = Path(str(watcher._cfg.state_dir / "fake.SC2Replay"))
        with watcher._inflight_lock:
            watcher._inflight.add(str(path))
        watcher._submit_parse(path)

        # After the fallback, the executor must be a ThreadPoolExecutor
        # and the in-thread handler queued for the same path. The
        # in-thread ``_handle_replay`` runs ``_wait_for_file_ready`` on
        # a non-existent file and returns within the settle timeout —
        # we don't need to wait for that here, just verify the swap.
        assert watcher._uses_processes is False
        assert isinstance(watcher._executor, ThreadPoolExecutor)
        # Exactly the one failed submit on the bad pool.
        assert bad_pool.submit_calls == 1
        # Fallback must log a triage-friendly warning with a reason.
        fallback_logs = [
            rec for rec in caplog.records
            if "parse_pool_runtime_failure_falling_back" in rec.message
        ]
        assert fallback_logs, "expected a runtime fallback WARNING"
        assert "BrokenProcessPool" in fallback_logs[0].message
    finally:
        # Reap the original real ProcessPoolExecutor so the test
        # doesn't leak a child process. The factory teardown shuts
        # down ``watcher._executor`` (now the new thread pool) but
        # not the original we displaced.
        try:
            real_pool.shutdown(wait=False, cancel_futures=True)
        except Exception:  # noqa: BLE001
            pass


# --- post-parse filter check still runs in process mode ---------------


def test_filter_check_still_applied_in_process_mode(
    monkeypatch, watcher_factory,
) -> None:
    """A replay outside the user's date window must be marked filtered.

    In process mode the filter check moved from ``_handle_replay`` to
    ``_on_worker_done`` because the worker doesn't have access to the
    parent's state. This regression-locks that the check still runs
    on the parent side and that the upload queue never sees the job.
    """
    monkeypatch.delenv("SC2TOOLS_PARSE_USE_PROCESSES", raising=False)
    with patch(
        "sc2tools_agent.watcher._probe_process_pool",
        return_value=(True, None),
    ):
        watcher = watcher_factory()
    # Pin the user's filter to a window that excludes early 2020.
    # ``SyncFilter.from_state`` accepts ISO timestamps — using
    # ``custom`` with explicit since/until is the most deterministic
    # way to drive the filter without depending on the current date.
    watcher._test_state.sync_filter_preset = "custom"
    watcher._test_state.sync_filter_since = "2026-01-01T00:00:00Z"
    watcher._test_state.sync_filter_until = "2026-12-31T23:59:59Z"

    path_str = str(watcher._cfg.state_dir / "filtered.SC2Replay")
    with watcher._inflight_lock:
        watcher._inflight.add(path_str)

    # Game from 2020 — well outside the 2026 window.
    old_game = _make_cloud_game(date_iso="2020-06-15T12:00:00Z")
    fut: Future = Future()
    fut.set_result(("game", path_str, old_game))
    watcher._on_worker_done(fut, path_str)

    assert watcher._test_state.uploaded.get(path_str) == "filtered"
    assert watcher._test_upload.submitted == [], (
        "filtered replay must NOT be enqueued for upload"
    )
    # And the inflight discard still happens regardless of filter.
    assert path_str not in watcher._inflight


def test_in_range_replay_reaches_upload_queue_in_process_mode(
    monkeypatch, watcher_factory,
) -> None:
    """Sibling case to the filter test: an in-range replay must upload.

    Without this we couldn't tell whether the previous test passed
    because of the filter or because the upload code path is just
    broken in process mode.
    """
    monkeypatch.delenv("SC2TOOLS_PARSE_USE_PROCESSES", raising=False)
    with patch(
        "sc2tools_agent.watcher._probe_process_pool",
        return_value=(True, None),
    ):
        watcher = watcher_factory()
    watcher._test_state.sync_filter_preset = "all"

    path_str = str(watcher._cfg.state_dir / "kept.SC2Replay")
    with watcher._inflight_lock:
        watcher._inflight.add(path_str)
    game = _make_cloud_game(date_iso="2026-04-01T12:00:00Z")
    fut: Future = Future()
    fut.set_result(("game", path_str, game))
    watcher._on_worker_done(fut, path_str)

    assert path_str not in watcher._test_state.uploaded, (
        "in-range game must not be marked filtered/skipped on the parent side"
    )
    assert len(watcher._test_upload.submitted) == 1
    assert watcher._test_upload.submitted[0].game.game_id == "g1"
    assert path_str not in watcher._inflight


# --- inflight cleanup invariants --------------------------------------


def test_inflight_set_cleared_after_process_worker_done(
    monkeypatch, watcher_factory,
) -> None:
    """Each terminal kind ("game", "skipped", "settle_failed",
    "analyzer_error") must clear the inflight entry."""
    monkeypatch.delenv("SC2TOOLS_PARSE_USE_PROCESSES", raising=False)
    with patch(
        "sc2tools_agent.watcher._probe_process_pool",
        return_value=(True, None),
    ):
        watcher = watcher_factory()
    watcher._test_state.sync_filter_preset = "all"

    cases: List[Tuple[str, Any]] = [
        ("game", _make_cloud_game()),
        ("skipped", None),
        ("settle_failed", None),
        ("analyzer_error", "import failure detail"),
    ]
    for i, (kind, payload) in enumerate(cases):
        path_str = str(watcher._cfg.state_dir / f"case-{i}.SC2Replay")
        with watcher._inflight_lock:
            watcher._inflight.add(path_str)
        fut: Future = Future()
        fut.set_result((kind, path_str, payload))
        watcher._on_worker_done(fut, path_str)
        assert path_str not in watcher._inflight, (
            f"inflight not cleared for kind={kind}"
        )


def test_paused_state_skips_sweep_and_watchdog_submission(
    monkeypatch, watcher_factory,
) -> None:
    """When ``state.paused`` is True, neither the periodic sweep nor a
    watchdog ``on_replay_created`` event must enqueue any parse work.

    Pre-v0.5.8 the pause button only stopped uploads; the watcher
    kept parsing in the background. Under threading mode the parser's
    GIL-bound throughput happened to keep the activity log quiet, so
    nobody noticed. Process mode parses 5–10× faster and surfaced the
    bug as a flood of ``replay_parsed`` log lines after the user
    clicked Pause expecting silence. This test locks down the new
    behaviour: pause halts all parse submission."""
    monkeypatch.setenv("SC2TOOLS_PARSE_USE_PROCESSES", "0")
    watcher = watcher_factory()
    watcher._test_state.paused = True

    # Replace _submit_parse with a counter so we can assert it's
    # never invoked while paused. We don't care WHY it would be —
    # only that pause is the contract gate.
    submit_calls: List[Path] = []

    def _record(path: Path) -> None:
        submit_calls.append(path)

    watcher._submit_parse = _record  # type: ignore[assignment]

    # Synthesize a watched root with a fake replay file so the sweep
    # has something to find.
    fake_root = watcher._cfg.state_dir / "Replays" / "Multiplayer"
    fake_root.mkdir(parents=True, exist_ok=True)
    fake_replay = fake_root / "Pause Test LE (1).SC2Replay"
    fake_replay.write_bytes(b"")
    watcher._roots = [fake_root]
    watcher._test_state.sync_filter_preset = "all"

    # Sweep — must be a no-op while paused.
    watcher._sweep_once()
    assert submit_calls == [], (
        "paused sweep submitted parse work — pause must short-circuit"
    )

    # Live watchdog event — also must be a no-op while paused.
    watcher.on_replay_created(fake_replay)
    assert submit_calls == [], (
        "paused on_replay_created submitted parse work — pause must "
        "short-circuit live events too"
    )

    # Un-pause and confirm the same paths NOW do submit. This proves
    # the gate is the only thing blocking submission, not some other
    # short-circuit (an empty roots list, a stale mtime filter, etc.).
    watcher._test_state.paused = False
    watcher._sweep_once()
    assert len(submit_calls) >= 1, (
        "after un-pause, sweep must resume submitting parse work"
    )


def test_n_strikes_done_callback_failures_trigger_fallback(
    monkeypatch, watcher_factory, caplog,
) -> None:
    """Three consecutive done-callback BrokenProcessPool failures must
    proactively swap to threading mode.

    Regression check for the v0.5.8 incident: ``ONE_FILE=True`` builds
    plus high ``parse_concurrency`` produced waves of worker crashes
    where ``future.result()`` raised in the done-callback. The
    original fallback only triggered on submit-time failures, so the
    parent kept submitting more work into a broken pool until the
    next live submit happened to fail. The N-strikes path catches
    this earlier — proactively, before the next submit — by counting
    consecutive done-callback BrokenProcessPool exceptions and
    falling back at the threshold."""
    from sc2tools_agent.watcher import _PROCESS_CRASH_STRIKES_THRESHOLD

    monkeypatch.delenv("SC2TOOLS_PARSE_USE_PROCESSES", raising=False)
    caplog.set_level("WARNING", logger="sc2tools_agent.watcher")
    with patch(
        "sc2tools_agent.watcher._probe_process_pool",
        return_value=(True, None),
    ):
        watcher = watcher_factory()
    assert watcher._uses_processes is True

    # Fire (threshold - 1) crashes — must NOT swap yet.
    for i in range(_PROCESS_CRASH_STRIKES_THRESHOLD - 1):
        path_str = str(watcher._cfg.state_dir / f"crash-{i}.SC2Replay")
        with watcher._inflight_lock:
            watcher._inflight.add(path_str)
        fut: Future = Future()
        fut.set_exception(BrokenProcessPool("simulated worker death"))
        watcher._on_worker_done(fut, path_str)
    assert watcher._uses_processes is True, (
        "fallback fired prematurely — must require the full threshold"
    )
    assert watcher._process_crash_strikes == _PROCESS_CRASH_STRIKES_THRESHOLD - 1

    # The Nth strike triggers the swap.
    last_path = str(watcher._cfg.state_dir / "crash-last.SC2Replay")
    with watcher._inflight_lock:
        watcher._inflight.add(last_path)
    fut = Future()
    fut.set_exception(BrokenProcessPool("simulated worker death"))
    watcher._on_worker_done(fut, last_path)

    assert watcher._uses_processes is False
    assert isinstance(watcher._executor, ThreadPoolExecutor)
    # Strike counter resets after the swap so subsequent crashes don't
    # double-count.
    assert watcher._process_crash_strikes == 0
    # Both diagnostic lines must appear: the threshold trip itself,
    # and the runtime fallback that the trip triggered.
    threshold_logs = [
        rec for rec in caplog.records
        if "parse_pool_strike_threshold_reached" in rec.message
    ]
    assert threshold_logs
    fallback_logs = [
        rec for rec in caplog.records
        if "parse_pool_runtime_failure_falling_back" in rec.message
    ]
    assert fallback_logs


def test_strike_counter_resets_on_clean_worker_return(
    monkeypatch, watcher_factory, caplog,
) -> None:
    """One transient crash followed by a successful parse must NOT push
    the strike counter toward the threshold."""
    from sc2tools_agent.watcher import _PROCESS_CRASH_STRIKES_THRESHOLD

    monkeypatch.delenv("SC2TOOLS_PARSE_USE_PROCESSES", raising=False)
    caplog.set_level("INFO", logger="sc2tools_agent.watcher")
    with patch(
        "sc2tools_agent.watcher._probe_process_pool",
        return_value=(True, None),
    ):
        watcher = watcher_factory()
    watcher._test_state.sync_filter_preset = "all"

    # First strike — transient crash.
    p1 = str(watcher._cfg.state_dir / "transient.SC2Replay")
    with watcher._inflight_lock:
        watcher._inflight.add(p1)
    fut: Future = Future()
    fut.set_exception(BrokenProcessPool("transient"))
    watcher._on_worker_done(fut, p1)
    assert watcher._process_crash_strikes == 1

    # Then a clean parse — counter must reset.
    p2 = str(watcher._cfg.state_dir / "clean.SC2Replay")
    with watcher._inflight_lock:
        watcher._inflight.add(p2)
    fut = Future()
    fut.set_result(("game", p2, _make_cloud_game()))
    watcher._on_worker_done(fut, p2)
    assert watcher._process_crash_strikes == 0
    assert watcher._uses_processes is True

    # Now (threshold - 1) more crashes still don't trip — the reset
    # forced us back to the start.
    for i in range(_PROCESS_CRASH_STRIKES_THRESHOLD - 1):
        path_str = str(watcher._cfg.state_dir / f"after-reset-{i}.SC2Replay")
        with watcher._inflight_lock:
            watcher._inflight.add(path_str)
        fut = Future()
        fut.set_exception(BrokenProcessPool("post-reset"))
        watcher._on_worker_done(fut, path_str)
    assert watcher._uses_processes is True


def test_strikes_only_counted_for_processpool_exceptions(
    monkeypatch, watcher_factory,
) -> None:
    """A non-pool exception (e.g. corrupted future, custom error) must
    NOT count toward the strike threshold."""
    from sc2tools_agent.watcher import _PROCESS_CRASH_STRIKES_THRESHOLD

    monkeypatch.delenv("SC2TOOLS_PARSE_USE_PROCESSES", raising=False)
    with patch(
        "sc2tools_agent.watcher._probe_process_pool",
        return_value=(True, None),
    ):
        watcher = watcher_factory()

    for i in range(_PROCESS_CRASH_STRIKES_THRESHOLD * 2):
        path_str = str(watcher._cfg.state_dir / f"non-pool-{i}.SC2Replay")
        with watcher._inflight_lock:
            watcher._inflight.add(path_str)
        fut: Future = Future()
        fut.set_exception(ValueError("not a pool problem"))
        watcher._on_worker_done(fut, path_str)
    assert watcher._uses_processes is True, (
        "non-pool exceptions must not trip the strike fallback"
    )
    assert watcher._process_crash_strikes == 0


def test_inflight_cleared_when_future_itself_raises(
    monkeypatch, watcher_factory, caplog,
) -> None:
    """A worker crash (BrokenProcessPool surfaced via future.result()
    raising) must still clear the inflight entry — otherwise the
    file is permanently stuck and never re-submits on a future
    sweep."""
    monkeypatch.delenv("SC2TOOLS_PARSE_USE_PROCESSES", raising=False)
    caplog.set_level("WARNING", logger="sc2tools_agent.watcher")
    with patch(
        "sc2tools_agent.watcher._probe_process_pool",
        return_value=(True, None),
    ):
        watcher = watcher_factory()

    path_str = str(watcher._cfg.state_dir / "crashy.SC2Replay")
    with watcher._inflight_lock:
        watcher._inflight.add(path_str)

    fut: Future = Future()
    fut.set_exception(BrokenProcessPool("simulated crash"))
    watcher._on_worker_done(fut, path_str)

    assert path_str not in watcher._inflight, (
        "inflight must be cleared even when the future raised — "
        "otherwise the replay is permanently stuck"
    )
    # And the crash gets logged with type+repr (not just str(exc),
    # which is empty for BrokenProcessPool in some cases).
    crash_logs = [
        rec for rec in caplog.records if "parse_worker_crashed" in rec.message
    ]
    assert crash_logs, "expected a parse_worker_crashed warning"
    assert "BrokenProcessPool" in crash_logs[0].message


# --- env-var resolution unit -----------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        ("", True),
        ("1", True),
        ("true", True),
        ("True", True),
        ("on", True),
        ("anything", True),
        ("0", False),
        ("false", False),
        ("FALSE", False),
        ("off", False),
        ("Off", False),
        ("no", False),
        ("  0  ", False),
    ],
)
def test_parse_pool_use_processes_env_resolution(
    monkeypatch, value: str, expected: bool,
) -> None:
    from sc2tools_agent.watcher import _parse_pool_use_processes_env

    if value == "":
        monkeypatch.delenv("SC2TOOLS_PARSE_USE_PROCESSES", raising=False)
    else:
        monkeypatch.setenv("SC2TOOLS_PARSE_USE_PROCESSES", value)
    assert _parse_pool_use_processes_env() is expected

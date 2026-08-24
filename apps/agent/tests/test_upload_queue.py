"""Tests for sc2tools_agent.uploader.queue (pause + resync additions)."""

from __future__ import annotations

import hashlib
import queue
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable, Dict, List

from sc2tools_agent.api_client import (
    ReplayArchiveSourceUnavailable,
    ReplayIngestBusy,
)
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.replay_pipeline import CloudGame
from sc2tools_agent.state import AgentState
from sc2tools_agent.uploader.queue import (
    TerminalUploadError,
    UploadJob,
    UploadQueue,
)
from sc2tools_agent.uploader.archive_journal import (
    ReplayArchiveJournal,
    ReplayArchiveJournalError,
    ReplayArchiveTask,
)


class _StubApi:
    """Test double for ApiClient.

    Tests count ``self.calls`` to assert how many times the agent hit
    the cloud, regardless of whether the queue used the legacy
    single-game endpoint or the v0.5.8+ batch endpoint. Each game
    inside a batch counts as one entry in ``calls`` so existing
    "expected exactly N calls" assertions don't break when we flip
    ``upload_batch_size`` between 1 and N.

    ``batch_calls`` separately tracks the SHAPE of how the queue
    issued its requests — one entry per HTTP round-trip, regardless
    of how many games were in the batch. New tests use this to
    assert "the queue made K HTTP requests for these N games".
    """

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        # One entry per HTTP request to ``upload_games_batch``,
        # capturing the batch size of that request.
        self.batch_calls: List[int] = []
        self.mmr_calls: List[Dict[str, Any]] = []

    def upload_game(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        # Legacy single-game endpoint. The v0.5.8 queue routes through
        # ``upload_games_batch`` even for size-1 batches; this method
        # is kept so any direct caller (or external code that mocks
        # ``ApiClient`` and exposes only ``upload_game``) keeps
        # working.
        self.calls.append(payload)
        return {"accepted": [{"gameId": payload["gameId"], "created": True}]}

    def upload_games_batch(
        self, games: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        self.batch_calls.append(len(games))
        accepted = []
        for g in games:
            self.calls.append(g)
            accepted.append({"gameId": g["gameId"], "created": True})
        return {"accepted": accepted, "rejected": []}

    def patch_last_mmr(
        self, *, mmr: int, captured_at=None, region=None, game_id=None,
    ) -> Dict[str, Any]:
        self.mmr_calls.append(
            {
                "mmr": mmr,
                "captured_at": captured_at,
                "region": region,
                "game_id": game_id,
            },
        )
        return {"ok": True, "wrote": True}


def _cfg(
    tmp_path: Path,
    *,
    upload_concurrency: int = 1,
    upload_batch_size: int = 1,
) -> AgentConfig:
    return AgentConfig(
        api_base="http://localhost:0",
        state_dir=tmp_path,
        replay_folder=None,
        poll_interval_sec=10,
        parse_concurrency=1,
        upload_concurrency=upload_concurrency,
        upload_batch_size=upload_batch_size,
    )


def _game(
    tmp_path: Path,
    name: str,
    *,
    my_mmr: int | None = None,
    my_toon_handle: str | None = None,
    date_iso: str = "2026-04-01T00:00:00Z",
) -> UploadJob:
    fp = tmp_path / name
    fp.write_bytes(b"")
    cloud = CloudGame(
        game_id=f"id-{name}",
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
        my_mmr=my_mmr,
        my_toon_handle=my_toon_handle,
    )
    return UploadJob(file_path=fp, game=cloud)


def _wait_for(
    predicate: Callable[[], bool],
    *,
    timeout: float = 3.0,
    interval: float = 0.02,
) -> bool:
    """Poll a background-thread condition without assuming runner speed."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def test_set_paused_persists_state_and_skips_uploads(tmp_path: Path) -> None:
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    q.set_paused(True)
    assert q.is_paused()
    q.start()
    try:
        q.submit(_game(tmp_path, "a.SC2Replay"))
        # Give the worker thread a few ticks to (not) process the job.
        time.sleep(0.5)
        assert api.calls == []
        # Resume + the job should drain.
        q.set_paused(False)
        assert _wait_for(lambda: len(api.calls) == 1, timeout=6.0)
    finally:
        q.stop()


def test_accepted_game_journals_original_before_success_callback(
    tmp_path: Path,
) -> None:
    events: list[str] = []

    class _ArchiveApi(_StubApi):
        def upload_replay_file(self, game_id: str, path: Path) -> bool:
            # The journal canonicalizes path identity with ``normcase``.
            # Depending on which archive-lane scheduling path wins, Windows
            # may therefore hydrate this task with lowercase display casing.
            assert path.samefile(job.file_path)
            events.append(f"archive:{game_id}")
            return True

    state = AgentState(device_token="t")
    api = _ArchiveApi()

    def _success(path: Path) -> None:
        durable = ReplayArchiveJournal(tmp_path)
        assert durable.contains(
            ReplayArchiveTask(path, f"id-{path.name}"),
        )
        events.append(f"success:{path.name}")

    q = UploadQueue(
        cfg=_cfg(tmp_path),
        state=state,
        api=api,
        on_success=_success,
    )
    job = _game(tmp_path, "archive.SC2Replay")
    q.start()
    try:
        assert q.submit(job)
        assert _wait_for(lambda: str(job.file_path) in state.uploaded)
        assert _wait_for(
            lambda: f"archive:{job.game.game_id}" in events,
            timeout=5.0,
        )
        assert q.archive_pending_count() == 0
    finally:
        q.stop()

    assert events == [
        "success:archive.SC2Replay",
        "archive:id-archive.SC2Replay",
    ]


def test_permanently_unarchivable_file_does_not_block_parsed_sync(
    tmp_path: Path,
) -> None:
    events: list[str] = []

    class _UnavailableArchiveApi(_StubApi):
        def upload_replay_file(self, game_id: str, path: Path) -> bool:
            events.append(f"unavailable:{game_id}:{path.name}")
            return False

    state = AgentState(device_token="t")
    api = _UnavailableArchiveApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path),
        state=state,
        api=api,
        on_success=lambda path: events.append(f"success:{path.name}"),
    )
    job = _game(tmp_path, "too-large.SC2Replay")
    q.start()
    try:
        assert q.submit(job)
        assert _wait_for(lambda: str(job.file_path) in state.uploaded)
        assert _wait_for(
            lambda: any(event.startswith("unavailable:") for event in events),
            timeout=5.0,
        )
        assert q.archive_pending_count() == 0
    finally:
        q.stop()

    assert events[0] == "success:too-large.SC2Replay"
    prefix, archived_name = events[1].rsplit(":", 1)
    assert prefix == "unavailable:id-too-large.SC2Replay"
    # The durable journal uses the host OS's path identity. Windows may
    # hydrate its normalized lowercase spelling while the immediate lane
    # retains the original display casing; both resolve to the same file.
    assert Path(archived_name) == Path("too-large.SC2Replay")


def test_accepted_archive_marker_skips_local_hash_and_upload(
    tmp_path: Path,
) -> None:
    """A verified ownership-scoped marker makes Full Re-sync cheap.

    The queue must not call the archive client at all: that call hashes the
    local file before the prepare endpoint can return ``alreadyStored``.
    """

    replay_bytes = b"exact archived replay identity"
    marker = {
        "available": True,
        "sizeBytes": len(replay_bytes),
        "sha256": hashlib.sha256(replay_bytes).hexdigest(),
        "storedAt": "2026-08-13T00:00:00Z",
    }

    class _AlreadyArchivedApi(_StubApi):
        def upload_games_batch(
            self,
            games: List[Dict[str, Any]],
        ) -> Dict[str, Any]:
            self.batch_calls.append(len(games))
            self.calls.extend(games)
            return {
                "accepted": [
                    {
                        "gameId": game["gameId"],
                        "created": False,
                        "replayArchive": marker,
                    }
                    for game in games
                ],
                "rejected": [],
            }

        def upload_replay_file(self, game_id: str, path: Path) -> bool:
            raise AssertionError(
                f"already archived game was re-read: {game_id} {path}",
            )

    state = AgentState(device_token="t")
    api = _AlreadyArchivedApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    job = _game(tmp_path, "already-archived.SC2Replay")
    job.file_path.write_bytes(replay_bytes)
    stale = ReplayArchiveTask(job.file_path, job.game.game_id)
    q._archive_journal.enqueue_many([stale])
    assert q.submit(job)
    q.start()
    try:
        assert _wait_for(lambda: str(job.file_path) in state.uploaded)
        assert _wait_for(lambda: q.archive_pending_count() == 0)
    finally:
        q.stop()

    assert len(api.calls) == 1


def test_missing_archive_marker_preserves_existing_archive_flow(
    tmp_path: Path,
) -> None:
    archived: list[tuple[str, str]] = []

    class _MissingArchiveApi(_StubApi):
        def upload_games_batch(
            self,
            games: List[Dict[str, Any]],
        ) -> Dict[str, Any]:
            result = super().upload_games_batch(games)
            for accepted in result["accepted"]:
                accepted["replayArchive"] = {"available": False}
            return result

        def upload_replay_file(self, game_id: str, path: Path) -> bool:
            archived.append((game_id, path.name))
            return True

    state = AgentState(device_token="t")
    api = _MissingArchiveApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    job = _game(tmp_path, "missing-archive.SC2Replay")
    q.start()
    try:
        assert q.submit(job)
        assert _wait_for(lambda: str(job.file_path) in state.uploaded)
        assert _wait_for(lambda: len(archived) == 1, timeout=5.0)
    finally:
        q.stop()

    assert len(archived) == 1
    assert archived[0][0] == job.game.game_id
    assert Path(archived[0][1]) == Path(job.file_path.name)


def test_archive_restart_hydration_is_fair_to_later_available_file(
    tmp_path: Path,
    monkeypatch,
) -> None:
    import sc2tools_agent.uploader.queue as queue_module

    monkeypatch.setattr(queue_module, "_ARCHIVE_READY_LIMIT", 2)
    monkeypatch.setattr(queue_module, "_ARCHIVE_IDLE_GRACE_SEC", 0.01)
    monkeypatch.setattr(queue_module, "_ARCHIVE_RETRY_BASE_SEC", 5.0)
    missing = [
        ReplayArchiveTask(tmp_path / f"missing-{i}.SC2Replay", f"missing-{i}")
        for i in range(2)
    ]
    available = ReplayArchiveTask(tmp_path / "available.SC2Replay", "ready")
    available.file_path.write_bytes(b"MPQ\x1bready")
    journal = ReplayArchiveJournal(tmp_path)
    journal.enqueue_many([*missing, available])
    archived: list[str] = []

    class _ArchiveApi(_StubApi):
        def upload_replay_file_durable(
            self,
            game_id: str,
            path: Path,
        ) -> bool:
            if not path.is_file():
                raise ReplayArchiveSourceUnavailable("source offline")
            archived.append(game_id)
            return True

    q = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(), api=_ArchiveApi())
    q.start()
    try:
        assert _wait_for(lambda: archived == ["ready"], timeout=4.0)
        assert q.archive_pending_count() == 2
    finally:
        q.stop()

    # The missing sources remain durable across restart. Once they reappear,
    # a fresh queue hydrates and finishes them without another analysis sync.
    for task in missing:
        task.file_path.write_bytes(b"MPQ\x1brestored")
    restarted_api = _ArchiveApi()
    restarted = UploadQueue(
        cfg=_cfg(tmp_path),
        state=AgentState(),
        api=restarted_api,
    )
    restarted.start()
    try:
        assert _wait_for(
            lambda: restarted.archive_pending_count() == 0,
            timeout=4.0,
        )
    finally:
        restarted.stop()


def test_archive_lane_circuit_breaker_bounds_calls_during_outage(
    tmp_path: Path,
    monkeypatch,
) -> None:
    import sc2tools_agent.uploader.queue as queue_module

    monkeypatch.setattr(queue_module, "_ARCHIVE_IDLE_GRACE_SEC", 0.01)
    monkeypatch.setattr(queue_module, "_ARCHIVE_RETRY_BASE_SEC", 1.0)
    tasks = []
    for index in range(20):
        path = tmp_path / f"outage-{index}.SC2Replay"
        path.write_bytes(b"MPQ\x1bdata")
        tasks.append(ReplayArchiveTask(path, f"g-{index}"))
    ReplayArchiveJournal(tmp_path).enqueue_many(tasks)

    class _OutageApi(_StubApi):
        def __init__(self) -> None:
            super().__init__()
            self.archive_calls = 0

        def upload_replay_file_durable(
            self,
            _game_id: str,
            _path: Path,
        ) -> bool:
            self.archive_calls += 1
            raise RuntimeError("storage unavailable")

    api = _OutageApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(), api=api)
    q.start()
    try:
        assert _wait_for(lambda: api.archive_calls == 1, timeout=2.0)
        time.sleep(0.3)
        assert api.archive_calls == 1
        assert q.archive_pending_count() == len(tasks)
    finally:
        q.stop()


def test_archive_journal_checkpoint_failure_suspends_before_next_upload(
    tmp_path: Path,
    monkeypatch,
) -> None:
    import sc2tools_agent.uploader.queue as queue_module

    monkeypatch.setattr(queue_module, "_ARCHIVE_IDLE_GRACE_SEC", 0.01)
    tasks = []
    for index in range(2):
        path = tmp_path / f"checkpoint-{index}.SC2Replay"
        path.write_bytes(b"MPQ\x1bdata")
        tasks.append(ReplayArchiveTask(path, f"checkpoint-{index}"))
    ReplayArchiveJournal(tmp_path).enqueue_many(tasks)

    class _ArchiveApi(_StubApi):
        def __init__(self) -> None:
            super().__init__()
            self.archive_calls = 0

        def upload_replay_file_durable(
            self,
            _game_id: str,
            _path: Path,
        ) -> bool:
            self.archive_calls += 1
            return True

    api = _ArchiveApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(), api=api)

    def _fail_ack(*_args: Any, **_kwargs: Any) -> int:
        raise ReplayArchiveJournalError("checkpoint poisoned")

    monkeypatch.setattr(q._archive_journal, "acknowledge_many", _fail_ack)
    q.start()
    try:
        assert _wait_for(lambda: api.archive_calls == 1, timeout=2.0)
        assert _wait_for(lambda: q._archive_journal_error is not None)
        time.sleep(0.3)
        assert api.archive_calls == 1
        assert q.archive_pending_count() == len(tasks)
    finally:
        q.stop()


def test_pause_holds_durable_archive_worker(tmp_path: Path, monkeypatch) -> None:
    import sc2tools_agent.uploader.queue as queue_module

    monkeypatch.setattr(queue_module, "_ARCHIVE_IDLE_GRACE_SEC", 0.01)
    task = ReplayArchiveTask(tmp_path / "paused.SC2Replay", "paused")
    task.file_path.write_bytes(b"MPQ\x1bpaused")
    ReplayArchiveJournal(tmp_path).enqueue_many([task])
    archived = threading.Event()

    class _ArchiveApi(_StubApi):
        def upload_replay_file_durable(
            self,
            _game_id: str,
            _path: Path,
        ) -> bool:
            archived.set()
            return True

    q = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(), api=_ArchiveApi())
    q.set_paused(True)
    q.start()
    try:
        assert not archived.wait(0.3)
        assert q.archive_pending_count() == 1
        q.set_paused(False)
        assert archived.wait(2.0)
        assert _wait_for(lambda: q.archive_pending_count() == 0)
    finally:
        q.stop()


def test_history_jobs_coalesce_during_short_callback_wave(
    tmp_path: Path,
) -> None:
    api = _StubApi()
    state = AgentState(device_token="t")
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_batch_size=5),
        state=state,
        api=api,
    )
    jobs = [_game(tmp_path, f"wave-{i}.SC2Replay") for i in range(5)]
    q.start()
    try:
        assert q.submit(jobs[0])
        # Simulate process-pool callbacks landing just after the first worker
        # wake-up instead of being preloaded in the queue.
        time.sleep(0.05)
        for job in jobs[1:]:
            assert q.submit(job)
        assert _wait_for(lambda: len(api.calls) == len(jobs))
    finally:
        q.stop()

    assert api.batch_calls == [5]


def test_live_job_ends_history_coalescing_wait(
    tmp_path: Path,
    monkeypatch,
) -> None:
    import sc2tools_agent.uploader.queue as queue_module

    # A long test-only window makes it unambiguous that the live arrival,
    # rather than the deadline, wakes the history worker.
    monkeypatch.setattr(queue_module, "_BATCH_COALESCE_SEC", 1.0)
    first_request = threading.Event()

    class _SignallingApi(_StubApi):
        def upload_games_batch(
            self,
            games: List[Dict[str, Any]],
        ) -> Dict[str, Any]:
            first_request.set()
            return super().upload_games_batch(games)

    api = _SignallingApi()
    state = AgentState(device_token="t")
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_batch_size=5),
        state=state,
        api=api,
    )
    history = _game(tmp_path, "history.SC2Replay")
    live = replace(_game(tmp_path, "live.SC2Replay"), priority=True)
    q.start()
    try:
        assert q.submit(history)
        time.sleep(0.05)
        assert q.submit(live)
        assert first_request.wait(0.5), "live arrival did not end batch wait"
        assert _wait_for(lambda: len(api.calls) == 2)
    finally:
        q.stop()

    assert api.batch_calls == [1, 1]
    assert [call["gameId"] for call in api.calls] == [
        history.game.game_id,
        live.game.game_id,
    ]


def test_pause_during_history_coalescing_prevents_network_call(
    tmp_path: Path,
    monkeypatch,
) -> None:
    import sc2tools_agent.uploader.queue as queue_module

    monkeypatch.setattr(queue_module, "_BATCH_COALESCE_SEC", 0.5)
    api = _StubApi()
    state = AgentState(device_token="t")
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_batch_size=5),
        state=state,
        api=api,
    )
    job = _game(tmp_path, "pause-during-coalesce.SC2Replay")
    q.start()
    try:
        assert q.submit(job)
        time.sleep(0.05)
        q.set_paused(True)
        time.sleep(0.6)
        assert api.calls == []
        assert q.pending_count() == 1
        q.set_paused(False)
        assert _wait_for(lambda: len(api.calls) == 1, timeout=3.0)
    finally:
        q.stop()


def test_pause_while_waiting_for_shared_network_slot_prevents_call(
    tmp_path: Path,
) -> None:
    api = _StubApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1),
        state=AgentState(),
        api=api,
    )
    try:
        with q._network_gate.hold(0), q._network_gate.hold(0):
            q.start()
            assert q.submit(_game(tmp_path, "gate-pause.SC2Replay"))
            time.sleep(0.1)
            q.set_paused(True)
        time.sleep(0.2)
        assert api.calls == []
        assert q.pending_count() == 1
        q.set_paused(False)
        assert _wait_for(lambda: len(api.calls) == 1)
    finally:
        q.stop()


def test_resync_event_can_be_acknowledged(tmp_path: Path) -> None:
    state = AgentState(device_token="t")
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi())
    assert not q.is_resync_requested()
    q.request_full_resync()
    assert q.is_resync_requested()
    q.acknowledge_resync()
    assert not q.is_resync_requested()


def test_default_paused_picks_up_state(tmp_path: Path) -> None:
    state = AgentState(device_token="t", paused=True)
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi())
    assert q.is_paused()


class _RejectAllApi:
    """Stub that mimics the server's AJV-validation rejection shape.

    Returns the same envelope a real ``POST /v1/games`` returns when
    every game in the batch fails validation: ``accepted: []`` and
    ``rejected: [{gameId, errors}]``. The queue's ``_upload_one`` reads
    ``accepted[0].gameId`` to decide success, so this drives the
    ``_ServerRejectedError`` branch.
    """

    def __init__(self) -> None:
        self.calls: int = 0

    def upload_game(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        self.calls += 1
        return {
            "accepted": [],
            "rejected": [
                {
                    "gameId": payload["gameId"],
                    "errors": ["/oppBuildLog must NOT have more than 5000 items"],
                }
            ],
        }

    def upload_games_batch(
        self, games: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        # Each invocation counts as one ``call`` against the server,
        # matching the legacy single-game behaviour where the queue
        # would call ``upload_game`` once per submitted job and we'd
        # tally those. The retry-loop test asserts this stays at 1.
        self.calls += 1
        return {
            "accepted": [],
            "rejected": [
                {
                    "gameId": g["gameId"],
                    "errors": ["/oppBuildLog must NOT have more than 5000 items"],
                }
                for g in games
            ],
        }


def test_server_rejection_marks_replay_done_and_skips_retry(
    tmp_path: Path,
) -> None:
    """A schema rejection must NOT loop on the upload queue.

    Pre-fix behaviour: ``_upload_one`` raised ``RuntimeError`` on
    rejection, the worker slept 2 s, re-enqueued the same job, and
    re-tried indefinitely — eventually filling the bounded queue and
    dropping every fresh replay with ``upload_queue_full``.

    Post-fix behaviour: rejection raises ``_ServerRejectedError``; the
    worker logs once, marks the path as ``"rejected"`` in
    ``state.uploaded`` so the next sweep skips it, and never re-enqueues.
    """
    state = AgentState(device_token="t")
    api = _RejectAllApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    job = _game(tmp_path, "rejected.SC2Replay")
    q.start()
    try:
        q.submit(job)
        # Wait for the terminal outcome to land, then sit out the 2 s
        # retry window — in the broken old behaviour the re-enqueued
        # job would call the API again inside it.
        assert _wait_for(
            lambda: str(job.file_path) in state.uploaded, timeout=6.0,
        )
        time.sleep(2.5)
    finally:
        q.stop()

    # API must have been called exactly once: no retry loop.
    assert api.calls == 1, (
        f"server rejection re-tried; got {api.calls} calls — the "
        "queue's old retry-on-Exception branch leaks for permanent "
        "validation failures and starves the bounded queue."
    )
    # State must remember this file as rejected so future sweeps skip
    # it (otherwise it'd come back through the watcher and re-fail).
    assert str(job.file_path) in state.uploaded
    assert state.uploaded[str(job.file_path)] == "rejected"
    # Queue must drain — the rejected job is gone, not parked for retry.
    assert q.pending_count() == 0


def test_transient_failure_still_retries(tmp_path: Path) -> None:
    """Inverse of the rejection test — non-rejection failures still retry.

    The fix carved out a permanent-rejection branch but kept the
    legacy retry-on-Exception path for transient errors (network
    blip, 5xx). This test makes sure that the carve-out didn't
    accidentally short-circuit the retry path: a stub that raises
    on the first call but accepts on the second must still upload
    successfully without the file being marked ``rejected``.
    """

    class _FlakyApi:
        def __init__(self) -> None:
            self.calls: int = 0

        def upload_game(self, payload: Dict[str, Any]) -> Dict[str, Any]:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("simulated_network_blip")
            return {
                "accepted": [{"gameId": payload["gameId"], "created": True}]
            }

        def upload_games_batch(
            self, games: List[Dict[str, Any]],
        ) -> Dict[str, Any]:
            # Same flaky-then-success pattern via the batch endpoint
            # so the queue's transient-failure → retry → success path
            # is exercised under both single-game and batch upload modes.
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("simulated_network_blip")
            return {
                "accepted": [
                    {"gameId": g["gameId"], "created": True}
                    for g in games
                ],
                "rejected": [],
            }

    state = AgentState(device_token="t")
    api = _FlakyApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    q.start()
    try:
        q.submit(_game(tmp_path, "flaky.SC2Replay"))
        # The retry path sleeps 2 s before re-enqueueing; poll for the
        # eventual success rather than betting on a fixed window.
        assert _wait_for(lambda: len(state.uploaded) == 1, timeout=10.0)
    finally:
        q.stop()

    assert api.calls >= 2, "transient error must trigger retry"
    # And the eventual success must mark the file as uploaded — not
    # "rejected" (that label is reserved for permanent failures).
    only_key = next(iter(state.uploaded))
    assert state.uploaded[only_key] != "rejected"


# -------------------------------------------------------------------------
# Pending-path dedupe + live-upload priority. These protect the watcher
# against re-enqueueing the same replay on every sweep while an upload is
# queued/retrying, and keep a newly completed game ahead of a large backfill.
# -------------------------------------------------------------------------


def test_submit_dedupes_same_path_while_pending(tmp_path: Path) -> None:
    state = AgentState(device_token="t")
    pending_updates: list[int] = []
    q = UploadQueue(
        cfg=_cfg(tmp_path),
        state=state,
        api=_StubApi(),
        on_pending_changed=pending_updates.append,
    )
    job = _game(tmp_path, "pending.SC2Replay")

    assert q.submit(job) is True
    assert q.is_pending(job.file_path) is True
    assert pending_updates == [1]
    assert q.submit(job) is False
    assert q.pending_count() == 1
    # A dedupe rejection does not change the number of reserved paths.
    assert pending_updates == [1]
    assert str(job.file_path) not in state.uploaded

    q.start()
    try:
        assert _wait_for(lambda: str(job.file_path) in state.uploaded)
        assert _wait_for(lambda: pending_updates[-1:] == [0])
    finally:
        q.stop()

    assert pending_updates == [1, 0]


def test_pending_reservation_survives_retry_then_releases_on_success(
    tmp_path: Path,
) -> None:
    first_attempt = threading.Event()
    retry_succeeded = threading.Event()

    class _CoordinatedFlakyApi:
        def __init__(self) -> None:
            self.calls = 0

        def upload_games_batch(
            self, games: List[Dict[str, Any]],
        ) -> Dict[str, Any]:
            self.calls += 1
            if self.calls == 1:
                first_attempt.set()
                raise RuntimeError("simulated_transient_failure")
            retry_succeeded.set()
            return {
                "accepted": [
                    {"gameId": game["gameId"], "created": True}
                    for game in games
                ],
                "rejected": [],
            }

        def patch_last_mmr(self, **_kwargs: Any) -> Dict[str, Any]:
            return {"ok": True, "wrote": False}

    state = AgentState(device_token="t")
    api = _CoordinatedFlakyApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    job = _game(tmp_path, "retry-reserved.SC2Replay")
    assert q.submit(job) is True
    q.start()
    try:
        assert first_attempt.wait(timeout=10.0)
        # The worker is now in the transient-failure retry path. The path
        # must remain reserved even though it is temporarily outside _q.
        assert q.is_pending(job.file_path) is True
        assert q.submit(job) is False

        assert retry_succeeded.wait(timeout=10.0)
        assert _wait_for(
            lambda: str(job.file_path) in state.uploaded,
            timeout=2.0,
        )
        assert q.is_pending(job.file_path) is False
    finally:
        q.stop()

    assert api.calls == 2


def test_transient_retry_survives_saturated_primary_queue(
    tmp_path: Path,
) -> None:
    first_failure = threading.Event()

    class _FailFirstApi:
        def __init__(self) -> None:
            self.game_ids: list[str] = []

        def upload_games_batch(
            self, games: List[Dict[str, Any]],
        ) -> Dict[str, Any]:
            self.game_ids.extend(game["gameId"] for game in games)
            if len(self.game_ids) == 1:
                raise RuntimeError("simulated_transient_failure")
            return {
                "accepted": [
                    {"gameId": game["gameId"], "created": True}
                    for game in games
                ],
                "rejected": [],
            }

        def patch_last_mmr(self, **_kwargs: Any) -> Dict[str, Any]:
            return {"ok": True, "wrote": False}

    state = AgentState(device_token="t")
    api = _FailFirstApi()
    retried = _game(tmp_path, "retry-through-saturation.SC2Replay")
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=1),
        state=state,
        api=api,
        on_failure=lambda path, _exc: (
            first_failure.set() if path == retried.file_path else None
        ),
    )
    # A tiny primary lane makes the saturation boundary deterministic.
    # The retry lane remains the production unbounded PriorityQueue.
    q._q = queue.PriorityQueue(maxsize=2)

    assert q.submit(retried) is True
    q.start()
    try:
        assert first_failure.wait(timeout=10.0)
        backlog = [
            _game(tmp_path, f"saturating-{i}.SC2Replay")
            for i in range(2)
        ]
        for job in backlog:
            assert q.submit(job) is True
        assert q._q.full()
        assert q.is_pending(retried.file_path) is True
        assert q.submit(retried) is False

        assert _wait_for(
            lambda: str(retried.file_path) in state.uploaded,
            timeout=6.0,
        )
    finally:
        q.stop()

    assert api.game_ids.count(retried.game.game_id) == 2
    assert q.is_pending(retried.file_path) is False


def test_mixed_terminal_job_is_not_resurrected_by_valid_job_retry(
    tmp_path: Path,
) -> None:
    class _FailFirstValidPostApi:
        def __init__(self) -> None:
            self.payload_game_ids: list[list[str]] = []

        def upload_games_batch(
            self, games: List[Dict[str, Any]],
        ) -> Dict[str, Any]:
            game_ids = [game["gameId"] for game in games]
            self.payload_game_ids.append(game_ids)
            if len(self.payload_game_ids) == 1:
                raise RuntimeError("simulated_valid_post_failure")
            return {
                "accepted": [
                    {"gameId": game_id, "created": True}
                    for game_id in game_ids
                ],
                "rejected": [],
            }

        def patch_last_mmr(self, **_kwargs: Any) -> Dict[str, Any]:
            return {"ok": True, "wrote": False}

    state = AgentState(device_token="t")
    api = _FailFirstValidPostApi()
    failures: list[tuple[Path, Exception]] = []
    successes: list[Path] = []
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=2),
        state=state,
        api=api,
        on_failure=lambda path, exc: failures.append((path, exc)),
        on_success=successes.append,
    )
    invalid_base = _game(tmp_path, "missing-game-id.SC2Replay")
    invalid = UploadJob(
        file_path=invalid_base.file_path,
        game=replace(invalid_base.game, game_id=""),
    )
    valid = _game(tmp_path, "valid-after-terminal.SC2Replay")

    assert q.submit(invalid) is True
    assert q.submit(valid) is True
    q.start()
    try:
        assert _wait_for(
            lambda: str(valid.file_path) in state.uploaded,
            timeout=6.0,
        )
    finally:
        q.stop()

    invalid_failures = [
        exc for path, exc in failures if path == invalid.file_path
    ]
    valid_failures = [
        exc for path, exc in failures if path == valid.file_path
    ]

    assert api.payload_game_ids == [
        [valid.game.game_id],
        [valid.game.game_id],
    ]
    assert state.uploaded[str(invalid.file_path)] == "rejected"
    assert len(invalid_failures) == 1
    assert isinstance(invalid_failures[0], TerminalUploadError)
    assert len(valid_failures) == 1
    assert not isinstance(valid_failures[0], TerminalUploadError)
    assert successes == [valid.file_path]
    assert q.is_pending(invalid.file_path) is False
    assert q.is_pending(valid.file_path) is False


def test_live_priority_uploads_ahead_of_normal_backlog(tmp_path: Path) -> None:
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=1),
        state=state,
        api=api,
    )
    normal_jobs = [
        _game(tmp_path, f"backlog-{i}.SC2Replay") for i in range(3)
    ]
    for job in normal_jobs:
        assert q.submit(job) is True

    live_base = _game(tmp_path, "just-finished.SC2Replay")
    live_job = UploadJob(
        file_path=live_base.file_path,
        game=live_base.game,
        priority=True,
    )
    assert q.submit(live_job) is True

    q.start()
    try:
        assert _wait_for(lambda: len(api.calls) == 4, timeout=3.0)
    finally:
        q.stop()

    assert [payload["gameId"] for payload in api.calls] == [
        live_job.game.game_id,
        *(job.game.game_id for job in normal_jobs),
    ]


def test_same_game_id_sends_one_payload_and_records_both_paths(
    tmp_path: Path,
) -> None:
    state = AgentState(device_token="t")
    api = _StubApi()
    succeeded: list[Path] = []
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=2),
        state=state,
        api=api,
        on_success=succeeded.append,
    )
    first = _game(tmp_path, "alias-one.SC2Replay")
    second_base = _game(tmp_path, "alias-two.SC2Replay")
    second = UploadJob(
        file_path=second_base.file_path,
        game=replace(second_base.game, game_id=first.game.game_id),
    )

    assert q.submit(first) is True
    assert q.submit(second) is True
    q.start()
    try:
        assert _wait_for(lambda: len(state.uploaded) == 2, timeout=3.0)
    finally:
        q.stop()

    # Both aliases are coalesced into one game payload in one request,
    # while each local path still reaches its own terminal outcome.
    assert api.batch_calls == [1]
    assert len(api.calls) == 1
    assert set(state.uploaded) == {str(first.file_path), str(second.file_path)}
    assert set(succeeded) == {first.file_path, second.file_path}
    assert q.is_pending(first.file_path) is False
    assert q.is_pending(second.file_path) is False


def test_resumed_upload_includes_legacy_ids_for_same_local_file(
    tmp_path: Path,
) -> None:
    base = _game(tmp_path, "resumed.SC2Replay")
    resumed = UploadJob(
        file_path=base.file_path,
        game=replace(
            base.game,
            is_resumed_from_replay=True,
            resumed_replay_game_ids=["explicit-alias"],
        ),
    )
    state = AgentState(
        device_token="t",
        path_by_game_id={
            "legacy-uploaded-id": str(resumed.file_path),
            resumed.game.game_id: str(resumed.file_path),
            "another-file-id": str(tmp_path / "other.SC2Replay"),
        },
    )
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)

    assert q.submit(resumed) is True
    q.start()
    try:
        assert _wait_for(lambda: len(api.calls) == 1, timeout=3.0)
    finally:
        q.stop()

    assert api.calls[0]["isResumedFromReplay"] is True
    assert api.calls[0]["resumedReplayGameIds"] == [
        "explicit-alias",
        "legacy-uploaded-id",
    ]
    assert "another-file-id" not in api.calls[0]["resumedReplayGameIds"]


def test_legacy_single_upload_also_includes_resumed_aliases(
    tmp_path: Path,
) -> None:
    base = _game(tmp_path, "legacy-single-resumed.SC2Replay")
    resumed = UploadJob(
        file_path=base.file_path,
        game=replace(base.game, is_resumed_from_replay=True),
    )
    state = AgentState(
        device_token="t",
        path_by_game_id={"old-single-id": str(resumed.file_path)},
    )
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)

    q._upload_one(resumed)

    assert api.calls[0]["resumedReplayGameIds"] == ["old-single-id"]


# -------------------------------------------------------------------------
# Sticky-MMR ping. The session widget falls back to the cloud profile's
# ``lastKnownMmr`` whenever no game in the user's history carries
# ``myMmr`` — so the upload queue must ping it on each successful
# upload that DOES carry a fresh MMR. Tests here lock down:
#   - the happy path (push fires + state updates),
#   - the no-MMR skip,
#   - the older-replay-skip (no clobbering during a backfill),
#   - the network-error fail-soft (MMR push must not break uploads).
# -------------------------------------------------------------------------


def test_successful_upload_pushes_last_mmr(tmp_path: Path) -> None:
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    job = _game(
        tmp_path, "ranked.SC2Replay",
        my_mmr=4730,
        my_toon_handle="1-S2-1-267727",
        date_iso="2026-05-07T10:00:00Z",
    )
    q.start()
    try:
        q.submit(job)
        assert _wait_for(lambda: len(api.mmr_calls) == 1, timeout=6.0)
    finally:
        q.stop()
    assert len(api.mmr_calls) == 1
    assert api.mmr_calls[0]["mmr"] == 4730
    assert api.mmr_calls[0]["region"] == "NA"
    assert api.mmr_calls[0]["captured_at"] == "2026-05-07T10:00:00Z"
    assert api.mmr_calls[0]["game_id"] == job.game.game_id
    # The state cache reflects what we pushed so a backfill of older
    # replays after this point doesn't reset the cloud value.
    assert state.last_known_mmr == 4730
    assert state.last_known_mmr_date_iso == "2026-05-07T10:00:00Z"
    assert state.last_known_mmr_region == "NA"


def test_upload_without_mmr_does_not_ping(tmp_path: Path) -> None:
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    q.start()
    try:
        # Unranked / AI / customs all leave my_mmr=None on the CloudGame.
        # The MMR ping must be a no-op for those — otherwise we'd
        # overwrite a real ranked value with garbage.
        q.submit(_game(tmp_path, "unranked.SC2Replay", my_mmr=None))
        # Wait for the upload itself, then a short grace period in
        # which a buggy ping would have fired.
        assert _wait_for(lambda: len(api.calls) == 1, timeout=6.0)
        time.sleep(0.2)
    finally:
        q.stop()
    assert api.mmr_calls == []
    assert state.last_known_mmr is None


def test_resumed_marker_never_pushes_sticky_mmr(tmp_path: Path) -> None:
    """Synthetic resume results cannot establish the user's ladder MMR."""
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    base = _game(
        tmp_path,
        "resumed-with-legacy-mmr.SC2Replay",
        my_mmr=4730,
        my_toon_handle="1-S2-1-267727",
        date_iso="2026-05-07T10:00:00Z",
    )
    resumed = UploadJob(
        file_path=base.file_path,
        game=replace(base.game, is_resumed_from_replay=True),
    )
    q.start()
    try:
        q.submit(resumed)
        assert _wait_for(lambda: len(api.calls) == 1, timeout=6.0)
        time.sleep(0.2)
    finally:
        q.stop()

    assert api.calls[0]["isResumedFromReplay"] is True
    assert "myMmr" not in api.calls[0]
    assert api.mmr_calls == []
    assert state.last_known_mmr is None


def test_legacy_single_resumed_upload_never_pushes_sticky_mmr(
    tmp_path: Path,
) -> None:
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    base = _game(
        tmp_path,
        "legacy-resumed-with-mmr.SC2Replay",
        my_mmr=4730,
        my_toon_handle="1-S2-1-267727",
    )
    resumed = UploadJob(
        file_path=base.file_path,
        game=replace(base.game, is_resumed_from_replay=True),
    )

    q._upload_one(resumed)

    assert api.mmr_calls == []
    assert state.last_known_mmr is None


def test_older_replay_does_not_overwrite_newer_sticky_mmr(tmp_path: Path) -> None:
    # Pre-seed state as if a newer replay was already pushed. A
    # subsequent backfill of an OLDER replay must NOT push its MMR —
    # that would reset the sticky value to a season-old rating.
    state = AgentState(
        device_token="t",
        last_known_mmr=5000,
        last_known_mmr_date_iso="2026-05-07T10:00:00Z",
        last_known_mmr_region="NA",
    )
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    q.start()
    try:
        q.submit(
            _game(
                tmp_path, "old.SC2Replay",
                my_mmr=4200,
                my_toon_handle="1-S2-1-267727",
                date_iso="2025-12-01T10:00:00Z",
            ),
        )
        assert _wait_for(lambda: len(api.calls) == 1, timeout=6.0)
        time.sleep(0.2)
    finally:
        q.stop()
    # Game upload itself goes through; the MMR push is what's gated.
    assert len(api.calls) == 1
    assert api.mmr_calls == []
    # State still reflects the newer value.
    assert state.last_known_mmr == 5000


def test_parallel_mmr_pushes_preserve_newest_cloud_and_local_value(
    tmp_path: Path,
) -> None:
    """An older slow MMR patch must serialize ahead of a newer push.

    The older worker deliberately holds its cloud call open until the
    newer game's upload has completed and its worker is attempting the
    MMR push. The newer worker must stop at ``_mmr_push_lock``; after the
    older call is released, it patches second and leaves both cursors at
    the newer game.
    """

    old_date = "2026-05-07T10:00:00Z"
    new_date = "2026-05-07T11:00:00Z"
    old_mmr = 4700
    new_mmr = 4750
    old_patch_started = threading.Event()
    newer_push_attempted = threading.Event()
    newer_patch_started = threading.Event()
    release_old_patch = threading.Event()

    old = _game(
        tmp_path,
        "mmr-race-old.SC2Replay",
        my_mmr=old_mmr,
        my_toon_handle="1-S2-1-267727",
        date_iso=old_date,
    )
    newer = _game(
        tmp_path,
        "mmr-race-new.SC2Replay",
        my_mmr=new_mmr,
        my_toon_handle="1-S2-1-267727",
        date_iso=new_date,
    )

    class _MmrRaceApi:
        def __init__(self) -> None:
            self.upload_game_ids: list[str] = []
            self.mmr_calls: list[Dict[str, Any]] = []
            self.cloud_last_mmr: int | None = None
            self.cloud_last_date: str | None = None
            self._lock = threading.Lock()

        def upload_games_batch(
            self, games: List[Dict[str, Any]],
        ) -> Dict[str, Any]:
            assert len(games) == 1
            game_id = games[0]["gameId"]
            if game_id == newer.game.game_id:
                assert old_patch_started.wait(timeout=10.0)
            with self._lock:
                self.upload_game_ids.append(game_id)
            return {
                "accepted": [{"gameId": game_id, "created": True}],
                "rejected": [],
            }

        def patch_last_mmr(
            self, *, mmr: int, captured_at=None, region=None, game_id=None,
        ) -> Dict[str, Any]:
            if captured_at == old_date:
                old_patch_started.set()
                assert release_old_patch.wait(timeout=15.0)
            elif captured_at == new_date:
                newer_patch_started.set()
            with self._lock:
                self.mmr_calls.append({
                    "mmr": mmr,
                    "captured_at": captured_at,
                    "region": region,
                    "game_id": game_id,
                })
                self.cloud_last_mmr = mmr
                self.cloud_last_date = captured_at
            return {"ok": True, "wrote": True}

    class _SignalingUploadQueue(UploadQueue):
        def _maybe_push_last_mmr(self, job: UploadJob) -> None:
            if job.file_path == newer.file_path:
                newer_push_attempted.set()
            super()._maybe_push_last_mmr(job)

    state = AgentState(device_token="t")
    api = _MmrRaceApi()
    q = _SignalingUploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=2, upload_batch_size=1),
        state=state,
        api=api,
    )
    assert q.submit(old) is True
    assert q.submit(newer) is True
    q.start()
    try:
        assert old_patch_started.wait(timeout=10.0)
        assert newer_push_attempted.wait(timeout=10.0)
        # The newer worker has reached the MMR push but cannot enter the
        # API while the older worker owns the serialization lock.
        assert not newer_patch_started.wait(timeout=0.2)
        release_old_patch.set()
        assert _wait_for(lambda: len(api.mmr_calls) == 2, timeout=3.0)
    finally:
        # Always unblock the old worker so a failed assertion cannot leak
        # a daemon worker into the rest of the suite.
        release_old_patch.set()
        q.stop()

    assert api.upload_game_ids == [old.game.game_id, newer.game.game_id]
    assert [call["captured_at"] for call in api.mmr_calls] == [
        old_date,
        new_date,
    ]
    assert [call["game_id"] for call in api.mmr_calls] == [
        old.game.game_id,
        newer.game.game_id,
    ]
    assert api.cloud_last_mmr == new_mmr
    assert api.cloud_last_date == new_date
    assert state.last_known_mmr == new_mmr
    assert state.last_known_mmr_date_iso == new_date
    assert state.last_known_mmr_region == "NA"


def test_mmr_push_failure_does_not_break_upload(tmp_path: Path) -> None:
    """A failing patch_last_mmr must not roll back the game upload."""

    class _ApiThatFailsMmrPush(_StubApi):
        def patch_last_mmr(self, **_kw):
            raise RuntimeError("simulated network error on /v1/me/last-mmr")

    state = AgentState(device_token="t")
    api = _ApiThatFailsMmrPush()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    job = _game(
        tmp_path, "ranked.SC2Replay",
        my_mmr=4730,
        my_toon_handle="1-S2-1-267727",
        date_iso="2026-05-07T10:00:00Z",
    )
    q.start()
    try:
        q.submit(job)
        assert _wait_for(
            lambda: str(job.file_path) in state.uploaded, timeout=6.0,
        )
    finally:
        q.stop()
    # The game itself uploaded successfully — that's the contract.
    # The MMR push silently failing must not re-enqueue or mark the
    # file as rejected.
    assert len(api.calls) == 1
    assert str(job.file_path) in state.uploaded
    assert state.uploaded[str(job.file_path)] != "rejected"
    # State stays unset because the push didn't succeed.
    assert state.last_known_mmr is None


class _SlowApi:
    """API stub where every ``upload_game`` call blocks ``delay``
    seconds before returning. Used to detect parallelism — if N jobs
    each take ``delay`` seconds, a single-thread queue serialises
    them at N×delay total wall clock; an N-thread queue completes in
    roughly delay (give or take a small overhead)."""

    def __init__(self, *, delay: float) -> None:
        self.delay = delay
        self.calls: List[Dict[str, Any]] = []
        self._call_lock = threading.Lock()
        # Track concurrent invocations so the test can assert on the
        # peak overlap, not just total elapsed wall clock (which is
        # flaky on a busy CI runner). ``in_flight_peak`` is the
        # high-water mark of simultaneous in-flight uploads observed.
        self._in_flight = 0
        self.in_flight_peak = 0

    def upload_game(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self._call_lock:
            self._in_flight += 1
            self.in_flight_peak = max(self.in_flight_peak, self._in_flight)
        try:
            time.sleep(self.delay)
            with self._call_lock:
                self.calls.append(payload)
            return {"accepted": [{"gameId": payload["gameId"], "created": True}]}
        finally:
            with self._call_lock:
                self._in_flight -= 1

    def upload_games_batch(
        self, games: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        # Same in-flight tracking as the single-game path so the
        # parallelism test doesn't depend on which endpoint the
        # queue happens to call.
        with self._call_lock:
            self._in_flight += 1
            self.in_flight_peak = max(self.in_flight_peak, self._in_flight)
        try:
            time.sleep(self.delay)
            accepted = []
            with self._call_lock:
                for g in games:
                    self.calls.append(g)
                    accepted.append({"gameId": g["gameId"], "created": True})
            return {"accepted": accepted, "rejected": []}
        finally:
            with self._call_lock:
                self._in_flight -= 1

    def patch_last_mmr(self, **_kwargs: Any) -> Dict[str, Any]:
        # Not exercised by the parallelism test but the contract on
        # the queue requires this method to exist on the API stub.
        return {"ok": True, "wrote": False}


class _BarrierApi:
    """Stub that BLOCKS every upload call until ``target`` overlap.

    Proves worker concurrency by construction instead of sampling a
    peak on a wall-clock schedule (the sampled version failed on a
    hosted Windows runner that took >0.4 s just to start the worker
    threads — the sample saw 2 of 4 in flight). Each call parks on an
    event that only fires once ``target`` calls are inside the stub
    simultaneously, so a slow runner merely takes longer to fill the
    barrier. If fewer than ``target`` workers exist, the barrier can
    never fill; the escape timeout releases the stalled calls so the
    suite keeps moving, and the recorded peak stays below ``target``
    which fails the assertion — the exact regression this guards.
    """

    def __init__(self, *, target: int, escape_after: float = 10.0) -> None:
        self.target = target
        self.escape_after = escape_after
        self.calls: List[Dict[str, Any]] = []
        self.in_flight_peak = 0
        self._in_flight = 0
        self._lock = threading.Lock()
        self._all_in = threading.Event()

    def upload_games_batch(
        self, games: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        with self._lock:
            self._in_flight += 1
            self.in_flight_peak = max(self.in_flight_peak, self._in_flight)
            if self._in_flight >= self.target:
                self._all_in.set()
        self._all_in.wait(timeout=self.escape_after)
        accepted = []
        with self._lock:
            for g in games:
                self.calls.append(g)
                accepted.append({"gameId": g["gameId"], "created": True})
            self._in_flight -= 1
        return {"accepted": accepted, "rejected": []}

    def patch_last_mmr(self, **_kwargs: Any) -> Dict[str, Any]:
        return {"ok": True, "wrote": False}


def test_upload_workers_run_in_parallel(tmp_path: Path) -> None:
    """Extra ingest workers remain inside the global two-request ceiling."""
    state = AgentState(device_token="t")
    api = _BarrierApi(target=2)
    q = UploadQueue(cfg=_cfg(tmp_path, upload_concurrency=4), state=state, api=api)
    # Queue all four before starting so no worker can finish one job
    # and steal a second before its siblings have work to claim.
    for i in range(4):
        q.submit(_game(tmp_path, f"parallel-{i}.SC2Replay"))
    q.start()
    try:
        assert _wait_for(lambda: len(api.calls) == 4, timeout=15.0), (
            f"expected 4 uploads to finish, got {len(api.calls)}"
        )
    finally:
        q.stop()

    assert api.in_flight_peak == 2, (
        f"expected global request ceiling 2 with upload_concurrency=4, "
        f"peak was {api.in_flight_peak}"
    )


def test_single_upload_worker_runs_serially(tmp_path: Path) -> None:
    """Sanity check: with ``upload_concurrency=1`` (the test default
    and pre-v0.5.8 behaviour), the same four jobs must run one at a
    time. Peak in-flight is 1."""
    state = AgentState(device_token="t")
    api = _SlowApi(delay=0.2)
    q = UploadQueue(cfg=_cfg(tmp_path, upload_concurrency=1), state=state, api=api)
    for i in range(4):
        q.submit(_game(tmp_path, f"serial-{i}.SC2Replay"))
    q.start()
    try:
        # The peak is monotonic, so sampling AFTER the drain is exact —
        # a single worker holding each call 0.2 s cannot overlap itself,
        # while a second worker would certainly overlap somewhere in
        # four back-to-back 0.2 s holds.
        assert _wait_for(lambda: len(api.calls) == 4, timeout=8.0)
    finally:
        q.stop()

    assert api.in_flight_peak == 1, (
        f"single-worker queue had peak in-flight {api.in_flight_peak}, "
        "expected 1 — serial-upload guarantee broken"
    )


# --- Batch upload behaviour (v0.5.8+) -----------------------------


def test_batch_upload_packs_multiple_games_into_one_request(
    tmp_path: Path,
) -> None:
    """With ``upload_batch_size=10`` and 10 games submitted at once,
    the queue must ship them in ONE HTTP request — not 10 separate
    ones. Without batching, the cloud's 120 req/min rate limit
    bottlenecks throughput long before the parser does.

    Asserts on the API stub's ``batch_calls`` (one entry per HTTP
    round-trip, capturing batch size) rather than its ``calls``
    counter (one entry per game) — the former proves the batching
    contract, the latter proves correctness of per-game ack handling.
    """
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=10),
        state=state, api=api,
    )
    # Pre-submit jobs BEFORE starting the worker so the first
    # ``q.get(timeout=1.0)`` finds a fully-loaded queue. This makes
    # the test deterministic — without it, racing producer/consumer
    # threads could hand the worker a 1-element batch on the first
    # tick and the rest as the second batch.
    for i in range(10):
        q.submit(_game(tmp_path, f"batched-{i:02d}.SC2Replay"))
    q.start()
    try:
        # Drain the queue.
        assert _wait_for(lambda: len(api.calls) == 10, timeout=6.0)
    finally:
        q.stop()

    assert len(api.calls) == 10, (
        f"expected all 10 games to make it through the API stub, got {len(api.calls)}"
    )
    # The whole batch must have shipped in 1–2 HTTP requests. The
    # exact count depends on the worker's get-loop timing — if the
    # first ``get(timeout=1.0)`` happens to fire before all 10 are
    # submitted, the worker could ship a partial batch first and
    # mop up the remainder on the second iteration. 1–2 is the
    # acceptable range; 10 (one request per game) means batching is
    # broken.
    assert len(api.batch_calls) <= 2, (
        f"expected ≤2 HTTP batch requests for 10 games, got "
        f"{len(api.batch_calls)} (sizes: {api.batch_calls}) — "
        "batching is broken; the queue is shipping one game per request"
    )
    assert sum(api.batch_calls) == 10
    # Every accepted file must end up in state.uploaded with an ISO
    # timestamp (not "rejected", not "filtered", not "skipped").
    for i in range(10):
        path = str(tmp_path / f"batched-{i:02d}.SC2Replay")
        marker = state.uploaded.get(path, "")
        assert marker not in ("", "rejected", "filtered", "skipped"), (
            f"batched game {i} not marked uploaded: {marker!r}"
        )


class _PartialAcceptApi:
    """API stub that accepts even-indexed gameIds and rejects odd ones.

    Lets the partial-success test exercise the per-game accept/reject
    branch inside ``_upload_batch`` — the contract is that the queue
    must mirror the response back to ``state.uploaded`` per-game,
    so a 10-game batch with 5 accepts and 5 rejects results in 5
    timestamps + 5 ``"rejected"`` markers in state.
    """

    def __init__(self) -> None:
        self.batch_calls: int = 0

    def upload_games_batch(
        self, games: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        self.batch_calls += 1
        accepted = []
        rejected = []
        for g in games:
            # ``gameId`` is ``id-<name>`` from ``_game``. Sort by the
            # numeric suffix and split even/odd.
            name = g["gameId"].rsplit("-", 1)[-1]
            try:
                idx = int(name)
            except ValueError:
                idx = 0
            if idx % 2 == 0:
                accepted.append({"gameId": g["gameId"], "created": True})
            else:
                rejected.append({
                    "gameId": g["gameId"],
                    "errors": [f"simulated rejection for {g['gameId']}"],
                })
        return {"accepted": accepted, "rejected": rejected}

    def patch_last_mmr(self, **_kwargs: Any) -> Dict[str, Any]:
        return {"ok": True, "wrote": False}


def test_batch_partial_success_marks_per_game_outcomes(
    tmp_path: Path,
) -> None:
    """Mixed-result batch: some games accepted, some rejected. State
    must reflect each one independently — the queue must NOT bail
    on the whole batch if ANY game in it rejects."""
    state = AgentState(device_token="t")
    api = _PartialAcceptApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=8),
        state=state, api=api,
    )
    submitted = []
    for i in range(8):
        # ``_game`` builds gameId="id-<name>"; we want a numeric
        # suffix so _PartialAcceptApi's even/odd split is meaningful.
        name = f"part{i:02d}.SC2Replay"
        job = _game(tmp_path, name)
        # Override gameId so the splitter sees i, not "part00".
        new_game = CloudGame(
            game_id=f"id-{i}",
            date_iso=job.game.date_iso,
            result=job.game.result,
            my_race=job.game.my_race,
            my_build=job.game.my_build,
            map_name=job.game.map_name,
            duration_sec=job.game.duration_sec,
            macro_score=job.game.macro_score,
            apm=job.game.apm,
            spq=job.game.spq,
            opponent=job.game.opponent,
            build_log=job.game.build_log,
            early_build_log=job.game.early_build_log,
            opp_early_build_log=job.game.opp_early_build_log,
            opp_build_log=job.game.opp_build_log,
        )
        submitted.append((job.file_path, i, UploadJob(file_path=job.file_path, game=new_game)))
    for _path, _i, j in submitted:
        q.submit(j)
    q.start()
    try:
        assert _wait_for(lambda: len(state.uploaded) == 8, timeout=6.0)
    finally:
        q.stop()

    assert api.batch_calls >= 1
    # Even-indexed (0, 2, 4, 6) → uploaded with ISO timestamp.
    # Odd-indexed (1, 3, 5, 7) → "rejected".
    for path, i, _job in submitted:
        marker = state.uploaded.get(str(path), "")
        if i % 2 == 0:
            assert marker not in ("", "rejected"), (
                f"index {i} expected accepted, got {marker!r}"
            )
        else:
            assert marker == "rejected", (
                f"index {i} expected 'rejected', got {marker!r}"
            )


class _MixedRetryableApi:
    """Accept one, permanently reject one, retry one storage failure."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def upload_games_batch(
        self, games: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        ids = [str(game["gameId"]) for game in games]
        self.calls.append(ids)
        if len(self.calls) == 1:
            return {
                "accepted": [{"gameId": "id-0", "created": True}],
                "rejected": [
                    {
                        "gameId": "id-1",
                        "retryable": True,
                        "errors": ["upsert_failed: r2 unavailable"],
                    },
                    {
                        "gameId": "id-2",
                        "errors": ["schema rejection"],
                    },
                ],
            }
        return {
            "accepted": [
                {"gameId": game["gameId"], "created": False}
                for game in games
            ],
            "rejected": [],
        }

    def patch_last_mmr(self, **_kwargs: Any) -> Dict[str, Any]:
        return {"ok": True, "wrote": False}


def test_mixed_batch_retries_only_retryable_server_rejection(
    tmp_path: Path,
) -> None:
    state = AgentState(device_token="t")
    api = _MixedRetryableApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=3),
        state=state,
        api=api,
    )
    jobs = []
    for index in range(3):
        original = _game(tmp_path, f"retry-{index}.SC2Replay")
        jobs.append(
            UploadJob(
                file_path=original.file_path,
                game=CloudGame(
                    game_id=f"id-{index}",
                    date_iso=original.game.date_iso,
                    result=original.game.result,
                    my_race=original.game.my_race,
                    my_build=original.game.my_build,
                    map_name=original.game.map_name,
                    duration_sec=original.game.duration_sec,
                    macro_score=original.game.macro_score,
                    apm=original.game.apm,
                    spq=original.game.spq,
                    opponent=original.game.opponent,
                    build_log=original.game.build_log,
                    early_build_log=original.game.early_build_log,
                    opp_early_build_log=original.game.opp_early_build_log,
                    opp_build_log=original.game.opp_build_log,
                ),
            ),
        )
    for job in jobs:
        assert q.submit(job)
    q.start()
    try:
        assert _wait_for(lambda: len(state.uploaded) == 3, timeout=8.0)
    finally:
        q.stop()

    assert api.calls[0] == ["id-0", "id-1", "id-2"]
    assert api.calls[1:] == [["id-1"]]
    assert state.uploaded[str(jobs[0].file_path)] != "rejected"
    assert state.uploaded[str(jobs[1].file_path)] != "rejected"
    assert state.uploaded[str(jobs[2].file_path)] == "rejected"


class _BatchFlakyApi:
    """First call to ``upload_games_batch`` raises a network error,
    second succeeds. Verifies the whole-batch retry path."""

    def __init__(self) -> None:
        self.batch_calls: int = 0

    def upload_games_batch(
        self, games: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        self.batch_calls += 1
        if self.batch_calls == 1:
            raise RuntimeError("simulated_batch_network_failure")
        return {
            "accepted": [
                {"gameId": g["gameId"], "created": True} for g in games
            ],
            "rejected": [],
        }

    def patch_last_mmr(self, **_kwargs: Any) -> Dict[str, Any]:
        return {"ok": True, "wrote": False}


def test_batch_transient_failure_re_enqueues_whole_batch(
    tmp_path: Path,
) -> None:
    """A network error on a 5-game batch must re-enqueue all 5 jobs,
    not silently drop them. The retry path sleeps 2 s, so we wait
    past that window before asserting on final state."""
    state = AgentState(device_token="t")
    api = _BatchFlakyApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=5),
        state=state, api=api,
    )
    for i in range(5):
        q.submit(_game(tmp_path, f"flaky-batch-{i}.SC2Replay"))
    q.start()
    try:
        # First batch fails (raises), worker sleeps 2 s, re-enqueues
        # all 5, second batch succeeds. Poll for the retried outcome.
        assert _wait_for(lambda: len(state.uploaded) == 5, timeout=10.0)
    finally:
        q.stop()

    assert api.batch_calls >= 2, (
        f"expected at least 2 HTTP attempts (first fails, second "
        f"succeeds), got {api.batch_calls}"
    )
    # Every game must end up successfully uploaded (not rejected,
    # not dropped). The retry path is the contract here.
    for i in range(5):
        path = str(tmp_path / f"flaky-batch-{i}.SC2Replay")
        marker = state.uploaded.get(path, "")
        assert marker not in ("", "rejected", "filtered"), (
            f"flaky-batch-{i}: post-retry marker is {marker!r} — "
            "transient failure path lost a job"
        )


def test_two_workers_yield_to_server_admission_without_shrinking_or_skipping(
    tmp_path: Path,
) -> None:
    """A held server slot defers worker two without penalizing its batch."""
    first_entered = threading.Event()
    busy_seen = threading.Event()
    release_first = threading.Event()

    class _SingleSlotApi:
        def __init__(self) -> None:
            self._lock = threading.Lock()
            self._active = False
            self.calls: list[list[str]] = []

        def upload_games_batch(
            self, games: List[Dict[str, Any]],
        ) -> Dict[str, Any]:
            game_ids = [str(game["gameId"]) for game in games]
            with self._lock:
                self.calls.append(game_ids)
                if self._active:
                    busy_seen.set()
                    raise ReplayIngestBusy(0.5)
                self._active = True
            try:
                if not first_entered.is_set():
                    first_entered.set()
                    assert release_first.wait(timeout=5.0)
                return {
                    "accepted": [
                        {"gameId": game_id, "created": True}
                        for game_id in game_ids
                    ],
                    "rejected": [],
                }
            finally:
                with self._lock:
                    self._active = False

        def patch_last_mmr(self, **_kwargs: Any) -> Dict[str, Any]:
            return {"ok": True, "wrote": False}

    state = AgentState(device_token="t")
    api = _SingleSlotApi()
    failures: list[tuple[Path, Exception]] = []
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=2, upload_batch_size=4),
        state=state,
        api=api,
        on_failure=lambda path, exc: failures.append((path, exc)),
    )
    jobs = [
        _game(tmp_path, f"server-busy-{i}.SC2Replay")
        for i in range(8)
    ]
    for job in jobs:
        assert q.submit(job) is True
    q.start()
    try:
        assert first_entered.wait(timeout=3.0)
        assert busy_seen.wait(timeout=3.0)
        assert state.uploaded == {}
        assert all(q.is_pending(job.file_path) for job in jobs)
        assert q._batch_size == 4
        assert q._batch_ceiling == 4
        assert failures == []
        # The API client yields on the first 503 rather than sending the same
        # multi-megabyte JSON body through its normal three-attempt loop.
        assert len(api.calls) == 2

        release_first.set()
        assert _wait_for(lambda: len(state.uploaded) == 8, timeout=8.0)
    finally:
        release_first.set()
        q.stop()

    assert all(not q.is_pending(job.file_path) for job in jobs)
    assert q._batch_size == 4
    assert q._batch_ceiling == 4
    assert failures == []
    assert len(api.calls) == 3


# --- Hot-swap (set_concurrency / set_batch_size) ---------------------


def test_set_concurrency_grows_worker_count_at_runtime(
    tmp_path: Path,
) -> None:
    """``set_concurrency(2)`` on a queue running with 1 worker must
    add a second worker immediately, without dropping the jobs
    that were enqueued before the swap.

    This is the core contract behind the GUI's Upload-concurrency
    button group: clicking ``2`` is supposed to take effect now,
    not on the next agent restart."""
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=1),
        state=state, api=api,
    )
    q.start()
    try:
        # Sanity: started with 1 worker.
        assert len([t for t in q._threads if t.is_alive()]) == 1
        # Hot-swap up to 2 workers.
        q.set_concurrency(2)
        # Worker creation is asynchronous; hosted Windows runners can
        # briefly stall while other jobs consume CPU and disk.
        assert _wait_for(
            lambda: len([t for t in q._threads if t.is_alive()]) == 2,
        )
        alive = [t for t in q._threads if t.is_alive()]
        assert len(alive) == 2, (
            f"expected 2 workers after set_concurrency(2), got {len(alive)}"
        )
        # And the queue still drains correctly post-swap.
        for i in range(3):
            q.submit(_game(tmp_path, f"hotswap-{i}.SC2Replay"))
        assert _wait_for(lambda: len(api.calls) == 3)
    finally:
        q.stop()


def test_set_concurrency_shrinks_worker_count_at_runtime(
    tmp_path: Path,
) -> None:
    """``set_concurrency(1)`` on a queue running with 2 workers must
    shut one worker down (each finishing its in-flight upload first)
    while keeping the queue draining via the remaining one."""
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=2, upload_batch_size=1),
        state=state, api=api,
    )
    q.start()
    try:
        assert len([t for t in q._threads if t.is_alive()]) == 2
        q.set_concurrency(1)
        assert _wait_for(
            lambda: len([t for t in q._threads if t.is_alive()]) == 1,
        )
        alive = [t for t in q._threads if t.is_alive()]
        assert len(alive) == 1, (
            f"expected 1 worker after set_concurrency(1), got {len(alive)}"
        )
        # And the surviving worker still drains the queue.
        for i in range(3):
            q.submit(_game(tmp_path, f"shrink-{i}.SC2Replay"))
        assert _wait_for(lambda: len(api.calls) == 3)
    finally:
        q.stop()


def test_set_concurrency_waits_for_old_long_request_before_replacement(
    tmp_path: Path,
) -> None:
    entered = threading.Event()
    release = threading.Event()

    class _LongApi(_StubApi):
        def upload_games_batch(
            self,
            games: List[Dict[str, Any]],
        ) -> Dict[str, Any]:
            entered.set()
            assert release.wait(3.0)
            return super().upload_games_batch(games)

    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1),
        state=AgentState(),
        api=_LongApi(),
    )
    q.start()
    changer = threading.Thread(target=lambda: q.set_concurrency(2))
    try:
        assert q.submit(_game(tmp_path, "long-generation.SC2Replay"))
        assert entered.wait(1.0)
        changer.start()
        time.sleep(0.1)
        assert changer.is_alive()
        assert len([thread for thread in q._threads if thread.is_alive()]) == 1
        release.set()
        changer.join(timeout=2.0)
        assert not changer.is_alive()
        assert _wait_for(
            lambda: len([t for t in q._threads if t.is_alive()]) == 2,
        )
        assert q._network_gate.peak_active <= 2
    finally:
        release.set()
        changer.join(timeout=2.0)
        q.stop()


def test_stop_then_start_retires_long_archive_worker_before_restart(
    tmp_path: Path,
    monkeypatch,
) -> None:
    import sc2tools_agent.uploader.queue as queue_module

    monkeypatch.setattr(queue_module, "_ARCHIVE_IDLE_GRACE_SEC", 0.01)
    entered = threading.Event()
    release = threading.Event()
    calls: list[str] = []
    task = ReplayArchiveTask(tmp_path / "long-archive.SC2Replay", "long")
    task.file_path.write_bytes(b"MPQ\x1blong")
    ReplayArchiveJournal(tmp_path).enqueue_many([task])

    class _LongArchiveApi(_StubApi):
        def upload_replay_file_durable(
            self,
            game_id: str,
            _path: Path,
        ) -> bool:
            calls.append(game_id)
            entered.set()
            assert release.wait(3.0)
            return True

    q = UploadQueue(
        cfg=_cfg(tmp_path),
        state=AgentState(),
        api=_LongArchiveApi(),
    )
    q.start()
    stopper = threading.Thread(target=q.stop)
    try:
        assert entered.wait(2.0)
        stopper.start()
        time.sleep(0.1)
        assert stopper.is_alive()
        release.set()
        stopper.join(timeout=2.0)
        assert not stopper.is_alive()
        assert q._archive_thread is None
        q.start()
        assert _wait_for(lambda: q.archive_pending_count() == 0)
        assert q._archive_thread is not None
        assert q._archive_thread.is_alive()
        assert calls == ["long"]
        assert q._network_gate.peak_active <= 2
    finally:
        release.set()
        stopper.join(timeout=2.0)
        q.stop()


def test_set_concurrency_is_idempotent_on_no_op(tmp_path: Path) -> None:
    """A re-click of the already-selected button (``set_concurrency``
    called with the current count) must not stop+restart workers —
    the user expects the button group to feel inert when they re-
    click their current choice. Cheaply detected by the worker
    threads' identity surviving the call."""
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=2),
        state=state, api=api,
    )
    q.start()
    try:
        thread_ids_before = {id(t) for t in q._threads}
        q.set_concurrency(2)  # same count as current
        thread_ids_after = {id(t) for t in q._threads}
        assert thread_ids_before == thread_ids_after, (
            "set_concurrency(same_count) restarted workers — should "
            "have been a no-op to avoid a spurious queue-drain pause"
        )
    finally:
        q.stop()


def test_set_batch_size_takes_effect_on_next_drain(tmp_path: Path) -> None:
    """A runtime ``set_batch_size`` must change how many games the
    next batch carries — workers re-read the value at the top of
    each drain iteration so the change propagates within ~1 sec
    without restarting threads."""
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=1),
        state=state, api=api,
    )
    q.start()
    try:
        # Verify size-1 baseline: each game is its own request.
        for i in range(3):
            q.submit(_game(tmp_path, f"pre-{i}.SC2Replay"))
        assert _wait_for(lambda: len(api.calls) == 3)
        pre_swap_batches = list(api.batch_calls)
        assert all(s == 1 for s in pre_swap_batches)
        # Pause while feeding the post-swap backlog so the instantaneous
        # stub cannot drain each sequential submit before the next one is
        # queued. This makes the batching assertion deterministic while
        # still exercising the same already-running worker thread.
        q.set_paused(True)
        q.set_batch_size(5)
        for i in range(5):
            q.submit(_game(tmp_path, f"post-{i}.SC2Replay"))
        q.set_paused(False)
        assert _wait_for(lambda: len(api.calls) == 8, timeout=3.0)
        # Find the request after the swap that carried >1 game.
        post_swap_batches = api.batch_calls[len(pre_swap_batches):]
        assert any(s > 1 for s in post_swap_batches), (
            f"expected at least one multi-game batch after "
            f"set_batch_size(5); got post-swap batches: "
            f"{post_swap_batches}"
        )
    finally:
        q.stop()


def test_set_concurrency_preserves_pending_jobs(tmp_path: Path) -> None:
    """The swap is implemented as stop()+start(). The Queue itself
    must survive: any jobs sitting in it before the swap must be
    drained by the new workers afterwards."""
    state = AgentState(device_token="t")
    # ``_SlowApi`` so jobs queue up faster than they upload, which
    # gives us a window to perform the swap with pending work.
    api = _SlowApi(delay=0.3)
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=1),
        state=state, api=api,
    )
    # Pre-load 5 jobs before start so they're definitely queued
    # when the swap fires.
    for i in range(5):
        q.submit(_game(tmp_path, f"preserve-{i}.SC2Replay"))
    q.start()
    try:
        # Almost-immediate swap, before more than 1-2 jobs could
        # have completed.
        time.sleep(0.05)
        q.set_concurrency(2)
        # Drain everything.
        assert _wait_for(lambda: len(api.calls) == 5, timeout=10.0)
    finally:
        q.stop()
    # All 5 jobs must have eventually uploaded — none lost in the
    # stop/start gap.
    assert len(api.calls) == 5


def test_size_one_batch_is_legacy_single_game_behaviour(
    tmp_path: Path,
) -> None:
    """``upload_batch_size=1`` must yield single-game-per-request
    behaviour bit-for-bit identical to the pre-v0.5.8 path. Lets
    cautious users opt out of batching entirely without losing the
    rest of the v0.5.8 changes (process pool, parallel uploads,
    pause behaviour)."""
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=1),
        state=state, api=api,
    )
    for i in range(5):
        q.submit(_game(tmp_path, f"single-{i}.SC2Replay"))
    q.start()
    try:
        # Poll rather than a fixed sleep: every successful batch
        # persists state via write→fsync→rename, and five sequential
        # fsync cycles can outlast any fixed budget on a slow CI
        # runner (observed: 2 of 5 done after 0.6 s on hosted Windows).
        _wait_for(lambda: len(api.batch_calls) >= 5, timeout=6.0)
    finally:
        q.stop()

    # With batch size 1, every game ships in its own HTTP request.
    assert len(api.batch_calls) == 5, (
        f"batch_size=1 should produce 5 HTTP requests for 5 games, "
        f"got {len(api.batch_calls)} (sizes: {api.batch_calls})"
    )
    assert all(size == 1 for size in api.batch_calls)


# --- v0.5.9 sync-filter enforcement on the upload queue ----------
# Belt-and-suspenders: even when the runner's drain doesn't catch
# everything (a worker had already picked the job out of the queue at
# the moment of Save), the queue must re-check the filter at upload
# time and skip the network round-trip.


def test_upload_drops_job_outside_filter(tmp_path: Path) -> None:
    """A queued job whose date_iso falls outside the active filter
    must be dropped at upload time. The api MUST NOT see the call,
    state.uploaded must be marked "filtered", and on_failure must be
    invoked with a _FilteredOutError so the GUI's Recent uploads feed
    surfaces the drop."""
    from sc2tools_agent.uploader.queue import _FilteredOutError

    state = AgentState(
        device_token="t",
        sync_filter_preset="season:67",
    )
    api = _StubApi()
    failures: list[tuple[Path, Exception]] = []
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=1),
        state=state, api=api,
        on_failure=lambda p, e: failures.append((p, e)),
    )
    # Season 65 is well before Season 67's start, so the job must be
    # dropped by the live filter check inside _upload_batch.
    job = _game(
        tmp_path, "out.SC2Replay",
        date_iso="2025-09-01T10:00:00Z",
    )
    q.start()
    try:
        q.submit(job)
        assert _wait_for(
            lambda: str(job.file_path) in state.uploaded, timeout=6.0,
        )
    finally:
        q.stop()
    # API must not see the call — the filter dropped it before the
    # network round-trip.
    assert api.calls == [], (
        "out-of-window job reached the API; the per-batch filter "
        "check failed"
    )
    # State marker is "filtered" so future sweeps skip the file.
    assert state.uploaded[str(job.file_path)] == "filtered"
    # Failure callback fired with a _FilteredOutError so the GUI's
    # Recent uploads feed shows the drop, not silently swallows it.
    assert len(failures) == 1
    assert isinstance(failures[0][1], _FilteredOutError)


def test_upload_passes_job_inside_filter(tmp_path: Path) -> None:
    """Inverse: a job inside the active window must upload normally
    despite the filter being set."""
    from sc2tools_agent import sync_filter as sf

    # Pin the filter to a season that contains the job's date.
    state = AgentState(
        device_token="t",
        sync_filter_preset="season:67",
    )
    api = _StubApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=1),
        state=state, api=api,
    )
    # Season 67 starts 2026-04-01. Pick a date well inside.
    inside = _game(
        tmp_path, "inside.SC2Replay",
        date_iso="2026-05-07T10:00:00Z",
    )
    q.start()
    try:
        q.submit(inside)
        assert _wait_for(lambda: len(api.calls) == 1, timeout=6.0)
    finally:
        q.stop()
    assert len(api.calls) == 1
    # Marker is a real ISO timestamp (not "filtered" / "rejected").
    marker = state.uploaded[str(inside.file_path)]
    assert marker not in ("filtered", "rejected", "skipped")
    assert marker.startswith("2026-")
    # Sanity: the SyncFilter would also accept this date, just
    # double-checking the test setup matches the production filter.
    f = sf.SyncFilter.from_state(
        preset="season:67",
        since_iso=None,
        until_iso=None,
    )
    assert f.replay_in_range("2026-05-07T10:00:00Z")


def test_drain_outside_filter_drops_only_matching(tmp_path: Path) -> None:
    """drain_outside_filter must keep in-window jobs in the queue
    in their original submission order, drop out-of-window jobs,
    and persist the resulting state.uploaded marks atomically."""
    state = AgentState(
        device_token="t",
        sync_filter_preset="season:67",
    )
    api = _StubApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=1),
        state=state, api=api,
    )
    # Submit 6 jobs, alternating in/out by date_iso. Submit BEFORE
    # start so the worker can't drain anything before drain_outside_filter
    # runs.
    interleaved = [
        ("a-in.SC2Replay", "2026-04-15T10:00:00Z"),    # in
        ("b-out.SC2Replay", "2025-09-01T10:00:00Z"),   # out
        ("c-in.SC2Replay", "2026-04-20T10:00:00Z"),    # in
        ("d-out.SC2Replay", "2025-10-01T10:00:00Z"),   # out
        ("e-in.SC2Replay", "2026-05-01T10:00:00Z"),    # in
        ("f-out.SC2Replay", "2025-11-01T10:00:00Z"),   # out
    ]
    for name, iso in interleaved:
        q.submit(_game(tmp_path, name, date_iso=iso))
    dropped = q.drain_outside_filter()
    assert dropped == 3
    # The three out-of-window paths are marked "filtered" in state.
    for name, iso in interleaved:
        if "out" in name:
            assert state.uploaded[str(tmp_path / name)] == "filtered"
        else:
            # In-window jobs aren't yet uploaded — they're still in
            # the queue. Their state.uploaded entry must be untouched.
            assert str(tmp_path / name) not in state.uploaded
    # Order preserved: drain the queue manually and check the survivors.
    survivors = []
    while not q._q.empty():
        _rank, _sequence, job = q._q.get_nowait()
        survivors.append(job.file_path.name)
        q._q.task_done()
    assert survivors == [
        "a-in.SC2Replay", "c-in.SC2Replay", "e-in.SC2Replay",
    ]


def test_drain_outside_filter_no_active_filter_is_noop(
    tmp_path: Path,
) -> None:
    """``drain_outside_filter`` must do nothing when the filter is
    fully open (preset is None / "all"). Otherwise a no-op Save click
    would walk the queue for nothing."""
    state = AgentState(
        device_token="t",
        sync_filter_preset=None,
    )
    api = _StubApi()
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=1),
        state=state, api=api,
    )
    for i in range(3):
        q.submit(_game(tmp_path, f"open-{i}.SC2Replay"))
    dropped = q.drain_outside_filter()
    assert dropped == 0
    # All 3 still queued.
    assert q.pending_count() == 3


def test_drain_outside_filter_invokes_on_failure(tmp_path: Path) -> None:
    """Every dropped job must fire on_failure so the GUI's Recent
    uploads feed shows the drop. Without this the user sees their
    queue-depth counter drop silently and assumes things uploaded."""
    from sc2tools_agent.uploader.queue import _FilteredOutError

    state = AgentState(
        device_token="t",
        sync_filter_preset="season:67",
    )
    api = _StubApi()
    failures: list[tuple[Path, Exception]] = []
    q = UploadQueue(
        cfg=_cfg(tmp_path, upload_concurrency=1, upload_batch_size=1),
        state=state, api=api,
        on_failure=lambda p, e: failures.append((p, e)),
    )
    q.submit(_game(tmp_path, "x.SC2Replay", date_iso="2025-09-01T10:00:00Z"))
    q.submit(_game(tmp_path, "y.SC2Replay", date_iso="2025-08-15T10:00:00Z"))
    dropped = q.drain_outside_filter()
    assert dropped == 2
    assert len(failures) == 2
    assert all(isinstance(e, _FilteredOutError) for _p, e in failures)

"""Tests for sc2tools_agent.uploader.queue (pause + resync additions)."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Dict, List

from sc2tools_agent.config import AgentConfig
from sc2tools_agent.replay_pipeline import CloudGame
from sc2tools_agent.state import AgentState
from sc2tools_agent.uploader.queue import UploadJob, UploadQueue


class _StubApi:
    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []

    def upload_game(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        self.calls.append(payload)
        return {"accepted": [{"gameId": payload["gameId"], "created": True}]}


def _cfg(tmp_path: Path) -> AgentConfig:
    return AgentConfig(
        api_base="http://localhost:0",
        state_dir=tmp_path,
        replay_folder=None,
        poll_interval_sec=10,
        parse_concurrency=1,
    )


def _game(tmp_path: Path, name: str) -> UploadJob:
    fp = tmp_path / name
    fp.write_bytes(b"")
    cloud = CloudGame(
        game_id=f"id-{name}",
        date_iso="2026-04-01T00:00:00Z",
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
    return UploadJob(file_path=fp, game=cloud)


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
        time.sleep(1.0)
        assert len(api.calls) == 1
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
        # Allow plenty of wall clock for the worker to run and (in the
        # broken old behaviour) retry — the 2 s retry window means a
        # buggy implementation would call the API more than once here.
        time.sleep(3.0)
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

    state = AgentState(device_token="t")
    api = _FlakyApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    q.start()
    try:
        q.submit(_game(tmp_path, "flaky.SC2Replay"))
        # The retry path sleeps 2 s before re-enqueueing, so wait
        # comfortably past that window.
        time.sleep(3.5)
    finally:
        q.stop()

    assert api.calls >= 2, "transient error must trigger retry"
    # And the eventual success must mark the file as uploaded — not
    # "rejected" (that label is reserved for permanent failures).
    only_key = next(iter(state.uploaded))
    assert state.uploaded[only_key] != "rejected"

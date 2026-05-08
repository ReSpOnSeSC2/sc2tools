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
        # Track MMR pings separately so tests can assert exactly when
        # the sticky-MMR cloud ping fires (and what it carries).
        self.mmr_calls: List[Dict[str, Any]] = []

    def upload_game(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        self.calls.append(payload)
        return {"accepted": [{"gameId": payload["gameId"], "created": True}]}

    def patch_last_mmr(
        self, *, mmr: int, captured_at=None, region=None,
    ) -> Dict[str, Any]:
        self.mmr_calls.append(
            {"mmr": mmr, "captured_at": captured_at, "region": region},
        )
        return {"ok": True, "wrote": True}


def _cfg(tmp_path: Path) -> AgentConfig:
    return AgentConfig(
        api_base="http://localhost:0",
        state_dir=tmp_path,
        replay_folder=None,
        poll_interval_sec=10,
        parse_concurrency=1,
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
        time.sleep(1.0)
    finally:
        q.stop()
    assert len(api.mmr_calls) == 1
    assert api.mmr_calls[0]["mmr"] == 4730
    assert api.mmr_calls[0]["region"] == "NA"
    assert api.mmr_calls[0]["captured_at"] == "2026-05-07T10:00:00Z"
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
        time.sleep(0.7)
    finally:
        q.stop()
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
        time.sleep(0.7)
    finally:
        q.stop()
    # Game upload itself goes through; the MMR push is what's gated.
    assert len(api.calls) == 1
    assert api.mmr_calls == []
    # State still reflects the newer value.
    assert state.last_known_mmr == 5000


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
        time.sleep(0.7)
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

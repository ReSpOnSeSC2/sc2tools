"""Tests for sc2tools_agent.uploader.queue (pause + resync additions)."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any, Dict, List

from sc2tools_agent.config import AgentConfig
from sc2tools_agent.replay_pipeline import CloudGame
from sc2tools_agent.state import AgentState
from sc2tools_agent.uploader.queue import UploadJob, UploadQueue


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
        self, *, mmr: int, captured_at=None, region=None,
    ) -> Dict[str, Any]:
        self.mmr_calls.append(
            {"mmr": mmr, "captured_at": captured_at, "region": region},
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


def test_upload_workers_run_in_parallel(tmp_path: Path) -> None:
    """With ``upload_concurrency=4``, four jobs submitted at once must
    run concurrently — peak in-flight count must reach 4."""
    state = AgentState(device_token="t")
    api = _SlowApi(delay=0.4)
    q = UploadQueue(cfg=_cfg(tmp_path, upload_concurrency=4), state=state, api=api)
    q.start()
    try:
        for i in range(4):
            q.submit(_game(tmp_path, f"parallel-{i}.SC2Replay"))
        # All four uploads should be in flight near-simultaneously.
        # Wait long enough for them to overlap (the API stub holds
        # each call for 0.4 s) but not so long that we miss the peak.
        time.sleep(0.25)
        peak_during = api.in_flight_peak
        # And eventually all four complete.
        time.sleep(1.0)
    finally:
        q.stop()

    assert len(api.calls) == 4, (
        f"expected 4 successful uploads, got {len(api.calls)}"
    )
    assert peak_during >= 4, (
        f"expected concurrent in-flight uploads to reach 4 with "
        f"upload_concurrency=4, peak was {peak_during} — workers "
        "are running serially despite the config setting"
    )


def test_single_upload_worker_runs_serially(tmp_path: Path) -> None:
    """Sanity check: with ``upload_concurrency=1`` (the test default
    and pre-v0.5.8 behaviour), the same four jobs must run one at a
    time. Peak in-flight is 1."""
    state = AgentState(device_token="t")
    api = _SlowApi(delay=0.2)
    q = UploadQueue(cfg=_cfg(tmp_path, upload_concurrency=1), state=state, api=api)
    q.start()
    try:
        for i in range(4):
            q.submit(_game(tmp_path, f"serial-{i}.SC2Replay"))
        time.sleep(0.1)
        peak_during = api.in_flight_peak
        time.sleep(1.5)  # give all four serial uploads time to drain
    finally:
        q.stop()

    assert len(api.calls) == 4
    assert peak_during == 1, (
        f"single-worker queue had peak in-flight {peak_during}, "
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
        time.sleep(1.0)
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
        time.sleep(1.0)
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
        # all 5, second batch succeeds. Allow plenty of wall clock.
        time.sleep(3.5)
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
        # Two workers should be running now (small grace for thread
        # spin-up — Windows thread create is ~1 ms but we leave room).
        time.sleep(0.1)
        alive = [t for t in q._threads if t.is_alive()]
        assert len(alive) == 2, (
            f"expected 2 workers after set_concurrency(2), got {len(alive)}"
        )
        # And the queue still drains correctly post-swap.
        for i in range(3):
            q.submit(_game(tmp_path, f"hotswap-{i}.SC2Replay"))
        time.sleep(0.6)
        assert len(api.calls) == 3
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
        time.sleep(0.1)
        alive = [t for t in q._threads if t.is_alive()]
        assert len(alive) == 1, (
            f"expected 1 worker after set_concurrency(1), got {len(alive)}"
        )
        # And the surviving worker still drains the queue.
        for i in range(3):
            q.submit(_game(tmp_path, f"shrink-{i}.SC2Replay"))
        time.sleep(0.6)
        assert len(api.calls) == 3
    finally:
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
        time.sleep(0.5)
        pre_swap_batches = list(api.batch_calls)
        assert all(s == 1 for s in pre_swap_batches)
        # Bump batch size and re-feed.
        q.set_batch_size(5)
        # Wait long enough for the worker to finish its current
        # iteration (which includes the 1-sec ``q.get(timeout=1.0)``
        # so the next iteration sees the new batch size).
        time.sleep(1.2)
        for i in range(5):
            q.submit(_game(tmp_path, f"post-{i}.SC2Replay"))
        time.sleep(0.5)
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
        time.sleep(2.5)
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
        time.sleep(0.6)
    finally:
        q.stop()

    # With batch size 1, every game ships in its own HTTP request.
    assert len(api.batch_calls) == 5, (
        f"batch_size=1 should produce 5 HTTP requests for 5 games, "
        f"got {len(api.batch_calls)} (sizes: {api.batch_calls})"
    )
    assert all(size == 1 for size in api.batch_calls)

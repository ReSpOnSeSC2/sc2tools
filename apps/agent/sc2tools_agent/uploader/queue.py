"""Bounded, thread-safe upload queue with persistent dedupe.

The watcher pushes ``(file_path, CloudGame)`` pairs onto the queue.
A worker thread drains them, posts to /v1/games, and on success records
the file path in ``state.uploaded`` so retries / restarts don't
re-upload. Failed uploads are retried with exponential backoff on the
ApiClient side; if the queue is busy, new replays park in memory.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..api_client import ApiClient
from ..config import AgentConfig
from ..replay_pipeline import CloudGame
from ..state import AgentState, save_state
from ..sync_filter import SyncFilter

log = logging.getLogger(__name__)

# Backpressure budget for ``UploadQueue.submit``. With a 32-worker
# process-mode parse pool feeding into a single-threaded upload
# worker, parses can outrun uploads by 5–10×. Blocking the parse
# done-callback thread on a full queue is the right behaviour
# (no data loss) but we cap the wait so a wedged upload worker
# doesn't freeze the entire pipeline indefinitely. 5 minutes is
# longer than any reasonable network blip but short enough that
# a real outage is visible to the user via the resulting log line.
_BACKPRESSURE_TIMEOUT_SEC = 300.0


class _ServerRejectedError(Exception):
    """Server validated the payload and returned ``rejected: [...]``.

    Distinct from a transient transport error so the worker can skip
    the 2 s sleep + re-enqueue dance: a rejection that came from the
    schema validator (``"/oppBuildLog must NOT have more than 5000
    items"`` and friends) will fail the same way every time the same
    payload is uploaded. Re-enqueueing it just fills the bounded queue,
    drops new replays with ``upload_queue_full`` warnings, and never
    converges. Mark the file as permanently rejected in
    ``state.uploaded`` instead so future sweeps skip it.
    """


class _FilteredOutError(Exception):
    """Job dropped at upload time because the active sync filter
    excludes it. Distinct from a transport failure or a server-side
    rejection — the user changed their date-range filter and we caught
    the still-queued job before paying the network round-trip. Surfaced
    via ``_on_failure`` so the GUI's Recent uploads feed shows the
    drop instead of silently swallowing it.
    """


@dataclass(frozen=True)
class UploadJob:
    file_path: Path
    game: CloudGame


class UploadQueue:
    """Drain-on-demand worker queue."""

    def __init__(
        self,
        *,
        cfg: AgentConfig,
        state: AgentState,
        api: ApiClient,
        on_success: Optional[Callable[[Path], None]] = None,
        on_failure: Optional[Callable[[Path, Exception], None]] = None,
    ) -> None:
        self._cfg = cfg
        self._state = state
        self._api = api
        self._q: queue.Queue[UploadJob] = queue.Queue(maxsize=1000)
        self._stop = threading.Event()
        # Upload workers. Pre-v0.5.8 there was a single thread; v0.5.8
        # parallelises uploads to ``cfg.upload_concurrency`` threads so
        # the cloud-side bottleneck stops gating the user's "synced"
        # counter on a backfill. ApiClient is a frozen dataclass with
        # no shared mutable state and uses module-level ``requests``
        # calls under the hood, so concurrent invocations are safe.
        # State writes ARE shared but each one happens under
        # ``self._lock`` and ``save_state`` does an atomic
        # write-fsync-rename — so 4 threads racing to record successful
        # uploads serialise cleanly through the lock with no
        # interleaved writes to the JSON file on disk.
        self._threads: list[threading.Thread] = []
        # Effective worker count, kept separate from ``cfg`` so it can
        # be hot-swapped at runtime via ``set_concurrency()``. The
        # GUI's Upload-concurrency button group flips this between
        # 1 and 2 with no agent restart required.
        self._worker_count: int = max(
            1, getattr(cfg, "upload_concurrency", 1),
        )
        # Effective batch size, also runtime-mutable via
        # ``set_batch_size()``. Workers re-read this at the top of
        # every drain iteration so a Settings-tab change propagates
        # to the next batch they assemble — no worker-restart
        # ceremony needed for batch-size adjustments.
        self._batch_size: int = max(
            1, getattr(cfg, "upload_batch_size", 1),
        )
        self._on_success = on_success or (lambda _p: None)
        self._on_failure = on_failure or (lambda _p, _e: None)
        self._lock = threading.Lock()
        # Lifecycle lock for ``start`` / ``stop`` / ``set_concurrency``.
        # Prevents two GUI button clicks racing into overlapping
        # restart sequences (which would leak threads).
        self._lifecycle_lock = threading.Lock()
        self._paused = bool(getattr(state, "paused", False))
        self._resync_requested = threading.Event()

    def start(self) -> None:
        with self._lifecycle_lock:
            if any(t.is_alive() for t in self._threads):
                return
            self._stop.clear()
            self._threads = []
            # ``self._worker_count`` is validated to >=1 in __init__
            # and again on each ``set_concurrency`` call, but
            # belt-and-suspenders ``max(1, …)`` here so a corrupt
            # state file can't ship 0 worker threads.
            worker_count = max(1, self._worker_count)
            for i in range(worker_count):
                t = threading.Thread(
                    target=self._run,
                    name=f"sc2tools-upload-{i}",
                    daemon=True,
                )
                t.start()
                self._threads.append(t)
            log.info("upload_workers_started count=%d", worker_count)

    def stop(self) -> None:
        with self._lifecycle_lock:
            self._stop.set()
            # Join in order; any thread already idle inside the
            # ``q.get(timeout=1.0)`` will exit on its next iteration.
            # A thread mid-upload finishes the in-flight request
            # first so we never abandon a successful API write
            # without recording it in state.uploaded.
            for t in self._threads:
                t.join(timeout=5)
            self._threads = []

    def set_concurrency(self, new_count: int) -> None:
        """Hot-swap the worker count without losing in-flight uploads.

        Triggered by the Settings tab's Upload-concurrency button
        group (1 / 2) — a click should take effect immediately, not
        require an agent restart.

        Approach: stop the current workers (each one finishes its
        in-flight HTTPS POST first because ``stop()`` joins with a
        5-second timeout, plenty for a typical request), then
        ``start()`` again with the new count. The internal
        ``Queue`` of pending jobs is untouched across the swap, so
        anything not yet picked up by an old worker gets drained by
        the new ones. Anything picked up but not finished gets
        recorded in ``state.uploaded`` by the worker before it
        exits — no data loss.

        No-op if the new count matches the current one. Brief gap
        (typically <1 sec) where the queue isn't being drained,
        but the parse-pool's ``put`` backpressure path handles
        that automatically.
        """
        new_count = max(1, int(new_count))
        with self._lifecycle_lock:
            if new_count == self._worker_count and any(
                t.is_alive() for t in self._threads
            ):
                # Already at the target count and running — nothing
                # to do. Skipping the stop/start dance avoids a
                # spurious queue-drain pause on a no-op click.
                return
            old_count = self._worker_count
            self._worker_count = new_count
        log.info(
            "upload_concurrency_change from=%d to=%d", old_count, new_count,
        )
        # Order matters: ``stop()`` then ``start()``. Both take the
        # ``_lifecycle_lock``; we released it above so they can each
        # acquire it cleanly. The ``_worker_count`` mutation under
        # the lock above is what governs how many threads ``start()``
        # spawns next.
        self.stop()
        self.start()

    def set_batch_size(self, new_size: int) -> None:
        """Hot-swap the per-request batch size at runtime.

        No worker restart needed: workers re-read ``self._batch_size``
        at the top of every drain iteration (see ``_run`` above), so
        the change takes effect on the next batch each worker
        assembles — typically within 1–2 seconds.

        Idempotent on no-op. Floor of 1; ceiling enforced by the
        runner's save handler against ``UPLOAD_BATCH_SIZE_USEFUL_MAX``,
        not here, so a hot-swap from a hand-edited override stays
        within sensible bounds without this method needing to know
        about server limits.
        """
        new_size = max(1, int(new_size))
        if new_size == self._batch_size:
            return
        log.info(
            "upload_batch_size_change from=%d to=%d",
            self._batch_size, new_size,
        )
        # Single int assignment — no lock needed (Python dict / int
        # writes are atomic at the bytecode level for single-stmt
        # assignment, and the worker's ``max(1, self._batch_size)``
        # is read inside its own iteration loop). Worst case the
        # in-flight batch uses the OLD size and the next one uses
        # the new size; that's the contract.
        self._batch_size = new_size

    def submit(self, job: UploadJob) -> bool:
        """Enqueue a job. Returns False if already uploaded.

        Backpressure (added v0.5.8): when process-mode parse pools
        produce parses faster than the cloud uploader drains them
        (5–10× ratio is typical on a 32-worker pool), the bounded
        ``Queue(maxsize=1000)`` would otherwise fill up and silently
        drop incoming jobs via ``put_nowait``. Dropped jobs were not
        marked ``state.uploaded`` so the next sweep would re-discover
        them, re-parse them (wasted CPU), and drop them again — a
        loop that could repeat indefinitely on a backfill of N>>1k
        replays.

        The fix: ``put`` with a generous timeout. Blocks the caller
        (the parse-pool done-callback thread) until the upload worker
        drains a slot. ``ProcessPoolExecutor`` gracefully accumulates
        completed-but-not-yet-callback'd futures during the block, so
        nothing is lost — parses just queue up in memory until the
        upload thread catches up. The 5-minute timeout is a safety
        net for a wedged upload thread (e.g. a hung HTTPS connection
        the connection pool hasn't reaped yet); we'd rather log the
        symptom and drop one job than block the entire pipeline
        forever.
        """
        if str(job.file_path) in self._state.uploaded:
            log.debug("dedupe_skip %s", job.file_path.name)
            return False
        try:
            self._q.put(job, timeout=_BACKPRESSURE_TIMEOUT_SEC)
            return True
        except queue.Full:
            # Reached only when the upload thread has been
            # unresponsive for the full timeout window. By the time
            # we hit this branch the agent is in a degraded state —
            # log loudly so support can correlate it with whatever
            # network / API outage caused it.
            log.error(
                "upload_queue_blocked_for_%ds; dropping %s "
                "(upload worker likely stuck — investigate API "
                "connectivity or restart the agent)",
                int(_BACKPRESSURE_TIMEOUT_SEC),
                job.file_path.name,
            )
            return False

    def pending_count(self) -> int:
        return self._q.qsize()

    def set_paused(self, paused: bool) -> None:
        """Pause or resume the worker. While paused, the worker keeps
        draining the queue but holds onto each job (re-enqueueing it
        with a brief sleep) so we don't hit the network until the user
        un-pauses."""
        with self._lock:
            self._paused = bool(paused)
        log.info("upload_queue_paused=%s", paused)

    def is_paused(self) -> bool:
        with self._lock:
            return self._paused

    def request_full_resync(self) -> None:
        """Signal the watcher / runner that every replay should be
        re-considered for upload. The actual rescan happens on the
        watcher's next sweep — this just clears the in-memory dedupe
        cache so jobs aren't filtered out on submit()."""
        self._resync_requested.set()
        log.info("upload_queue_resync_requested")

    def is_resync_requested(self) -> bool:
        return self._resync_requested.is_set()

    def acknowledge_resync(self) -> None:
        self._resync_requested.clear()

    def drain_outside_filter(self) -> int:
        """Drop every queued job whose game date_iso falls outside the
        active sync filter, re-enqueueing the survivors in their
        original submission order. Returns the number of jobs dropped.

        Called by the runner immediately after a filter Save so
        already-parsed jobs sitting in the queue at the moment of the
        Save click don't sneak past the new window. Without this, a
        queue depth of 5–100 (typical during a backfill or hot ladder
        session) would keep flying out for ~30 seconds before the
        watcher's filter started biting on fresh files.

        No-op when the filter is fully open (preset is None / "all").
        Persists ``state.uploaded`` once at the end if anything was
        dropped — both so the next sweep skips re-parsing the dropped
        files and so a crash mid-drop doesn't leak the change.
        """
        sync_filter = SyncFilter.from_state(
            preset=getattr(self._state, "sync_filter_preset", None),
            since_iso=getattr(self._state, "sync_filter_since", None),
            until_iso=getattr(self._state, "sync_filter_until", None),
        )
        if not sync_filter.is_active():
            return 0
        keep: list[UploadJob] = []
        dropped_jobs: list[UploadJob] = []
        # Drain the entire queue sequentially so we can re-enqueue
        # survivors in submission order. ``get_nowait`` raises
        # ``queue.Empty`` when drained — that's the exit condition.
        while True:
            try:
                job = self._q.get_nowait()
            except queue.Empty:
                break
            try:
                date_iso = getattr(job.game, "date_iso", None)
                if sync_filter.replay_in_range(date_iso):
                    keep.append(job)
                else:
                    dropped_jobs.append(job)
                    log.info(
                        "queued_upload_dropped_by_filter %s date_iso=%s",
                        job.file_path.name, date_iso,
                    )
            finally:
                # ``Queue.task_done`` is mandatory for every ``get`` to
                # keep the implicit ``Queue.join`` counter balanced.
                self._q.task_done()
        # Re-enqueue survivors. ``put_nowait`` is safe because we just
        # drained the entire queue — capacity is guaranteed.
        for job in keep:
            try:
                self._q.put_nowait(job)
            except queue.Full:
                # Defensive: shouldn't happen because we just emptied
                # the queue. Log and swallow rather than abort.
                log.error(
                    "requeue_failed_after_drain %s", job.file_path.name,
                )
        if dropped_jobs:
            label = sync_filter.short_label()
            err = _FilteredOutError(f"Outside sync window {label}")
            with self._lock:
                for job in dropped_jobs:
                    self._state.uploaded[str(job.file_path)] = "filtered"
                save_state(self._cfg.state_dir, self._state)
            # Mirror callbacks OUTSIDE the lock so a slow GUI handler
            # doesn't hold up the next state mutation.
            for job in dropped_jobs:
                try:
                    self._on_failure(job.file_path, err)
                except Exception:  # noqa: BLE001
                    log.exception(
                        "drain_filter_on_failure_callback_failed %s",
                        job.file_path.name,
                    )
        return len(dropped_jobs)

    # ---------------- internals ----------------
    def _run(self) -> None:
        """Worker loop: drain a batch, post via ``upload_games_batch``.

        Per-batch behaviour:

          1. Block on ``q.get(timeout=1.0)`` for the first job. The 1
             s timeout is short enough that ``stop()`` is responsive.
          2. If paused, re-enqueue the first job and sleep — same
             non-loss semantics the pre-batching worker had.
          3. Greedy-drain up to ``cfg.upload_batch_size - 1`` more
             ready jobs via ``q.get_nowait()`` (so we don't block
             waiting for a full batch when only a few are ready).
          4. POST the batch to ``/v1/games``. Per-game ``accepted`` /
             ``rejected`` results are processed individually inside
             ``_upload_batch`` so partial-success batches (some
             games accept, some fail validation) work correctly.
          5. Whole-batch transient failures (network, 429, timeout)
             re-enqueue every job in the batch so nothing is lost.

        Re-reads ``self._batch_size`` at the top of every iteration
        (not just once at function entry) so a runtime ``set_batch_size``
        call propagates to the next batch the worker assembles —
        same hot-swap semantics as ``set_concurrency``.
        """
        while not self._stop.is_set():
            batch_cap = max(1, self._batch_size)
            try:
                first_job = self._q.get(timeout=1.0)
            except queue.Empty:
                continue
            if self.is_paused():
                # Re-enqueue and sleep; never lose work because we paused.
                try:
                    self._q.put_nowait(first_job)
                except queue.Full:
                    log.error("upload_queue_full_during_pause; dropping")
                self._q.task_done()
                time.sleep(1.0)
                continue
            # Drain additional ready jobs into the batch — but DON'T
            # block waiting for them. If the queue was empty after
            # ``first_job`` we send a 1-element batch immediately
            # rather than dawdling on the off-chance more arrive.
            batch: List[UploadJob] = [first_job]
            while len(batch) < batch_cap:
                try:
                    batch.append(self._q.get_nowait())
                except queue.Empty:
                    break
            try:
                self._upload_batch(batch)
            except _ServerRejectedError as exc:
                # Whole-batch envelope rejection (e.g. server returned
                # a top-level error not per-game). Mark every job in
                # the batch as rejected so we don't loop. Per-game
                # rejections never reach this branch — they're handled
                # individually inside ``_upload_batch`` via the
                # ``rejected`` array of the response.
                with self._lock:
                    for job in batch:
                        log.error(
                            "upload_rejected %s: %s",
                            job.file_path.name, exc,
                        )
                        self._on_failure(job.file_path, exc)
                        self._state.uploaded[str(job.file_path)] = "rejected"
                    save_state(self._cfg.state_dir, self._state)
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "upload_batch_failed size=%d: %s",
                    len(batch), exc,
                )
                for job in batch:
                    self._on_failure(job.file_path, exc)
                # Park briefly then retry the whole batch by
                # re-enqueueing every job. The dedupe-on-submit gate
                # in ``submit()`` prevents already-uploaded files from
                # going around twice if a partial success was followed
                # by a transient error mid-batch.
                time.sleep(2.0)
                for job in batch:
                    try:
                        self._q.put_nowait(job)
                    except queue.Full:
                        log.error(
                            "upload_queue_full_after_retry; dropping %s",
                            job.file_path.name,
                        )
            finally:
                # ``task_done`` once per ``get`` regardless of outcome.
                # Required for ``Queue.join()`` semantics; tests rely
                # on it via the implicit accounting.
                for _ in batch:
                    self._q.task_done()

    def _upload_batch(self, batch: List[UploadJob]) -> None:
        """POST a batch of games as one HTTP request, then mirror the
        per-game ``accepted`` / ``rejected`` arrays back into
        ``state.uploaded``.

        The cloud API at ``POST /v1/games`` accepts ``{games: [...]}``
        and replies with the same per-game accept/reject envelope it
        uses for single-game uploads. Per-game outcomes are handled
        independently here — a 25-game batch where 23 succeed and 2
        fail validation results in 23 ``ISO timestamp`` entries plus
        2 ``"rejected"`` entries in ``state.uploaded``, all written
        under one ``save_state`` call so the on-disk state file
        reflects the whole batch atomically.
        """
        if not batch:
            return
        # Defense-in-depth filter check at the moment of upload. The
        # watcher applies the filter post-parse, but if the user
        # changed the filter between parse and upload (typical queue
        # depth during a backfill is dozens), we'd otherwise ship
        # out-of-window replays anyway. The runner's
        # ``drain_outside_filter`` call on Save already empties most
        # of the queue — this catches any straggler that beat the
        # drain (worker had already pulled it from the queue and was
        # mid-batch when the Save fired).
        sync_filter = SyncFilter.from_state(
            preset=getattr(self._state, "sync_filter_preset", None),
            since_iso=getattr(self._state, "sync_filter_since", None),
            until_iso=getattr(self._state, "sync_filter_until", None),
        )
        if sync_filter.is_active():
            kept: List[UploadJob] = []
            filtered_out: List[UploadJob] = []
            for job in batch:
                date_iso = getattr(job.game, "date_iso", None)
                if sync_filter.replay_in_range(date_iso):
                    kept.append(job)
                else:
                    filtered_out.append(job)
            if filtered_out:
                label = sync_filter.short_label()
                err = _FilteredOutError(f"Outside sync window {label}")
                with self._lock:
                    for job in filtered_out:
                        log.info(
                            "upload_dropped_by_filter %s date_iso=%s "
                            "filter=%s",
                            job.file_path.name,
                            getattr(job.game, "date_iso", None),
                            label,
                        )
                        self._state.uploaded[str(job.file_path)] = (
                            "filtered"
                        )
                    save_state(self._cfg.state_dir, self._state)
                for job in filtered_out:
                    try:
                        self._on_failure(job.file_path, err)
                    except Exception:  # noqa: BLE001
                        log.exception(
                            "filter_on_failure_callback_failed %s",
                            job.file_path.name,
                        )
            if not kept:
                # Nothing left in this batch worth shipping. Skip the
                # network round-trip entirely.
                return
            batch = kept
        # Build payloads + a gameId→job lookup so we can map server
        # responses back to the originating ``UploadJob``. Keyed off
        # the server's authoritative gameId rather than file path
        # because the response envelope only carries gameIds.
        payloads: List[Dict[str, Any]] = []
        by_id: Dict[str, UploadJob] = {}
        for job in batch:
            payload = job.game.to_payload()
            payloads.append(payload)
            gid = payload.get("gameId")
            if isinstance(gid, str) and gid:
                by_id[gid] = job
        if len(by_id) < len(batch):
            log.warning(
                "upload_batch_missing_gameids count=%d expected=%d",
                len(by_id), len(batch),
            )
        log.info("uploading_batch size=%d", len(batch))
        # Single-item batches still go through the batch endpoint —
        # the server's per-game response envelope is identical for
        # 1-game and N-game batches, so this keeps the worker code
        # path uniform. Tests that pin to ``upload_concurrency=1``
        # and ``upload_batch_size=1`` to assert single-game behaviour
        # see one ``upload_games_batch`` call with a 1-element list.
        result = self._api.upload_games_batch(payloads)
        accepted = result.get("accepted") or []
        rejected = result.get("rejected") or []

        accepted_jobs: List[UploadJob] = []
        rejected_jobs: List[Tuple[UploadJob, str]] = []
        with self._lock:
            now_iso = datetime.now(timezone.utc).isoformat()
            for acc in accepted:
                gid = acc.get("gameId") if isinstance(acc, dict) else None
                job = by_id.get(gid) if isinstance(gid, str) else None
                if not job:
                    log.warning("upload_unmapped_accepted gameId=%r", gid)
                    continue
                path_str = str(job.file_path)
                self._state.uploaded[path_str] = now_iso
                # Reverse-index by gameId so the Socket.io recompute
                # path can locate this replay's file in O(1) — same
                # invariant maintained by the pre-batching path.
                if isinstance(gid, str) and gid:
                    self._state.path_by_game_id[gid] = path_str
                accepted_jobs.append(job)
            for rej in rejected:
                gid = rej.get("gameId") if isinstance(rej, dict) else None
                job = by_id.get(gid) if isinstance(gid, str) else None
                if not job:
                    log.warning("upload_unmapped_rejected gameId=%r", gid)
                    continue
                errs = rej.get("errors") if isinstance(rej, dict) else None
                err_msg = "; ".join(str(e) for e in (errs or [])) or "unknown"
                self._state.uploaded[str(job.file_path)] = "rejected"
                rejected_jobs.append((job, err_msg))
            if accepted_jobs or rejected_jobs:
                save_state(self._cfg.state_dir, self._state)

        # User-facing callbacks + the sticky-MMR push happen OUTSIDE
        # the lock — they may take a network round-trip and we don't
        # want to hold the state lock that long.
        for job in accepted_jobs:
            self._on_success(job.file_path)
        for job, err_msg in rejected_jobs:
            log.error("upload_rejected %s: %s", job.file_path.name, err_msg)
            self._on_failure(job.file_path, _ServerRejectedError(err_msg))
        # Sticky-MMR: pushing one MMR per accepted game would make
        # N redundant API calls for the older entries (each would
        # short-circuit on the date check after the newest had
        # already updated state). Compute the newest dated job ONCE
        # and only push for that.
        self._push_last_mmr_for_newest(accepted_jobs)

        # Sanity check: every batched gameId should appear in either
        # accepted or rejected. A server that drops a game silently
        # would otherwise leave the file in inflight purgatory —
        # re-enqueue so the next sweep picks it up. This is a
        # defensive belt-and-suspenders check; we've never observed
        # the cloud API drop a game from the response.
        seen = (
            {a.get("gameId") for a in accepted if isinstance(a, dict)}
            | {r.get("gameId") for r in rejected if isinstance(r, dict)}
        )
        for gid, job in by_id.items():
            if gid in seen:
                continue
            log.warning(
                "upload_unaccounted_game gameId=%s; re-enqueueing %s",
                gid, job.file_path.name,
            )
            try:
                self._q.put_nowait(job)
            except queue.Full:
                log.error(
                    "upload_queue_full_unaccounted; dropping %s",
                    job.file_path.name,
                )

    def _push_last_mmr_for_newest(self, jobs: List[UploadJob]) -> None:
        """Run sticky-MMR push for the newest dated game in ``jobs``.

        ``_maybe_push_last_mmr`` is correct when called per-job, but
        running it for every accepted game in a batch is wasteful:
        the second-and-later calls all short-circuit on the date
        comparison once the first call has updated
        ``state.last_known_mmr_date_iso``. Picking the newest up
        front collapses N short-circuited checks (and possibly N-1
        redundant API calls if a thread races) to a single
        ``patch_last_mmr`` round-trip.
        """
        newest: Optional[UploadJob] = None
        for job in jobs:
            my_mmr = getattr(job.game, "my_mmr", None)
            if not isinstance(my_mmr, int) or not (500 <= my_mmr <= 9999):
                continue
            game_date = getattr(job.game, "date_iso", None)
            if not isinstance(game_date, str) or not game_date:
                continue
            if newest is None:
                newest = job
                continue
            newest_date = getattr(newest.game, "date_iso", "")
            if game_date > newest_date:
                newest = job
        if newest is not None:
            self._maybe_push_last_mmr(newest)

    def _upload_one(self, job: UploadJob) -> None:
        """Legacy single-game upload path. v0.5.8 routes everything
        through ``_upload_batch`` (with size-1 batches when
        ``upload_batch_size=1``); this method survives only for any
        downstream caller that imports it directly. Internal callers
        within the queue's own code go through ``_upload_batch``.
        """
        # Defense-in-depth: the watcher checks at parse time, but a
        # filter change between parse and upload would otherwise let an
        # out-of-window replay through. Keep the symmetric check on
        # both real upload paths so importer-of-_upload_one code (and
        # any future re-exports) gets the same guarantee.
        sync_filter = SyncFilter.from_state(
            preset=getattr(self._state, "sync_filter_preset", None),
            since_iso=getattr(self._state, "sync_filter_since", None),
            until_iso=getattr(self._state, "sync_filter_until", None),
        )
        date_iso = getattr(job.game, "date_iso", None)
        if sync_filter.is_active() and not sync_filter.replay_in_range(
            date_iso,
        ):
            label = sync_filter.short_label()
            log.info(
                "upload_dropped_by_filter %s date_iso=%s filter=%s",
                job.file_path.name, date_iso, label,
            )
            path_str = str(job.file_path)
            with self._lock:
                self._state.uploaded[path_str] = "filtered"
                save_state(self._cfg.state_dir, self._state)
            self._on_failure(
                job.file_path,
                _FilteredOutError(f"Outside sync window {label}"),
            )
            return
        log.info("uploading %s", job.file_path.name)
        result = self._api.upload_game(job.game.to_payload())
        accepted = bool((result.get("accepted") or [{}])[0].get("gameId"))
        if not accepted:
            raise _ServerRejectedError(f"server_rejected: {result!r}")
        path_str = str(job.file_path)
        with self._lock:
            self._state.uploaded[path_str] = (
                datetime.now(timezone.utc).isoformat()
            )
            # Reverse-index by gameId so the Socket.io recompute path
            # can locate this replay's file on disk in O(1) instead of
            # re-parsing the whole folder. Skipped only when the
            # CloudGame somehow lacks a gameId — should never happen
            # because validate_game_record requires it server-side.
            game_id = getattr(job.game, "game_id", None)
            if isinstance(game_id, str) and game_id:
                self._state.path_by_game_id[game_id] = path_str
            save_state(self._cfg.state_dir, self._state)
        self._on_success(job.file_path)
        # Sticky-MMR ping. The session widget falls back to this
        # profile field whenever no game in the user's cloud history
        # carries ``myMmr`` (Tier-2 / Tier-3 / Tier-4 / Tier-5 of
        # GamesService.todaySession), so a single failed-extraction
        # window doesn't blank the overlay. We gate-keep on the GAME
        # date — never push an older replay's MMR over a newer one,
        # otherwise re-syncing 12k old replays would reset the sticky
        # MMR to whatever the streamer's rating was three seasons ago.
        self._maybe_push_last_mmr(job)

    def _maybe_push_last_mmr(self, job: UploadJob) -> None:
        """Push the streamer's MMR to the cloud profile if it's the most
        recent we've seen.

        Self-protective: silently no-ops when the game has no MMR, when
        the in-memory state already reflects a more recent game, or
        when the HTTP call fails. Failures must never block the upload
        ack — the per-game upload itself has already succeeded.
        """
        my_mmr = getattr(job.game, "my_mmr", None)
        if not isinstance(my_mmr, int) or not (500 <= my_mmr <= 9999):
            return
        game_date = getattr(job.game, "date_iso", None)
        if not isinstance(game_date, str) or not game_date:
            return
        with self._lock:
            stored_date = self._state.last_known_mmr_date_iso
            if stored_date and stored_date >= game_date:
                # Older replay than what we already pushed; skip the
                # round-trip and the state churn. ISO-8601 strings sort
                # lexicographically iff they share the same shape (UTC
                # 'Z' suffix), which ``_to_iso`` in replay_pipeline.py
                # guarantees on every CloudGame.
                return
        region = _region_from_toon_handle(getattr(job.game, "my_toon_handle", None))
        try:
            self._api.patch_last_mmr(
                mmr=my_mmr,
                captured_at=game_date,
                region=region,
            )
        except Exception as exc:  # noqa: BLE001
            log.debug("last_mmr_push_failed file=%s: %s", job.file_path.name, exc)
            return
        with self._lock:
            self._state.last_known_mmr = my_mmr
            self._state.last_known_mmr_date_iso = game_date
            if region:
                self._state.last_known_mmr_region = region
            save_state(self._cfg.state_dir, self._state)
        log.info(
            "last_mmr_pushed mmr=%d region=%s game_date=%s",
            my_mmr, region or "?", game_date,
        )


# Map the leading region byte of an SC2 toon handle to a short
# Blizzard-region label. Mirrors ``regionFromToonHandle`` in
# ``apps/api/src/services/games.js`` so the agent and cloud agree on
# which label belongs to which numeric prefix.
_TOON_HANDLE_REGION_BYTE = {
    "1": "NA",
    "2": "EU",
    "3": "KR",
    "5": "CN",
    "6": "SEA",
}


def _region_from_toon_handle(handle: Optional[str]) -> Optional[str]:
    if not isinstance(handle, str) or not handle:
        return None
    head = handle.split("-", 1)[0]
    return _TOON_HANDLE_REGION_BYTE.get(head)

"""Bounded, thread-safe upload queue with persistent dedupe.

The watcher pushes ``(file_path, CloudGame)`` pairs onto the queue.
A worker thread drains them, posts to /v1/games, and on success records
the file path in ``state.uploaded`` so retries / restarts don't
re-upload. Failed uploads are retried with exponential backoff on the
ApiClient side; if the queue is busy, new replays park in memory.
"""

from __future__ import annotations

import itertools
import logging
import queue
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from ..api_client import (
    ApiClient,
    ReplayArchiveSourceUnavailable,
    ReplayIngestBusy,
    replay_file_matches_archive_marker,
)
from ..config import AgentConfig
from ..replay_pipeline import CloudGame
from ..state import AgentState, save_state
from ..sync_filter import SyncFilter
from .archive_journal import (
    ReplayArchiveJournal,
    ReplayArchiveJournalError,
    ReplayArchiveTask,
)

log = logging.getLogger(__name__)

# Backpressure budget for ``UploadQueue.submit``. Was 300 s — that
# turned out to be a pipeline-killer: ``submit()`` is called from the
# parse pool's done-callback, which in process mode runs on the
# executor's manager thread. Blocking that thread for 5 minutes
# stalls ALL result processing AND pending-future cancellation
# (observed 2026-06-10: a congested API filled the queue, the
# manager thread blocked, and ~12.6k queued parses were eventually
# mass-cancelled / never collected). A short wait absorbs normal
# drain jitter; on timeout we return False WITHOUT marking the file
# uploaded, so the next sweep re-parses it once the queue has
# breathing room — slow-API congestion now costs wasted CPU instead
# of a wedged agent. The sweep-side throttle in
# ``watcher._sweep_once`` keeps re-parse churn rare by not
# submitting new parses while the queue is congested.
_BACKPRESSURE_TIMEOUT_SEC = 15.0

# A process parse pool completes jobs in small, slightly staggered waves.  An
# immediate non-blocking drain therefore produced a median batch of only two
# games even when the user selected 50.  Historical work may wait briefly for
# its neighbours; rank-0 live games are never held for this window.
_BATCH_COALESCE_SEC = 0.2

# Ingest previously peaked at two server-facing calls for the production
# default. The archive lane shares these same slots; it never adds a third
# request even if a stale/hand-edited setting starts more ingest threads.
_NETWORK_CONCURRENCY_LIMIT = 2

# Only this many durable tasks are hydrated into the ready queue. The journal
# may safely hold tens of thousands without constructing an equally large
# in-memory work queue.
_ARCHIVE_READY_LIMIT = 256
_ARCHIVE_RETRY_BASE_SEC = 2.0
_ARCHIVE_RETRY_MAX_SEC = 60.0
_ARCHIVE_IDLE_GRACE_SEC = 1.0


class _NetworkRequestGate:
    """Bound all queue-owned cloud work and favor parsed-game ingest.

    Priority 0 is a newly finished live game, priority 1 is historical
    ingest, and priority 2 is original-replay archival. Archive work is
    deliberately the lowest priority: it is durable and may finish later,
    while parsed-game progress is what the user is actively waiting on.
    """

    def __init__(self, limit: int) -> None:
        self._limit = max(1, int(limit))
        self._condition = threading.Condition()
        self._active = 0
        self._waiters = [0, 0, 0]
        # Kept observable for focused concurrency tests and diagnostics.
        self.peak_active = 0

    @contextmanager
    def hold(self, priority: int):
        rank = min(2, max(0, int(priority)))
        with self._condition:
            self._waiters[rank] += 1
            try:
                while self._active >= self._limit or any(
                    self._waiters[higher] > 0 for higher in range(rank)
                ):
                    self._condition.wait(timeout=0.5)
                self._active += 1
                self.peak_active = max(self.peak_active, self._active)
            finally:
                self._waiters[rank] -= 1
        try:
            yield
        finally:
            with self._condition:
                self._active -= 1
                self._condition.notify_all()


def _path_identity(value: Any) -> str:
    """Return a case-insensitive stable key for one local replay path."""
    try:
        return str(Path(str(value)).resolve(strict=False)).casefold()
    except (OSError, RuntimeError, TypeError, ValueError):
        return str(value or "").strip().casefold()


class TerminalUploadError(Exception):
    """Base for a FINAL, per-file upload outcome.

    A file reported through ``_on_failure`` with a ``TerminalUploadError``
    is done — it will NOT be retried. ``ImportController`` accounts for it
    immediately (never waiting for a retry) using the two class attributes
    below. The concrete cases are a server-side per-game rejection
    (``_ServerRejectedError`` — a real error) and a sync-window filter drop
    (``_FilteredOutError`` — a benign, intentional exclusion).

    Transient whole-batch failures (read timeout, 5xx, connection reset)
    deliberately do NOT subclass this: the worker re-enqueues those jobs,
    so the same file comes back around and eventually reports success (or
    a real terminal error). If a transient hit were counted, the import
    card would fill with read-timeout retry noise ("N files couldn't be
    imported") AND the file would be double-counted — once as an error
    now, once as a completed upload when the retry lands. The
    transient/terminal split is exactly this ``isinstance`` boundary; see
    ``ImportController.on_upload_failure``.
    """

    #: ``errorBreakdown`` bucket this outcome contributes to.
    import_error_code = "rejected_by_server"
    #: True → counts as an import error (with a sample the user can act
    #: on); False → a benign completion (processed as intended, kept out
    #: of the "couldn't be imported" tally, same as a vs-AI skip).
    counts_as_error = True


class _ServerRejectedError(TerminalUploadError):
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


class _RetryablePerGameError(Exception):
    """One or more validated games hit transient server-side storage.

    Raised after accepted and permanent outcomes in the same response have
    been committed. The worker's ordinary transient-exception path then
    requeues only paths whose pending reservation remains live.
    """


class _PausedBeforeNetwork(Exception):
    """Pause won the race while an ingest worker waited for a shared slot."""


class _FilteredOutError(TerminalUploadError):
    """Job dropped at upload time because the active sync filter
    excludes it. Distinct from a transport failure or a server-side
    rejection — the user changed their date-range filter and we caught
    the still-queued job before paying the network round-trip. Surfaced
    via ``_on_failure`` so the GUI's Recent uploads feed shows the
    drop instead of silently swallowing it.
    """

    # A filter drop is an INTENTIONAL exclusion, not a failure — the user
    # narrowed their date range and we honoured it. Count it as a benign
    # completion under its own bucket so it neither inflates the import
    # card's error tally nor borrows the misleading "server rejected" copy.
    import_error_code = "filtered"
    counts_as_error = False


@dataclass(frozen=True)
class UploadJob:
    file_path: Path
    game: CloudGame
    priority: bool = False


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
        on_pending_changed: Optional[Callable[[int], None]] = None,
        on_archive_pending_changed: Optional[Callable[[int], None]] = None,
    ) -> None:
        self._cfg = cfg
        self._state = state
        self._api = api
        self._q: queue.PriorityQueue[Tuple[int, int, UploadJob]] = (
            queue.PriorityQueue(maxsize=1000)
        )
        # Transient failures retain work in a separate unbounded lane.
        # Re-inserting into the bounded producer queue after a backoff
        # raced with new parses for the freed slots and caused the exact
        # ``upload_queue_full_after_retry; dropping`` field failure this
        # queue is supposed to prevent.
        self._retry_q: queue.PriorityQueue[Tuple[int, int, UploadJob]] = (
            queue.PriorityQueue()
        )
        self._queue_sequence = itertools.count()
        self._network_gate = _NetworkRequestGate(
            _NETWORK_CONCURRENCY_LIMIT,
        )
        self._archive_journal = ReplayArchiveJournal(cfg.state_dir)
        self._archive_q: queue.PriorityQueue[
            Tuple[float, int, ReplayArchiveTask, int]
        ] = queue.PriorityQueue(maxsize=_ARCHIVE_READY_LIMIT)
        self._archive_sequence = itertools.count()
        self._archive_scheduled: set[tuple[str, str]] = set()
        self._archive_lane_not_before = 0.0
        self._archive_lane_failures = 0
        self._archive_journal_error: Optional[ReplayArchiveJournalError] = None
        self._archive_lock = threading.Lock()
        self._archive_thread: Optional[threading.Thread] = None
        self._archive_wake = threading.Event()
        self._archive_idle_since: Optional[float] = None
        self._archive_stop = threading.Event()
        self._ingest_stop = threading.Event()
        self._ingest_generation = 0
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
        # User-configured ceiling for the adaptive batch sizing below.
        # On a transient whole-batch failure (read timeout, 5xx) the
        # effective ``_batch_size`` halves so the agent converges on a
        # batch the server can actually process inside the timeout;
        # each fully-successful batch nudges it back up toward this
        # ceiling. ``set_batch_size`` resets both.
        self._batch_ceiling: int = self._batch_size
        self._on_success = on_success or (lambda _p: None)
        self._on_failure = on_failure or (lambda _p, _e: None)
        self._on_pending_changed = on_pending_changed or (lambda _n: None)
        self._on_archive_pending_changed = (
            on_archive_pending_changed or (lambda _n: None)
        )
        self._lock = threading.Lock()
        # Preserve notification order across parser + uploader threads.
        # The callback itself stays outside ``_lock`` so UI work cannot
        # block state mutations.
        self._pending_notify_lock = threading.RLock()
        # Serialize the compare -> cloud patch -> local cursor update.
        # With two upload workers, an older backfill request could
        # otherwise finish after a fresh replay and roll the sticky MMR
        # backward even though both passed the initial date check.
        self._mmr_push_lock = threading.Lock()
        # A replay path stays reserved from the moment it enters the
        # queue until it reaches a terminal outcome. ``state.uploaded``
        # cannot provide this protection because it is intentionally
        # written only after the API accepts/rejects a game. Without an
        # in-memory reservation, the watcher's 10-second sweep sees a
        # queued replay as "not uploaded" and parses/enqueues it again
        # for as long as a congested backlog takes to drain.
        self._pending_paths: set[str] = set()
        # Lifecycle lock for ``start`` / ``stop`` / ``set_concurrency``.
        # Prevents two GUI button clicks racing into overlapping
        # restart sequences (which would leak threads).
        self._lifecycle_lock = threading.Lock()
        self._paused = bool(getattr(state, "paused", False))
        self._resync_requested = threading.Event()

    def start(self) -> None:
        with self._lifecycle_lock:
            if not any(t.is_alive() for t in self._threads):
                self._start_ingest_workers_locked()
            if self._archive_thread is None or not self._archive_thread.is_alive():
                self._archive_stop.clear()
                self._hydrate_archive_ready()
                self._archive_thread = threading.Thread(
                    target=self._run_archive,
                    name="sc2tools-replay-archive",
                    daemon=True,
                )
                self._archive_thread.start()
                self._notify_archive_pending()
                log.info(
                    "replay_archive_worker_started pending=%d",
                    self._archive_journal.pending_count(),
                )

    def stop(self) -> None:
        with self._lifecycle_lock:
            self._ingest_generation += 1
            self._ingest_stop.set()
            self._archive_stop.set()
            self._archive_wake.set()
            # Join in order; any thread already idle inside the
            # ``q.get(timeout=1.0)`` will exit on its next iteration.
            # A thread mid-upload finishes the in-flight request
            # first so we never abandon a successful API write
            # without recording it in state.uploaded.
            for t in self._threads:
                # Cloud calls have explicit finite timeouts (up to 150 s for
                # a size-50 ingest and 120 s per replay PUT). Never detach a
                # still-live worker after an arbitrary 5 s: an immediate
                # restart could otherwise overlap generations and strand the
                # archive successor. Shutdown waits for the bounded request
                # to finish and its local cursor/journal commit to land.
                t.join()
            self._threads = []
            archive_thread = self._archive_thread
            if archive_thread is not None:
                archive_thread.join()
                self._archive_thread = None
            try:
                self._archive_journal.flush()
            except Exception:  # noqa: BLE001
                # The durable enqueue records remain intact. Surface the
                # checkpoint problem, but never turn shutdown into task loss.
                log.exception("replay_archive_journal_flush_failed")

    def _start_ingest_workers_locked(self) -> None:
        """Start only parsed-game workers; caller holds lifecycle lock."""
        self._ingest_generation += 1
        generation = self._ingest_generation
        self._ingest_stop.clear()
        self._threads = []
        # ``self._worker_count`` is validated to >=1 in __init__ and again on
        # each runtime change. Keep the floor here for hand-edited state.
        worker_count = max(1, self._worker_count)
        for i in range(worker_count):
            thread = threading.Thread(
                target=self._run,
                args=(generation,),
                name=f"sc2tools-upload-{i}",
                daemon=True,
            )
            thread.start()
            self._threads.append(thread)
        log.info("upload_workers_started count=%d", worker_count)

    def set_concurrency(self, new_count: int) -> None:
        """Hot-swap the worker count without losing in-flight uploads.

        Triggered by the Settings tab's Upload-concurrency button
        group (1 / 2) — a click should take effect immediately, not
        require an agent restart.

        Approach: retire the current generation (each worker finishes its
        bounded in-flight HTTPS request and commits its cursor), then start
        the replacement generation with the new count. The internal
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
        # Restart parsed-game workers only. The single durable archive worker
        # must survive this settings change; restarting it could briefly run
        # two original-file uploads if the old thread was inside a long PUT.
        with self._lifecycle_lock:
            self._ingest_generation += 1
            self._ingest_stop.set()
            for thread in self._threads:
                # Retire the old generation completely before clearing its
                # shared stop event for replacement workers. Requests are
                # bounded by ApiClient timeouts, so this cannot wait forever.
                thread.join()
            self._threads = []
            self._start_ingest_workers_locked()

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
            # Still pin the adaptive ceiling: the current size may be
            # an adaptive shrink that happens to equal the user's new
            # setting, and the ceiling must reflect the user's intent.
            self._batch_ceiling = new_size
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
        # An explicit user setting resets the adaptive ceiling too —
        # otherwise a Save after a bad-network session would stay
        # clamped to whatever the halving converged on.
        self._batch_ceiling = new_size

    def submit(self, job: UploadJob) -> bool:
        """Enqueue a job. Returns False if uploaded or already pending.

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
        path_key = str(job.file_path)
        with self._lock:
            if path_key in self._state.uploaded:
                log.debug("dedupe_skip_uploaded %s", job.file_path.name)
                return False
            if path_key in self._pending_paths:
                log.debug("dedupe_skip_pending %s", job.file_path.name)
                return False
            self._pending_paths.add(path_key)
        with self._archive_lock:
            self._archive_idle_since = None
        self._archive_wake.set()
        self._notify_pending()
        try:
            self._q.put(
                self._queue_item(job),
                timeout=_BACKPRESSURE_TIMEOUT_SEC,
            )
            return True
        except queue.Full:
            # Queue saturated (slow / unreachable API). NOT a loss:
            # the file is not marked uploaded, so a later sweep
            # re-parses and re-submits it once the queue drains.
            log.warning(
                "upload_queue_saturated; deferring %s to a later sweep "
                "(uploads not keeping up — API slow or unreachable)",
                job.file_path.name,
            )
            self._release_pending((job,))
            return False

    def pending_count(self) -> int:
        # Include jobs a worker has already pulled from the physical
        # queue. Those paths are still uploading/retrying and must count
        # as pending both for watcher backpressure and the GUI's Queued
        # card; qsize() alone misleadingly drops them to zero mid-flight.
        with self._lock:
            return len(self._pending_paths)

    def archive_pending_count(self) -> int:
        """Number of accepted originals still awaiting private storage."""
        return self._archive_journal.pending_count()

    def _notify_archive_pending(self) -> None:
        count = self._archive_journal.pending_count()
        try:
            self._on_archive_pending_changed(count)
        except Exception:  # noqa: BLE001
            log.exception(
                "replay_archive_pending_callback_failed count=%d",
                count,
            )

    def _hydrate_archive_ready(self) -> None:
        """Page durable tasks into the bounded in-memory ready queue."""
        with self._archive_lock:
            available = max(0, _ARCHIVE_READY_LIMIT - self._archive_q.qsize())
            if available <= 0:
                return
            tasks = self._archive_journal.next_tasks(
                excluded=set(self._archive_scheduled),
                limit=available,
            )
            now = time.monotonic()
            for task in tasks:
                attempt = self._archive_journal.retry_attempt(task)
                try:
                    self._archive_q.put_nowait(
                        (now, next(self._archive_sequence), task, attempt),
                    )
                except queue.Full:
                    break
                self._archive_scheduled.add(task.key)

    def _schedule_archive_task(self, task: ReplayArchiveTask) -> None:
        """Make one already-durable task runnable without duplicating it."""
        with self._archive_lock:
            if task.key in self._archive_scheduled:
                return
            try:
                self._archive_q.put_nowait(
                    (
                        time.monotonic(),
                        next(self._archive_sequence),
                        task,
                        0,
                    ),
                )
            except queue.Full:
                # It remains in the durable journal and will be paged in as
                # soon as the worker acknowledges another ready task.
                return
            self._archive_scheduled.add(task.key)
        self._archive_wake.set()

    def _requeue_archive_task(
        self,
        task: ReplayArchiveTask,
        *,
        attempt: int,
        ready_at: float,
    ) -> None:
        try:
            self._archive_q.put_nowait(
                (
                    ready_at,
                    next(self._archive_sequence),
                    task,
                    attempt,
                ),
            )
        except queue.Full:
            # A concurrently accepted task may have claimed the freed ready
            # slot. Drop only the in-memory reservation: the journal remains
            # authoritative and hydration will recover this task later.
            with self._archive_lock:
                self._archive_scheduled.discard(task.key)
        self._archive_wake.set()

    def _run_archive(self) -> None:
        """Drain one crash-safe, low-priority original-replay lane."""
        while not self._archive_stop.is_set():
            with self._archive_lock:
                journal_error = self._archive_journal_error
            if journal_error is not None:
                # A failed append/fsync poisons this journal instance to avoid
                # concatenating onto an uncertain tail. No network operation
                # can make progress safely until restart reloads/repairs it.
                self._archive_stop.wait(1.0)
                continue
            try:
                self._hydrate_archive_ready()
            except ReplayArchiveJournalError as exc:
                with self._archive_lock:
                    self._archive_journal_error = exc
                log.exception("replay_archive_journal_suspended")
                continue
            try:
                ready_at, _sequence, task, attempt = self._archive_q.get(
                    timeout=0.5,
                )
            except queue.Empty:
                continue
            try:
                now = time.monotonic()
                if ready_at > now:
                    self._archive_stop.wait(min(0.5, ready_at - now))
                    self._requeue_archive_task(
                        task,
                        attempt=attempt,
                        ready_at=ready_at,
                    )
                    continue
                if self.is_paused():
                    self._requeue_archive_task(
                        task,
                        attempt=attempt,
                        ready_at=now + 1.0,
                    )
                    self._archive_stop.wait(0.5)
                    continue
                with self._archive_lock:
                    lane_not_before = self._archive_lane_not_before
                if lane_not_before > now:
                    self._requeue_archive_task(
                        task,
                        attempt=attempt,
                        ready_at=lane_not_before,
                    )
                    self._archive_stop.wait(
                        min(0.5, lane_not_before - now),
                    )
                    continue

                # Analysis owns the foreground. Do not even claim a shared
                # network slot until its queue has stayed empty for a short
                # grace window; this prevents archive PUTs from slowing a
                # large Full Re-sync while retaining one spare slot for a
                # live game that arrives during an already-started PUT.
                if self.pending_count() > 0:
                    with self._archive_lock:
                        self._archive_idle_since = None
                    self._requeue_archive_task(
                        task,
                        attempt=attempt,
                        ready_at=now + 0.5,
                    )
                    continue
                with self._archive_lock:
                    if self._archive_idle_since is None:
                        self._archive_idle_since = now
                    idle_for = now - self._archive_idle_since
                if idle_for < _ARCHIVE_IDLE_GRACE_SEC:
                    self._requeue_archive_task(
                        task,
                        attempt=attempt,
                        ready_at=now + (_ARCHIVE_IDLE_GRACE_SEC - idle_for),
                    )
                    continue

                upload = getattr(
                    self._api,
                    "upload_replay_file_durable",
                    None,
                )
                if not callable(upload):
                    upload = getattr(self._api, "upload_replay_file", None)
                try:
                    if not callable(upload):
                        raise RuntimeError(
                            "replay_archive_api_unavailable",
                        )
                    else:
                        with self._network_gate.hold(2):
                            # A fresh replay can become pending while this
                            # worker waits behind an ingest request. Give it
                            # the slot instead and defer archival again.
                            if self.pending_count() > 0 or self.is_paused():
                                self._requeue_archive_task(
                                    task,
                                    attempt=attempt,
                                    ready_at=time.monotonic() + 0.5,
                                )
                                continue
                            # An exact server marker may have acknowledged this
                            # journal row while it waited for the low-priority
                            # slot. Do not perform stale network work.
                            if not self._archive_journal.contains(task):
                                with self._archive_lock:
                                    self._archive_scheduled.discard(task.key)
                                continue
                            stored = bool(upload(task.game_id, task.file_path))
                except ReplayArchiveJournalError:
                    # The outer boundary suspends the lane until restart.
                    # Never misclassify poisoned local durability as a cloud
                    # outage and continue probing the unhealthy journal.
                    raise
                except ReplayArchiveSourceUnavailable as exc:
                    next_attempt = attempt + 1
                    delay = min(
                        _ARCHIVE_RETRY_MAX_SEC,
                        _ARCHIVE_RETRY_BASE_SEC
                        * (2 ** min(attempt, 20)),
                    )
                    log.warning(
                        "replay_archive_retry file=%s gameId=%s "
                        "attempt=%d delay=%.1fs: %s",
                        task.file_path.name,
                        task.game_id,
                        next_attempt,
                        delay,
                        exc,
                    )
                    # Rotate this file out of the bounded ready capacity. The
                    # durable journal remains authoritative; hydration skips
                    # it until the cooldown expires, allowing later valid
                    # tasks to make progress in the meantime.
                    with self._archive_lock:
                        self._archive_scheduled.discard(task.key)
                    self._archive_journal.defer(
                        task,
                        not_before=time.monotonic() + delay,
                        attempt=next_attempt,
                    )
                    continue
                except Exception as exc:  # noqa: BLE001
                    # Transport/429/5xx/rolling-route failures affect the
                    # entire archival capability, not one replay. Open a
                    # lane-wide circuit breaker so an outage causes one probe
                    # per backoff window instead of walking all 256 files.
                    with self._archive_lock:
                        self._archive_lane_failures += 1
                        delay = min(
                            _ARCHIVE_RETRY_MAX_SEC,
                            _ARCHIVE_RETRY_BASE_SEC
                            * (2 ** min(self._archive_lane_failures - 1, 20)),
                        )
                        self._archive_lane_not_before = (
                            time.monotonic() + delay
                        )
                    log.warning(
                        "replay_archive_lane_backoff attempt=%d delay=%.1fs: %s",
                        self._archive_lane_failures,
                        delay,
                        exc,
                    )
                    self._requeue_archive_task(
                        task,
                        attempt=attempt + 1,
                        ready_at=self._archive_lane_not_before,
                    )
                    continue

                # True is confirmed stored/alreadyStored. False is the API
                # client's terminal local/per-file result (empty/over-size,
                # 400, 413, or an explicitly deleted owned game). Both are
                # final; missing/inaccessible local sources and transient
                # cloud failures raise above and leave the task intact.
                self._archive_journal.acknowledge_many(
                    [task],
                    durable=True,
                )
                with self._archive_lock:
                    self._archive_scheduled.discard(task.key)
                    self._archive_lane_failures = 0
                    self._archive_lane_not_before = 0.0
                if stored:
                    log.info(
                        "replay_archived %s gameId=%s",
                        task.file_path.name,
                        task.game_id,
                    )
                else:
                    log.warning(
                        "replay_archive_terminal_unavailable %s gameId=%s",
                        task.file_path.name,
                        task.game_id,
                    )
                self._notify_archive_pending()
            except ReplayArchiveJournalError as exc:
                # Do not upload another byte while acknowledgements cannot be
                # made durable. The current task remains in the journal and
                # restart is the safe recovery boundary.
                with self._archive_lock:
                    self._archive_scheduled.discard(task.key)
                    self._archive_journal_error = exc
                log.exception("replay_archive_journal_suspended")
            except Exception as exc:  # noqa: BLE001
                # A non-poisoning checkpoint error is still lane-wide: until
                # acknowledgements work, uploading another file can only
                # repeat bytes without making durable progress. Back off the
                # whole lane; the journal restored this pending task first.
                with self._archive_lock:
                    self._archive_lane_failures += 1
                    delay = min(
                        _ARCHIVE_RETRY_MAX_SEC,
                        _ARCHIVE_RETRY_BASE_SEC
                        * (2 ** min(self._archive_lane_failures - 1, 20)),
                    )
                    self._archive_lane_not_before = time.monotonic() + delay
                log.exception(
                    "replay_archive_worker_retry file=%s gameId=%s",
                    task.file_path.name,
                    task.game_id,
                )
                self._requeue_archive_task(
                    task,
                    attempt=attempt + 1,
                    ready_at=self._archive_lane_not_before,
                )
            finally:
                self._archive_q.task_done()

    def _queue_item(self, job: UploadJob) -> Tuple[int, int, UploadJob]:
        """Wrap a job for newest-live-first, stable FIFO ordering."""
        rank = 0 if job.priority else 1
        return (rank, next(self._queue_sequence), job)

    def _next_queue_item(
        self,
    ) -> Tuple[
        queue.PriorityQueue[Tuple[int, int, UploadJob]],
        Tuple[int, int, UploadJob],
    ]:
        """Take the next item, preferring fresh work then retries.

        The primary queue is checked first because rank-0 jobs are newly
        completed games. If its next item is ordinary history, an older
        transient retry gets the worker instead. This keeps retries in a
        non-dropping lane without letting a failed historical batch block
        a live replay after the API recovers.
        """
        try:
            main_item = self._q.get_nowait()
        except queue.Empty:
            try:
                return self._retry_q, self._retry_q.get_nowait()
            except queue.Empty:
                # Only producers can wake the system from a fully empty
                # state, and they always enter through the primary queue.
                return self._q, self._q.get(timeout=1.0)

        if main_item[0] == 0:
            return self._q, main_item

        try:
            retry_item = self._retry_q.get_nowait()
        except queue.Empty:
            return self._q, main_item

        # A normal primary item lost to a retained retry. Put it back
        # with its original sequence so FIFO order remains stable. A
        # producer can theoretically claim the freed bounded slot first;
        # if so, keep the primary item and return the retry to its
        # unbounded lane instead of dropping either one.
        try:
            self._q.put_nowait(main_item)
        except queue.Full:
            self._retry_q.put_nowait(retry_item)
            self._retry_q.task_done()
            return self._q, main_item
        self._q.task_done()
        return self._retry_q, retry_item

    def is_pending(self, file_path: Path) -> bool:
        """Whether ``file_path`` is queued, uploading, or retrying."""
        with self._lock:
            return str(file_path) in self._pending_paths

    def _release_pending(self, jobs: Iterable[UploadJob]) -> None:
        """Release path reservations after a terminal/drop outcome."""
        keys = {str(job.file_path) for job in jobs}
        if not keys:
            return
        with self._lock:
            before = len(self._pending_paths)
            self._pending_paths.difference_update(keys)
            changed = len(self._pending_paths) != before
        if changed:
            self._notify_pending()

    def _notify_pending(self) -> None:
        """Publish the real queued/uploading/retrying path count."""
        with self._pending_notify_lock:
            # Re-read only after acquiring the sequencing lock. A thread
            # that mutated after an earlier notifier was waiting must be
            # the last value published, never an out-of-order stale count.
            with self._lock:
                count = len(self._pending_paths)
            try:
                self._on_pending_changed(count)
            except Exception:  # noqa: BLE001
                # UI failures must never interfere with the upload pipeline.
                log.exception("upload_pending_callback_failed count=%d", count)

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
        keep: list[
            Tuple[
                queue.PriorityQueue[Tuple[int, int, UploadJob]],
                UploadJob,
            ]
        ] = []
        dropped_jobs: list[UploadJob] = []
        # Drain the entire queue sequentially so we can re-enqueue
        # survivors in submission order. ``get_nowait`` raises
        # ``queue.Empty`` when drained — that's the exit condition.
        for source_q in (self._q, self._retry_q):
            while True:
                try:
                    _rank, _sequence, job = source_q.get_nowait()
                except queue.Empty:
                    break
                try:
                    date_iso = getattr(job.game, "date_iso", None)
                    if sync_filter.replay_in_range(date_iso):
                        keep.append((source_q, job))
                    else:
                        dropped_jobs.append(job)
                        log.info(
                            "queued_upload_dropped_by_filter %s date_iso=%s",
                            job.file_path.name, date_iso,
                        )
                finally:
                    source_q.task_done()
        # Re-enqueue survivors. ``put_nowait`` is safe because we just
        # drained the entire queue — capacity is guaranteed.
        for source_q, job in keep:
            try:
                source_q.put_nowait(self._queue_item(job))
            except queue.Full:
                # Defensive: shouldn't happen because we just emptied
                # the queue. Log and swallow rather than abort.
                log.error(
                    "requeue_failed_after_drain %s", job.file_path.name,
                )
                self._release_pending((job,))
        if dropped_jobs:
            label = sync_filter.short_label()
            err = _FilteredOutError(f"Outside sync window {label}")
            try:
                with self._lock:
                    for job in dropped_jobs:
                        self._state.uploaded[str(job.file_path)] = "filtered"
                    save_state(self._cfg.state_dir, self._state)
                    for job in dropped_jobs:
                        self._pending_paths.discard(str(job.file_path))
            except Exception:  # noqa: BLE001
                # These items have already been removed from their source
                # queues. Retain them until the state cursor can be saved;
                # otherwise the reservation would have no worker left to
                # finish it and the Queued count would stick forever.
                log.exception("drain_filter_state_save_failed; retaining")
                for job in dropped_jobs:
                    self._retry_q.put_nowait(self._queue_item(job))
                return 0
            self._notify_pending()
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
    def _shrink_batch_size_after_failure(self, failed_size: int) -> None:
        """Halve the effective batch size after a whole-batch
        transient failure (read timeout, 5xx, network error).

        Rationale: the dominant transient-failure mode in the field is
        the server needing longer than the read timeout to process a
        large batch (observed 2026-06-10 with size=50 batches). Naive
        retry at the same size fails the same way every ~30 s while
        re-enqueueing the full batch into a congested queue. Halving
        converges on a size the server can handle within a few
        failures (50 → 25 → 12 → …); successful batches grow it back
        toward the user's configured ceiling.
        """
        if failed_size <= 1:
            return
        new_size = max(1, failed_size // 2)
        if new_size < self._batch_size:
            log.warning(
                "upload_batch_size_auto_reduced from=%d to=%d "
                "(transient batch failure; will grow back on success)",
                self._batch_size, new_size,
            )
            self._batch_size = new_size

    def _grow_batch_size_after_success(self, succeeded_size: int) -> None:
        """Additive recovery for the adaptive batch sizing.

        +1 per fully-successful batch, capped at the user-configured
        ceiling. Asymmetric on purpose (halve on failure, +1 on
        success) so a marginal server gets probed gently instead of
        oscillating between timeout and full size.
        """
        if succeeded_size < self._batch_size:
            # Partial drain (queue had fewer ready jobs than the cap)
            # tells us nothing about the server's capacity at the
            # current size — don't grow on it.
            return
        if self._batch_size < self._batch_ceiling:
            self._batch_size = min(self._batch_ceiling, self._batch_size + 1)

    def _run(self, generation: int) -> None:
        """Worker loop: drain a batch, post via ``upload_games_batch``.

        Per-batch behaviour:

          1. Block on ``q.get(timeout=1.0)`` for the first job. The 1
             s timeout is short enough that ``stop()`` is responsive.
          2. If paused, re-enqueue the first job and sleep — same
             non-loss semantics the pre-batching worker had.
          3. Greedy-drain up to ``cfg.upload_batch_size - 1`` more jobs.
             Historical work gets a 200 ms coalescing window so staggered
             parser callbacks form useful batches; live work never waits.
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
        while (
            not self._ingest_stop.is_set()
            and generation == self._ingest_generation
        ):
            batch_cap = max(1, self._batch_size)
            try:
                source_q, first_item = self._next_queue_item()
                _rank, _sequence, first_job = first_item
            except queue.Empty:
                continue
            if self.is_paused():
                # Re-enqueue and sleep; never lose work because we paused.
                try:
                    source_q.put_nowait(self._queue_item(first_job))
                except queue.Full:
                    # A producer may claim the bounded slot after this worker
                    # removes the item. Keep the reservation in the existing
                    # unbounded retry lane; pause must never become data loss.
                    self._retry_q.put_nowait(self._queue_item(first_job))
                source_q.task_done()
                time.sleep(1.0)
                continue
            # Drain additional ready jobs into the batch. Historical jobs
            # from the primary lane get one small coalescing window because
            # process-pool callbacks arrive a few milliseconds apart; without
            # it a configured size-50 queue routinely sent batches of 1–2.
            # A live rank-0 arrival wakes ``get`` immediately, is returned to
            # the head of the queue, and ends the wait. Retry-lane work is not
            # coalesced because a newly-arrived live job lives in the primary
            # queue and therefore could not wake a retry-queue wait.
            batch: List[UploadJob] = [first_job]
            # A just-finished game travels alone. Coupling it to up to
            # 39 historical payloads makes its acknowledgment inherit a
            # slow/timeout-prone backfill request, defeating the priority
            # lane before it reaches the API.
            if not first_job.priority:
                coalesce_deadline = (
                    time.monotonic() + _BATCH_COALESCE_SEC
                    if source_q is self._q and batch_cap > 1
                    else None
                )
                while len(batch) < batch_cap:
                    try:
                        if coalesce_deadline is None:
                            item = source_q.get_nowait()
                        else:
                            remaining = coalesce_deadline - time.monotonic()
                            if remaining <= 0:
                                break
                            item = source_q.get(timeout=remaining)
                        _rank, _sequence, job = item
                        if _rank == 0:
                            # A live replay arrived after this normal batch
                            # started assembling. Leave it at the head for
                            # the next request rather than coupling it to
                            # historical work. Balance the get/put task
                            # accounting while preserving its sequence.
                            try:
                                source_q.put_nowait(item)
                            except queue.Full:
                                self._retry_q.put_nowait(item)
                            source_q.task_done()
                            break
                        batch.append(job)
                    except queue.Empty:
                        break
            # Pause can be clicked while a history worker is inside the
            # coalescing wait. Re-check immediately before the network call;
            # every assembled item remains reserved and returns to its source
            # lane without being reported as failed or uploaded.
            if self.is_paused():
                for job in batch:
                    try:
                        source_q.put_nowait(self._queue_item(job))
                    except queue.Full:
                        # A producer may have claimed a primary-queue slot
                        # during coalescing. The unbounded retry lane safely
                        # retains the already-reserved job instead of dropping
                        # it or blocking this worker.
                        self._retry_q.put_nowait(self._queue_item(job))
                for _ in batch:
                    source_q.task_done()
                self._ingest_stop.wait(1.0)
                continue
            try:
                self._upload_batch(batch)
                self._grow_batch_size_after_success(len(batch))
            except _PausedBeforeNetwork:
                # Pause was clicked after batch assembly while this worker
                # waited for the global request gate. Retain every still-live
                # reservation without a failure callback or adaptive shrink.
                for job in batch:
                    if self.is_pending(job.file_path):
                        self._retry_q.put_nowait(self._queue_item(job))
                self._ingest_stop.wait(0.1)
            except ReplayIngestBusy as exc:
                # Intentional server admission control is neither a broken
                # payload nor a capacity signal for adaptive batch sizing.
                # Keep every path reserved, yield for Retry-After once, then
                # retry the identical batch via the durable retry lane. Do not
                # emit a failure callback: no upload has actually failed.
                retry_jobs = [
                    job for job in batch if self.is_pending(job.file_path)
                ]
                log.info(
                    "upload_batch_deferred size=%d retry_after=%.3f",
                    len(retry_jobs), exc.retry_after_seconds,
                )
                self._ingest_stop.wait(exc.retry_after_seconds)
                for job in retry_jobs:
                    self._retry_q.put_nowait(self._queue_item(job))
            except _ServerRejectedError as exc:
                # Whole-batch envelope rejection (e.g. server returned
                # a top-level error not per-game). Mark every job in
                # the batch as rejected so we don't loop. Per-game
                # rejections never reach this branch — they're handled
                # individually inside ``_upload_batch`` via the
                # ``rejected`` array of the response.
                try:
                    with self._lock:
                        for job in batch:
                            log.error(
                                "upload_rejected %s: %s",
                                job.file_path.name, exc,
                            )
                            self._state.uploaded[str(job.file_path)] = "rejected"
                        save_state(self._cfg.state_dir, self._state)
                        for job in batch:
                            self._pending_paths.discard(str(job.file_path))
                except Exception as persist_exc:  # noqa: BLE001
                    # The server outcome is terminal, but until its local
                    # cursor is durable these popped jobs must stay owned
                    # by a worker. Retain them instead of killing this
                    # worker and leaking their reservations forever.
                    log.exception(
                        "upload_rejection_state_save_failed; retaining"
                    )
                    time.sleep(2.0)
                    for job in batch:
                        self._retry_q.put_nowait(self._queue_item(job))
                    for job in batch:
                        try:
                            self._on_failure(job.file_path, persist_exc)
                        except Exception:  # noqa: BLE001
                            log.exception(
                                "upload_retry_callback_failed %s",
                                job.file_path.name,
                            )
                else:
                    self._notify_pending()
                    for job in batch:
                        try:
                            self._on_failure(job.file_path, exc)
                        except Exception:  # noqa: BLE001
                            log.exception(
                                "upload_failure_callback_failed %s",
                                job.file_path.name,
                            )
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "upload_batch_failed size=%d: %s",
                    len(batch), exc,
                )
                self._shrink_batch_size_after_failure(len(batch))
                # ``exc`` here is a TRANSIENT transport error (read
                # timeout, 5xx, connection reset) — a bare exception, not
                # a ``TerminalUploadError``. We still fire ``_on_failure``
                # so the GUI's Recent-uploads feed reflects the hiccup,
                # but because it isn't terminal ``ImportController`` skips
                # counting it: the jobs below get re-enqueued and will
                # report a real outcome (success or a terminal error) on
                # the retry. Counting here would double-count the file and
                # spam the import card with retry noise.
                retry_jobs = [
                    job for job in batch if self.is_pending(job.file_path)
                ]
                for job in retry_jobs:
                    try:
                        self._on_failure(job.file_path, exc)
                    except Exception:  # noqa: BLE001
                        log.exception(
                            "upload_retry_callback_failed %s",
                            job.file_path.name,
                        )
                # Park briefly, then retain only still-nonterminal jobs
                # in the unbounded retry lane. Filtered/malformed jobs may
                # already have reached a terminal outcome inside
                # ``_upload_batch`` before a remaining valid POST failed;
                # checking their reservation prevents resurrecting them.
                if retry_jobs:
                    time.sleep(2.0)
                    for job in retry_jobs:
                        self._retry_q.put_nowait(self._queue_item(job))
            finally:
                # ``task_done`` once per ``get`` regardless of outcome.
                # Required for ``Queue.join()`` semantics; tests rely
                # on it via the implicit accounting.
                for _ in batch:
                    source_q.task_done()

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
                        self._pending_paths.discard(str(job.file_path))
                self._notify_pending()
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
        by_id: Dict[str, List[UploadJob]] = {}
        invalid_jobs: List[UploadJob] = []
        missing_game_ids = 0
        for job in batch:
            payload = self._payload_for_job(job)
            gid = payload.get("gameId")
            if isinstance(gid, str) and gid:
                aliases = by_id.setdefault(gid, [])
                if not aliases:
                    payloads.append(payload)
                aliases.append(job)
            else:
                missing_game_ids += 1
                invalid_jobs.append(job)
        if missing_game_ids:
            log.warning(
                "upload_batch_missing_gameids count=%d expected=%d",
                missing_game_ids, len(batch),
            )
            err = _ServerRejectedError("missing gameId in upload payload")
            with self._lock:
                for job in invalid_jobs:
                    path_str = str(job.file_path)
                    self._state.uploaded[path_str] = "rejected"
                save_state(self._cfg.state_dir, self._state)
                for job in invalid_jobs:
                    self._pending_paths.discard(str(job.file_path))
            self._notify_pending()
            for job in invalid_jobs:
                try:
                    self._on_failure(job.file_path, err)
                except Exception:  # noqa: BLE001
                    log.exception(
                        "upload_failure_callback_failed %s",
                        job.file_path.name,
                    )
            if not payloads:
                return
        log.info(
            "uploading_batch size=%d unique_games=%d",
            len(batch), len(payloads),
        )
        # Single-item batches still go through the batch endpoint —
        # the server's per-game response envelope is identical for
        # 1-game and N-game batches, so this keeps the worker code
        # path uniform. Tests that pin to ``upload_concurrency=1``
        # and ``upload_batch_size=1`` to assert single-game behaviour
        # see one ``upload_games_batch`` call with a 1-element list.
        ingest_priority = 0 if any(job.priority for job in batch) else 1
        with self._network_gate.hold(ingest_priority):
            if self.is_paused():
                raise _PausedBeforeNetwork()
            result = self._api.upload_games_batch(payloads)
        accepted = result.get("accepted") or []
        rejected = result.get("rejected") or []

        # Parsed stats and the exact replay file form one durable operation:
        # accepted originals enter the fsync'd archive journal before the
        # parsed-game cursor advances. Actual object storage is handled by a
        # single restart-safe background worker so it cannot serialize every
        # history ingest request behind a large file PUT.
        archive_tasks: list[ReplayArchiveTask] = []
        for acc in accepted:
            gid = acc.get("gameId") if isinstance(acc, dict) else None
            jobs = by_id.get(gid) if isinstance(gid, str) else None
            if jobs and isinstance(gid, str):
                archive = acc.get("replayArchive")
                already_available = replay_file_matches_archive_marker(
                    jobs[0].file_path,
                    archive,
                )
                if already_available:
                    # Current APIs attach this ownership-scoped marker after
                    # ingest. Skip prepare only after the local size + SHA-256
                    # match its verified object identity; malformed/stale
                    # metadata safely falls through to the archive flow.
                    log.info(
                        "replay_archive_already_available %s gameId=%s",
                        jobs[0].file_path.name,
                        gid,
                    )
                    archived_task = ReplayArchiveTask(jobs[0].file_path, gid)
                    if self._archive_journal.contains(archived_task):
                        self._archive_journal.acknowledge_many(
                            [archived_task],
                            durable=True,
                        )
                        with self._archive_lock:
                            self._archive_scheduled.discard(
                                archived_task.key,
                            )
                else:
                    archive_tasks.append(
                        ReplayArchiveTask(jobs[0].file_path, gid),
                    )
        if archive_tasks:
            # If this raises (disk full, permission failure, corrupt journal),
            # the upload batch stays reserved and retries. The server upsert
            # is idempotent, so accepted analysis can never outrun its durable
            # private-backup obligation.
            self._archive_journal.enqueue_many(archive_tasks)

        accepted_jobs: List[UploadJob] = []
        rejected_jobs: List[Tuple[UploadJob, str]] = []
        retryable_jobs: List[Tuple[UploadJob, str]] = []
        terminal_paths: set[str] = set()
        with self._lock:
            now_iso = datetime.now(timezone.utc).isoformat()
            for acc in accepted:
                gid = acc.get("gameId") if isinstance(acc, dict) else None
                jobs = by_id.get(gid) if isinstance(gid, str) else None
                if not jobs:
                    log.warning("upload_unmapped_accepted gameId=%r", gid)
                    continue
                for job in jobs:
                    path_str = str(job.file_path)
                    if path_str in terminal_paths:
                        continue
                    terminal_paths.add(path_str)
                    self._state.uploaded[path_str] = now_iso
                    if isinstance(gid, str) and gid:
                        self._state.path_by_game_id[gid] = path_str
                    accepted_jobs.append(job)
                # Reverse-index by gameId so the Socket.io recompute
                # path can locate this replay's file in O(1) — same
                # invariant maintained by the pre-batching path.
            for rej in rejected:
                gid = rej.get("gameId") if isinstance(rej, dict) else None
                jobs = by_id.get(gid) if isinstance(gid, str) else None
                if not jobs:
                    log.warning("upload_unmapped_rejected gameId=%r", gid)
                    continue
                errs = rej.get("errors") if isinstance(rej, dict) else None
                err_msg = "; ".join(str(e) for e in (errs or [])) or "unknown"
                retryable = (
                    isinstance(rej, dict)
                    and rej.get("retryable") is True
                )
                for job in jobs:
                    path_str = str(job.file_path)
                    if path_str in terminal_paths:
                        continue
                    if retryable:
                        retryable_jobs.append((job, err_msg))
                        continue
                    terminal_paths.add(path_str)
                    self._state.uploaded[path_str] = "rejected"
                    rejected_jobs.append((job, err_msg))
            if accepted_jobs or rejected_jobs:
                save_state(self._cfg.state_dir, self._state)
                self._pending_paths.difference_update(terminal_paths)

        for task in archive_tasks:
            self._schedule_archive_task(task)
        if archive_tasks:
            self._notify_archive_pending()

        # User-facing callbacks + the sticky-MMR push happen OUTSIDE
        # the lock — they may take a network round-trip and we don't
        # want to hold the state lock that long.
        for job in accepted_jobs:
            try:
                self._on_success(job.file_path)
            except Exception:  # noqa: BLE001
                log.exception(
                    "upload_success_callback_failed %s",
                    job.file_path.name,
                )
        for job, err_msg in rejected_jobs:
            log.error("upload_rejected %s: %s", job.file_path.name, err_msg)
            try:
                self._on_failure(job.file_path, _ServerRejectedError(err_msg))
            except Exception:  # noqa: BLE001
                log.exception(
                    "upload_failure_callback_failed %s",
                    job.file_path.name,
                )
        if accepted_jobs or rejected_jobs:
            # Success sinks historically decrement their own pending
            # counter. Publish the authoritative reservation count after
            # those callbacks so GUI/tray/console cannot double-decrement.
            self._notify_pending()
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
        for gid, jobs in by_id.items():
            if gid in seen:
                continue
            for job in jobs:
                log.warning(
                    "upload_unaccounted_game gameId=%s; re-enqueueing %s",
                    gid, job.file_path.name,
                )
                self._retry_q.put_nowait(self._queue_item(job))

        if retryable_jobs:
            summary = "; ".join(
                f"{job.file_path.name}: {message}"
                for job, message in retryable_jobs[:3]
            )
            raise _RetryablePerGameError(summary)

    def _payload_for_job(self, job: UploadJob) -> Dict[str, Any]:
        """Build one payload and attach legacy IDs for resumed artifacts.

        Full Re-sync intentionally clears ``state.uploaded`` but preserves
        ``path_by_game_id``. Agents predating resume detection may therefore
        have one or more cloud gameIds pointing at this exact local file. Send
        those aliases with the marker so the API can quarantine legacy rows
        even if parser-version changes caused the newly derived ID to drift.
        """
        payload = job.game.to_payload()
        if payload.get("isResumedFromReplay") is not True:
            return payload

        game_id = payload.get("gameId")
        current = game_id.strip() if isinstance(game_id, str) else ""
        target_path = _path_identity(job.file_path)
        with self._lock:
            reverse_index = list(
                (getattr(self._state, "path_by_game_id", {}) or {}).items()
            )

        raw_aliases = payload.get("resumedReplayGameIds")
        candidates = (
            list(raw_aliases)
            if isinstance(raw_aliases, (list, tuple, set))
            else []
        )
        candidates.extend(
            gid
            for gid, replay_path in reverse_index
            if _path_identity(replay_path) == target_path
        )
        seen = {current} if current else set()
        aliases: List[str] = []
        for candidate in candidates:
            if not isinstance(candidate, str):
                continue
            alias = candidate.strip()
            if not alias or len(alias) > 200 or alias in seen:
                continue
            seen.add(alias)
            aliases.append(alias)
            if len(aliases) >= 50:
                break
        if aliases:
            payload["resumedReplayGameIds"] = aliases
        else:
            payload.pop("resumedReplayGameIds", None)
        return payload

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
            # Resume-from-replay outcomes are synthetic branch results. A
            # quarantine marker may carry legacy fields when it was built by
            # an older caller, but it must never update the user's sticky MMR.
            if getattr(job.game, "is_resumed_from_replay", False) is True:
                continue
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
                self._pending_paths.discard(path_str)
            self._notify_pending()
            self._on_failure(
                job.file_path,
                _FilteredOutError(f"Outside sync window {label}"),
            )
            return
        log.info("uploading %s", job.file_path.name)
        with self._network_gate.hold(0 if job.priority else 1):
            if self.is_paused():
                raise _PausedBeforeNetwork()
            result = self._api.upload_game(self._payload_for_job(job))
        accepted_rows = result.get("accepted") or []
        accepted_row = accepted_rows[0] if accepted_rows else {}
        accepted = bool(
            accepted_row.get("gameId")
            if isinstance(accepted_row, dict)
            else None
        )
        if not accepted:
            self._release_pending((job,))
            raise _ServerRejectedError(f"server_rejected: {result!r}")
        game_id = getattr(job.game, "game_id", None)
        if isinstance(game_id, str) and game_id:
            task = ReplayArchiveTask(job.file_path, game_id)
            marker = (
                accepted_row.get("replayArchive")
                if isinstance(accepted_row, dict)
                else None
            )
            if replay_file_matches_archive_marker(job.file_path, marker):
                if self._archive_journal.contains(task):
                    self._archive_journal.acknowledge_many(
                        [task],
                        durable=True,
                    )
                task = None
            else:
                self._archive_journal.enqueue_many([task])
        else:
            task = None
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
            self._pending_paths.discard(path_str)
        if task is not None:
            self._schedule_archive_task(task)
            self._notify_archive_pending()
        try:
            self._on_success(job.file_path)
        finally:
            # See the batched path above: success sinks decrement first,
            # then this authoritative count corrects any local estimate.
            self._notify_pending()
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
        # Keep the legacy single-upload path safe as well as batch uploads.
        # Resumed sessions are synthetic and cannot establish ladder rating.
        if getattr(job.game, "is_resumed_from_replay", False) is True:
            return
        my_mmr = getattr(job.game, "my_mmr", None)
        if not isinstance(my_mmr, int) or not (500 <= my_mmr <= 9999):
            return
        game_date = getattr(job.game, "date_iso", None)
        if not isinstance(game_date, str) or not game_date:
            return
        with self._mmr_push_lock:
            with self._lock:
                stored_date = self._state.last_known_mmr_date_iso
                if stored_date and stored_date >= game_date:
                    # Older replay than what we already pushed; skip the
                    # round-trip and the state churn. ISO-8601 strings sort
                    # lexicographically iff they share the same shape (UTC
                    # 'Z' suffix), which ``_to_iso`` in replay_pipeline.py
                    # guarantees on every CloudGame.
                    return
            region = _region_from_toon_handle(
                getattr(job.game, "my_toon_handle", None)
            )
            try:
                with self._network_gate.hold(0 if job.priority else 1):
                    self._api.patch_last_mmr(
                        mmr=my_mmr,
                        captured_at=game_date,
                        region=region,
                        game_id=getattr(job.game, "game_id", None),
                    )
            except Exception as exc:  # noqa: BLE001
                log.debug(
                    "last_mmr_push_failed file=%s: %s",
                    job.file_path.name,
                    exc,
                )
                return
            with self._lock:
                self._state.last_known_mmr = my_mmr
                self._state.last_known_mmr_date_iso = game_date
                if region:
                    self._state.last_known_mmr_region = region
                try:
                    save_state(self._cfg.state_dir, self._state)
                except Exception:  # noqa: BLE001
                    # Memory still carries the monotonic cursor, so an
                    # older worker cannot roll the cloud value backward
                    # during this run. The next successful save persists it.
                    log.exception(
                        "last_mmr_state_save_failed game_date=%s",
                        game_date,
                    )
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

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
from typing import Callable, Optional

from ..api_client import ApiClient
from ..config import AgentConfig
from ..replay_pipeline import CloudGame
from ..state import AgentState, save_state

log = logging.getLogger(__name__)


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
        self._thread: Optional[threading.Thread] = None
        self._on_success = on_success or (lambda _p: None)
        self._on_failure = on_failure or (lambda _p, _e: None)
        self._lock = threading.Lock()
        self._paused = bool(getattr(state, "paused", False))
        self._resync_requested = threading.Event()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="sc2tools-upload", daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def submit(self, job: UploadJob) -> bool:
        """Enqueue a job. Returns False if already uploaded or queue full."""
        if str(job.file_path) in self._state.uploaded:
            log.debug("dedupe_skip %s", job.file_path.name)
            return False
        try:
            self._q.put_nowait(job)
            return True
        except queue.Full:
            log.warning("upload_queue_full; dropping %s", job.file_path.name)
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

    # ---------------- internals ----------------
    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                job = self._q.get(timeout=1.0)
            except queue.Empty:
                continue
            if self.is_paused():
                # Re-enqueue and sleep; never lose work because we paused.
                try:
                    self._q.put_nowait(job)
                except queue.Full:
                    log.error("upload_queue_full_during_pause; dropping")
                self._q.task_done()
                time.sleep(1.0)
                continue
            try:
                self._upload_one(job)
            except Exception as exc:  # noqa: BLE001
                log.warning("upload_failed %s: %s", job.file_path.name, exc)
                self._on_failure(job.file_path, exc)
                # Park briefly then retry the same job.
                time.sleep(2.0)
                try:
                    self._q.put_nowait(job)
                except queue.Full:
                    log.error("upload_queue_full_after_retry; dropping")
            finally:
                self._q.task_done()

    def _upload_one(self, job: UploadJob) -> None:
        log.info("uploading %s", job.file_path.name)
        result = self._api.upload_game(job.game.to_payload())
        accepted = bool((result.get("accepted") or [{}])[0].get("gameId"))
        if not accepted:
            raise RuntimeError(f"server_rejected: {result!r}")
        with self._lock:
            self._state.uploaded[str(job.file_path)] = (
                datetime.now(timezone.utc).isoformat()
            )
            save_state(self._cfg.state_dir, self._state)
        self._on_success(job.file_path)

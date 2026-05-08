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
            except _ServerRejectedError as exc:
                # Permanent rejection — schema/validator failure. Do
                # NOT retry: the same payload would fail the same way
                # forever and starve the queue (which is what filled
                # the bounded queue and caused
                # ``upload_queue_full_after_retry; dropping`` cascades
                # before this branch existed).
                log.error(
                    "upload_rejected %s: %s",
                    job.file_path.name, exc,
                )
                self._on_failure(job.file_path, exc)
                path_str = str(job.file_path)
                with self._lock:
                    self._state.uploaded[path_str] = "rejected"
                    save_state(self._cfg.state_dir, self._state)
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

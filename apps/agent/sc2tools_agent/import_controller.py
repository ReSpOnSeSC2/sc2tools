"""Import-job visibility layer.

The cloud has had a complete bulk-import API (`/v1/import/*`,
``import_jobs`` collection, ``import:progress`` socket fan-out) since
the SaaS cutover — but the agent never listened, so web-triggered
imports created jobs that sat "running" forever, and the agent's own
first-run history backfill (the startup sweep parsing every replay on
disk) happened invisibly.

This module closes the loop WITHOUT building a second parse pipeline.
The watcher + upload queue already do the work; the controller just
counts it and reports it:

  * counters are fed by three hooks the runner chains in —
    ``UploadQueue.on_success`` / ``on_failure`` and the watcher's new
    ``on_replay_skipped`` — so the numbers reflect exactly what the
    real pipeline did;
  * a throttled reporter thread POSTs ``/v1/import/progress`` after
    counters move or the job changes state; the cloud re-emits each
    report to the user's sockets as ``import:progress`` for the live
    card;
  * ``maybe_start_auto_backfill()`` (called once after the watcher
    starts) registers the organic startup sweep as a visible job via
    ``POST /v1/import/agent-start`` when enough un-uploaded replays
    are on disk to be worth a progress card.

Skip-reason semantics: ``ai_game`` and ``resumed_replay`` count as
*completed*: the file was processed and intentionally not uploaded, not a
failure. Both still appear in ``errorBreakdown`` so the UI can explain the
intentional skips.
Other reasons (``parse_failed``, ``player_unresolved``,
``no_result``, upload rejections) count as errors and contribute a
capped ``errorSamples`` entry with the filename so the user can act.
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .uploader.queue import TerminalUploadError

log = logging.getLogger(__name__)

# Reasons that are "the pipeline worked as intended", not failures.
_BENIGN_REASONS = {"ai_game", "resumed_replay"}

# Minimum un-uploaded replay count for the startup sweep to register
# itself as a visible job. Below this the sweep finishes in seconds
# and a progress card would just flash.
AUTO_BACKFILL_MIN = 25

_REPORT_INTERVAL_SEC = 2.0
_MAX_SAMPLES = 25
_INVENTORY_RETRY_SEC = 60.0

# Stall guard. ``total`` is a point-in-time estimate from
# ``count_pending()``; files that settle_fail, get dropped by queue
# backpressure, or sit behind a wedged upload worker never invoke a
# counted callback, so ``processed >= total`` may NEVER become true.
# Pre-guard, the reporter heartbeated ``import:progress`` every 10 s
# forever — the web app refreshed continuously even with nothing left
# to sync (observed 2026-06-10/11: job total=12661 outlived the
# session). After this long with zero counter movement we re-check
# the disk; if nothing is actually pending the job is done, and if
# something is pending but nothing has moved the pipeline is wedged.
# A non-empty inventory is reported as ``stalled`` rather than ``done``.
# The reporter then stays attached but silent: no repeated API writes,
# while a later callback can immediately restore the job to ``running``.
# Background sync itself is unaffected.
_STALL_TIMEOUT_SEC = 600.0


class ImportController:
    """Tracks one active import job and reports its progress."""

    def __init__(
        self,
        *,
        api: Any,
        watcher: Any,
        full_resync: Optional[Callable[[], None]] = None,
        list_folders: Optional[Callable[[], List[str]]] = None,
    ) -> None:
        self._api = api
        self._watcher = watcher
        self._full_resync = full_resync
        self._list_folders = list_folders or (lambda: [])
        self._lock = threading.Lock()
        self._job_id: Optional[str] = None
        self._total = 0
        self._completed = 0
        self._errors = 0
        self._breakdown: Dict[str, int] = {}
        self._samples: List[Dict[str, str]] = []
        self._dirty = False
        self._cancelled = False
        self._resume_from_stalled = False
        self._reporter: Optional[threading.Thread] = None
        self._stop = threading.Event()

    # ---------------- pipeline hooks ----------------
    # Chained by the runner into the existing UploadQueue / watcher
    # callbacks. No-ops while no job is active so steady-state play
    # (one replay per game) costs one lock acquire per upload.

    def on_upload_success(self, path: Path) -> None:  # noqa: ARG002
        with self._lock:
            if self._job_id is None:
                return
            self._completed += 1
            self._dirty = True

    def on_upload_failure(self, path: Path, exc: Exception) -> None:
        # Only FINAL outcomes are accounted here. The queue fires this
        # hook for a transient whole-batch failure (read timeout, 5xx,
        # connection reset) too, but it re-enqueues those jobs — so the
        # same file comes back through ``on_upload_success`` (or a real
        # terminal error) later. Counting the transient hit would fill the
        # card with "N files couldn't be imported" retry noise AND
        # double-count the file once its retry lands. Terminal outcomes
        # subclass ``TerminalUploadError``; everything else is transient
        # and must not touch the tally.
        if not isinstance(exc, TerminalUploadError):
            return
        code = getattr(exc, "import_error_code", "rejected_by_server")
        is_error = getattr(exc, "counts_as_error", True)
        with self._lock:
            if self._job_id is None:
                return
            if is_error:
                self._errors += 1
                self._bump(code, path, str(exc))
            else:
                # Benign terminal outcome (e.g. a file outside the user's
                # sync window): the pipeline did exactly what the filter
                # asked, so it's a completion, not a failure. Its own
                # breakdown bucket keeps it out of the error tally — same
                # treatment as a vs-AI skip in ``on_replay_skipped``.
                self._completed += 1
                self._breakdown[code] = self._breakdown.get(code, 0) + 1
            self._dirty = True

    def on_replay_skipped(self, path: Path, reason: Optional[str]) -> None:
        code = reason or "parse_failed"
        with self._lock:
            if self._job_id is None:
                return
            if code in _BENIGN_REASONS:
                self._completed += 1
                self._breakdown[code] = self._breakdown.get(code, 0) + 1
            else:
                self._errors += 1
                self._bump(code, path, None)
            self._dirty = True

    # ---------------- socket event handlers ----------------

    def handle_scan_request(self, payload: Dict[str, Any]) -> None:
        """``import:scan_request`` — count candidates, report, done."""
        job_id = _job_id_of(payload)
        if not job_id:
            return
        total = self._try_count_pending()
        if total is None:
            self._post_progress({
                "jobId": job_id,
                "total": 0,
                "phase": "scan",
                "message": "inventory_unavailable",
                "stalled": True,
            })
            return
        log.info("import_scan jobId=%s candidates=%d", job_id, total)
        self._post_progress({
            "jobId": job_id,
            "total": total,
            "phase": "scan",
            "message": f"{total} replays eligible for import",
            "done": True,
        })

    def handle_start_request(self, payload: Dict[str, Any]) -> None:
        """``import:start_request`` — adopt the cloud-minted job.

        ``force`` re-imports everything: we run the same full-resync
        flow the tray's Re-sync button uses (clears the uploaded
        cursor, rediscovers roots). Without force, the job covers
        whatever the cursor says is still un-uploaded.
        """
        job_id = _job_id_of(payload)
        if not job_id:
            return
        force = bool(payload.get("force"))
        if force and self._full_resync is not None:
            try:
                self._full_resync()
            except Exception:  # noqa: BLE001
                log.exception("import_start_force_resync_failed")
        total = self._try_count_pending()
        if total is None:
            log.warning(
                "import_start_inventory_unavailable jobId=%s force=%s",
                job_id, force,
            )
            # Zero here means "unknown", never "nothing to import".
            # Keep the job unfinished while the reporter retries discovery.
            self._activate(job_id, 0, resume_from_stalled=True)
            self._post_progress({
                "jobId": job_id,
                "total": 0,
                "phase": "import",
                "message": "inventory_unavailable",
                "stalled": True,
            })
            try:
                self._watcher.request_immediate_sweep()
            except Exception:  # noqa: BLE001
                log.exception("import_start_sweep_failed")
            return
        log.info(
            "import_start jobId=%s total=%d force=%s", job_id, total, force,
        )
        self._activate(job_id, total)
        if total == 0:
            self._post_progress({
                "jobId": job_id,
                "total": 0,
                "phase": "import",
                "message": "nothing_to_import",
                "done": True,
            })
            self._deactivate()
            return
        self._post_progress({
            "jobId": job_id,
            "total": total,
            "phase": "import",
        })
        try:
            self._watcher.request_immediate_sweep()
        except Exception:  # noqa: BLE001
            log.exception("import_start_sweep_failed")

    def handle_cancel_request(self, payload: Dict[str, Any]) -> None:
        """``import:cancel_request`` — stop tracking the job.

        The server already marked the job cancelled. We stop reporting;
        the watcher's organic sweep keeps syncing at its own pace (it
        always has — cancel stops the *job card*, not background sync).
        """
        job_id = _job_id_of(payload)
        log.info("import_cancel jobId=%s", job_id or "unknown")
        with self._lock:
            self._cancelled = True
        self._deactivate()

    def handle_pick_folder_request(self, payload: Dict[str, Any]) -> None:  # noqa: ARG002
        """``import:pick_folder_request`` — report the watched folders.

        The headless agent can't open a native folder dialog; what the
        web actually needs is "which folders is the agent watching",
        which we already know. Reported via /v1/import/host-info.
        """
        folders = []
        try:
            folders = list(self._list_folders())[:16]
        except Exception:  # noqa: BLE001
            log.exception("import_pick_folder_list_failed")
        try:
            self._api.import_host_info({"replayFolders": folders})
        except Exception:  # noqa: BLE001
            log.exception("import_host_info_failed")

    # ---------------- auto backfill ----------------

    def maybe_start_auto_backfill(self) -> None:
        """Register the startup sweep as a visible job when it's big.

        Called once by the runner right after ``watcher.start()``. The
        sweep itself runs regardless — this only decides whether the
        user gets a live progress card for it.
        """
        with self._lock:
            if self._job_id is not None:
                return
        total = self._safe_count_pending()
        if total < AUTO_BACKFILL_MIN:
            log.info(
                "auto_backfill_not_registered candidates=%d threshold=%d",
                total,
                AUTO_BACKFILL_MIN,
            )
            return
        try:
            out = self._api.import_agent_start({"total": total})
        except Exception as exc:  # noqa: BLE001
            # Older API without the route (404) or offline — the sweep
            # still runs, just without the card.
            log.info("auto_backfill_register_failed: %s", exc)
            return
        job_id = out.get("jobId") if isinstance(out, dict) else None
        if not job_id:
            log.info("auto_backfill_register_no_job_id resp=%r", out)
            return
        # Adopting a job that survived an agent restart (auto-update
        # mid-backfill): seed our counters from the job's prior
        # progress so our absolute reports continue the count instead
        # of re-reporting from zero — which dragged the web card's
        # numbers backwards, then forwards again as we caught up. The
        # server also $max-guards the counters, but seeding keeps the
        # reported numbers (and the card's ETA) continuous. ``total``
        # becomes prior processed + what's still on disk.
        completed = errors = 0
        if out.get("existing"):
            completed = _as_count(out.get("completed"))
            errors = _as_count(out.get("errors"))
            total = completed + errors + total
        log.info(
            "auto_backfill_registered jobId=%s total=%d seeded_completed=%d "
            "seeded_errors=%d existing=%s",
            job_id, total, completed, errors, bool(out.get("existing")),
        )
        self._activate(
            str(job_id),
            total,
            completed=completed,
            errors=errors,
            resume_from_stalled=(out.get("status") == "stalled"),
        )

    # ---------------- internals ----------------

    def _bump(self, code: str, path: Path, message: Optional[str]) -> None:
        """Record a non-benign failure (caller holds the lock)."""
        self._breakdown[code] = self._breakdown.get(code, 0) + 1
        if len(self._samples) < _MAX_SAMPLES:
            sample: Dict[str, str] = {
                "file": path.name,
                "errorCode": code,
            }
            if message:
                sample["message"] = message[:300]
            self._samples.append(sample)

    def _activate(
        self,
        job_id: str,
        total: int,
        *,
        completed: int = 0,
        errors: int = 0,
        resume_from_stalled: bool = False,
    ) -> None:
        with self._lock:
            self._job_id = job_id
            self._total = total
            self._completed = completed
            self._errors = errors
            self._breakdown = {}
            self._samples = []
            self._dirty = False
            self._cancelled = False
            self._resume_from_stalled = resume_from_stalled
        self._stop.clear()
        if self._reporter is None or not self._reporter.is_alive():
            self._reporter = threading.Thread(
                target=self._report_loop,
                name="sc2tools-import-reporter",
                daemon=True,
            )
            self._reporter.start()

    def _deactivate(self) -> None:
        with self._lock:
            self._job_id = None
            self._resume_from_stalled = False
        self._stop.set()

    def stop(self) -> None:
        self._deactivate()
        thr = self._reporter
        if thr is not None:
            thr.join(timeout=3.0)

    def _report_loop(self) -> None:
        last_processed = -1
        last_movement = time.monotonic()
        last_inventory_check = last_movement
        stalled = False
        stalled_remaining: Optional[int] = None
        tracked_job_id: Optional[str] = None
        completion_recount_after = 0.0
        while not self._stop.wait(_REPORT_INTERVAL_SEC):
            with self._lock:
                job_id = self._job_id
                if job_id is None:
                    break
                processed = self._completed + self._errors
                done = self._total > 0 and processed >= self._total
                dirty = self._dirty
                resume_from_stalled = self._resume_from_stalled
                body = self._snapshot_body(job_id, done)
                if dirty or done:
                    self._dirty = False
            now = time.monotonic()
            new_job = job_id != tracked_job_id
            if new_job:
                # A new cloud job can replace a silently-attached stalled
                # tracker without starting a second reporter thread. Reset
                # every per-job clock/state value before interpreting its
                # counters. Seed ``last_processed`` from the first snapshot:
                # adopting an existing stalled job is observation, not real
                # movement, and must not clear the warning by itself.
                tracked_job_id = job_id
                last_processed = processed
                last_movement = now
                last_inventory_check = now
                completion_recount_after = 0.0
                stalled = resume_from_stalled
                stalled_remaining = None
            if resume_from_stalled and self._total == 0:
                # Initial inventory discovery failed. Retry at a bounded
                # cadence and finish only after a successful zero recount.
                if (now - last_inventory_check) >= _INVENTORY_RETRY_SEC:
                    remaining = self._try_count_pending()
                    last_inventory_check = now
                    if remaining is not None:
                        if remaining == 0:
                            body = self._snapshot_body(job_id, True)
                            body["remaining"] = 0
                            body["message"] = "nothing_to_import"
                            done = True
                            dirty = True
                        else:
                            with self._lock:
                                if self._job_id != job_id:
                                    continue
                                self._total = remaining
                                self._resume_from_stalled = False
                                body = self._snapshot_body(job_id, False)
                            body["stalled"] = False
                            body["message"] = "import_inventory_recovered"
                            stalled = False
                            stalled_remaining = None
                            last_movement = now
                            dirty = True
            if done and now < completion_recount_after:
                done = False
                body.pop("done", None)
                body.pop("remaining", None)
            elif done:
                # ``total`` is only the inventory observed when tracking
                # began. A live game can arrive during a multi-day resync
                # and reach its terminal callback before older history;
                # processed == original total is therefore not proof that
                # the original backlog is empty. Recount only at this
                # apparent finish line (not on every progress tick).
                remaining = self._try_count_pending()
                last_inventory_check = now
                if remaining is None:
                    completion_recount_after = now + _INVENTORY_RETRY_SEC
                    done = False
                    body.pop("done", None)
                    body.pop("remaining", None)
                    log.warning(
                        "import_completion_inventory_unavailable "
                        "jobId=%s processed=%d total=%d",
                        job_id, processed, self._total,
                    )
                elif remaining > 0:
                    completion_recount_after = 0.0
                    with self._lock:
                        if self._job_id != job_id:
                            continue
                        processed = self._completed + self._errors
                        self._total = max(
                            self._total,
                            processed + remaining,
                        )
                        body = self._snapshot_body(job_id, False)
                        self._dirty = False
                    done = False
                    dirty = True
                    log.info(
                        "import_total_reconciled jobId=%s processed=%d "
                        "remaining_on_disk=%d total=%d",
                        job_id, processed, remaining, self._total,
                    )
                else:
                    completion_recount_after = 0.0
                    # Refresh after the inventory walk so callbacks that
                    # landed during it are included in the final payload.
                    with self._lock:
                        if self._job_id != job_id:
                            continue
                        processed = self._completed + self._errors
                        body = self._snapshot_body(job_id, True)
                    body["remaining"] = 0
            if not new_job and processed != last_processed:
                last_processed = processed
                last_movement = now
                if stalled:
                    # The watcher recovered after a stalled inventory
                    # report. Explicitly restore this same job to running;
                    # an ordinary stale report must never resurrect a
                    # cancelled job.
                    stalled = False
                    stalled_remaining = None
                    body["stalled"] = False
                    body["message"] = "import_progress_resumed"
                    dirty = True
            elif (
                not done
                and (now - last_movement) >= _STALL_TIMEOUT_SEC
                and (
                    not stalled
                    or (now - last_inventory_check) >= _STALL_TIMEOUT_SEC
                )
            ):
                # No counter movement for the full stall window. Check
                # what's actually left on disk. A failed inventory read
                # is UNKNOWN, never zero: it must not manufacture a
                # successful completion.
                remaining = self._try_count_pending()
                last_inventory_check = now
                if remaining is None:
                    log.warning(
                        "import_job_inventory_unavailable jobId=%s "
                        "processed=%d total=%d",
                        job_id, processed, self._total,
                    )
                    # Avoid rescanning every reporter tick. Retain the
                    # truthful current state and retry after one stall
                    # window, or sooner if a callback moves the count.
                    last_movement = now
                    continue
                log.warning(
                    "import_job_stalled jobId=%s processed=%d total=%d "
                    "remaining_on_disk=%d stall_sec=%.0f "
                    "(background sync continues)",
                    job_id, processed, self._total, remaining,
                    now - last_movement,
                )
                body["remaining"] = remaining
                if remaining == 0:
                    done = True
                    body["done"] = True
                    body["message"] = "import_complete"
                elif not stalled or remaining != stalled_remaining:
                    stalled = True
                    stalled_remaining = remaining
                    body["stalled"] = True
                    body["message"] = "import_stalled_background_continues"
                    dirty = True
            # No unchanged heartbeat: movement and state transitions are
            # enough for the socket card, while REST polling remains the
            # fallback. This avoids one database write and fan-out every
            # ten seconds for a backlog that may run for days.
            if dirty or done:
                self._post_progress(body)
            if done:
                log.info(
                    "import_job_done jobId=%s completed=%d errors=%d total=%d",
                    job_id,
                    body.get("completed", 0),
                    body.get("errors", 0),
                    body.get("total", 0),
                )
                self._deactivate()
                break

    def _snapshot_body(self, job_id: str, done: bool) -> Dict[str, Any]:
        """Build the progress payload (caller holds the lock)."""
        body: Dict[str, Any] = {
            "jobId": job_id,
            "total": self._total,
            "completed": self._completed,
            "errors": self._errors,
            "remaining": max(
                0, self._total - self._completed - self._errors,
            ),
            "phase": "import",
        }
        if self._breakdown:
            body["errorBreakdown"] = dict(self._breakdown)
        if self._samples:
            body["errorSamples"] = list(self._samples)
        if done:
            body["done"] = True
        return body

    def _post_progress(self, body: Dict[str, Any]) -> None:
        try:
            self._api.import_progress(body)
        except Exception as exc:  # noqa: BLE001
            # Reporting is best-effort: a flaky network must never
            # disturb the parse/upload pipeline it's narrating.
            log.debug("import_progress_post_failed: %s", exc)

    def _safe_count_pending(self) -> int:
        remaining = self._try_count_pending()
        return remaining if remaining is not None else 0

    def _try_count_pending(self) -> Optional[int]:
        """Return the pending inventory, or ``None`` when it is unknown.

        Inventory failures must never be interpreted as an empty disk and a
        successful job. Start, scan, and completion all use this strict form;
        the auto-backfill prompt alone may safely decline to mount on unknown.
        """
        try:
            return max(0, int(self._watcher.count_pending()))
        except Exception:  # noqa: BLE001
            log.exception("count_pending_failed")
            return None


def _as_count(value: Any) -> int:
    """Coerce a wire counter to a non-negative int (0 on junk)."""
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _job_id_of(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    raw = payload.get("jobId")
    if isinstance(raw, str) and raw:
        return raw
    return None

"""Crash-safe, append-only queue for original replay archival.

The ordinary agent state file is already several megabytes for a large replay
library. Rewriting that whole JSON document after every archived object turns
a 10k-file backfill into quadratic write amplification. This compact journal
records enqueue/ack transitions instead:

* enqueue records are flushed + fsync'd before parsed-game success is exposed;
* acknowledgements are appended only after object storage confirms the file,
  and may be checkpointed in small groups (a crash merely repeats an
  idempotent already-stored upload);
* compaction atomically rewrites only still-pending tasks.

The in-memory ready queue lives in ``UploadQueue`` and is bounded. This class
keeps the durable pending index so it can feed that queue incrementally.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional


ARCHIVE_JOURNAL_FILENAME = "replay-archive-queue.jsonl"
_ACK_CHECKPOINT_SIZE = 16
_ACK_CHECKPOINT_SEC = 5.0
_COMPACT_MIN_RECORDS = 2048
_COMPACT_MIN_BYTES = 4 * 1024 * 1024


def _normalized_path(value: Path | str) -> str:
    """Canonicalize a replay path for durable (path, gameId) identity."""
    path = Path(str(value))
    try:
        rendered = str(path.resolve(strict=False))
    except (OSError, RuntimeError):
        rendered = str(path.absolute())
    return os.path.normcase(os.path.normpath(rendered))


@dataclass(frozen=True)
class ReplayArchiveTask:
    file_path: Path
    game_id: str

    @property
    def key(self) -> tuple[str, str]:
        return (_normalized_path(self.file_path), self.game_id)


class ReplayArchiveJournalError(RuntimeError):
    """Journal could not be read safely; ingest must not advance cursors."""


class ReplayArchiveJournal:
    """Append-only durable task index with atomic periodic compaction."""

    def __init__(self, state_dir: Path) -> None:
        self._state_dir = Path(state_dir)
        self._state_dir.mkdir(parents=True, exist_ok=True)
        self.path = self._state_dir / ARCHIVE_JOURNAL_FILENAME
        self._lock = threading.RLock()
        # Key by both identities. A parser-version gameId drift for the same
        # local file must not replace an older accepted row that still needs
        # its own archive attachment.
        # The value is process-local retry metadata. Keeping it alongside the
        # already-required durable index avoids a second unbounded cooldown
        # map when thousands of cloud-backed replay paths are offline.
        self._pending: dict[tuple[str, str], tuple[float, int]] = {}
        self._buffered_acks: list[dict[str, str]] = []
        self._last_ack_flush = time.monotonic()
        self._record_count = 0
        self._unhealthy: Optional[ReplayArchiveJournalError] = None
        self._load()

    def pending_count(self) -> int:
        with self._lock:
            return len(self._pending)

    def current_game_id(self, file_path: Path | str) -> Optional[str]:
        """Compatibility lookup for callers that know one path maps once."""
        with self._lock:
            target = _normalized_path(file_path)
            return next(
                (gid for path_str, gid in self._pending if path_str == target),
                None,
            )

    def contains(self, task: ReplayArchiveTask) -> bool:
        with self._lock:
            return task.key in self._pending

    def defer(
        self,
        task: ReplayArchiveTask,
        *,
        not_before: float,
        attempt: int,
    ) -> None:
        """Defer one source locally without changing durable task state."""
        with self._lock:
            self._require_healthy_locked()
            if task.key in self._pending:
                self._pending[task.key] = (
                    max(0.0, float(not_before)),
                    max(0, int(attempt)),
                )

    def retry_attempt(self, task: ReplayArchiveTask) -> int:
        with self._lock:
            _not_before, attempt = self._pending.get(task.key, (0.0, 0))
            return attempt

    def next_tasks(
        self,
        *,
        excluded: set[tuple[str, str]],
        limit: int,
    ) -> list[ReplayArchiveTask]:
        """Return at most ``limit`` unscheduled tasks in journal order."""
        if limit <= 0:
            return []
        out: list[ReplayArchiveTask] = []
        with self._lock:
            self._require_healthy_locked()
            now = time.monotonic()
            for (path_str, game_id), (not_before, _attempt) in self._pending.items():
                if (path_str, game_id) in excluded:
                    continue
                if not_before > now:
                    continue
                out.append(ReplayArchiveTask(Path(path_str), game_id))
                if len(out) >= limit:
                    break
        return out

    def enqueue_many(
        self,
        tasks: Iterable[ReplayArchiveTask],
    ) -> int:
        """Durably add/replace tasks, using one fsync for the whole batch."""
        deduped: dict[tuple[str, str], ReplayArchiveTask] = {}
        for task in tasks:
            path_str = _normalized_path(task.file_path)
            game_id = str(task.game_id).strip()
            if path_str and game_id:
                clean = ReplayArchiveTask(Path(path_str), game_id)
                deduped[clean.key] = clean
        if not deduped:
            return 0
        with self._lock:
            self._require_healthy_locked()
            # Preserve record order if a prior acknowledgement and a new
            # enqueue target the same path/gameId in one long-running process.
            self._flush_acks_locked(force=True)
            changed = [
                task for key, task in deduped.items() if key not in self._pending
            ]
            if not changed:
                return 0
            records = [
                {
                    "op": "enqueue",
                    "path": str(task.file_path),
                    "gameId": task.game_id,
                }
                for task in changed
            ]
            # Persist before publishing into the in-memory index. If this
            # raises, the caller does not advance state.uploaded and retries
            # the accepted ingest; a valid append prefix is harmless.
            self._append_records_locked(records)
            for task in changed:
                self._pending[task.key] = (0.0, 0)
            try:
                self._maybe_compact_locked()
            except OSError:
                pass
            return len(changed)

    def acknowledge_many(
        self,
        tasks: Iterable[ReplayArchiveTask],
        *,
        durable: bool = False,
    ) -> int:
        """Remove tasks after a stored/already-stored or terminal outcome.

        Non-durable acknowledgement batching is intentionally at-least-once:
        an abrupt exit can replay up to 15 confirmed tasks, and the server's
        idempotent ``alreadyStored`` response completes them cheaply.
        """
        removed = 0
        with self._lock:
            self._require_healthy_locked()
            for task in tasks:
                path_str = _normalized_path(task.file_path)
                if task.key not in self._pending:
                    continue
                self._pending.pop(task.key, None)
                self._buffered_acks.append(
                    {
                        "op": "ack",
                        "path": path_str,
                        "gameId": task.game_id,
                    },
                )
                removed += 1
            if removed:
                self._flush_acks_locked(force=durable)
            return removed

    def flush(self) -> None:
        with self._lock:
            self._require_healthy_locked()
            self._flush_acks_locked(force=True)
            try:
                self._maybe_compact_locked()
            except OSError:
                # Compaction is an optimization. All transitions were already
                # fsync'd to the append-only journal.
                pass

    def _load(self) -> None:
        try:
            payload = self.path.read_bytes()
        except FileNotFoundError:
            return
        except OSError as exc:
            raise ReplayArchiveJournalError(
                f"replay_archive_journal_unreadable: {exc}",
            ) from exc

        lines = payload.splitlines(keepends=True)
        saw_torn_tail = False
        for index, line in enumerate(lines):
            terminated = line.endswith((b"\n", b"\r"))
            is_last = index == len(lines) - 1
            try:
                raw = line.decode("utf-8").strip()
                record = json.loads(raw) if raw else None
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                if is_last and not terminated:
                    saw_torn_tail = True
                    break
                raise ReplayArchiveJournalError(
                    f"replay_archive_journal_corrupt_record line={index + 1}",
                ) from exc
            if not isinstance(record, dict):
                if is_last and not terminated:
                    saw_torn_tail = True
                    break
                raise ReplayArchiveJournalError(
                    f"replay_archive_journal_invalid_record line={index + 1}",
                )
            op = record.get("op")
            path_str = record.get("path")
            game_id = record.get("gameId")
            if (
                op not in ("enqueue", "ack")
                or not isinstance(path_str, str)
                or not path_str
                or not isinstance(game_id, str)
                or not game_id
            ):
                if is_last and not terminated:
                    saw_torn_tail = True
                    break
                raise ReplayArchiveJournalError(
                    f"replay_archive_journal_invalid_record line={index + 1}",
                )
            self._record_count += 1
            path_str = _normalized_path(path_str)
            key = (path_str, game_id)
            if op == "enqueue":
                self._pending[key] = (0.0, 0)
            else:
                self._pending.pop(key, None)
            # A complete-looking JSON record can still be the tail of an
            # interrupted two-write append (JSON first, newline second).
            # Apply the valid transition, then rewrite a terminated snapshot
            # before any future append can concatenate another object to it.
            if is_last and not terminated:
                saw_torn_tail = True
        if saw_torn_tail:
            # A truncated final append must not poison all future records by
            # concatenating JSON onto an unterminated line. Repair immediately
            # to a compact snapshot of every valid task recovered above.
            self._compact_locked()

    def _flush_acks_locked(self, *, force: bool) -> None:
        if not self._buffered_acks:
            return
        due = (time.monotonic() - self._last_ack_flush) >= _ACK_CHECKPOINT_SEC
        if not force and len(self._buffered_acks) < _ACK_CHECKPOINT_SIZE and not due:
            return
        records = list(self._buffered_acks)
        try:
            self._append_records_locked(records)
        except Exception:
            # The ack was not durable. Restore every task to the live index so
            # this process retries it instead of waiting for a restart to
            # replay the still-present enqueue records.
            for record in records:
                self._pending[(record["path"], record["gameId"])] = (
                    0.0,
                    0,
                )
            self._buffered_acks.clear()
            raise
        self._buffered_acks.clear()
        self._last_ack_flush = time.monotonic()
        try:
            self._maybe_compact_locked()
        except OSError:
            pass

    def _append_records_locked(self, records: list[dict[str, str]]) -> None:
        if not records:
            return
        self._require_healthy_locked()
        try:
            with self.path.open("a", encoding="utf-8", newline="\n") as fh:
                for record in records:
                    fh.write(json.dumps(record, separators=(",", ":")))
                    fh.write("\n")
                fh.flush()
                os.fsync(fh.fileno())
        except OSError as exc:
            # The append may have reached any byte boundary, including after
            # a complete JSON object but before its newline/fsync. Continuing
            # to append in this process could concatenate records and corrupt
            # the queue. Fail closed until restart reloads/repairs the tail.
            unhealthy = ReplayArchiveJournalError(
                f"replay_archive_journal_write_failed: {exc}",
            )
            self._unhealthy = unhealthy
            raise unhealthy from exc
        self._record_count += len(records)

    def _require_healthy_locked(self) -> None:
        if self._unhealthy is not None:
            raise self._unhealthy

    def _maybe_compact_locked(self) -> None:
        try:
            size = self.path.stat().st_size
        except OSError:
            size = 0
        live = len(self._pending)
        excessive_churn = self._record_count >= max(
            _COMPACT_MIN_RECORDS,
            (live * 3) + 256,
        )
        if size < _COMPACT_MIN_BYTES and not excessive_churn:
            return
        self._compact_locked()

    def _compact_locked(self) -> None:
        fd, tmp_path = tempfile.mkstemp(
            prefix="replay-archive.",
            suffix=".tmp",
            dir=str(self._state_dir),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
                for path_str, game_id in self._pending:
                    fh.write(
                        json.dumps(
                            {
                                "op": "enqueue",
                                "path": path_str,
                                "gameId": game_id,
                            },
                            separators=(",", ":"),
                        ),
                    )
                    fh.write("\n")
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_path, self.path)
            self._record_count = len(self._pending)
            self._buffered_acks.clear()
            self._last_ack_flush = time.monotonic()
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

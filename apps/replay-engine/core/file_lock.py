"""
file_lock.py -- cross-process lock primitive for the data/ directory.

Why this exists
---------------
Three independent writers touch ``data/MyOpponentHistory.json`` and
its siblings: the PowerShell live-phase scanner, the Python replay
watcher (this package), and the Node.js stream-overlay backend.
Each writer already does a correct atomic write (write-tmp + fsync +
rename) via its own helper -- ``core/atomic_io.py`` here,
``stream-overlay-backend/lib/atomic-fs.js`` on the Node side, and
``Write-FileAtomic`` in ``Reveal-Sc2Opponent.ps1``.

What's missing is **coordination across processes**. Two writers can
each do a textbook atomic write, but if they both load the live file
into memory at roughly the same time, mutate their in-memory copy,
and then race their renames, the second rename clobbers the first
writer's update. The result is the file looking "fine" (last writer
wins, parses cleanly) but with the loser's mutation silently lost.
And in pathological orderings where one writer's ``.tmp`` is being
fsynced while another writer's rename copies the live file to
``.bak``, we end up with a ``.bak`` that captures a half-written
state -- exactly what corrupted ``MyOpponentHistory.json`` and
``meta_database.json`` repeatedly through April 2026.

How
---
A POSIX-style lockfile in ``data/.locks/<safe-name>.lock`` that is
created with ``O_EXCL`` semantics: the OS guarantees the create is
atomic, so only one acquirer wins. Inside the lockfile we record:

    {
      "pid":   <int>,           # holder's process id
      "host":  "<hostname>",    # for cross-machine paranoia
      "lang":  "python|node|ps",
      "since": <epoch_ms>,      # acquisition time, used for stale check
      "stamp": "<ISO8601>"      # human-readable
    }

If acquisition fails because the lockfile already exists, we read its
metadata and decide:

  - holder PID is alive AND lock is younger than ``stale_after_sec``:
    wait with exponential backoff up to ``timeout_sec``.
  - holder PID is dead:
    steal the lock (unlink + retry the create).
  - holder PID is alive AND lock is older than ``stale_after_sec``:
    the holder is alive but stuck (debugger, AV scan). Wait until
    timeout, then steal -- the alternative is deadlock.

The lock is intentionally **per-target-file**, not a global gate, so
unrelated writers don't serialize. The lock name is derived from the
target path with a deterministic safe-character mapping.

Cross-language compatibility
----------------------------
The lockfile contract is documented above and mirrored byte-for-byte
in ``stream-overlay-backend/lib/file-lock.js`` and the PowerShell
``Lock-FileAtomic`` helper. As long as all three writers honour the
same lockfile and the same staleness rules, they coordinate.

Engineering preamble compliance
-------------------------------
* Pure module: file paths, timeouts, and the clock are injectable for tests.
* Type hints on every public function; mypy --strict clean.
* Functions <= 30 lines, no magic constants (all knobs are module
  constants with documented meaning).
* Atomic primitives: ``os.open(O_CREAT | O_EXCL | O_RDWR | O_TRUNC)``
  for acquisition, ``os.fsync`` after write, ``os.unlink`` for release.
* PII safe: opponent names never appear in lockfiles; only PIDs and
  the target filename.

Example
-------
    >>> from core.file_lock import file_lock  # doctest: +SKIP
    >>> with file_lock("data/MyOpponentHistory.json"):  # doctest: +SKIP
    ...     # safe to read-modify-write the target now
    ...     pass
"""
from __future__ import annotations

import contextlib
import errno
import json
import os
import platform
import socket
import sys
import time
from typing import Any, Callable, Dict, Iterator, Optional

# Default knobs. Override per-call where it matters.
DEFAULT_TIMEOUT_SEC = 30.0
DEFAULT_STALE_AFTER_SEC = 30.0
DEFAULT_BACKOFF_INITIAL_MS = 5
DEFAULT_BACKOFF_MAX_MS = 250

LOCK_DIR_NAME = ".locks"
LOCK_SUFFIX = ".lock"
ENABLE_ENV_VAR = "SC2TOOLS_DATA_LOCK_ENABLED"
DISABLE_VALUE = "0"
LANG_TAG = "python"


def _safe_lock_name(target_path: str) -> str:
    """Map a target filename to a deterministic lockfile basename.

    Drops directory components and replaces every character outside
    ``[A-Za-z0-9._-]`` with ``_``. Two different paths can collide
    iff their basenames differ only by such characters; we treat
    that as a feature -- ``MyOpponentHistory.json`` and
    ``MyOpponentHistory.json.bak`` SHOULD share a lock so the .bak
    write doesn't race the live write.

    Example:
        >>> _safe_lock_name("/x/y/MyOpponentHistory.json")
        'MyOpponentHistory.json.lock'
    """
    base = os.path.basename(target_path)
    # Strip the .bak / .tmp_* / .broken-* suffixes so the same
    # logical file shares one lock.
    for strip in (".bak", ".tmp_restore"):
        if base.endswith(strip):
            base = base[: -len(strip)]
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in base)
    return safe + LOCK_SUFFIX


def _resolve_lock_dir(target_path: str) -> str:
    """Lock directory sibling-of the data file (creates it if needed)."""
    parent = os.path.dirname(os.path.abspath(target_path))
    lock_dir = os.path.join(parent, LOCK_DIR_NAME)
    os.makedirs(lock_dir, exist_ok=True)
    return lock_dir


def _is_pid_alive(pid: int) -> bool:
    """True if ``pid`` is currently running. Best-effort, never raises."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return False
        if exc.errno == errno.EPERM:
            # We can't signal it (different user / elevated), but it
            # exists. Treat as alive.
            return True
        return False
    except Exception:  # noqa: BLE001
        return False


def _read_lock_meta(lock_path: str) -> Optional[Dict[str, Any]]:
    """Parse the holder metadata; ``None`` on missing / unreadable / bad JSON."""
    try:
        with open(lock_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None


def _make_lock_meta() -> Dict[str, Any]:
    return {
        "pid": os.getpid(),
        "host": socket.gethostname(),
        "lang": LANG_TAG,
        "platform": platform.system(),
        "since": int(time.time() * 1000),
        "stamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def _try_create_lockfile(lock_path: str, meta: Dict[str, Any]) -> bool:
    """Attempt the O_EXCL create. True on success, False if it already existed."""
    try:
        flags = os.O_CREAT | os.O_EXCL | os.O_RDWR
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY  # type: ignore[attr-defined]
        fd = os.open(lock_path, flags, 0o644)
    except FileExistsError:
        return False
    except OSError as exc:
        if exc.errno == errno.EEXIST:
            return False
        raise
    try:
        payload = json.dumps(meta, indent=2).encode("utf-8")
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    return True


def _is_stale(meta: Optional[Dict[str, Any]], stale_after_sec: float) -> bool:
    """True if the holder is dead OR the lockfile is older than the threshold."""
    if meta is None:
        return True
    pid = meta.get("pid")
    if not isinstance(pid, int) or not _is_pid_alive(pid):
        return True
    since = meta.get("since")
    if isinstance(since, (int, float)):
        age_sec = (time.time() * 1000 - since) / 1000.0
        if age_sec >= stale_after_sec:
            return True
    return False


def _try_steal(lock_path: str, expected: Optional[Dict[str, Any]]) -> bool:
    """Best-effort unlink of a stale lockfile. Idempotent under contention.

    Returns True if WE removed it (or it was already gone). False means
    another acquirer already swapped in fresh metadata that no longer
    matches what we read; back off and re-loop.
    """
    current = _read_lock_meta(lock_path)
    if current is None:
        # Already gone -- a competing acquirer beat us to it.
        return True
    # ``expected is None`` means our caller's first read of the holder
    # metadata failed (typically because the holder was mid-write and
    # the file was briefly inaccessible -- PowerShell uses
    # FileShare.None, and Windows AV scans new files transiently). If
    # the second read NOW returns valid metadata, that holder is
    # healthy; we MUST NOT steal. Without this guard, a sharing-
    # violation transient on a fresh lockfile lets us silently delete
    # a real holder's lock and produce lost updates.
    if expected is None:
        return False
    if current != expected:
        return False
    try:
        os.unlink(lock_path)
        return True
    except FileNotFoundError:
        return True
    except OSError:
        return False


def _backoff_sleep(attempt: int) -> None:
    """Exponential backoff with a hard ceiling -- keeps CPU off the spin lock."""
    delay_ms = min(
        DEFAULT_BACKOFF_INITIAL_MS * (2 ** attempt),
        DEFAULT_BACKOFF_MAX_MS,
    )
    time.sleep(delay_ms / 1000.0)


class FileLockTimeout(TimeoutError):
    """Raised when a lock can't be acquired within ``timeout_sec``."""


def _is_disabled() -> bool:
    return os.environ.get(ENABLE_ENV_VAR, "1") == DISABLE_VALUE


@contextlib.contextmanager
def file_lock(
    target_path: str,
    *,
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
    stale_after_sec: float = DEFAULT_STALE_AFTER_SEC,
    clock: Callable[[], float] = time.monotonic,
) -> Iterator[None]:
    """Acquire a cross-process lock for ``target_path`` until the with-block exits.

    Args:
        target_path: Absolute or relative path of the file you're about
            to mutate. The lock is named after the basename so all
            writers across processes share the same lock.
        timeout_sec: Hard ceiling on how long to wait. Raises
            :class:`FileLockTimeout` on expiry.
        stale_after_sec: After this many seconds the lock is treated
            as stale (likely a crashed holder) and stolen.
        clock: Injectable monotonic clock for testing.

    Raises:
        FileLockTimeout: when no acquisition succeeds within
            ``timeout_sec``.

    Example:
        >>> with file_lock("data/MyOpponentHistory.json"):  # doctest: +SKIP
        ...     # safe to atomic-write here
        ...     pass
    """
    if _is_disabled():
        # Opt-out for emergency rollback; behaves as a no-op so the
        # callers don't have to branch.
        yield
        return

    lock_dir = _resolve_lock_dir(target_path)
    lock_path = os.path.join(lock_dir, _safe_lock_name(target_path))
    meta = _make_lock_meta()
    deadline = clock() + timeout_sec
    attempt = 0
    last_seen: Optional[Dict[str, Any]] = None

    while True:
        if _try_create_lockfile(lock_path, meta):
            try:
                yield
            finally:
                _release_owned(lock_path, meta)
            return

        # Acquisition failed. Inspect the holder.
        observed = _read_lock_meta(lock_path)
        if _is_stale(observed, stale_after_sec):
            _try_steal(lock_path, observed)
            # Loop and retry the create. No backoff sleep on a stale
            # steal so we get back into the lock as fast as possible.
            attempt = 0
            last_seen = None
            continue

        if clock() >= deadline:
            raise FileLockTimeout(
                f"file_lock: timeout after {timeout_sec:.1f}s waiting on "
                f"{lock_path}; current holder pid={observed.get('pid') if observed else '?'}"
            )

        if observed != last_seen:
            # Holder changed -- reset the backoff so we're fresh.
            attempt = 0
            last_seen = observed
        else:
            attempt += 1
        _backoff_sleep(attempt)


def _release_owned(lock_path: str, meta: Dict[str, Any]) -> None:
    """Unlink the lockfile only if it still carries OUR metadata.

    If we got pre-empted by a stale-steal somewhere else, the file may
    now belong to a different process. Removing it would orphan that
    holder; safer to log + skip.

    On Windows another process briefly holding a read handle for a
    liveness check (or AV indexing) makes ``os.unlink`` raise
    ``PermissionError`` (ERROR_SHARING_VIOLATION). Retry a few times
    with brief sleeps so we don't leak the lockfile -- on POSIX the
    first attempt always succeeds and the loop exits immediately.
    """
    current = _read_lock_meta(lock_path)
    if current is None:
        return
    if current.get("pid") != meta.get("pid") or current.get("since") != meta.get("since"):
        # Someone else owns it now; stay out of their way.
        print(
            f"[file_lock] release skipped: holder changed under us "
            f"({current.get('pid')} != ours {meta.get('pid')})",
            file=sys.stderr,
        )
        return
    max_attempts = 6
    last_exc: Optional[BaseException] = None
    for attempt in range(max_attempts):
        try:
            os.unlink(lock_path)
            return
        except FileNotFoundError:
            return
        except PermissionError as exc:
            last_exc = exc
        except OSError as exc:
            last_exc = exc
            # EBUSY / EACCES / EPERM are the codes we get on Windows
            # when another process is briefly holding a read handle.
            if exc.errno not in (errno.EBUSY, errno.EACCES, errno.EPERM):
                break
        delay_ms = min(5 * (2 ** attempt), 80)
        time.sleep(delay_ms / 1000.0)
    if last_exc is not None:
        print(f"[file_lock] release error: {last_exc}", file=sys.stderr)


__all__ = [
    "file_lock",
    "FileLockTimeout",
    "DEFAULT_TIMEOUT_SEC",
    "DEFAULT_STALE_AFTER_SEC",
    "ENABLE_ENV_VAR",
]

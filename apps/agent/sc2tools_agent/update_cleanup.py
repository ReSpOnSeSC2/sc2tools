"""Delete the installer downloads and interrupted-save files the agent made.

Each update used to leave its ~230 MB setup in ``%TEMP%`` for good. Updates
now download into ``<state dir>/updates``. Once a version runs, its own setup
and every older one are deleted there, and the copies earlier versions left
in ``%TEMP%`` follow the same rule. Setups for a newer version stay, because
the updater may still reuse them.

Only names the agent itself writes are ever touched:

* ``SC2ToolsAgent-Setup-<version>.exe`` (a verified download);
* ``.SC2ToolsAgent-Setup-<version>-<random>.exe.part`` (a download in
  progress) and the same name without ``.part`` (the copy used when the
  normal name was locked);
* in the state folder only, ``agent.<random>.tmp`` (written by agents before
  0.24) and ``agent-credentials-<hex>.tmp``, which an interrupted save of
  ``agent.json`` can leave behind.

Partial downloads and state temp files are removed only once they are an hour
old, so a download or save in progress is never cut off. Files that are open
elsewhere (the installer that just ran this version, say) are skipped and
retried once a couple of minutes later.
"""
from __future__ import annotations

from dataclasses import dataclass
import logging
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from typing import Callable, Optional

log = logging.getLogger(__name__)

UPDATES_DIRNAME = "updates"
STALE_AFTER_SEC = 3600.0
LOCKED_RETRY_SEC = 120.0

_VERSION = r"(?P<version>[0-9]{1,6}(?:\.[0-9]{1,6}){1,3})(?:-[0-9A-Za-z.]{1,40})?"
_SETUP = re.compile(rf"SC2ToolsAgent-Setup-{_VERSION}\.exe", re.IGNORECASE)
# tempfile.mkstemp names: the prefix, eight characters from [a-z0-9_], the suffix.
_STAGING = re.compile(rf"\.SC2ToolsAgent-Setup-{_VERSION}-[a-z0-9_]{{8}}\.exe(?:\.part)?", re.IGNORECASE)
_STATE_TEMP = re.compile(r"agent\.[a-z0-9_]{8}\.tmp|agent-credentials-[0-9a-f]{32}\.tmp", re.IGNORECASE)


@dataclass
class CleanupResult:
    removed: int = 0
    freed_bytes: int = 0
    locked: int = 0

    def add(self, other: "CleanupResult") -> "CleanupResult":
        self.removed += other.removed
        self.freed_bytes += other.freed_bytes
        self.locked += other.locked
        return self


def updates_dir(state_dir: Path) -> Path:
    """The app-owned folder update downloads go to."""
    return Path(state_dir) / UPDATES_DIRNAME


def _numeric(version: str) -> Optional[tuple[int, ...]]:
    match = re.match(r"\s*v?([0-9]{1,6}(?:\.[0-9]{1,6})*)", version or "")
    return tuple(int(part) for part in match.group(1).split(".")) if match else None


def _not_newer(version: str, running: Optional[tuple[int, ...]]) -> bool:
    candidate = _numeric(version)
    if candidate is None or running is None:
        return False
    width = max(len(candidate), len(running))
    return candidate + (0,) * (width - len(candidate)) <= running + (0,) * (width - len(running))


def _remove(entry: os.DirEntry, result: CleanupResult) -> None:
    try:
        size = entry.stat(follow_symlinks=False).st_size
        os.unlink(entry.path)
    except FileNotFoundError:
        return
    except PermissionError:
        result.locked += 1  # in use (WinError 32) or read-only; retried later
        return
    except OSError as exc:
        log.debug("update_cleanup_skip name=%s err=%s", entry.name, type(exc).__name__)
        return
    result.removed += 1
    result.freed_bytes += size


def _age(entry: os.DirEntry, now: float) -> float:
    try:
        return now - entry.stat(follow_symlinks=False).st_mtime
    except OSError:
        return 0.0


def _files(directory: Path):
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                try:
                    if entry.is_file(follow_symlinks=False):
                        yield entry
                except OSError:
                    continue
    except (FileNotFoundError, NotADirectoryError):
        return
    except OSError as exc:
        log.debug("update_cleanup_unreadable_dir err=%s", type(exc).__name__)


def sweep_installers(directory: Path, running_version: str, *, now: Optional[float] = None,
                     stale_after: float = STALE_AFTER_SEC) -> CleanupResult:
    """Delete agent setups not newer than ``running_version`` from one folder.

    Staging copies (``.part`` downloads and lock fallbacks) of a newer version
    are deleted once they are ``stale_after`` seconds old.
    """
    now = time.time() if now is None else now
    running = _numeric(running_version)
    result = CleanupResult()
    for entry in _files(directory):
        setup = _SETUP.fullmatch(entry.name)
        if setup:
            if _not_newer(setup.group("version"), running):
                _remove(entry, result)
            continue
        staging = _STAGING.fullmatch(entry.name)
        if staging and (_not_newer(staging.group("version"), running) or _age(entry, now) >= stale_after):
            _remove(entry, result)
    return result


def sweep_state_temp_files(state_dir: Path, *, now: Optional[float] = None,
                           stale_after: float = STALE_AFTER_SEC) -> CleanupResult:
    """Delete stale temp files an interrupted ``agent.json`` save left behind."""
    now = time.time() if now is None else now
    result = CleanupResult()
    for entry in _files(Path(state_dir)):
        if _STATE_TEMP.fullmatch(entry.name) and _age(entry, now) >= stale_after:
            _remove(entry, result)
    return result


def system_temp_dir() -> Path:
    """Where agents before 0.25.6 downloaded their setups."""
    return Path(tempfile.gettempdir())


def sweep_update_leftovers(state_dir: Path, running_version: str, *, temp_dir: Optional[Path] = None,
                           now: Optional[float] = None) -> CleanupResult:
    """One pass over the updates folder, the state folder and, when given, ``temp_dir``."""
    result = CleanupResult()
    result.add(sweep_installers(updates_dir(state_dir), running_version, now=now))
    if temp_dir is not None:
        result.add(sweep_installers(Path(temp_dir), running_version, now=now))
    result.add(sweep_state_temp_files(state_dir, now=now))
    return result


def start_update_cleanup(state_dir: Path, running_version: str, *, temp_dir: Optional[Path] = None,
                         retry_after: float = LOCKED_RETRY_SEC,
                         wait: Optional[Callable[[float], bool]] = None) -> threading.Thread:
    """Sweep in the background; retry once if a file was still in use.

    ``wait`` returns True when the agent is stopping (an ``Event.wait``).
    """
    wait = wait or threading.Event().wait

    def run() -> None:
        try:
            result = sweep_update_leftovers(state_dir, running_version, temp_dir=temp_dir)
            if result.locked and not wait(retry_after):
                retry = sweep_update_leftovers(state_dir, running_version, temp_dir=temp_dir)
                result = CleanupResult(result.removed + retry.removed, result.freed_bytes + retry.freed_bytes,
                                       retry.locked)
            if result.removed or result.locked:
                log.info("update_cleanup removed=%d freed_mb=%.1f locked=%d",
                         result.removed, result.freed_bytes / (1024 * 1024), result.locked)
        except Exception:  # noqa: BLE001 - housekeeping must never take the agent down
            log.warning("update_cleanup_failed", exc_info=True)

    thread = threading.Thread(target=run, name="sc2tools-update-cleanup", daemon=True)
    thread.start()
    return thread


__all__ = [
    "CleanupResult", "UPDATES_DIRNAME", "start_update_cleanup", "sweep_installers",
    "sweep_state_temp_files", "sweep_update_leftovers", "system_temp_dir", "updates_dir",
]

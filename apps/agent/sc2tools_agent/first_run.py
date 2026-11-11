"""Durable first-run setup and a watcher gate for the desktop boot worker."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Lock
import time

from .folder_info import describe_folder
from .sync_filter import PRESET_ALL, PRESET_CURRENT_SEASON, PRESET_LAST_30_DAYS, PRESET_SINCE_SETUP, SyncFilter


IMPORT_CHOICES = (
    (PRESET_CURRENT_SEASON, "This season (recommended)"),
    (PRESET_LAST_30_DAYS, "Last 30 days"),
    (PRESET_ALL, "Everything"),
    (PRESET_SINCE_SETUP, "Only new games"),
)


@dataclass(frozen=True)
class SetupChoices:
    folders: tuple[str, ...]
    preset: str
    start_with_windows: bool | None


def prepare_first_run(state, persist, *, now=None):
    """Migrate already-linked installs and durably mark a genuinely fresh GUI.

    The marker must reach disk before pairing, so a quit or crash between
    linking and finishing does not turn this install into a legacy migration.
    """
    if state.setup_completed_at is not None:
        return False
    if state.setup_pending:
        return True
    if state.is_paired:
        # Existing devices are already running. Never hold their startup
        # just to write an optional migration marker.
        state.setup_completed_at = now if now is not None else time.time()
        return False
    state.setup_pending = True
    try:
        persist()
    except Exception:
        state.setup_pending = False
        raise
    return True


def setup_range(preset, *, now=None):
    if preset not in {key for key, _ in IMPORT_CHOICES}:
        raise ValueError("Choose a replay history range.")
    current = now or datetime.now(timezone.utc)
    return SyncFilter.from_state(preset, current.isoformat() if preset == PRESET_SINCE_SETUP else None, None)


def describe_setup_folder(folder, *, now=None):
    current = now or datetime.now(timezone.utc)
    ranges = {preset: SyncFilter.from_state(preset, None, None).resolve(now=current)
              for preset in (PRESET_CURRENT_SEASON, PRESET_LAST_30_DAYS)}
    counts = dict.fromkeys(ranges, 0)

    def count(mtime):
        stamp = datetime.fromtimestamp(mtime, tz=timezone.utc)
        for preset, (since, until) in ranges.items():
            if (since is None or since <= stamp) and (until is None or stamp <= until):
                counts[preset] += 1

    details = describe_folder(Path(folder), on_replay_mtime=count)
    return details, {**counts, PRESET_ALL: details.replay_count, PRESET_SINCE_SETUP: 0}


class FirstRunSetup:
    def __init__(self, *, folders, start_with_windows, save):
        self.folders = tuple(str(folder) for folder in folders)
        self.start_with_windows = start_with_windows
        self._save = save
        self._lock = Lock()
        self._finished = Event()
        self._result = None

    def complete(self, choices):
        with self._lock:
            if not self._finished.is_set():
                self._result = (choices, self._save(choices))
                self._finished.set()
            return self._result

    def wait(self, stop_event):
        while not stop_event.is_set():
            if self._finished.wait(0.1):
                return not stop_event.is_set()
        return False

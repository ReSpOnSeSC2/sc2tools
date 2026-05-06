"""Replay-folder watcher.

Two modes — both ALWAYS run:

  1. Live (watchdog FS events). The instant SC2 finishes writing a
     replay, watchdog fires on_created, we wait for the file to settle,
     parse, and enqueue an upload.

  2. Periodic sweep (the ``poll_interval_sec`` thread). Every N seconds
     we scan all configured Multiplayer dirs for files newer than our
     dedupe cursor. Catches the OneDrive / cloud-sync case where the
     filesystem event never fires.

Both code paths funnel into ``_handle_replay`` which is idempotent on
the dedupe set in ``state.uploaded``.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, Future
from pathlib import Path
from typing import Iterable, Optional

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from .config import AgentConfig
from .replay_finder import all_multiplayer_dirs, find_replays_root
from .replay_pipeline import parse_replay_for_cloud
from .state import AgentState
from .uploader.queue import UploadJob, UploadQueue

log = logging.getLogger(__name__)

REPLAY_SUFFIX = ".SC2Replay"
SETTLE_TIMEOUT_SEC = 15
SETTLE_POLL_SEC = 1.0


class ReplayWatcher:
    """Owns the watchdog observer + the periodic sweeper."""

    def __init__(
        self,
        *,
        cfg: AgentConfig,
        state: AgentState,
        upload: UploadQueue,
    ) -> None:
        self._cfg = cfg
        self._state = state
        self._upload = upload
        self._stop = threading.Event()
        self._observer: Optional[Observer] = None
        self._sweeper: Optional[threading.Thread] = None
        self._executor = ThreadPoolExecutor(
            max_workers=cfg.parse_concurrency,
            thread_name_prefix="sc2tools-parse",
        )
        self._inflight: set[str] = set()
        self._inflight_lock = threading.Lock()
        self._roots: list[Path] = []

    def start(self) -> None:
        roots = self._discover_roots()
        if not roots:
            log.warning(
                "no_replay_dirs_found; agent will park until one appears.",
            )
        self._roots = roots
        self._observer = Observer()
        for root in roots:
            handler = _Handler(self)
            self._observer.schedule(handler, str(root), recursive=True)
        self._observer.start()
        self._sweeper = threading.Thread(
            target=self._sweep_loop, name="sc2tools-sweep", daemon=True,
        )
        self._sweeper.start()
        # On startup, run one immediate sweep so any replays played
        # while the agent was off get picked up.
        self._executor.submit(self._sweep_once)

    def stop(self) -> None:
        self._stop.set()
        if self._observer:
            self._observer.stop()
            self._observer.join(timeout=3)
        if self._sweeper:
            self._sweeper.join(timeout=3)
        self._executor.shutdown(wait=False, cancel_futures=True)

    # ---------------- internals ----------------
    def _discover_roots(self) -> list[Path]:
        """Return every folder we should watch + sweep, deduplicated.

        Each region and battle.net handle has its own
        ``Replays/Multiplayer`` directory, so the user may have
        configured several. Watchdog handlers and the sweep loop both
        operate per-root, and ``recursive=True`` means a parent dir
        catches every Multiplayer subfolder underneath it — so the
        list can be a mix of full account roots and individual
        Multiplayer dirs without double-uploading anything (the
        ``state.uploaded`` cursor dedupes by absolute path).
        """
        out: list[Path] = []
        seen: set[str] = set()

        def _add(p: Path) -> None:
            try:
                key = str(p.resolve())
            except OSError:
                key = str(p)
            if key in seen:
                return
            seen.add(key)
            out.append(p)

        # Modern multi-folder override.
        for raw in getattr(self._state, "replay_folders_override", []) or []:
            path = Path(raw)
            if path.exists():
                _add(path)

        if out:
            return out

        # Env-var override path (tests, headless servers).
        if self._cfg.replay_folder:
            _add(self._cfg.replay_folder)
            return out

        # Auto-discover every (account, toon) pair under the SC2 root.
        root = find_replays_root()
        if not root:
            return []
        for mp in all_multiplayer_dirs(root):
            _add(mp)
        if not out:
            _add(root)
        return out

    def _sweep_loop(self) -> None:
        while not self._stop.wait(self._cfg.poll_interval_sec):
            try:
                self._sweep_once()
            except Exception:  # noqa: BLE001
                log.exception("sweep_failed")

    def _sweep_once(self) -> None:
        # If the runner triggered a "Re-sync from scratch" via the tray,
        # rediscover the roots (in case the override changed too) and
        # walk every file again. The state.uploaded dict was already
        # cleared by the runner before signalling, so keys that match
        # below would be re-enqueued anyway — but we still want fresh
        # roots in case the override changed since the agent started.
        if self._upload.is_resync_requested():
            self._roots = self._discover_roots()
            self._upload.acknowledge_resync()
        if not self._roots:
            self._roots = self._discover_roots()
            if not self._roots:
                return
        for root in self._roots:
            for path in _walk_replays(root):
                key = str(path)
                if key in self._state.uploaded:
                    continue
                with self._inflight_lock:
                    if key in self._inflight:
                        continue
                    self._inflight.add(key)
                self._executor.submit(self._handle_replay, path)

    def _handle_replay(self, path: Path) -> None:
        try:
            if not _wait_for_file_ready(path, SETTLE_TIMEOUT_SEC):
                log.warning("file_never_settled %s", path.name)
                return
            game = parse_replay_for_cloud(path, state_dir=self._cfg.state_dir)
            if not game:
                # AI / unresolved / parse error — record so we don't
                # re-attempt every sweep.
                self._state.uploaded[str(path)] = "skipped"
                return
            self._upload.submit(UploadJob(file_path=path, game=game))
        finally:
            with self._inflight_lock:
                self._inflight.discard(str(path))

    # Called by _Handler on a watchdog event.
    def on_replay_created(self, path: Path) -> None:
        key = str(path)
        if key in self._state.uploaded:
            return
        with self._inflight_lock:
            if key in self._inflight:
                return
            self._inflight.add(key)
        self._executor.submit(self._handle_replay, path)


class _Handler(FileSystemEventHandler):
    """Adapter from watchdog's events to ReplayWatcher."""

    def __init__(self, parent: ReplayWatcher) -> None:
        super().__init__()
        self._parent = parent

    def on_created(self, event) -> None:
        if event.is_directory:
            return
        path = Path(str(event.src_path))
        if path.suffix.lower() != REPLAY_SUFFIX.lower():
            return
        log.info("watchdog_seen %s", path.name)
        self._parent.on_replay_created(path)


def _walk_replays(root: Path) -> Iterable[Path]:
    try:
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                if name.lower().endswith(REPLAY_SUFFIX.lower()):
                    yield Path(dirpath) / name
    except OSError:
        return


def _wait_for_file_ready(path: Path, timeout_sec: float) -> bool:
    """Poll size until it stops growing — SC2 writes incrementally."""
    deadline = time.monotonic() + timeout_sec
    last = -1
    while time.monotonic() < deadline:
        try:
            cur = path.stat().st_size
        except OSError:
            time.sleep(SETTLE_POLL_SEC)
            continue
        if cur > 0 and cur == last:
            return True
        last = cur
        time.sleep(SETTLE_POLL_SEC)
    return False

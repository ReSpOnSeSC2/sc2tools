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

Concurrency mode (added v0.3.9):

The parse step is dispatched through either a ``ThreadPoolExecutor``
(default, safer) or a ``ProcessPoolExecutor`` (opt-in via the env var
``SC2TOOLS_PARSE_USE_PROCESSES=1``). Process mode delivers true
parallelism for the GIL-bound sc2reader work — measured ~5× speedup
on a backfill of 12k replays vs. the thread-pool default — at the
cost of higher memory use and slower worker startup. Threading stays
the default while we shake out the frozen-exe edge cases.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import (
    Executor,
    Future,
    ProcessPoolExecutor,
    ThreadPoolExecutor,
)
from pathlib import Path
from typing import Iterable, Optional

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from .config import AgentConfig
from .replay_finder import (
    all_multiplayer_dirs,
    all_multiplayer_dirs_anywhere,
    find_all_replays_roots,
    find_replays_root,
)
from .replay_pipeline import AnalyzerImportError, parse_replay_for_cloud
from .state import AgentState
from .uploader.queue import UploadJob, UploadQueue

log = logging.getLogger(__name__)

REPLAY_SUFFIX = ".SC2Replay"
SETTLE_TIMEOUT_SEC = 15
SETTLE_POLL_SEC = 1.0


def _parse_in_worker(path_str: str, state_dir_str: str) -> tuple:
    """Top-level worker function — runs in the parse pool.

    Lives at module scope (not as a method) because
    ``ProcessPoolExecutor`` needs a picklable callable: bound methods
    on instances with file handles / threading primitives won't
    pickle. Returns a 3-tuple ``(kind, path_str, payload)`` so the
    parent thread can dispatch on ``kind`` without sharing a ``state``
    object across the process boundary:

      * ``("game", path_str, CloudGame)`` → enqueue for upload
      * ``("skipped", path_str, None)``    → mark as permanently
                                              skipped in ``state.uploaded``
      * ``("analyzer_error", path_str, str)`` → systemic import error;
                                              do NOT mark skipped
      * ``("settle_failed", path_str, None)`` → file size never
                                              stabilised within the
                                              timeout

    The function is intentionally process-mode-safe: it imports
    everything fresh, runs the file-settle loop in the worker (so
    we don't pay 15 s of parent-side wall clock per replay), and
    returns a plain dataclass over the IPC boundary.
    """
    from pathlib import Path as _Path  # re-imported in child process
    from .replay_pipeline import (
        AnalyzerImportError as _AnalyzerImportError,
        parse_replay_for_cloud as _parse,
    )

    path = _Path(path_str)
    state_dir = _Path(state_dir_str) if state_dir_str else None
    if not _wait_for_file_ready(path, SETTLE_TIMEOUT_SEC):
        return ("settle_failed", path_str, None)
    try:
        game = _parse(path, state_dir=state_dir)
    except _AnalyzerImportError as exc:
        return ("analyzer_error", path_str, str(exc))
    if not game:
        return ("skipped", path_str, None)
    return ("game", path_str, game)


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
        # Threading mode is the only supported parse pool in v0.3.10+.
        # The opt-in process pool from 0.3.9 (``SC2TOOLS_PARSE_USE_PROCESSES``)
        # crashed every child during spawn on PyInstaller windowed exes
        # — ``concurrent.futures.process.BrokenProcessPool`` with no
        # readable detail. The plumbing for process mode is still in
        # place (``_parse_in_worker``, ``_on_worker_done``, the
        # ``Executor`` abstraction below) so a future release can
        # re-enable it once the frozen-exe spawn path is debugged
        # against a real install. Until then we skip the env var
        # entirely — users shouldn't be juggling shell variables to
        # turn on a feature that doesn't work yet.
        self._executor: Executor = ThreadPoolExecutor(
            max_workers=cfg.parse_concurrency,
            thread_name_prefix="sc2tools-parse",
        )
        self._uses_processes = False
        self._inflight: set[str] = set()
        self._inflight_lock = threading.Lock()
        self._roots: list[Path] = []
        # Throttle the systemic "analyzer not loadable" log so a stuck
        # bundle doesn't fill agent.log with thousands of identical
        # errors (one per replay × however many SC2 has on disk).
        self._analyzer_unavailable: bool = False
        self._analyzer_error_logged_at: float = 0.0

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
        # while the agent was off get picked up. Spawned as a plain
        # daemon thread rather than going through ``self._executor``
        # because (a) sweeping is I/O-bound and doesn't need to share
        # the parse pool, and (b) when the parse pool is a
        # ``ProcessPoolExecutor`` the bound-method ``self._sweep_once``
        # is not safely picklable.
        threading.Thread(
            target=self._sweep_once, name="sc2tools-startup-sweep", daemon=True,
        ).start()

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

        # Auto-discover every (account, toon) pair under EVERY SC2 root
        # we can reach (regular Documents, OneDrive, redirected
        # Pictures\Documents, etc.). Returning a per-root match means a
        # player with multiple regions/handles sees every Multiplayer
        # folder watched simultaneously, not just the first one.
        for mp in all_multiplayer_dirs_anywhere():
            _add(mp)
        if not out:
            for root in find_all_replays_roots():
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
                self._submit_parse(path)

    def _submit_parse(self, path: Path) -> None:
        """Hand a replay to the executor and wire up result handling.

        Threading mode: keeps the legacy in-thread path that mutates
        ``self._state.uploaded`` directly — same code that's been in
        production since 0.2.0. Process mode: dispatches the parse to
        a child process via the picklable ``_parse_in_worker`` and
        applies the result-tuple back in the parent thread (where
        ``state`` lives). Both paths converge on the same upload-queue
        submission and dedupe-cursor write.
        """
        if self._uses_processes:
            future = self._executor.submit(
                _parse_in_worker, str(path),
                str(self._cfg.state_dir) if self._cfg.state_dir else "",
            )
            future.add_done_callback(self._on_worker_done)
        else:
            self._executor.submit(self._handle_replay, path)

    def _on_worker_done(self, future) -> None:
        """Callback for ProcessPoolExecutor results.

        Runs on a thread inside the parent process (concurrent.futures
        invokes done-callbacks on a thread of its choosing). Safe to
        mutate ``self._state.uploaded`` here — it's a plain dict and
        the inflight lock serialises any cross-future contention on
        the same path key.
        """
        try:
            kind, path_str, payload = future.result()
        except Exception as exc:  # noqa: BLE001
            # ``BrokenProcessPool`` arrives with an empty str() in some
            # cases — log the type + repr so silent crashes during
            # child spawn are debuggable. See the v0.3.9 frozen-exe
            # incident: the bare ``%s`` produced 9 lines of
            # "parse_worker_crashed:" with nothing after the colon.
            log.warning(
                "parse_worker_crashed type=%s repr=%r",
                type(exc).__name__,
                exc,
            )
            return
        path = Path(path_str)
        try:
            if kind == "game":
                self._upload.submit(UploadJob(file_path=path, game=payload))
                if self._analyzer_unavailable:
                    log.info("analyzer_recovered")
                    self._analyzer_unavailable = False
            elif kind == "skipped":
                # AI / unresolved / per-file parse error — record so the
                # next sweep doesn't re-attempt.
                self._state.uploaded[path_str] = "skipped"
                if self._analyzer_unavailable:
                    log.info("analyzer_recovered")
                    self._analyzer_unavailable = False
            elif kind == "settle_failed":
                log.warning("file_never_settled %s", path.name)
            elif kind == "analyzer_error":
                # Throttled — same logic as the in-thread handler.
                now = time.monotonic()
                if (
                    not self._analyzer_unavailable
                    or (now - self._analyzer_error_logged_at) > 60.0
                ):
                    log.error(
                        "analyzer_unavailable_skipping_until_restart "
                        "path=%s — replays will be re-tried on next "
                        "agent launch.",
                        path.name,
                    )
                    self._analyzer_error_logged_at = now
                self._analyzer_unavailable = True
            else:
                log.warning("parse_worker_unknown_kind=%s path=%s", kind, path.name)
        finally:
            with self._inflight_lock:
                self._inflight.discard(path_str)

    def _handle_replay(self, path: Path) -> None:
        try:
            if not _wait_for_file_ready(path, SETTLE_TIMEOUT_SEC):
                log.warning("file_never_settled %s", path.name)
                return
            try:
                game = parse_replay_for_cloud(
                    path, state_dir=self._cfg.state_dir,
                )
            except AnalyzerImportError:
                # Systemic failure (bundled analyzer can't be loaded).
                # Do NOT mark the replay as skipped — once the user
                # restarts with a fixed bundle, every replay sitting on
                # disk should still be eligible for upload. Throttle
                # the log so we don't spam agent.log with thousands of
                # copies of the same import error.
                now = time.monotonic()
                if (
                    not self._analyzer_unavailable
                    or (now - self._analyzer_error_logged_at) > 60.0
                ):
                    log.error(
                        "analyzer_unavailable_skipping_until_restart "
                        "path=%s — replays will be re-tried on next "
                        "agent launch.",
                        path.name,
                    )
                    self._analyzer_error_logged_at = now
                self._analyzer_unavailable = True
                return
            else:
                # We got past the import; reset the throttle so a
                # subsequent failure (e.g., after a reload) is logged
                # promptly.
                if self._analyzer_unavailable:
                    log.info("analyzer_recovered")
                    self._analyzer_unavailable = False
            if not game:
                # AI / unresolved / per-file parse error — record so we
                # don't re-attempt every sweep.
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
        self._submit_parse(path)


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
    """Yield every .SC2Replay under ``root``, newest first.

    Sorting by mtime-descending matters for UX during a backfill.
    A user with 12,000+ replays watching the dashboard sees their
    MOST RECENT games show up in 'Recent uploads' first, not the
    alphabetically-first map's thousand replays from years ago.
    Without this sort, ``os.walk`` returns files in arbitrary
    filesystem order — typically alphabetical, which means the
    sweep grinds through every "10000 Feet LE (N).SC2Replay" before
    touching any "Acid Plant" / "Old Republic" / etc., and the
    user (correctly) thinks the agent is map-filtering.

    We materialise the full list once per sweep — fine for tens of
    thousands of files (each ``Path`` is ~80 bytes, plus one stat
    call each). Yielding lazily but unsorted would be cheaper but
    defeat the whole point of this fix.
    """
    candidates: list[tuple[float, Path]] = []
    try:
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                if not name.lower().endswith(REPLAY_SUFFIX.lower()):
                    continue
                p = Path(dirpath) / name
                try:
                    mtime = p.stat().st_mtime
                except OSError:
                    # Stale dirent or permission glitch — skip the
                    # file entirely rather than yielding it without
                    # a sort key, which would scramble the ordering.
                    continue
                candidates.append((mtime, p))
    except OSError:
        return
    candidates.sort(key=lambda pair: pair[0], reverse=True)
    for _, p in candidates:
        yield p


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

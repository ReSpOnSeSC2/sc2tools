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

Concurrency mode (re-enabled v0.5.8):

The parse step dispatches through one of two executor types:

  * ``ProcessPoolExecutor`` (default in v0.5.8+). Each worker is a real
    OS process with its own GIL, so ``parse_concurrency=N`` delivers
    actual N-way parallelism for the CPU-bound sc2reader pipeline.
    Measured ~5× wall-clock speedup on a 12k-replay backfill vs. the
    thread-pool fallback below.

  * ``ThreadPoolExecutor`` (fallback). Used when (a) the user
    explicitly opts out via ``SC2TOOLS_PARSE_USE_PROCESSES=0`` or (b)
    the boot-time process-pool probe fails (e.g. the frozen-exe spawn
    path is broken on this user's install). Threads still serialise on
    the GIL but the watcher continues to function — graceful
    degradation rather than a hard crash.

The v0.3.9 attempt at process mode shipped enabled and crashed every
child during spawn on PyInstaller windowed exes (``BrokenProcessPool``
with empty repr). v0.3.10 disabled the feature entirely. v0.5.8
re-enables it with three guardrails: (1) the worker explicitly
re-bootstraps the analyzer ``sys.path`` in the child via
``bootstrap_analyzer_path()``, (2) a synthetic smoke-test child runs
once at boot to detect any spawn-time failure before real replays are
in flight, and (3) a runtime catch in ``_submit_parse`` swaps in a
ThreadPoolExecutor mid-session if a worker dies unexpectedly.
"""

from __future__ import annotations

import logging
import multiprocessing
import os
import threading
import time
from concurrent.futures import (
    Executor,
    Future,
    ProcessPoolExecutor,
    ThreadPoolExecutor,
)
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path
from typing import Iterable, Optional, Tuple

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
from .sync_filter import SyncFilter
from .uploader.queue import UploadJob, UploadQueue

log = logging.getLogger(__name__)

REPLAY_SUFFIX = ".SC2Replay"
SETTLE_TIMEOUT_SEC = 15
SETTLE_POLL_SEC = 1.0

# Boot-time probe budget. A healthy spawn on Windows takes ~1–3 s
# (cold) or ~0.5 s (warm); 30 s is the upper bound we'll wait before
# declaring the pool dead and falling back to threads. Keeping this
# generous avoids spurious fallbacks on slow / antivirus-heavy
# machines where the very first child spawn eats a few extra seconds
# while Windows Defender scans the freshly-written exe.
_PROBE_TIMEOUT_SEC = 30.0

# How many consecutive worker crashes via the done-callback path
# trigger a proactive runtime fallback to threading mode. One bad
# replay can legitimately crash a worker (memory corruption inside
# sc2reader on a malformed MPQ archive), so a single strike is not
# evidence the pool is broken. Three in a row is.
_PROCESS_CRASH_STRIKES_THRESHOLD = 3


def _child_smoke_test() -> Tuple[str, str]:
    """Synthetic worker payload — runs ONCE in a probe child at boot.

    Mirrors the work ``_parse_in_worker`` does at startup (re-bootstrap
    the analyzer ``sys.path``, then import the analyzer's deep-parse
    entry point) without needing a real replay file. Returns a
    ``("ok", diagnostic)`` tuple on success; raises on failure (which
    surfaces in the caller as a ``Future.result()`` exception).

    Why a synthetic probe rather than just queueing a real replay and
    catching the resulting ``BrokenProcessPool``: a real-replay spawn
    failure orphans the user's first uploaded game (or worse, every
    replay in a multi-thousand backfill). The probe lets us detect a
    broken spawn path BEFORE any user-visible work is queued, so the
    fallback to ``ThreadPoolExecutor`` is invisible to the user beyond
    a single WARNING line in agent.log.
    """
    from .replay_pipeline import bootstrap_analyzer_path
    bootstrap_analyzer_path()
    # Importing ``core.sc2_replay_parser`` is the load-bearing assertion:
    # it's the actual module ``parse_replay_for_cloud`` reaches for, and
    # historically the one that triggered the v0.3.9 BrokenProcessPool
    # crash when the child's sys.path didn't include the reveal core.
    from core.sc2_replay_parser import parse_deep  # type: ignore # noqa: F401
    return ("ok", f"pid={os.getpid()}")


def _probe_process_pool() -> Tuple[bool, Optional[str]]:
    """Run ``_child_smoke_test`` in a one-worker ProcessPoolExecutor.

    Returns ``(True, None)`` if the child spawned, executed, and
    returned within ``_PROBE_TIMEOUT_SEC`` seconds. Returns
    ``(False, reason)`` on any failure: spawn error, import error
    inside the child, timeout, or unexpected return shape. The reason
    string goes straight into the WARNING log so support has something
    to triage with — most of the value here comes from including the
    exception type+repr, which is what was missing from the v0.3.9
    "parse_worker_crashed:" lines.

    Always shuts the probe pool down with ``cancel_futures=True`` and
    ``wait=True`` so we don't leak a zombie subprocess if the probe
    failed partway through (the child may have started but never
    finished its return).
    """
    ctx = multiprocessing.get_context("spawn")
    executor = ProcessPoolExecutor(max_workers=1, mp_context=ctx)
    try:
        try:
            future = executor.submit(_child_smoke_test)
        except Exception as exc:  # noqa: BLE001
            return False, f"submit_failed type={type(exc).__name__} repr={exc!r}"
        try:
            result = future.result(timeout=_PROBE_TIMEOUT_SEC)
        except BrokenProcessPool as exc:
            return False, f"broken_process_pool repr={exc!r}"
        except TimeoutError as exc:
            return False, f"probe_timeout after_sec={_PROBE_TIMEOUT_SEC}"
        except Exception as exc:  # noqa: BLE001
            return False, f"child_raised type={type(exc).__name__} repr={exc!r}"
        if not (isinstance(result, tuple) and result and result[0] == "ok"):
            return False, f"unexpected_probe_result repr={result!r}"
        return True, None
    finally:
        # Children must be reaped synchronously here. ``wait=True`` is
        # critical on Windows — without it the executor returns before
        # the spawned python.exe has cleaned up its handle to the
        # frozen exe, which on a few user installs holds a file lock
        # the auto-updater would later fail to release.
        try:
            executor.shutdown(wait=True, cancel_futures=True)
        except Exception:  # noqa: BLE001
            log.exception("probe_pool_shutdown_failed")


def _parse_pool_use_processes_env() -> bool:
    """Resolve the ``SC2TOOLS_PARSE_USE_PROCESSES`` env var.

    Default ON in v0.5.8+. Only the explicit OFF strings ("0", "false",
    "off", case-insensitive, leading/trailing whitespace tolerated)
    disable process mode. Anything else — unset, "1", "true", garbage
    — keeps process mode enabled, on the principle that the boot
    probe will catch any actual breakage and fall back automatically.
    """
    raw = os.environ.get("SC2TOOLS_PARSE_USE_PROCESSES", "")
    return raw.strip().lower() not in {"0", "false", "off", "no"}


def _install_worker_log_handler(state_dir_str: str) -> None:
    """Wire the child's root logger to the same ``agent.log`` the parent
    uses. Idempotent and safe to call from any number of workers.

    Why this exists: ``ProcessPoolExecutor`` children don't inherit the
    parent's log handlers (spawn-mode start method re-runs ``__main__``
    fresh). Without this hook every ``log.info(...)`` call inside the
    worker — ``replay_payload_ready``, ``my_mmr_unresolved``,
    sc2reader's ``ContextLoader`` warnings — writes to the child's
    default stderr handler, which on a PyInstaller windowed exe
    points at the void. Throughput is invisible and worker-side
    diagnostics are unrecoverable on a user install.

    Why a plain ``FileHandler`` instead of the parent's
    ``RotatingFileHandler``: rotating handlers do a rename+reopen on
    rollover that isn't process-safe — two workers attempting rollover
    simultaneously can corrupt the on-disk index of which file is
    "active". The non-rotating ``FileHandler`` opens once with
    ``mode='a'`` (FILE_APPEND_DATA on Windows), and the OS serialises
    appends across handles so concurrent writes from N workers + the
    parent never interleave mid-line. Rollover stays the parent's job;
    if rollover fires while a worker has the file open, the worker's
    handle keeps writing to the now-renamed ``agent.log.1`` until its
    next reconnect — acceptable for a few seconds of overlap.
    """
    # Idempotency guard. The first call sets the marker; later calls
    # in the same child (e.g. multiple parses dispatched to the same
    # warmed-up worker) skip handler creation entirely.
    root = logging.getLogger()
    if getattr(root, "_sc2tools_worker_handler", False):
        return
    log_dir = Path(state_dir_str) / "logs"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        # Don't crash the worker if log dir creation races; the worst
        # case is the worker's diagnostics stay silent for this call.
        return
    log_path = log_dir / "agent.log"
    try:
        handler = logging.FileHandler(str(log_path), mode="a", encoding="utf-8")
    except OSError:
        return
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s | %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    handler.setFormatter(formatter)
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    setattr(root, "_sc2tools_worker_handler", True)


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

    First-line invariant: ``bootstrap_analyzer_path()`` MUST run
    before any other import or call. PyInstaller's spawn-mode child
    doesn't inherit the parent's ``sys.path`` mutations, so without
    this explicit re-bootstrap the lazy ``from core.sc2_replay_parser
    import …`` inside ``parse_replay_for_cloud`` fails with an
    ImportError that the parent then sees as a ``BrokenProcessPool``
    with no readable detail. This was the v0.3.9 incident and the
    direct reason process mode was disabled in v0.3.10.
    """
    # Ordered imports: bootstrap_analyzer_path FIRST, before the other
    # replay_pipeline names — even though importing the module already
    # triggers the module-scope ``_ensure_analyzer_on_path()`` call,
    # going through the public name documents the dependency and
    # makes the worker robust to any future refactor that lazies the
    # module-scope call.
    from .replay_pipeline import bootstrap_analyzer_path
    bootstrap_analyzer_path()

    # Worker-side logging. By default the child process has no log
    # handlers configured (spawn doesn't inherit the parent's), and a
    # PyInstaller windowed exe has stderr redirected to /dev/null —
    # so any ``log.info(...)`` call inside the worker (e.g.
    # ``replay_payload_ready`` from inside ``parse_replay_for_cloud``,
    # the analyzer-side ``my_mmr_unresolved`` diagnostics, sc2reader's
    # tracker-bug warnings) silently vanishes. ``_install_worker_log_handler``
    # is idempotent (only adds the handler on the first call within
    # the child) and routes every log record into the same
    # ``state_dir/logs/agent.log`` the parent writes to. Concurrent
    # appends from multiple workers + the parent are safe on Windows
    # because the OS serialises FILE_APPEND_DATA writes when each
    # handle is opened with O_APPEND (Python's FileHandler does this).
    if state_dir_str:
        _install_worker_log_handler(state_dir_str)

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
        # Resolve which parse-pool flavour to use up-front. The
        # boot-time probe inside ``_make_parse_executor`` is the only
        # place a ProcessPoolExecutor is allowed to be created — every
        # other code path goes through the resolved ``self._executor``
        # without caring about the underlying type. This isolates the
        # spawn-time fragility (PyInstaller frozen-exe edge cases) to
        # a single, well-logged decision point.
        executor, uses_processes = self._make_parse_executor()
        self._executor: Executor = executor
        self._uses_processes: bool = uses_processes
        self._inflight: set[str] = set()
        self._inflight_lock = threading.Lock()
        # Lock covering swaps of ``self._executor`` and
        # ``self._uses_processes``. Submission threads (the watchdog
        # observer and the sweep loop) read ``self._executor`` under
        # the lock and the runtime-fallback path inside
        # ``_submit_parse`` mutates them under the same lock. Without
        # this, two concurrent submissions hitting a broken pool could
        # each construct their own replacement ThreadPoolExecutor and
        # one would leak.
        self._executor_lock = threading.Lock()
        self._roots: list[Path] = []
        # Throttle the systemic "analyzer not loadable" log so a stuck
        # bundle doesn't fill agent.log with thousands of identical
        # errors (one per replay × however many SC2 has on disk).
        self._analyzer_unavailable: bool = False
        self._analyzer_error_logged_at: float = 0.0
        # Strike counter for the proactive runtime fallback. The
        # original v0.5.8 fallback only triggered when ``submit()``
        # raised ``BrokenProcessPool``; that's correct for a hard pool
        # failure but misses the slower-burn pattern where individual
        # workers die mid-parse, surface as ``future.result()``
        # exceptions in ``_on_worker_done``, and the parent keeps
        # blindly submitting more work that's about to fail. After
        # ``_PROCESS_CRASH_STRIKES_THRESHOLD`` consecutive worker
        # crashes via the done-callback path we proactively swap the
        # pool. Resets to 0 on any clean worker return so a single
        # transient crash (e.g. a corrupt replay file) doesn't push
        # us into threading mode permanently.
        self._process_crash_strikes: int = 0

    def _make_parse_executor(self) -> tuple[Executor, bool]:
        """Resolve the parse-pool implementation for this session.

        Resolution order:

          1. If ``SC2TOOLS_PARSE_USE_PROCESSES`` is "0"/"false"/"off"
             (case-insensitive), use ``ThreadPoolExecutor`` directly.
             This is the explicit user opt-out — skip the probe so we
             don't pay a 1–3 s spawn delay at boot just to throw the
             result away.

          2. Otherwise, run ``_probe_process_pool()``. On success,
             construct a ``ProcessPoolExecutor`` with explicit
             ``mp_context=spawn`` and the user's
             ``parse_concurrency`` worker count. Log the chosen mode
             so the user can grep agent.log to confirm.

          3. On probe failure, fall back to ``ThreadPoolExecutor``
             with a single WARNING that includes the probe's reason
             string. Do NOT re-probe later — once the agent has
             committed to threading mode for this session, stay there.
             A new attempt happens on the next agent restart.

        Returns ``(executor, uses_processes)``. The ``uses_processes``
        flag drives the result-handling fork in ``_submit_parse``.
        """
        workers = self._cfg.parse_concurrency
        if not _parse_pool_use_processes_env():
            log.info(
                "parse_pool_mode=thread workers=%d reason=env_opt_out",
                workers,
            )
            return (
                ThreadPoolExecutor(
                    max_workers=workers,
                    thread_name_prefix="sc2tools-parse",
                ),
                False,
            )
        ok, err = _probe_process_pool()
        if not ok:
            log.warning(
                "parse_pool_probe_failed err=%s falling_back_to_threads",
                err,
            )
            log.info(
                "parse_pool_mode=thread workers=%d reason=probe_failed",
                workers,
            )
            return (
                ThreadPoolExecutor(
                    max_workers=workers,
                    thread_name_prefix="sc2tools-parse",
                ),
                False,
            )
        ctx = multiprocessing.get_context("spawn")
        log.info("parse_pool_mode=process workers=%d", workers)
        return (
            ProcessPoolExecutor(max_workers=workers, mp_context=ctx),
            True,
        )

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
        # Read the live executor under the lock — the runtime-fallback
        # path can swap it mid-session — and shut it down outside the
        # lock so a slow process-pool reap doesn't block other
        # cleanup. ``shutdown(wait=False, cancel_futures=True)`` is
        # supported by both ThreadPoolExecutor and ProcessPoolExecutor
        # with identical semantics from the caller's perspective.
        with self._executor_lock:
            executor = self._executor
        executor.shutdown(wait=False, cancel_futures=True)

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
        # Pause gate (added v0.5.8). Pre-process-pool, the parser was
        # so much slower than the uploader that "pause uploads but
        # keep parsing in the background" was a fine UX — the agent
        # stayed quiet because the parser's GIL-bound throughput was
        # unable to keep up with the user's clicking. Process-mode
        # parses 5–10× faster, which means an unpaused parser floods
        # the activity log with ``replay_parsed`` lines even after
        # the user explicitly clicked Pause expecting quiet. Treat
        # pause as a global stop: skip the sweep entirely. The next
        # sweep cycle (after the user un-pauses) will re-walk the
        # filesystem and find any replays that arrived during the
        # pause, so nothing is lost. ``state.paused`` is the
        # authoritative flag — the upload queue's ``is_paused()``
        # mirrors it but the watcher reads state directly to avoid
        # taking the upload queue's lock in a hot path.
        if getattr(self._state, "paused", False):
            return
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
        # Resolve the user's date-range filter once per sweep so the
        # mtime pre-check is a single object lookup per file rather
        # than re-parsing the preset string for every replay during a
        # 12k-replay backfill.
        sync_filter = self._sync_filter()
        for root in self._roots:
            for path, mtime in _walk_replays(root):
                key = str(path)
                if key in self._state.uploaded:
                    continue
                if not sync_filter.mtime_in_range(mtime):
                    # Pre-filter: file mtime is well outside the user's
                    # window. Mark "filtered" so the next sweep skips
                    # it without another stat call. The runner clears
                    # these entries when the user changes the filter.
                    self._state.uploaded[key] = "filtered"
                    continue
                with self._inflight_lock:
                    if key in self._inflight:
                        continue
                    self._inflight.add(key)
                self._submit_parse(path)

    def _sync_filter(self) -> SyncFilter:
        """Resolve the user's chosen date-range filter from state.

        State carries free-text fields (``sync_filter_preset`` etc.)
        because the GUI's combo box hands us a string. SyncFilter
        validates and falls back to ``all`` on any malformed value so
        a corrupt state file doesn't silently hide the streamer's
        replays.
        """
        return SyncFilter.from_state(
            preset=getattr(self._state, "sync_filter_preset", None),
            since_iso=getattr(self._state, "sync_filter_since", None),
            until_iso=getattr(self._state, "sync_filter_until", None),
        )

    def _submit_parse(self, path: Path) -> None:
        """Hand a replay to the executor and wire up result handling.

        Threading mode: keeps the legacy in-thread path that mutates
        ``self._state.uploaded`` directly — same code that's been in
        production since 0.2.0. Process mode: dispatches the parse to
        a child process via the picklable ``_parse_in_worker`` and
        applies the result-tuple back in the parent thread (where
        ``state`` lives). Both paths converge on the same upload-queue
        submission and dedupe-cursor write.

        Runtime fallback: if a process submit raises ``BrokenProcessPool``
        (or a RuntimeError mentioning "process pool"), we rebuild the
        executor as a ``ThreadPoolExecutor`` and re-submit. This catches
        the edge case where the boot probe passed but a later worker
        died — typically OOM during an unusually long replay parse, or
        a transient antivirus interlock against the spawned exe — so a
        single bad replay doesn't take down parse for the rest of the
        session.
        """
        with self._executor_lock:
            executor = self._executor
            uses_processes = self._uses_processes
        if uses_processes:
            path_str = str(path)
            try:
                future = executor.submit(
                    _parse_in_worker, path_str,
                    str(self._cfg.state_dir) if self._cfg.state_dir else "",
                )
            except (BrokenProcessPool, RuntimeError) as exc:
                # ``RuntimeError`` filter is narrow: only "cannot
                # schedule new futures after shutdown" / "process pool"
                # variants from concurrent.futures, never an arbitrary
                # RuntimeError raised by the worker (those arrive via
                # ``future.result()`` instead).
                msg = str(exc).lower()
                if (
                    not isinstance(exc, BrokenProcessPool)
                    and "process pool" not in msg
                ):
                    raise
                if not self._fall_back_to_threading(reason=repr(exc)):
                    raise
                self._executor.submit(self._handle_replay, path)
                return
            # Capture path_str on the callback so the inflight set is
            # cleared even when the future raises (e.g., a worker
            # crashed mid-parse). Without this closure, an unhandled
            # future exception leaves a stale entry in
            # ``self._inflight`` and the same replay never gets
            # re-submitted on a subsequent sweep.
            future.add_done_callback(
                lambda fut, _ps=path_str: self._on_worker_done(fut, _ps),
            )
        else:
            executor.submit(self._handle_replay, path)

    def _fall_back_to_threading(self, *, reason: str) -> bool:
        """Swap the live executor for a fresh ThreadPoolExecutor.

        Returns ``True`` if the swap happened (and therefore the
        caller should retry against the new executor), ``False`` if
        another thread already swapped while we were waiting on the
        lock (in which case the caller's stale view is already wrong
        and they should re-read ``self._executor`` and try again
        rather than constructing a duplicate).

        The swap is fire-and-forget on the old ProcessPoolExecutor:
        ``shutdown(wait=False, cancel_futures=True)`` so any in-flight
        children get reaped by the OS without blocking the submission
        thread. Any results that DO straggle back from those children
        will hit ``_on_worker_done`` against the (now defunct) future
        and be discarded by the existing exception path there.
        """
        with self._executor_lock:
            if not self._uses_processes:
                return False
            log.warning(
                "parse_pool_runtime_failure_falling_back reason=%s "
                "workers=%d",
                reason,
                self._cfg.parse_concurrency,
            )
            old = self._executor
            self._executor = ThreadPoolExecutor(
                max_workers=self._cfg.parse_concurrency,
                thread_name_prefix="sc2tools-parse",
            )
            self._uses_processes = False
        # Drop the lock before shutting down the old pool — shutdown
        # can take a moment if children are mid-spawn and we don't
        # want to block other submissions on it.
        try:
            old.shutdown(wait=False, cancel_futures=True)
        except Exception:  # noqa: BLE001
            log.exception("parse_pool_old_shutdown_failed")
        log.info(
            "parse_pool_mode=thread workers=%d reason=runtime_fallback",
            self._cfg.parse_concurrency,
        )
        return True

    def _on_worker_done(self, future, submitted_path_str: str) -> None:
        """Callback for ProcessPoolExecutor results.

        Runs on a thread inside the parent process (concurrent.futures
        invokes done-callbacks on a thread of its choosing). Safe to
        mutate ``self._state.uploaded`` here — it's a plain dict and
        the inflight lock serialises any cross-future contention on
        the same path key.

        ``submitted_path_str`` is captured at submit time so the
        ``finally:`` cleanup of ``self._inflight`` runs even when
        ``future.result()`` raises — without it a worker crash leaks
        a stale inflight entry and the replay never gets re-submitted.
        """
        try:
            try:
                kind, path_str, payload = future.result()
            except Exception as exc:  # noqa: BLE001
                # ``BrokenProcessPool`` arrives with an empty str() in
                # some cases — log the type + repr so silent crashes
                # during child spawn are debuggable. See the v0.3.9
                # frozen-exe incident: the bare ``%s`` produced 9
                # lines of "parse_worker_crashed:" with nothing after
                # the colon.
                log.warning(
                    "parse_worker_crashed path=%s type=%s repr=%r",
                    Path(submitted_path_str).name,
                    type(exc).__name__,
                    exc,
                )
                # Proactive fallback: if the same kind of crash is
                # happening to many workers in a row, the pool is
                # systemically broken and the next ``submit()`` will
                # also fail. Count strikes only for ``BrokenProcessPool``
                # (and the related "process pool" RuntimeErrors) —
                # never for analyzer-side exceptions like a malformed
                # replay, which produce ``("analyzer_error", …)``
                # results and don't escape ``_parse_in_worker`` as a
                # raw exception. ``RuntimeError`` is name-checked to
                # avoid catching the in-worker exception path that's
                # supposed to be returned, not raised.
                if isinstance(exc, BrokenProcessPool) or (
                    isinstance(exc, RuntimeError)
                    and "process pool" in str(exc).lower()
                ):
                    self._process_crash_strikes += 1
                    if (
                        self._process_crash_strikes
                        >= _PROCESS_CRASH_STRIKES_THRESHOLD
                    ):
                        log.warning(
                            "parse_pool_strike_threshold_reached "
                            "strikes=%d threshold=%d "
                            "triggering_runtime_fallback",
                            self._process_crash_strikes,
                            _PROCESS_CRASH_STRIKES_THRESHOLD,
                        )
                        self._fall_back_to_threading(
                            reason=f"crashed_workers={self._process_crash_strikes}",
                        )
                        # Reset the counter regardless of swap result —
                        # if the swap raced and lost, we're already on
                        # threads via another path; if it won, the
                        # next done-callback should start a fresh count
                        # against whatever pool is live now.
                        self._process_crash_strikes = 0
                return
            # Reset the crash-strike counter on any clean worker
            # return. We're tracking *consecutive* crashes — one
            # successful parse means the pool is healthy and any
            # pre-existing strikes were transients (e.g. a single
            # corrupt replay), not a systemic spawn problem.
            if self._process_crash_strikes:
                log.info(
                    "parse_pool_strikes_reset prior_strikes=%d "
                    "after_clean_worker_return",
                    self._process_crash_strikes,
                )
                self._process_crash_strikes = 0
            # Defensive: a misbehaving worker that returns a different
            # path than the one we submitted would skew the inflight
            # accounting. Trust the submitted path for the inflight
            # discard (handled in ``finally:`` below) and warn loudly.
            if path_str != submitted_path_str:
                log.warning(
                    "parse_worker_path_mismatch submitted=%s returned=%s",
                    submitted_path_str,
                    path_str,
                )
            path = Path(path_str)
            if kind == "game":
                # Post-parse date-range check. The mtime pre-filter is
                # cheap but lossy (file copy / OneDrive sync stamps the
                # mtime, not the play time). The replay's actual date
                # is authoritative — re-evaluate now that we have it.
                sync_filter = self._sync_filter()
                if not sync_filter.replay_in_range(
                    getattr(payload, "date_iso", None),
                ):
                    self._state.uploaded[path_str] = "filtered"
                    return
                self._upload.submit(UploadJob(file_path=path, game=payload))
                # Parent-side throughput line. The matching
                # ``replay_payload_ready`` log inside
                # ``parse_replay_for_cloud`` runs in the WORKER
                # process; in process-pool mode workers don't inherit
                # the parent's RotatingFileHandler and on a windowed
                # PyInstaller exe their stderr is /dev/null, so the
                # worker's log lines disappear and the user can't tell
                # whether parses are actually happening. Logging a
                # summary line here — from the parent, against the
                # already-configured handler — restores throughput
                # visibility without adding cross-process log
                # forwarding. Mirrors the worker line's payload so a
                # grep against either string works.
                log.info(
                    "replay_parsed file=%s build_log=%d opp_build_log=%d "
                    "macro_breakdown=%s apm_curve=%s spatial=%s mode=%s",
                    path.name,
                    len(getattr(payload, "build_log", []) or []),
                    len(getattr(payload, "opp_build_log", []) or []),
                    "yes" if getattr(payload, "macro_breakdown", None) else "no",
                    "yes" if getattr(payload, "apm_curve", None) else "no",
                    "yes" if getattr(payload, "spatial", None) else "no",
                    "process" if self._uses_processes else "thread",
                )
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
                self._inflight.discard(submitted_path_str)

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
            # Post-parse date-range check (authoritative; the mtime
            # pre-filter only catches the obvious cases). Marking
            # "filtered" — distinct from "skipped" — lets the runner
            # clear just these entries when the user widens the
            # filter, without re-parsing AI/corrupt files.
            sync_filter = self._sync_filter()
            if not sync_filter.replay_in_range(
                getattr(game, "date_iso", None),
            ):
                self._state.uploaded[str(path)] = "filtered"
                return
            self._upload.submit(UploadJob(file_path=path, game=game))
        finally:
            with self._inflight_lock:
                self._inflight.discard(str(path))

    # Called by _Handler on a watchdog event.
    def on_replay_created(self, path: Path) -> None:
        # Same global pause gate as ``_sweep_once``. The watchdog
        # observer keeps running while paused (cheap, just listens for
        # FS events), but we drop the work on the floor — the next
        # sweep after un-pause re-discovers the file via the
        # filesystem walk and re-submits cleanly. This makes the
        # Pause button feel truthful: the activity log goes quiet
        # the moment the user clicks it, rather than continuing to
        # log replay_parsed lines for several seconds while the
        # process pool drains.
        if getattr(self._state, "paused", False):
            return
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


def _walk_replays(root: Path) -> Iterable[tuple[Path, float]]:
    """Yield ``(path, mtime_unix)`` for every .SC2Replay under ``root``,
    newest first.

    Sorting by mtime-descending matters for UX during a backfill.
    A user with 12,000+ replays watching the dashboard sees their
    MOST RECENT games show up in 'Recent uploads' first, not the
    alphabetically-first map's thousand replays from years ago.
    Without this sort, ``os.walk`` returns files in arbitrary
    filesystem order — typically alphabetical, which means the
    sweep grinds through every "10000 Feet LE (N).SC2Replay" before
    touching any "Acid Plant" / "Old Republic" / etc., and the
    user (correctly) thinks the agent is map-filtering.

    Yielding the mtime alongside the path saves the watcher's
    date-range pre-filter a redundant ``stat()`` call per file —
    over 12k replays that's ~1 s of saved I/O per sweep.

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
    for mtime, p in candidates:
        yield (p, mtime)


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

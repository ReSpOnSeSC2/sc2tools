"""Regression tests for the agent's file-logging split.

These lock down the fix shipped in 0.13.4 for the Windows log-rotation
deadlock: parse-pool workers used to append to the parent's shared
``agent.log`` with a long-lived handle, so on Windows the parent's
``RotatingFileHandler.doRollover`` ``os.rename`` failed with WinError 32
while any worker held the file open. ``logging``'s ``handleError``
swallows that exception, so the parent's records were silently dropped
and ``agent.log`` grew without bound for the rest of the backfill
(observed 2026-07-11: a 147 MB ``agent.log`` on a v0.13.3 install).

The fix keeps every log file single-writer:

  * each parse worker owns its own ``agent-worker-<pid>.log``
    (``watcher._install_worker_log_handler``), so the parent is the sole
    holder of ``agent.log`` and its rotation can never be blocked by a
    live worker;
  * the parent prunes stale worker logs at startup
    (``runner._prune_worker_logs``).

Because the agent suite runs on a real ``windows-latest`` runner
(``.github/workflows/python-tests.yml``), the rotation test below
genuinely exercises the Windows rename path: if a future refactor ever
pointed a worker back at ``agent.log``, ``test_parent_log_rotates_while
_worker_handler_active`` would fail on CI, and the structural invariant
in ``test_worker_handler_writes_to_per_pid_file_not_shared_log`` would
fail on every platform.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
from pathlib import Path

import pytest

from sc2tools_agent.config import AgentConfig


# The idempotency marker the worker-handler install sets on the root
# logger. Tests must strip it before installing so the handler actually
# attaches, and restore the original state afterwards.
_WORKER_MARKER = "_sc2tools_worker_handler"


@pytest.fixture
def restore_root_logger():
    """Snapshot the root logger, clear the worker-install marker, and
    fully restore it afterwards.

    Restoration is not just tidiness: the file handlers these tests add
    hold an OS handle to a file under ``tmp_path``. On Windows pytest
    cannot remove ``tmp_path`` while that handle is open, so teardown
    MUST close every handler the test attached (the same class of
    WinError 32 the code under test exists to avoid).
    """
    root = logging.getLogger()
    saved_handlers = root.handlers[:]
    saved_level = root.level
    had_marker = hasattr(root, _WORKER_MARKER)
    saved_marker = getattr(root, _WORKER_MARKER, None)
    if had_marker:
        delattr(root, _WORKER_MARKER)

    yield root

    # Close + drop anything the test added, then restore the originals.
    for handler in root.handlers[:]:
        if handler not in saved_handlers:
            try:
                handler.close()
            except Exception:  # noqa: BLE001
                pass
            root.removeHandler(handler)
    root.handlers[:] = saved_handlers
    root.setLevel(saved_level)
    if had_marker:
        setattr(root, _WORKER_MARKER, saved_marker)
    elif hasattr(root, _WORKER_MARKER):
        delattr(root, _WORKER_MARKER)


def _worker_file_handlers(root: logging.Logger) -> list:
    """Root handlers that point at a per-pid ``agent-worker-*.log`` file.

    Filtered by filename rather than by ``isinstance(..., FileHandler)``:
    under pytest the root logger already carries the logging plugin's own
    ``_FileHandler`` (aimed at the null device), so a blanket file-handler
    count would include it.
    """
    handlers = []
    for h in root.handlers:
        if isinstance(h, logging.FileHandler):
            if Path(h.baseFilename).name.startswith("agent-worker-"):
                handlers.append(h)
    return handlers


# --- worker side: per-pid file, never the shared agent.log ------------


def test_worker_handler_writes_to_per_pid_file_not_shared_log(
    tmp_path, restore_root_logger,
) -> None:
    """The load-bearing invariant: a worker's handler targets
    ``agent-worker-<pid>.log``, NOT the parent's ``agent.log``.

    This is the single fact that keeps ``agent.log`` single-writer and
    therefore rotatable on Windows. If it regresses, the deadlock
    returns."""
    from sc2tools_agent.watcher import (
        WORKER_LOG_MAX_BYTES,
        _install_worker_log_handler,
    )

    _install_worker_log_handler(str(tmp_path))

    root = logging.getLogger()
    handlers = _worker_file_handlers(root)
    assert len(handlers) == 1, "expected exactly one worker file handler"
    handler = handlers[0]

    base = Path(handler.baseFilename)
    assert base.parent == (tmp_path / "logs")
    assert base.name == f"agent-worker-{os.getpid()}.log"
    # The whole point of the fix — the worker must never open agent.log.
    assert base.name != "agent.log"
    assert base != (tmp_path / "logs" / "agent.log")

    # And it self-rotates at its own small cap, so a worker's own file
    # can't grow without bound either.
    assert isinstance(handler, logging.handlers.RotatingFileHandler)
    assert handler.maxBytes == WORKER_LOG_MAX_BYTES


def test_worker_handler_install_is_idempotent(
    tmp_path, restore_root_logger,
) -> None:
    """Repeated installs in the same (warmed-up) worker add exactly one
    handler — otherwise a worker that parses many replays would stack a
    handler per parse and multiply every log line."""
    from sc2tools_agent.watcher import _install_worker_log_handler

    root = logging.getLogger()
    _install_worker_log_handler(str(tmp_path))
    after_first = len(_worker_file_handlers(root))
    _install_worker_log_handler(str(tmp_path))
    _install_worker_log_handler(str(tmp_path))
    after_repeats = len(_worker_file_handlers(root))

    assert after_first == 1
    assert after_repeats == 1
    assert getattr(root, _WORKER_MARKER, False) is True


# --- the actual deadlock: parent rotates while a worker holds a file --


def test_parent_log_rotates_while_worker_handler_active(
    tmp_path, restore_root_logger,
) -> None:
    """The parent's ``agent.log`` must roll over cleanly while a parse
    worker holds its own log open.

    This models the production topology (parent + a live worker) and, on
    the Windows CI runner, reproduces the exact conditions of the
    original bug. With the fix, the worker holds ``agent-worker-<pid>.log``
    — a different file — so the parent's rename succeeds and the live
    file stays bounded. Were a worker to reopen ``agent.log`` again, the
    rename would fail with WinError 32, ``handleError`` would swallow it,
    ``agent.log.1`` would never appear and ``agent.log`` would grow
    without bound — which the assertions below catch."""
    from sc2tools_agent import runner
    from sc2tools_agent.watcher import _install_worker_log_handler

    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    agent_log = log_dir / runner.LOG_FILENAME

    # A live parse worker, holding its per-pid handle open for the whole
    # duration (delay=False → opened at install time).
    _install_worker_log_handler(str(tmp_path))
    worker_log = logging.getLogger("test_logging.worker_sim")

    # The parent handler mirrors _configure_logging but with a tiny cap
    # so a handful of records forces several rollovers.
    parent_handler = logging.handlers.RotatingFileHandler(
        agent_log,
        maxBytes=256,
        backupCount=runner.LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    parent_log = logging.getLogger("test_logging.parent_sim")
    parent_log.propagate = False  # keep parent records off the root/worker file
    parent_log.setLevel(logging.INFO)
    parent_log.addHandler(parent_handler)
    try:
        for i in range(50):
            parent_log.info("parent record %03d %s", i, "x" * 80)
            worker_log.info("worker throughput %03d", i)
    finally:
        parent_log.removeHandler(parent_handler)
        parent_handler.close()

    # Rotation actually happened (the rename that used to fail on Windows).
    assert (log_dir / f"{runner.LOG_FILENAME}.1").exists(), (
        "parent agent.log never rotated — rollover was blocked"
    )
    # ...and the live file stayed bounded. Unbounded growth was the bug's
    # signature (the observed 147 MB agent.log).
    assert agent_log.stat().st_size <= 256 * 4
    # The most recent parent record survived the final rollover — parent
    # lines are not silently dropped.
    tail = agent_log.read_text(encoding="utf-8")
    assert "parent record 049" in tail
    # Worker throughput went to its OWN file, never the parent's.
    assert "worker throughput" not in tail
    assert (log_dir / f"agent-worker-{os.getpid()}.log").exists()


# --- parent startup: rotating agent.log + stale-worker-log prune ------


def test_configure_logging_installs_rotating_agent_log_and_prunes(
    tmp_path, restore_root_logger,
) -> None:
    """``_configure_logging`` wires exactly one rotating ``agent.log``
    handler (at the documented caps) and prunes stale worker logs left
    by previous sessions."""
    from sc2tools_agent import runner

    cfg = AgentConfig(
        api_base="http://localhost:0",
        state_dir=tmp_path,
        replay_folder=None,
        poll_interval_sec=10,
        parse_concurrency=2,
    )
    log_dir = tmp_path / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    # A stale worker log from a previous session — the PID is dead, so
    # startup must sweep it.
    stale = log_dir / "agent-worker-99999.log"
    stale.write_text("stale", encoding="utf-8")

    returned = runner._configure_logging(cfg)

    assert returned == log_dir
    root = logging.getLogger()
    agent_log = log_dir / runner.LOG_FILENAME
    rotating = [
        h for h in root.handlers
        if isinstance(h, logging.handlers.RotatingFileHandler)
        and Path(h.baseFilename) == agent_log
    ]
    assert len(rotating) == 1, "expected exactly one rotating agent.log handler"
    handler = rotating[0]
    assert handler.maxBytes == runner.LOG_MAX_BYTES
    assert handler.backupCount == runner.LOG_BACKUP_COUNT
    # Startup prune ran.
    assert not stale.exists()


def test_prune_worker_logs_removes_only_worker_files(tmp_path) -> None:
    """Pruning deletes ``agent-worker-*.log*`` (including rotated
    backups) and leaves the parent's ``agent.log`` family untouched."""
    from sc2tools_agent.runner import LOG_FILENAME, _prune_worker_logs

    log_dir = tmp_path
    # Stale worker files from prior sessions, incl. a rotated backup.
    (log_dir / "agent-worker-111.log").write_text("x", encoding="utf-8")
    (log_dir / "agent-worker-222.log").write_text("x", encoding="utf-8")
    (log_dir / "agent-worker-222.log.1").write_text("x", encoding="utf-8")
    # Parent files that MUST survive the sweep.
    (log_dir / LOG_FILENAME).write_text("keep", encoding="utf-8")
    (log_dir / f"{LOG_FILENAME}.1").write_text("keep", encoding="utf-8")
    (log_dir / f"{LOG_FILENAME}.3").write_text("keep", encoding="utf-8")

    _prune_worker_logs(log_dir)

    survivors = sorted(p.name for p in log_dir.iterdir())
    assert survivors == ["agent.log", "agent.log.1", "agent.log.3"]

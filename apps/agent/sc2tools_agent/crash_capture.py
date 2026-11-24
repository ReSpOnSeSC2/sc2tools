"""Keep a local trace of crashes the windowed app would otherwise lose.

The installed agent has no console, so a native crash, an exception that
escapes a thread or a Qt slot, and Qt's own warnings all used to vanish.
``install_crash_capture`` (called once logging is set up) adds:

* ``faulthandler`` writing native crash stacks to ``logs/crash.log``, which
  starts each session with one header line (time, version and process id).
  Windows also hands faulthandler some errors that were then handled, so a
  stack is a crash only if the session ended right after it; the file says so
  in its first line. A background check rotates it past 1 MB during a session;
* ``sys.excepthook`` and ``threading.excepthook`` that log uncaught
  exceptions to ``agent.log``;
* ``install_qt_message_handler`` (called when Qt starts) routing qDebug,
  qWarning and friends into the log, repeated messages at most once a minute.

Everything stays on this PC; nothing is sent anywhere.
"""
from __future__ import annotations

from datetime import datetime, timezone
import faulthandler
import logging
import os
from pathlib import Path
import sys
import threading
import time

log = logging.getLogger("sc2tools_agent.crash")

CRASH_LOG_FILENAME = "crash.log"
CRASH_LOG_MAX_BYTES = 1024 * 1024
CRASH_LOG_CHECK_SEC = 60.0
CRASH_LOG_NOTE = ("# Native crash stacks from SC2 Tools. Windows also reports some errors that were "
                  "handled, so a stack is a crash only if SC2 Tools closed right after it.\n")
QT_REPEAT_SEC = 60.0
_QT_SEEN_LIMIT = 256

_fault_file = None  # faulthandler writes to this descriptor until exit
_fault_lock = threading.Lock()
_installed = False


def _rotate(path: Path) -> None:
    try:
        if path.stat().st_size > CRASH_LOG_MAX_BYTES:
            os.replace(path, path.with_name(path.name + ".1"))
    except OSError:
        pass  # missing (first run) or locked: keep appending


def enable_fault_log(log_dir: Path, *, version: str = "") -> Path | None:
    """Send native crash stacks (all threads) to ``crash.log``. Never raises.

    Called again while a log is open, it closes that one first, so an
    oversized ``crash.log`` can be rotated (Windows can't rename an open file).
    """
    global _fault_file
    path = Path(log_dir) / CRASH_LOG_FILENAME
    with _fault_lock:
        previous, _fault_file = _fault_file, None
        if previous is not None:
            try:
                faulthandler.disable()
                previous.close()
            except (OSError, ValueError):
                pass
        try:
            _rotate(path)
            handle = open(path, "a", encoding="utf-8")  # noqa: SIM115 - must stay open for faulthandler
            if os.fstat(handle.fileno()).st_size == 0:
                handle.write(CRASH_LOG_NOTE)
            stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
            handle.write(f"--- session {stamp} sc2tools-agent {version} pid={os.getpid()}\n")
            handle.flush()
            faulthandler.enable(file=handle, all_threads=True)
        except Exception:  # noqa: BLE001 - crash capture must never stop the agent starting
            log.warning("crash_log_unavailable", exc_info=True)
            return None
        _fault_file = handle
    return path


def _fault_log_size():
    with _fault_lock:
        handle = _fault_file
        return os.fstat(handle.fileno()).st_size if handle is not None else 0


def start_fault_log_guard(log_dir: Path, *, version: str = "", check_every: float = CRASH_LOG_CHECK_SEC,
                          wait=None) -> threading.Thread:
    """Rotate ``crash.log`` during a session once it passes ``CRASH_LOG_MAX_BYTES``."""
    wait = wait or threading.Event().wait

    def run():
        while not wait(check_every):
            try:
                if _fault_log_size() > CRASH_LOG_MAX_BYTES:
                    enable_fault_log(log_dir, version=version)
            except (OSError, ValueError):
                pass

    thread = threading.Thread(target=run, name="sc2tools-crash-log-guard", daemon=True)
    thread.start()
    return thread


def _log_uncaught(exc_type, exc_value, exc_traceback):
    if issubclass(exc_type, KeyboardInterrupt):
        sys.__excepthook__(exc_type, exc_value, exc_traceback)
        return
    log.critical("uncaught_exception", exc_info=(exc_type, exc_value, exc_traceback))


def _log_thread_exception(args):
    if args.exc_type is SystemExit:
        return
    name = getattr(args.thread, "name", "?")
    log.error("thread_crashed thread=%s", name, exc_info=(args.exc_type, args.exc_value, args.exc_traceback))


def install_crash_capture(log_dir: Path, *, version: str = "") -> None:
    """Install the fault log and both exception hooks once per process."""
    global _installed
    enable_fault_log(log_dir, version=version)
    if _installed:
        return
    sys.excepthook = _log_uncaught
    threading.excepthook = _log_thread_exception
    start_fault_log_guard(log_dir, version=version)
    _installed = True


class QtMessageLog:
    """Qt message handler: one log line per message, repeats once a minute."""

    def __init__(self, QtCore, *, clock=time.monotonic, logger=None):
        self._levels = {
            QtCore.QtMsgType.QtDebugMsg: logging.DEBUG,
            QtCore.QtMsgType.QtInfoMsg: logging.INFO,
            QtCore.QtMsgType.QtWarningMsg: logging.WARNING,
            QtCore.QtMsgType.QtCriticalMsg: logging.ERROR,
            QtCore.QtMsgType.QtFatalMsg: logging.CRITICAL,
        }
        self._clock = clock
        self._log = logger or logging.getLogger("sc2tools_agent.qt")
        self._lock = threading.Lock()
        self._seen = {}

    def __call__(self, kind, context, message):
        try:
            level = self._levels.get(kind, logging.WARNING)
            if not self._log.isEnabledFor(level):
                return
            text = str(message)
            now = self._clock()
            with self._lock:
                last = self._seen.get(text)
                if last is not None and now - last < QT_REPEAT_SEC:
                    return
                if len(self._seen) >= _QT_SEEN_LIMIT:
                    self._seen.clear()
                self._seen[text] = now
            category = getattr(context, "category", None) or "qt"
            self._log.log(level, "qt_message category=%s | %s", category, text[:1000])
        except Exception:  # noqa: BLE001 - Qt calls this from any thread; it must never raise
            pass


def install_qt_message_handler(QtCore):
    """Route Qt's messages into the agent log. Returns the handler."""
    handler = QtMessageLog(QtCore)
    QtCore.qInstallMessageHandler(handler)
    return handler


__all__ = ["CRASH_LOG_FILENAME", "QtMessageLog", "enable_fault_log", "install_crash_capture",
           "install_qt_message_handler", "start_fault_log_guard"]

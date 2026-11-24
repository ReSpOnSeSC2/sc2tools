"""Local crash capture, the guarded pause loop and quiet sc2reader logs."""
import inspect
import logging
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import threading
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sc2tools_agent import crash_capture, runner
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.state import AgentState
from tests.test_logging import restore_root_logger  # noqa: F401 - fixture

AGENT_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def fake_faulthandler(monkeypatch):
    calls = []
    monkeypatch.setattr(crash_capture, "faulthandler", SimpleNamespace(
        enable=lambda **kwargs: calls.append(kwargs), disable=lambda: calls.append("disable")))
    monkeypatch.setattr(crash_capture, "_fault_file", None)
    yield calls
    if crash_capture._fault_file is not None:
        crash_capture._fault_file.close()


def test_fault_log_explains_itself_starts_each_session_with_a_header_and_rotates(tmp_path, fake_faulthandler):
    path = crash_capture.enable_fault_log(tmp_path, version="0.25.6")
    assert path == tmp_path / "crash.log"
    assert fake_faulthandler[-1]["all_threads"] is True
    assert fake_faulthandler[-1]["file"] is crash_capture._fault_file
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[0] == crash_capture.CRASH_LOG_NOTE.strip() and "handled" in lines[0]
    assert len(lines) == 2 and lines[1].startswith("--- session ")
    assert lines[1].endswith(f" sc2tools-agent 0.25.6 pid={os.getpid()}")
    crash_capture.enable_fault_log(tmp_path, version="0.25.6")  # next session: header only
    assert path.read_text(encoding="utf-8").count("# Native crash stacks") == 1
    assert path.read_text(encoding="utf-8").count("--- session ") == 2 and "disable" in fake_faulthandler
    with open(path, "ab") as other:  # the open log keeps growing
        other.write(b"x" * (crash_capture.CRASH_LOG_MAX_BYTES + 1))
    crash_capture.enable_fault_log(tmp_path, version="0.25.6")  # closes the open log first, then rotates
    assert (tmp_path / "crash.log.1").stat().st_size > crash_capture.CRASH_LOG_MAX_BYTES
    assert path.read_text(encoding="utf-8").count("--- session ") == 1


def test_the_guard_rotates_an_oversized_log_during_a_session(tmp_path, fake_faulthandler):
    path = crash_capture.enable_fault_log(tmp_path, version="0.25.6")
    with open(path, "ab") as other:
        other.write(b"x" * (crash_capture.CRASH_LOG_MAX_BYTES + 1))
    waits = []
    thread = crash_capture.start_fault_log_guard(tmp_path, version="0.25.6", check_every=5,
                                                 wait=lambda seconds: waits.append(seconds) or len(waits) > 2)
    thread.join(5)
    assert thread.daemon and thread.name == "sc2tools-crash-log-guard" and waits == [5, 5, 5]
    assert (tmp_path / "crash.log.1").stat().st_size > crash_capture.CRASH_LOG_MAX_BYTES
    assert path.stat().st_size < 1000  # rotated once; the small new log stays


def test_a_fault_log_that_cannot_open_never_stops_startup(tmp_path, fake_faulthandler, caplog):
    with caplog.at_level(logging.WARNING):
        assert crash_capture.enable_fault_log(tmp_path / "missing" / "logs") is None
    assert fake_faulthandler == [] and "crash_log_unavailable" in caplog.text


def test_a_native_crash_leaves_its_stack_in_crash_log(tmp_path):
    script = textwrap.dedent(r'''
        import ctypes, faulthandler, os, sys
        from pathlib import Path
        from sc2tools_agent.crash_capture import install_crash_capture
        if os.name == "nt":
            ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002)  # no Windows Error Reporting dialog
        install_crash_capture(Path(sys.argv[1]), version="test")
        def crash_here():
            faulthandler._sigsegv()
        crash_here()
    ''')
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(
        part for part in (str(AGENT_ROOT), os.environ.get("PYTHONPATH")) if part))
    result = subprocess.run([sys.executable, "-c", script, str(tmp_path)], env=env,
                            capture_output=True, text=True, timeout=60)
    assert result.returncode != 0
    content = (tmp_path / "crash.log").read_text(encoding="utf-8", errors="replace")
    assert content.startswith("# Native crash stacks") and "--- session " in content
    assert "sc2tools-agent test" in content
    assert ("Windows fatal exception" in content or "Fatal Python error" in content), content
    assert "crash_here" in content, content


def test_uncaught_exceptions_reach_the_log(monkeypatch, caplog):
    with caplog.at_level(logging.ERROR, logger="sc2tools_agent.crash"):
        try:
            raise ValueError("slot failed")
        except ValueError:
            crash_capture._log_uncaught(*sys.exc_info())
    record = next(item for item in caplog.records if item.message == "uncaught_exception")
    assert record.levelno == logging.CRITICAL and record.exc_info[0] is ValueError
    delegated = []
    monkeypatch.setattr(sys, "__excepthook__", lambda *args: delegated.append(args[0]))
    crash_capture._log_uncaught(KeyboardInterrupt, KeyboardInterrupt(), None)
    assert delegated == [KeyboardInterrupt]


def test_a_crashed_thread_is_logged_with_its_name(caplog):
    try:
        raise RuntimeError("worker died")
    except RuntimeError:
        exc_type, exc_value, exc_traceback = sys.exc_info()
    crashed = SimpleNamespace(exc_type=exc_type, exc_value=exc_value, exc_traceback=exc_traceback,
                              thread=SimpleNamespace(name="sc2tools-test-worker"))
    exited = SimpleNamespace(exc_type=SystemExit, exc_value=SystemExit(0), exc_traceback=None, thread=None)
    with caplog.at_level(logging.ERROR, logger="sc2tools_agent.crash"):
        crash_capture._log_thread_exception(crashed)
        crash_capture._log_thread_exception(exited)  # a thread calling sys.exit is not a crash
    records = [item for item in caplog.records if item.message.startswith("thread_crashed")]
    assert [item.message for item in records] == ["thread_crashed thread=sc2tools-test-worker"]
    assert records[0].exc_info[0] is RuntimeError


def test_install_sets_both_hooks_once(tmp_path, monkeypatch, fake_faulthandler):
    monkeypatch.setattr(sys, "excepthook", sys.excepthook)
    monkeypatch.setattr(crash_capture, "_installed", False)
    guards = []
    monkeypatch.setattr(crash_capture, "start_fault_log_guard", lambda log_dir, **kw: guards.append((log_dir, kw)))
    pytest_thread_hook = threading.excepthook  # pytest swaps this per phase; restore it in this phase
    try:
        crash_capture.install_crash_capture(tmp_path, version="0.25.6")
        assert sys.excepthook is crash_capture._log_uncaught
        assert threading.excepthook is crash_capture._log_thread_exception
        assert guards == [(tmp_path, {"version": "0.25.6"})]
        sys.excepthook = sentinel = lambda *_: None
        crash_capture.install_crash_capture(tmp_path, version="0.25.6")  # a second call only reopens the log
        assert sys.excepthook is sentinel and len(guards) == 1
        assert len([call for call in fake_faulthandler if call != "disable"]) == 2
    finally:
        threading.excepthook = pytest_thread_hook


def test_runner_installs_crash_capture_right_after_logging(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(runner, "_configure_logging", lambda cfg: calls.append("logging") or tmp_path)
    monkeypatch.setattr(runner, "install_crash_capture", lambda log_dir, **kw: calls.append(("crash", log_dir, kw)))
    monkeypatch.setattr(runner, "init_crash_reporter", lambda **_: calls.append("sentry"))
    monkeypatch.setattr(runner, "start_update_cleanup", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_run_headless", lambda *a, **k: 0)
    cfg = SimpleNamespace(state_dir=tmp_path, api_base="https://api.example.test")
    args = SimpleNamespace(no_gui=True, start_minimized=False, no_live=True, no_obs=True)
    assert runner._run_locked_agent(cfg, args, []) == 0
    assert calls == ["logging", ("crash", tmp_path, {"version": runner.__version__}), "sentry"]


class Unprintable:
    def __str__(self):
        raise RuntimeError("no text")


def test_qt_messages_are_logged_once_a_minute_and_never_raise(caplog):
    QtCore = pytest.importorskip("PySide6.QtCore")
    clock = {"now": 0.0}
    handler = crash_capture.QtMessageLog(QtCore, clock=lambda: clock["now"])
    context = SimpleNamespace(category="qt.qpa.window")
    with caplog.at_level(logging.INFO, logger="sc2tools_agent.qt"):
        handler(QtCore.QtMsgType.QtWarningMsg, context, "Unable to set geometry")
        handler(QtCore.QtMsgType.QtWarningMsg, context, "Unable to set geometry")
        clock["now"] = 61
        handler(QtCore.QtMsgType.QtWarningMsg, context, "Unable to set geometry")
        handler(QtCore.QtMsgType.QtCriticalMsg, SimpleNamespace(category=None), "critical thing")
        handler(QtCore.QtMsgType.QtDebugMsg, context, "debug noise")
        handler(QtCore.QtMsgType.QtWarningMsg, None, Unprintable())  # broken message
    lines = [(item.levelname, item.getMessage()) for item in caplog.records if item.name == "sc2tools_agent.qt"]
    assert lines == [("WARNING", "qt_message category=qt.qpa.window | Unable to set geometry")] * 2 + [
        ("ERROR", "qt_message category=qt | critical thing")]
    installed = []
    fake = SimpleNamespace(QtMsgType=QtCore.QtMsgType, qInstallMessageHandler=installed.append)
    assert crash_capture.install_qt_message_handler(fake) is installed[0]


def test_gui_installs_the_qt_handler_before_the_application():
    from sc2tools_agent.ui.gui import GuiUI
    source = inspect.getsource(GuiUI.run)
    assert source.index("install_qt_message_handler(QtCore)") < source.index("QtWidgets.QApplication(")


# ---------------- pause loop ----------------


def _cfg(tmp_path):
    return AgentConfig(api_base="http://localhost:0", state_dir=tmp_path, replay_folder=None,
                       poll_interval_sec=10, parse_concurrency=1)


def test_a_failing_refresh_never_ends_the_pause_loop(tmp_path, caplog):
    state = AgentState(paused=True, paused_until=time.time() - 1)
    upload, ui, stop = Mock(), Mock(), threading.Event()
    ui.refresh_status.side_effect = RuntimeError("window gone")
    resumed = threading.Event()
    ui.on_paused.side_effect = lambda paused, until: resumed.set()
    with caplog.at_level(logging.WARNING):
        thread = runner._start_pause_expiry(_cfg(tmp_path), state, lambda: upload, lambda: ui, stop,
                                            tick=0.01, refresh_every=0.0)
        try:
            assert resumed.wait(3)
            deadline = time.monotonic() + 3
            while ui.refresh_status.call_count < 5 and time.monotonic() < deadline:
                time.sleep(0.01)
            assert thread.is_alive() and ui.refresh_status.call_count >= 5
        finally:
            stop.set()
            thread.join(2)
    assert not state.paused and state.paused_until is None
    upload.set_paused.assert_called_with(False)
    assert caplog.text.count("pause_expiry_refresh_failed error=RuntimeError") == 1  # once per 10 minutes


def test_a_failed_save_still_resumes_the_queue_and_the_window(tmp_path, monkeypatch, caplog):
    state = AgentState(paused=True, paused_until=time.time() - 1)
    upload, ui, stop = Mock(), Mock(), threading.Event()
    resumed = threading.Event()
    ui.on_paused.side_effect = lambda paused, until: resumed.set()
    monkeypatch.setattr(runner, "save_state", Mock(side_effect=OSError("agent.json locked")))
    with caplog.at_level(logging.WARNING):
        thread = runner._start_pause_expiry(_cfg(tmp_path), state, lambda: upload, lambda: ui, stop, tick=0.01)
        try:
            assert resumed.wait(3)
            time.sleep(0.05)
            assert thread.is_alive()
        finally:
            stop.set()
            thread.join(2)
    upload.set_paused.assert_called_once_with(False)
    ui.on_paused.assert_called_once_with(False, None)
    assert not state.paused and "pause_expiry_tick_failed error=OSError" in caplog.text
    with pytest.raises(OSError):  # the caller still learns the save failed
        runner._handle_pause(_cfg(tmp_path), state, upload, True, ui=ui, until=123.0)
    upload.set_paused.assert_called_with(True)
    ui.on_paused.assert_called_with(True, 123.0)


def test_loop_errors_repeat_at_most_every_ten_minutes(caplog):
    seen, clock = {}, {"now": 0.0}
    with caplog.at_level(logging.WARNING):
        for now in (0.0, 1.0, 599.0, 600.0):
            clock["now"] = now
            runner._log_loop_error(seen, "loop_failed", ValueError("x"), clock=lambda: clock["now"])
        runner._log_loop_error(seen, "loop_failed", KeyError("x"), clock=lambda: clock["now"])
        runner._log_loop_error(seen, "other_failed", ValueError("x"), clock=lambda: clock["now"])
    assert caplog.text.count("loop_failed error=ValueError") == 2
    assert caplog.text.count("loop_failed error=KeyError") == 1
    assert caplog.text.count("other_failed error=ValueError") == 1


# ---------------- sc2reader ----------------


def test_sc2reader_errors_stay_out_of_agent_and_worker_logs(tmp_path, restore_root_logger):  # noqa: F811
    from sc2tools_agent.watcher import _install_worker_log_handler

    sc2reader = logging.getLogger("sc2reader")
    previous = sc2reader.level
    try:
        sc2reader.setLevel(logging.NOTSET)
        log_dir = runner._configure_logging(_cfg(tmp_path))
        noisy = logging.getLogger("sc2reader.engine.plugins.context.ContextLoader")
        assert sc2reader.level == logging.CRITICAL and not noisy.isEnabledFor(logging.ERROR)
        noisy.error("8813\tSomePlayer\tMarine unknown ability")
        logging.getLogger("sc2tools_agent.watcher").warning("replay_analysis_failed file=x.SC2Replay")
        for handler in logging.getLogger().handlers:
            handler.flush()
        content = (log_dir / runner.LOG_FILENAME).read_text(encoding="utf-8")
        assert "SomePlayer" not in content and "replay_analysis_failed" in content
        sc2reader.setLevel(logging.NOTSET)
        root = logging.getLogger()
        if hasattr(root, "_sc2tools_worker_handler"):
            delattr(root, "_sc2tools_worker_handler")
        _install_worker_log_handler(str(tmp_path / "worker"))
        assert sc2reader.level == logging.CRITICAL
    finally:
        sc2reader.setLevel(previous)

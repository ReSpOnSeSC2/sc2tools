"""Restart agent: the relaunch command, its detached spawn, and starting it only after the lock is free."""
from __future__ import annotations

import os
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock

from sc2tools_agent import relaunch, runner
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.relaunch import AgentRelaunch, relaunch_command
from sc2tools_agent.state import AgentState, save_state


def test_frozen_runs_restart_the_exe_and_source_runs_the_module():
    flags = ["--no-live", "--start-minimized", "--no-obs"]
    assert relaunch_command(flags, frozen=True, executable="C:/SC2 Tools/sc2tools-agent.exe") == [
        "C:/SC2 Tools/sc2tools-agent.exe", "--no-live", "--no-obs"]
    assert relaunch_command(flags, frozen=False, executable="C:/Python312/pythonw.exe") == [
        "C:/Python312/pythonw.exe", "-m", "sc2tools_agent", "--no-live", "--no-obs"]
    # Without argv, this run's own flags; the window always comes back.
    assert relaunch_command(None, frozen=False)[:3] == [sys.executable, "-m", "sc2tools_agent"]


def test_the_spawn_is_detached_and_uses_the_launch_environment(monkeypatch):
    popen = Mock()
    monkeypatch.setattr(relaunch.subprocess, "Popen", popen)
    restart = AgentRelaunch(["--no-live"], frozen=True, environ={"PATH": "C:/Windows"})
    assert restart.start_if_requested() is False and not popen.called  # nothing until a restart is asked for
    restart.request()
    assert restart.start_if_requested() is True
    command, options = popen.call_args.args[0], popen.call_args.kwargs
    assert command == [sys.executable, "--no-live"]
    assert options["env"] == {"PATH": "C:/Windows", "SC2TOOLS_RESTARTED": "1", "PYINSTALLER_RESET_ENVIRONMENT": "1"}
    assert (options["stdin"], options["stdout"], options["stderr"]) == (subprocess.DEVNULL,) * 3
    if os.name == "nt":
        assert options["creationflags"] == subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        assert options["start_new_session"] is True
    source = AgentRelaunch([], frozen=False, environ={"PATH": "C:/Windows"})
    assert "PYINSTALLER_RESET_ENVIRONMENT" not in source.environ


def test_a_failed_spawn_is_logged_not_raised(monkeypatch, caplog):
    monkeypatch.setattr(relaunch.subprocess, "Popen", Mock(side_effect=OSError("blocked")))
    restart = AgentRelaunch([], frozen=False)
    restart.request()
    with caplog.at_level("ERROR"):
        assert restart.start_if_requested() is False
    assert "agent_relaunch_failed" in caplog.text


def test_run_agent_starts_the_new_copy_only_after_releasing_the_lock(monkeypatch, tmp_path):
    events = []
    lock = Mock()
    lock.acquire.return_value = True
    lock.release.side_effect = lambda: events.append("lock released")
    monkeypatch.delenv("SC2TOOLS_API_BASE", raising=False)

    def bootstrap(_args, configure_logging=False):
        # Promoted from saved settings; a restart must read them afresh instead.
        monkeypatch.setenv("SC2TOOLS_API_BASE", "https://old.example.test")
        return SimpleNamespace(state_dir=tmp_path), tmp_path

    def locked(_cfg, _args, _argv, *, relaunch):
        relaunch.request()
        events.append("agent stopped")
        return 0

    popen = Mock(side_effect=lambda command, **options: events.append("spawned"))
    monkeypatch.setattr(runner, "_bootstrap", bootstrap)
    monkeypatch.setattr(runner, "AgentInstanceLock", lambda _path: lock)
    monkeypatch.setattr(runner, "_run_locked_agent", locked)
    monkeypatch.setattr(relaunch.subprocess, "Popen", popen)
    assert runner.run_agent(["--no-live", "--start-minimized"]) == 0
    assert events == ["agent stopped", "lock released", "spawned"]
    assert popen.call_args.args[0][-1] == "--no-live" and "--start-minimized" not in popen.call_args.args[0]
    assert "SC2TOOLS_API_BASE" not in popen.call_args.kwargs["env"]


def test_a_restarted_copy_shows_its_window_though_start_minimized_is_saved(monkeypatch, tmp_path):
    monkeypatch.setenv("SC2TOOLS_STATE_DIR", str(tmp_path))  # never the real state folder
    save_state(tmp_path, AgentState(start_minimized=True))
    restart = AgentRelaunch(["--no-live", "--start-minimized"], frozen=False)
    started = []
    monkeypatch.setattr(runner, "AgentInstanceLock", lambda _path: Mock(**{"acquire.return_value": True}))
    monkeypatch.setattr(runner, "_run_locked_agent",
                        lambda _cfg, args, _argv, **_kwargs: started.append(args.start_minimized) or 0)
    # The new copy: the relaunch command line and environment, through the real _bootstrap.
    monkeypatch.setenv(relaunch.RESTARTED_ENV, restart.environ[relaunch.RESTARTED_ENV])
    assert runner.run_agent(restart.command[3:]) == 0
    assert started == [False]
    # The marker is gone, so nothing that copy starts inherits it; a later normal start minimizes again.
    assert relaunch.RESTARTED_ENV not in os.environ
    assert runner.run_agent([]) == 0
    assert started == [False, True]


def test_restart_agent_from_the_window_requests_a_relaunch_then_quits(monkeypatch, tmp_path):
    gui_cls = Mock(name="GuiUI")
    gui = gui_cls.return_value
    gui.run.side_effect = lambda: gui_cls.call_args.kwargs["on_restart_agent"]() or 0
    monkeypatch.setattr(runner, "GuiUI", gui_cls)
    monkeypatch.setattr(runner, "can_use_tray", lambda: False)
    monkeypatch.setattr(runner, "ConsoleUI", Mock(name="ConsoleUI"))
    monkeypatch.setattr(runner, "_gui_boot_worker", lambda **_: None)
    monkeypatch.setattr(runner, "_build_stream_service", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_discover_replay_folders", lambda *_: [])
    monkeypatch.setattr(runner.autostart, "is_enabled", lambda: False)
    save_state(tmp_path, AgentState(device_token="t"))
    cfg = AgentConfig(api_base="https://api.sc2tools.com", state_dir=tmp_path, replay_folder=None,
                      poll_interval_sec=10, parse_concurrency=1)
    restart = AgentRelaunch([], frozen=False)
    assert runner._run_with_gui(cfg, tmp_path, start_minimized=True, relaunch=restart) == 0
    assert restart.requested and gui.request_quit.called
    # Without a relaunch (tests, older callers) the window gets no restart hook.
    gui_cls.reset_mock()
    gui.run.side_effect = None
    gui.run.return_value = 0
    runner._run_with_gui(cfg, tmp_path, start_minimized=True)
    assert gui_cls.call_args.kwargs["on_restart_agent"] is None

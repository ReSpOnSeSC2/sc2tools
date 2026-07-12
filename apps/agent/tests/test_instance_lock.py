"""Single-instance regression coverage for the desktop agent."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from sc2tools_agent.instance_lock import AgentInstanceLock
from sc2tools_agent import runner


def test_second_agent_for_same_state_dir_is_rejected(tmp_path: Path) -> None:
    first = AgentInstanceLock(tmp_path)
    second = AgentInstanceLock(tmp_path)
    try:
        assert first.acquire() is True
        assert second.acquire() is False
    finally:
        second.release()
        first.release()


def test_lock_can_be_reacquired_after_owner_exits(tmp_path: Path) -> None:
    first = AgentInstanceLock(tmp_path)
    replacement = AgentInstanceLock(tmp_path)
    assert first.acquire() is True
    first.release()
    try:
        assert replacement.acquire() is True
    finally:
        replacement.release()


def test_separate_state_dirs_can_run_independently(tmp_path: Path) -> None:
    first = AgentInstanceLock(tmp_path / "primary")
    second = AgentInstanceLock(tmp_path / "development")
    try:
        assert first.acquire() is True
        assert second.acquire() is True
        assert first.acquire() is True  # idempotent for the owner
    finally:
        second.release()
        first.release()


def test_runner_exits_before_logging_when_an_instance_exists(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    existing = Mock()
    existing.acquire.return_value = False
    configure_logging = Mock()
    monkeypatch.setattr(
        runner,
        "_bootstrap",
        lambda _args, configure_logging=False: (
            SimpleNamespace(state_dir=tmp_path),
            tmp_path / "logs",
        ),
    )
    monkeypatch.setattr(runner, "AgentInstanceLock", lambda _path: existing)
    monkeypatch.setattr(runner, "_configure_logging", configure_logging)

    assert runner.run_agent([]) == 0
    configure_logging.assert_not_called()
    assert "already running" in capsys.readouterr().err

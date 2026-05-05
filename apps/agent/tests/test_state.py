"""Tests for agent.state - atomic write + round-trip + GUI prefs."""

from __future__ import annotations

import json
from pathlib import Path

from sc2tools_agent.state import AgentState, load_state, save_state


def test_load_state_returns_defaults_when_file_missing(tmp_path: Path) -> None:
    state = load_state(tmp_path)
    assert state.device_token is None
    assert state.user_id is None
    assert state.uploaded == {}
    assert not state.is_paired
    # New GUI defaults.
    assert state.api_base_override is None
    assert state.log_level_override is None
    assert state.autostart_enabled is False
    assert state.start_minimized is False


def test_save_then_load_roundtrips(tmp_path: Path) -> None:
    s = AgentState(
        device_token="t-abc",
        user_id="u-1",
        paired_at="2026-05-04T00:00:00+00:00",
        uploaded={"/path/to/a.SC2Replay": "2026-05-04T00:00:00+00:00"},
    )
    save_state(tmp_path, s)
    loaded = load_state(tmp_path)
    assert loaded.device_token == "t-abc"
    assert loaded.user_id == "u-1"
    assert loaded.is_paired
    assert loaded.uploaded == s.uploaded


def test_save_writes_atomically(tmp_path: Path) -> None:
    s = AgentState(device_token="abc")
    save_state(tmp_path, s)
    target = tmp_path / "agent.json"
    assert target.exists()
    leftover = list(tmp_path.glob("agent.*.tmp"))
    assert leftover == []
    raw = json.loads(target.read_text(encoding="utf-8"))
    assert raw["device_token"] == "abc"


def test_load_state_recovers_from_corrupt_file(tmp_path: Path) -> None:
    (tmp_path / "agent.json").write_text("{not valid json", encoding="utf-8")
    state = load_state(tmp_path)
    assert state.device_token is None


# ---------------- GUI preferences (introduced with the PySide6 window) ----


def test_gui_preferences_roundtrip(tmp_path: Path) -> None:
    s = AgentState(
        device_token="t-abc",
        api_base_override="https://api.example.com",
        log_level_override="DEBUG",
        autostart_enabled=True,
        start_minimized=True,
    )
    save_state(tmp_path, s)

    loaded = load_state(tmp_path)
    assert loaded.api_base_override == "https://api.example.com"
    assert loaded.log_level_override == "DEBUG"
    assert loaded.autostart_enabled is True
    assert loaded.start_minimized is True


def test_blank_string_overrides_load_as_none(tmp_path: Path) -> None:
    """The GUI saves an empty string when the user clears a field; load
    should normalise that to None so AgentConfig falls back to defaults."""
    (tmp_path / "agent.json").write_text(
        json.dumps(
            {
                "device_token": "t-abc",
                "api_base_override": "   ",
                "log_level_override": "",
            }
        ),
        encoding="utf-8",
    )

    loaded = load_state(tmp_path)
    assert loaded.device_token == "t-abc"
    assert loaded.api_base_override is None
    assert loaded.log_level_override is None


def test_unknown_keys_are_ignored(tmp_path: Path) -> None:
    """A future agent version might add new state fields. Older agents
    should drop them silently rather than crash."""
    (tmp_path / "agent.json").write_text(
        json.dumps(
            {
                "device_token": "t-abc",
                "future_field_xyz": True,
                "another_unknown": [1, 2, 3],
            }
        ),
        encoding="utf-8",
    )
    loaded = load_state(tmp_path)
    assert loaded.device_token == "t-abc"

"""Tests for agent.state — atomic write + round-trip."""

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
    # No leftover .tmp files.
    leftover = list(tmp_path.glob("agent.*.tmp"))
    assert leftover == []
    # Round-trip via raw JSON to confirm format.
    raw = json.loads(target.read_text(encoding="utf-8"))
    assert raw["device_token"] == "abc"


def test_load_state_recovers_from_corrupt_file(tmp_path: Path) -> None:
    (tmp_path / "agent.json").write_text("{not valid json", encoding="utf-8")
    state = load_state(tmp_path)
    assert state.device_token is None

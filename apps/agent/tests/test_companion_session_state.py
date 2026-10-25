from __future__ import annotations

from dataclasses import asdict
import json

import pytest

from sc2tools_agent import runner
from sc2tools_agent.state import AgentState, load_state, save_state


def test_session_panel_defaults_off_and_roundtrip_preserves_existing_state(tmp_path):
    assert load_state(tmp_path).companion_session_enabled is False
    state = AgentState(device_token="paired-token", user_id="account", uploaded={"replay": "date"},
                       companion_preferences={"overlaysEnabled": False}, companion_skin="terran",
                       companion_session_enabled=True)
    save_state(tmp_path, state)
    loaded = load_state(tmp_path)
    assert loaded.companion_session_enabled is True
    assert loaded.device_token == state.device_token and loaded.user_id == state.user_id
    assert loaded.uploaded == state.uploaded and loaded.companion_skin == "terran"
    assert loaded.companion_preferences == {"overlaysEnabled": False}


@pytest.mark.parametrize("value", [None, 0, 1, "true", "false", [], {}])
def test_session_preference_requires_a_real_boolean(tmp_path, value):
    (tmp_path / "agent.json").write_text(json.dumps({"companion_session_enabled": value}), encoding="utf-8")
    assert load_state(tmp_path).companion_session_enabled is False
    state = AgentState(companion_session_enabled=value)
    save_state(tmp_path, state)
    assert json.loads((tmp_path / "agent.json").read_text(encoding="utf-8"))["companion_session_enabled"] is False


@pytest.mark.parametrize("error", [OSError("read-only state"), RuntimeError("serialization failed")])
def test_session_preference_rolls_back_memory_and_disk_on_failed_save(tmp_path, monkeypatch, error):
    state = AgentState(device_token="keep", companion_session_enabled=True)
    save_state(tmp_path, state)
    original = asdict(state)
    durable = (tmp_path / "agent.json").read_bytes()

    def fail(directory, candidate):
        assert candidate.companion_session_enabled is False
        raise error

    monkeypatch.setattr(runner, "save_state", fail)
    with pytest.raises(type(error), match=str(error)):
        runner._remember_companion_session(tmp_path, state, False)
    assert asdict(state) == original
    assert (tmp_path / "agent.json").read_bytes() == durable


@pytest.mark.parametrize("value", [None, 0, 1, "true", [], {}])
def test_invalid_session_switch_does_not_mutate_or_save(tmp_path, monkeypatch, value):
    state = AgentState(companion_session_enabled=True)
    saved = []
    monkeypatch.setattr(runner, "save_state", lambda *args: saved.append(args))
    with pytest.raises(ValueError):
        runner._remember_companion_session(tmp_path, state, value)
    assert state.companion_session_enabled is True and saved == []

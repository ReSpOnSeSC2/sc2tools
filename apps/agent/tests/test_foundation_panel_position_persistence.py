import pytest

from sc2tools_agent.runner import _remember_companion_panel_positions
from sc2tools_agent.state import AgentState, load_state


def test_panel_positions_persist_without_changing_account_or_preferences(tmp_path):
    state = AgentState(device_token="fixture", user_id="owner", uploaded={"kept": "2026-10-24"})
    _remember_companion_panel_positions(tmp_path, state, {"opponent": [-200, 50], "session": [100, 70]})
    loaded = load_state(tmp_path)
    assert loaded.companion_panel_positions == {"opponent": [-200, 50], "session": [100, 70]}
    assert loaded.device_token == "fixture" and loaded.user_id == "owner"
    assert loaded.uploaded == state.uploaded
    _remember_companion_panel_positions(tmp_path, state, {})
    assert load_state(tmp_path).companion_panel_positions == {}


def test_failed_position_save_rolls_back_without_losing_existing_positions(tmp_path, monkeypatch):
    state = AgentState(companion_panel_positions={"opponent": [1, 2]})
    def fail(*args):
        raise OSError("fixture")
    monkeypatch.setattr("sc2tools_agent.runner.save_state", fail)
    with pytest.raises(OSError):
        _remember_companion_panel_positions(tmp_path, state, {"session": [3, 4]})
    assert state.companion_panel_positions == {"opponent": [1, 2]}

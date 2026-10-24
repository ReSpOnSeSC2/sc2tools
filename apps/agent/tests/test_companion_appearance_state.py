from __future__ import annotations

from dataclasses import asdict
import json

import pytest

from sc2tools_agent import runner
from sc2tools_agent.state import AgentState, COMPANION_SKINS, load_state, save_state
from .test_build_checkin_ui_runner import gui_run


def test_appearance_defaults_preserve_current_skin_and_allow_animations(tmp_path):
    state = load_state(tmp_path)
    assert state.companion_skin == "default"
    assert state.companion_animations is True
    assert COMPANION_SKINS == {"default", "protoss", "terran", "zerg"}


@pytest.mark.parametrize("skin", ["default", "protoss", "terran", "zerg"])
@pytest.mark.parametrize("animations", [True, False])
def test_appearance_roundtrip_never_changes_pairing_or_other_preferences(tmp_path, skin, animations):
    state = AgentState(device_token="paired-token", user_id="account", uploaded={"replay": "2026-10-23"},
                       window_information_layout="detailed", companion_preferences={"overlaysEnabled": False},
                       companion_ghost={"enabled": True}, companion_skin=skin, companion_animations=animations)
    save_state(tmp_path, state)
    loaded = load_state(tmp_path)
    assert loaded.companion_skin == skin
    assert loaded.companion_animations is animations
    assert loaded.device_token == "paired-token" and loaded.user_id == "account"
    assert loaded.uploaded == state.uploaded
    assert loaded.window_information_layout == "detailed"
    assert loaded.companion_preferences == {"overlaysEnabled": False}
    assert loaded.companion_ghost == {"enabled": True}


@pytest.mark.parametrize("value", [None, True, False, 0, 1, [], {}, "", "PROTOSS", " zerg", "custom"])
def test_invalid_skin_falls_back_without_losing_pairing(tmp_path, value):
    (tmp_path / "agent.json").write_text(json.dumps({"device_token": "keep", "companion_skin": value}), encoding="utf-8")
    loaded = load_state(tmp_path)
    assert loaded.companion_skin == "default"
    assert loaded.device_token == "keep"


@pytest.mark.parametrize("value", [None, 0, 1, "false", "true", [], {}])
def test_animation_preference_requires_a_real_boolean(tmp_path, value):
    (tmp_path / "agent.json").write_text(json.dumps({"companion_animations": value}), encoding="utf-8")
    assert load_state(tmp_path).companion_animations is True


def test_save_sanitizes_invalid_appearance_without_mutating_shared_state(tmp_path):
    state = AgentState(companion_skin={"invalid": True}, companion_animations="false", device_token="keep")
    save_state(tmp_path, state)
    raw = json.loads((tmp_path / "agent.json").read_text(encoding="utf-8"))
    assert raw["companion_skin"] == "default" and raw["companion_animations"] is True
    assert state.companion_skin == {"invalid": True} and state.companion_animations == "false"
    assert raw["device_token"] == "keep"


@pytest.mark.parametrize("error", [OSError("read-only state"), RuntimeError("serialization failed")])
def test_runner_rolls_back_both_appearance_choices_on_save_failure(tmp_path, monkeypatch, error):
    state = AgentState(companion_skin="terran", companion_animations=False, device_token="keep")
    save_state(tmp_path, state)
    before = asdict(state)
    durable = (tmp_path / "agent.json").read_bytes()

    def fail(directory, candidate):
        assert candidate.companion_skin == "zerg" and candidate.companion_animations is True
        raise error

    monkeypatch.setattr(runner, "save_state", fail)
    with pytest.raises(type(error), match=str(error)):
        runner._remember_window_appearance(tmp_path, state, "zerg", True)
    assert asdict(state) == before
    assert (tmp_path / "agent.json").read_bytes() == durable


@pytest.mark.parametrize("skin,animations", [("unknown", True), ([], True), ("default", 0), ("zerg", "false")])
def test_invalid_runner_appearance_never_mutates_or_saves(tmp_path, monkeypatch, skin, animations):
    state = AgentState(companion_skin="protoss", companion_animations=False)
    before = asdict(state)
    saved = []
    monkeypatch.setattr(runner, "save_state", lambda *args: saved.append(args))
    with pytest.raises(ValueError):
        runner._remember_window_appearance(tmp_path, state, skin, animations)
    assert asdict(state) == before and saved == []


def test_runner_forwards_saved_appearance_and_persists_gui_callback(gui_run, tmp_path):
    save_state(tmp_path, AgentState(device_token="keep", companion_skin="protoss", companion_animations=False,
                                    companion_preferences={"opponentOverlay": True}, window_information_layout="standard"))
    gui_kwargs, tray_kwargs = gui_run(no_live=True)
    assert gui_kwargs["window_skin"] == "protoss"
    assert gui_kwargs["window_animations"] is False
    gui_kwargs["on_window_appearance"]("zerg", True)
    loaded = load_state(tmp_path)
    assert loaded.companion_skin == "zerg" and loaded.companion_animations is True
    assert loaded.device_token == "keep"
    assert loaded.companion_preferences == {"opponentOverlay": True}
    assert loaded.window_information_layout == "standard"

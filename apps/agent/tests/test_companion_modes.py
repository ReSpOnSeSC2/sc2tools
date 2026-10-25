from copy import deepcopy
import json

import pytest

from sc2tools_agent.companion import CompanionClient, CompanionError
from sc2tools_agent.companion_modes import default_modes, effective_mode_features, normalize_modes, validate_modes
from sc2tools_agent.state import AgentState, load_state, save_state


def test_defaults_preserve_ladder_controls_and_profiles_are_independent():
    modes = default_modes()
    assert modes["active"] == "ladder" and modes["hotkeyEnabled"] is False
    assert all(modes["profiles"]["ladder"].values())
    assert all(modes["profiles"]["customs"].values())
    assert not any(modes["profiles"]["review"].values())
    assert modes["profiles"]["practice"]["ghost"] is True
    assert modes["profiles"]["practice"]["randomizer"] is False
    modes["profiles"]["customs"]["ghost"] = False
    assert modes["profiles"]["ladder"]["ghost"] is True


def test_modes_load_tolerantly_but_changes_are_validated_strictly():
    modes = normalize_modes({"active": [], "hotkeyEnabled": "true", "profiles": {
        "practice": {"ghost": False, "randomizer": "true"}, "unknown": {"ghost": True},
    }})
    assert modes["active"] == "ladder" and modes["hotkeyEnabled"] is False
    assert not modes["profiles"]["practice"]["ghost"]
    assert not modes["profiles"]["practice"]["randomizer"]
    for value in (None, [], {"active": []}, {"active": "auto"}, {"hotkeyEnabled": 1},
                  {"profiles": {"ladder": {"ghost": "false"}}}, {"profiles": {"unknown": {}}},
                  {"profiles": {"ladder": {"unknown": False}}}, {"unknown": True}):
        with pytest.raises(ValueError):
            validate_modes(value)


def test_teams_is_manual_and_only_verified_human_one_on_one_can_unlock_customized_gates():
    modes = default_modes()
    modes["active"] = "teams"
    modes["profiles"]["teams"] = deepcopy(modes["profiles"]["ladder"])
    for envelope in ({}, {"players": [{"type": "user"}]},
                     {"players": [{"type": "user"}] * 4},
                     {"players": [{"type": "user"}, {"type": "computer"}]},
                     {"players": [{"type": "user"}] * 2, "isReplay": True}):
        gates = effective_mode_features(modes, {"liveGame": envelope})
        assert gates["mode"] == "teams"
        assert not any(value for key, value in gates.items() if key != "mode")
    verified = {"liveGame": {"players": [{"type": "user"}] * 2}}
    assert effective_mode_features(modes, verified)["ghost"] is True
    assert effective_mode_features(default_modes(), verified)["mode"] == "ladder"


def test_local_modes_persist_offline_without_mutating_pairing_or_account_preferences(tmp_path):
    state = AgentState(device_token="paired-token", uploaded={"replay": "2026-10-23"},
                       companion_preferences={"overlaysEnabled": False, "opponentOverlay": True},
                       build_checkin_prefs={"enabled": True, "askAtLoading": True, "askAfterGame": True})
    saved_preferences = deepcopy(state.companion_preferences)
    saved_checkins = deepcopy(state.build_checkin_prefs)

    def save(modes):
        state.companion_modes = modes
        save_state(tmp_path, state)

    def unexpected_network(*args, **kwargs):
        pytest.fail("Mode changes must be local and work without an OBS source or account request")

    client = CompanionClient(lambda: ("https://api.example.test", None),
                             modes_provider=lambda: state.companion_modes,
                             save_modes=save, transport=unexpected_network)
    modes = default_modes()
    modes["active"] = "customs"
    modes["hotkeyEnabled"] = True
    modes["profiles"]["customs"]["randomizer"] = False
    assert client.action({"action": "companion_modes", "modes": modes}) == {"modes": modes}
    assert client.action({"action": "snapshot"})["modes"] == modes
    assert client.action({"action": "companion_modes"}) == {
        "modes": modes, "preferences": {"overlaysEnabled": False, "opponentOverlay": False, "scoutingOverlay": False, "scoutingReadAloud": False},
        "sessionEnabled": False,
    }
    loaded = load_state(tmp_path)
    assert loaded.companion_modes == modes
    assert loaded.companion_preferences == saved_preferences
    assert loaded.build_checkin_prefs == saved_checkins
    assert loaded.device_token == "paired-token" and loaded.uploaded == state.uploaded
    assert "paired-token" not in repr(client.action({"action": "companion_modes"}))


def test_old_state_defaults_modes_and_bad_changes_never_save(tmp_path):
    (tmp_path / "agent.json").write_text(json.dumps({"companion_modes": {"active": "retired"}}), encoding="utf-8")
    assert load_state(tmp_path).companion_modes == default_modes()
    calls = []
    client = CompanionClient(lambda: ("https://api.example.test", None), save_modes=calls.append)
    with pytest.raises(CompanionError):
        client.action({"action": "companion_modes", "modes": {"hotkeyEnabled": "true"}})
    assert not calls


def test_mode_save_errors_are_safe_and_recoverable():
    def fail(_modes):
        raise OSError("private-path-token")

    client = CompanionClient(lambda: ("https://api.example.test", None), save_modes=fail)
    with pytest.raises(CompanionError) as failure:
        client.action({"action": "companion_modes", "modes": default_modes()})
    assert "could not be saved" in str(failure.value)
    assert "private" not in str(failure.value)

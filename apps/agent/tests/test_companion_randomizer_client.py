from copy import deepcopy
from types import SimpleNamespace

import pytest

from sc2tools_agent.companion import CompanionClient, CompanionError


def response(payload, status=200):
    return SimpleNamespace(status_code=status, json=lambda: payload)


@pytest.fixture
def client_state():
    state = {"calls": [], "config": {"version": 2, "sound": {"enabled": False, "volume": 0.3}, "matchups": {
        "PvZ": {"enabled": True, "useCustomWeights": True, "unitRandomizerEnabled": True,
                "builds": [{"id": "first", "name": "Old name", "race": "Protoss", "source": "catalog", "weight": 5,
                            "openingUnits": {"gateCount": 2, "units": [{"id": "adept", "weight": 1}]}}]},
        "TvT": {"enabled": True, "builds": [{"id": "other", "name": "Other matchup"}]},
    }}}

    def transport(method, url, **kwargs):
        state["calls"].append((method, url, kwargs))
        if method == "GET" and url.endswith("/preferences/randomizer"):
            return response(deepcopy(state["config"]))
        if method == "GET" and url.endswith("/build-intents/options"):
            return response({"builds": [{"key": "first", "name": "Canonical name", "source": "catalog"},
                                        {"key": "custom:second", "name": "My build", "source": "custom"}]})
        if method == "GET" and "/build-intents/live/" in url:
            return response({}, 404)
        if method == "PUT":
            state["config"] = deepcopy(kwargs["json"])
            return response(deepcopy(state["config"]))
        if method == "POST":
            return response({"gameKey": "Opp|Streamer|1790000000000", "randomizer": {"key": "first", "name": "Canonical name"}})
        raise AssertionError((method, url))

    client = CompanionClient(lambda: ("https://api.example.test", "private-token"), transport=transport)
    return client, state


def test_randomizer_state_loads_shared_settings_options_and_optional_current_intent(client_state):
    client, state = client_state
    result = client.action({"action": "randomizer_state", "matchup": "PvZ", "gameKey": "Opp|Streamer|1790000000000"})
    assert result["config"] == state["config"]
    assert result["options"]["builds"][0]["key"] == "first"
    assert result["intent"] == {}
    assert state["calls"][1][2]["params"] == {"matchup": "PvZ"}
    assert state["calls"][2][1].endswith("/live/Opp%7CStreamer%7C1790000000000")
    assert "private-token" not in repr(result)


def test_native_roll_uses_canonical_server_endpoint_instead_of_only_releasing_hold(client_state):
    client, state = client_state
    result = client.action({"action": "randomizer_roll", "matchup": "PvZ", "gameKey": "Opp|Streamer|1790000000000", "releaseHold": True})
    method, url, kwargs = state["calls"][-1]
    assert method == "POST" and url.endswith("/live/Opp%7CStreamer%7C1790000000000/randomizer")
    assert kwargs["json"] == {"matchup": "PvZ", "releaseHold": True}
    assert result["randomizer"]["name"] == "Canonical name"


def test_pool_edits_preserve_other_matchups_weights_and_opening_units(client_state):
    client, state = client_state
    original = deepcopy(state["config"])
    client.action({"action": "randomizer_settings", "matchup": "PvZ", "enabled": False, "buildKeys": ["first", "custom:second"]})
    saved = state["config"]
    assert saved["sound"] == original["sound"]
    assert saved["matchups"]["TvT"] == original["matchups"]["TvT"]
    own = saved["matchups"]["PvZ"]
    assert own["enabled"] is False and own["useCustomWeights"] is True
    assert own["builds"][0]["name"] == "Canonical name"
    assert own["builds"][0]["weight"] == 5
    assert own["builds"][0]["openingUnits"] == original["matchups"]["PvZ"]["builds"][0]["openingUnits"]
    assert own["builds"][1] == {"id": "custom:second", "name": "My build", "race": "Protoss", "source": "custom", "weight": 1}


@pytest.mark.parametrize("updates", [{"enabled": "false"}, {"buildKeys": ["unknown"]},
                                     {"buildKeys": ["first", "first"]}, {"buildKeys": "first"}])
def test_invalid_pool_mutations_never_write_preferences(client_state, updates):
    client, state = client_state
    with pytest.raises(CompanionError):
        client.action({"action": "randomizer_settings", "matchup": "PvZ", **updates})
    assert not any(call[0] == "PUT" for call in state["calls"])


@pytest.mark.parametrize("updates", [{"matchup": "Random"}, {"gameKey": "invalid"}, {"releaseHold": "true"}])
def test_invalid_native_roll_inputs_never_send_a_request(client_state, updates):
    client, state = client_state
    with pytest.raises(CompanionError):
        client.action({"action": "randomizer_roll", "matchup": "PvZ", "gameKey": "Opp|Streamer|1790000000000", "releaseHold": True, **updates})
    assert state["calls"] == []


def test_expected_conflicts_show_safe_recoverable_messages():
    client = CompanionClient(lambda: ("https://api.example.test", "private-token"),
        transport=lambda *args, **kwargs: response({"error": {"code": "hold_active", "message": "private-server-data"}}, 409))
    with pytest.raises(CompanionError, match="loading check-in") as failure:
        client.action({"action": "randomizer_roll", "matchup": "PvZ", "gameKey": "Opp|Streamer|1790000000000", "releaseHold": False})
    assert failure.value.code == "hold_active"
    assert "private" not in str(failure.value)

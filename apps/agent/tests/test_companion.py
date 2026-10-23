from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
import requests

from sc2tools_agent.companion import CompanionClient, CompanionError, DEFAULT_PREFERENCES
from sc2tools_agent.state import AgentState, load_state, save_state


def response(payload, status=200):
    return SimpleNamespace(status_code=status, json=lambda: payload)


def test_pairing_is_reused_and_credentials_are_not_returned():
    connection = ["https://api.example.test", None]
    calls = []
    client = CompanionClient(lambda: connection, transport=lambda *args, **kwargs: (
        calls.append((args, kwargs)) or response({"liveGame": {"phase": "menu"}})
    ))
    assert client.action({"action": "snapshot"}) == {
        "paired": False, "liveGame": None, "live": None, "preferences": DEFAULT_PREFERENCES,
    }
    assert not calls
    connection[1] = "paired-device-token"
    snapshot = client.action({"action": "snapshot"})
    assert snapshot["paired"] is True
    assert "paired-device-token" not in repr(snapshot)
    assert calls[0][0] == ("GET", "https://api.example.test/v1/me/live/snapshot")
    assert calls[0][1]["headers"]["Authorization"] == "Bearer paired-device-token"
    assert calls[0][1]["allow_redirects"] is False


@pytest.mark.parametrize("phase", ["match_in_progress", "match_ended"])
@pytest.mark.parametrize("game_key,old_key", [("new", "old"), (None, "old"), ("new", None)])
def test_new_match_drops_stale_postgame_scouting(game_key, old_key, phase):
    client = CompanionClient(lambda: ("https://api.example.test", "token"),
        transport=lambda *args, **kwargs: response({
            "liveGame": {"phase": phase, "gameKey": game_key},
            "overlayLive": {"gameKey": old_key, "oppName": "Previous opponent"},
        }))
    assert client.action({"action": "snapshot"})["live"] is None


def test_current_postgame_data_is_kept():
    live = {"gameKey": "current", "oppName": "Current opponent"}
    client = CompanionClient(lambda: ("https://api.example.test", "token"),
        transport=lambda *args, **kwargs: response({
            "liveGame": {"phase": "match_ended", "gameKey": "current"}, "overlayLive": live,
        }))
    assert client.action({"action": "snapshot"})["live"] == live


def test_directory_and_notes_use_owned_endpoints_and_bounded_inputs():
    calls = []

    def transport(*args, **kwargs):
        calls.append((args, kwargs))
        if args[0] == "PUT":
            return response(kwargs["json"])
        return response({"items": [{"pulseId": "a/b", "displayNameSample": "Barcode",
                                  "revealedName": "Player", "gameCount": 4}],
                         "nextBefore": "2026-10-01T00:00:00Z"})

    client = CompanionClient(lambda: ("https://api.example.test", "token"), transport=transport)
    page = client.action({"action": "opponents", "before": "2026-10-20T00:00:00Z"})
    assert page["items"][0]["name"] == "Player"
    assert page["items"][0]["total"] == 4
    assert page["nextCursor"] == "2026-10-01T00:00:00Z"
    assert calls[-1][1]["params"] == {"limit": 100, "before": "2026-10-20T00:00:00Z"}
    client.action({"action": "opponent", "pulseId": "a/b"})
    assert calls[-1][0][1].endswith("/opponents/a%2Fb")
    assert client.action({"action": "save_notes", "pulseId": "a/b", "text": "Scout the third",
                          "readAloud": True}) == {"notes": "Scout the third", "notesReadAloud": True}
    assert calls[-1][0][0] == "PUT"
    assert calls[-1][0][1].endswith("/opponents/a%2Fb/notes")
    before = len(calls)
    with pytest.raises(CompanionError):
        client.action({"action": "save_notes", "pulseId": "a/b", "text": "x" * 501})
    with pytest.raises(CompanionError):
        client.action({"action": "save_notes", "pulseId": "a/b", "text": "\U0001f680" * 251})
    assert len(calls) == before


def test_overlay_preferences_persist_without_repairing_or_network(tmp_path):
    state = AgentState(device_token="same-pairing", uploaded={"replay": "2026-10-23"})

    def save(preferences):
        state.companion_preferences = preferences
        save_state(tmp_path, state)

    def unexpected_network(*args, **kwargs):
        pytest.fail("Saving display preferences must work offline")

    client = CompanionClient(lambda: ("https://api.example.test", state.device_token),
        preferences_provider=lambda: state.companion_preferences,
        save_preferences=save, transport=unexpected_network)
    client.action({"action": "preferences", "preferences": {
        "overlaysEnabled": True, "scoutingOverlay": True,
    }})
    client.action({"action": "preferences", "preferences": {"overlaysEnabled": False}})
    loaded = load_state(tmp_path)
    assert loaded.companion_preferences == {
        "overlaysEnabled": False, "opponentOverlay": False, "scoutingOverlay": True,
    }
    assert loaded.device_token == "same-pairing"
    assert loaded.uploaded == state.uploaded


def test_preferences_reject_invalid_switches_and_handle_old_states(tmp_path):
    (tmp_path / "agent.json").write_text(json.dumps({
        "device_token": "old-token", "companion_preferences": {
            "overlaysEnabled": "false", "opponentOverlay": False, "unknown": True,
        },
    }), encoding="utf-8")
    loaded = load_state(tmp_path)
    assert loaded.companion_preferences == {"opponentOverlay": False}
    assert loaded.device_token == "old-token"
    client = CompanionClient(lambda: ("https://api.example.test", "token"))
    for updates in ({"overlaysEnabled": "false"}, {"unknown": True}):
        with pytest.raises(CompanionError):
            client.action({"action": "preferences", "preferences": updates})


@pytest.mark.parametrize("status", [301, 401, 403, 404, 429, 500])
def test_errors_do_not_disclose_server_payload_or_token(status):
    client = CompanionClient(lambda: ("https://api.example.test", "private-token"),
        transport=lambda *args, **kwargs: response({"secret": "private-server-data"}, status))
    with pytest.raises(CompanionError) as failure:
        client.action({"action": "snapshot"})
    assert "private" not in str(failure.value)


def test_timeout_has_a_recoverable_error():
    def transport(*args, **kwargs):
        raise requests.Timeout("private-token in failed URL")

    client = CompanionClient(lambda: ("https://api.example.test", "token"), transport=transport)
    with pytest.raises(CompanionError, match="Check your connection"):
        client.action({"action": "snapshot"})


@pytest.mark.parametrize("base", ["http://remote.example", "https://u:p@example.test", "https://example.test?key=secret"])
def test_insecure_or_credentialed_api_addresses_are_rejected(base):
    client = CompanionClient(lambda: (base, "token"),
        transport=lambda *args, **kwargs: pytest.fail("Credentials must not be sent"))
    with pytest.raises(CompanionError, match="API address"):
        client.action({"action": "snapshot"})

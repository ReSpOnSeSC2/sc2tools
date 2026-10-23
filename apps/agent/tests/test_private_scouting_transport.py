import asyncio
import json
from unittest.mock import Mock, patch

import pytest

from sc2tools_agent.api_client import ApiClient, ApiError
from sc2tools_agent.socket_client import SocketClient
from sc2tools_agent.state import AgentState, load_state, save_state


class RecordingSocket:
    def __init__(self):
        self.handlers = {}

    def event(self, fn):
        return fn

    def on(self, event):
        def register(fn):
            self.handlers[event] = fn
            return fn
        return register


def client(callback):
    return SocketClient(base_url="https://example.test", device_token="old",
                        on_recompute_games=lambda _: None, on_recompute_opp_build=lambda _: None,
                        on_scouting_brief=callback)


def test_scouting_socket_survives_repair_and_delivers_without_logging_private_text(caplog):
    values = []
    repaired = client(values.append).with_device_token("new")
    repaired._sio = RecordingSocket(); repaired._wire_handlers()
    payload = {"gameKey": "current", "note": "PRIVATE note"}
    asyncio.run(repaired._sio.handlers["scouting:brief"](payload))
    assert values == [payload]
    assert "PRIVATE" not in caplog.text


@pytest.mark.parametrize("bad", [None, [], "note", 42])
def test_scouting_socket_ignores_non_object_messages(bad):
    values = []; socket = client(values.append)
    socket._sio = RecordingSocket(); socket._wire_handlers()
    asyncio.run(socket._sio.handlers["scouting:brief"](bad))
    assert not values


def test_scouting_callback_failure_never_logs_the_exception_private_note(caplog):
    def broken(_):
        raise ValueError("PRIVATE note should not escape")
    socket = client(broken); socket._sio = RecordingSocket(); socket._wire_handlers()
    asyncio.run(socket._sio.handlers["scouting:brief"]({"note": "PRIVATE note"}))
    assert "scouting_brief_callback_failed type=ValueError" in caplog.text
    assert "PRIVATE" not in caplog.text


def response(status, payload):
    value = Mock(status_code=status, headers={}, text=json.dumps(payload))
    value.json.return_value = payload
    return value


def test_device_scouting_and_note_calls_are_encoded_private_and_interactive():
    api = ApiClient(base_url="https://example.test", device_token="paired")
    with patch("requests.request", return_value=response(200, {"ok": True})) as send:
        api.get_scouting_brief("key/name?private")
        api.put_opponent_note("1-1-1-42", "Private note")
    assert send.call_args_list[0].args == ("GET", "https://example.test/v1/agent/live/scouting?gameKey=key%2Fname%3Fprivate")
    assert send.call_args_list[1].kwargs["json"] == {"notes": "Private note", "notesReadAloud": False}
    for call in send.call_args_list:
        assert call.kwargs["headers"]["authorization"] == "Bearer paired"
        assert call.kwargs["timeout"][1] == 5


def test_private_scouting_fallback_fails_fast_without_sleeping():
    api = ApiClient(base_url="https://example.test", device_token="paired")
    with patch("requests.request", return_value=response(503, {"error": {"code": "busy"}})) as send, patch("time.sleep") as sleep:
        with pytest.raises(ApiError):
            api.get_scouting_brief("current")
    assert send.call_count == 1
    sleep.assert_not_called()


def test_local_scouting_preference_defaults_on_and_round_trips_off(tmp_path):
    assert load_state(tmp_path).show_scouting_at_loading is True
    save_state(tmp_path, AgentState(show_scouting_at_loading=False))
    assert load_state(tmp_path).show_scouting_at_loading is False

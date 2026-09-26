"""Process evidence must precede cleanup and must never change game results."""

import asyncio
from collections import deque
from types import SimpleNamespace as NS

import pytest
import aiohttp

from pluto_sc2.league_client import _diagnostic_context
from pluto_sc2.runner import DiagnosticSC2WebSocket, ManagedSC2Process


def owned_engine(monkeypatch, exit_code=None):
    engine = object.__new__(ManagedSC2Process)
    state = {"exit_code": exit_code}
    engine._process = NS(pid=123, poll=lambda: state["exit_code"])
    engine._managed_created_at = 100.5
    engine._port = 4567
    engine._ws = NS(closed=True, close_code=1006, exception=lambda: OSError("connection reset"))
    monkeypatch.setattr(ManagedSC2Process, "_active", {engine})
    monkeypatch.setattr(ManagedSC2Process, "_previous_sigint", None)
    monkeypatch.setattr(ManagedSC2Process, "_lifecycle_events", deque(maxlen=64))
    return engine, state


@pytest.mark.parametrize("exit_code", [None, 0, 3221225477])
def test_capture_child_exit_before_any_owned_cleanup(monkeypatch, exit_code):
    engine, state = owned_engine(monkeypatch, exit_code)
    calls = []

    async def close():
        calls.append("close")
        assert ManagedSC2Process._lifecycle_events[0]["exit_code"] == exit_code

    def clean(**_):
        calls.append("clean")
        assert ManagedSC2Process._lifecycle_events[-1]["phase"] == "before_owned_cleanup"
        assert ManagedSC2Process._lifecycle_events[-1]["exit_code"] == exit_code
        state["exit_code"] = -15
        engine._process = None

    engine._close_connection = close
    engine._clean = clean
    error = OSError("API disconnected")
    asyncio.run(engine.__aexit__(OSError, error, None))

    assert calls == ["close", "clean"]
    events = list(ManagedSC2Process._lifecycle_events)
    assert [event["phase"] for event in events] == ["before_connection_close", "before_owned_cleanup"]
    assert all(event["exit_code"] == exit_code for event in events)
    assert all(event["pid"] == 123 and event["process_created_at"] == 100.5 for event in events)
    assert events[0]["context_error"] == "OSError: API disconnected"
    assert events[0]["process_running"] is (exit_code is None)
    assert events[0]["exit_code_hex"] == (f"0x{exit_code & 0xffffffff:08X}" if exit_code is not None else None)
    assert not ManagedSC2Process._active


def test_failed_socket_has_only_its_owned_process_diagnostics(monkeypatch):
    engine, _state = owned_engine(monkeypatch, 3221225477)
    client = NS(_ws=engine._ws, _status=NS(name="in_game"), _player_id=2, _game_result=None)
    player = NS(name="Terran snapshot", race=NS(name="Terran"), ai=NS(error="disconnected"))
    context = _diagnostic_context("_play_game", (player, client), {})
    evidence = context["owned_engine"]
    assert evidence["exit_code_hex"] == "0xC0000005"
    assert evidence["websocket_closed"] is True
    assert evidence["websocket_close_code"] == 1006
    assert evidence["websocket_error"] == "OSError: connection reset"
    assert context["engine_results"] is None
    assert ManagedSC2Process.diagnostic_for_websocket(object()) is None
    assert ManagedSC2Process.diagnostic_for_websocket(None) is None


def test_unavailable_diagnostic_does_not_replace_original_error_or_skip_cleanup(monkeypatch):
    engine, _state = owned_engine(monkeypatch)

    def inaccessible():
        raise PermissionError("not readable")

    engine._process.poll = inaccessible
    engine._ws.exception = inaccessible
    cleaned = []

    async def close():
        raise OSError("original close error")

    engine._close_connection = close
    engine._clean = lambda **_: cleaned.append(True)
    with pytest.raises(OSError, match="original close error"):
        asyncio.run(engine.__aexit__(None, None, None))
    assert cleaned == [True]
    evidence = ManagedSC2Process._lifecycle_events[0]
    assert evidence["exit_code"] is None
    assert evidence["process_running"] is None
    assert len(evidence["diagnostic_errors"]) == 2


def test_connection_close_can_reveal_exit_without_misattributing_cleanup(monkeypatch):
    engine, state = owned_engine(monkeypatch)

    async def close():
        state["exit_code"] = 3221225477

    engine._close_connection = close
    engine._clean = lambda **_: None
    asyncio.run(engine.__aexit__(None, None, None))
    first, second = ManagedSC2Process._lifecycle_events
    assert first["exit_code"] is None
    assert second["exit_code_hex"] == "0xC0000005"


def test_first_parser_error_survives_aiohttp_close_error_and_later_closed_frame(monkeypatch):
    original = aiohttp.WebSocketError(1009, "Message size 5000000 exceeds limit 4194304")
    frames = iter([aiohttp.WSMessage(aiohttp.WSMsgType.ERROR, original, ""),
                   aiohttp.WSMessage(aiohttp.WSMsgType.CLOSED, None, None)])

    async def receive(*_, **__):
        return next(frames)

    monkeypatch.setattr(aiohttp.ClientWebSocketResponse, "receive", receive)
    websocket = object.__new__(DiagnosticSC2WebSocket)
    with pytest.raises(aiohttp.WSMessageTypeError, match="Message size"):
        asyncio.run(websocket.receive_bytes())
    evidence = dict(websocket._first_receive_failure)
    assert evidence["type"] == "ERROR"
    assert "4194304" in evidence["error"]
    with pytest.raises(aiohttp.WSMessageTypeError):
        asyncio.run(websocket.receive_bytes())
    assert websocket._first_receive_failure == evidence


def test_binary_observations_are_returned_unchanged_and_not_copied_into_diagnostics(monkeypatch):
    payload = b"game observation bytes"

    async def receive(*_, **__):
        return aiohttp.WSMessage(aiohttp.WSMsgType.BINARY, payload, "")

    monkeypatch.setattr(aiohttp.ClientWebSocketResponse, "receive", receive)
    websocket = object.__new__(DiagnosticSC2WebSocket)
    assert asyncio.run(websocket.receive_bytes()) is payload
    assert websocket._last_binary_size == len(payload)
    assert not hasattr(websocket, "_first_receive_failure")


def test_read_timeout_is_preserved_and_not_swallowed(monkeypatch):
    original = TimeoutError("original receive deadline")

    async def receive(*_, **__):
        raise original

    monkeypatch.setattr(aiohttp.ClientWebSocketResponse, "receive", receive)
    websocket = object.__new__(DiagnosticSC2WebSocket)
    with pytest.raises(TimeoutError) as captured:
        asyncio.run(websocket.receive_bytes())
    assert captured.value is original
    assert websocket._first_receive_failure["type"] == "raised"


def test_underlying_reader_cause_is_preserved_separately_from_close_failure(monkeypatch):
    engine, _state = owned_engine(monkeypatch)
    engine._ws._reader = NS(exception=lambda: aiohttp.WebSocketError(1009, "message too large"))
    evidence = engine.diagnostic_snapshot()
    assert "message too large" in evidence["websocket_reader_error"]
    assert evidence["websocket_error"] == "OSError: connection reset"

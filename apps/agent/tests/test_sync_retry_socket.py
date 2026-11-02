import asyncio
import json
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sc2tools_agent.socket_client import SocketClient
from sc2tools_agent.sync_retry_socket import SyncRetrySocket

DEVICE, SESSION = "a" * 24, "namespace-session"


def fixture(callback=None):
    client = SimpleNamespace(_stop=threading.Event(), _device_connected=True, _device_token="synthetic",
                             _sio=SimpleNamespace(sid="engine-io-id", get_sid=lambda **_: SESSION))
    callback = callback or Mock(return_value=("accepted", 3))
    protocol = SyncRetrySocket(client, callback, clock=lambda: 1.0)
    protocol.ready({"version": 1, "deviceId": DEVICE, "sessionId": SESSION})
    return protocol, client, callback


def packet(**changes):
    return {"requestId": "b" * 32, "deviceId": DEVICE, "sessionId": SESSION,
            "reason": "player_unresolved", "expiresAt": 10000, **changes}


def test_new_protocol_is_count_only_idempotent_and_never_full_resync():
    protocol, _client, callback = fixture()
    raw = packet()
    first = asyncio.run(protocol.request(raw)); first["count"] = 99
    second = asyncio.run(protocol.request(raw))
    assert second == {**{key: raw[key] for key in ("requestId", "deviceId", "sessionId", "reason")}, "code": "accepted", "count": 3}
    assert callback.call_count == 1
    assert asyncio.run(protocol.request(packet(reason="parse_failed")))["code"] == "invalid_request"
    assert "synthetic" not in json.dumps(second)


@pytest.mark.parametrize("changes", [{"reason": "filtered"}, {"reason": "ai_game"}, {"reason": "resumed_replay"},
    {"reason": "no_result"}, {"reason": []}, {"expiresAt": True}, {"expiresAt": float("nan")},
    {"requestId": "PrivateDisplay"}, {"deviceId": "bad"}, {"paths": ["C:/PrivateReplay"]}])
def test_strict_request_never_echoes_unvalidated_private_fields_or_calls_worker(changes):
    protocol, _client, callback = fixture()
    reply = asyncio.run(protocol.request(packet(**changes)))
    assert reply["code"] == "invalid_request" and reply["count"] == 0
    assert not any(value in json.dumps(reply) for value in ("PrivateDisplay", "PrivateReplay"))
    callback.assert_not_called()


@pytest.mark.parametrize("changes", [{"version": True}, {"version": "1"}, {"version": 0},
    {"deviceId": "bad"}, {"sessionId": "engine-io-id"}, {"userId": "foreign"}])
def test_advisory_binding_cannot_claim_another_namespace_session(changes):
    protocol, _client, callback = fixture(); protocol.retire()
    protocol.ready({"version": 1, "deviceId": DEVICE, "sessionId": SESSION, **changes})
    assert asyncio.run(protocol.request(packet()))["code"] == "owner_changed"
    callback.assert_not_called()


@pytest.mark.parametrize("expiry", [999, 1000, 16001])
def test_expired_or_unbounded_deadline_never_dispatches(expiry):
    protocol, _client, callback = fixture()
    assert asyncio.run(protocol.request(packet(expiresAt=expiry)))["code"] == "expired"
    callback.assert_not_called()


@pytest.mark.parametrize("retire", ["disconnect", "stop", "epoch", "expiry"])
def test_background_work_keeps_loop_responsive_and_retires_held_ack(retire):
    entered, release = threading.Event(), threading.Event()
    now = [1.0]
    seen = []
    def worker(raw, token, current):
        seen.append((raw, token, current)); entered.set()
        assert release.wait(3)
        return "accepted", 2
    protocol, client, _callback = fixture(worker); protocol.clock = lambda: now[0]
    async def run():
        task = asyncio.create_task(protocol.request(packet()))
        try:
            for _ in range(300):
                if entered.is_set(): break
                await asyncio.sleep(0.001)
            assert entered.is_set()
            assert (await protocol.request(packet(requestId="c" * 32)))["code"] == "busy"
            if retire == "disconnect": client._device_connected = False
            elif retire == "stop": client._stop.set()
            elif retire == "epoch": protocol.retire(); protocol.ready({"version": 1, "deviceId": DEVICE, "sessionId": SESSION})
            else: now[0] = 10.0
            if retire != "expiry": assert seen[0][2]() is False
        finally:
            release.set()
        result = await asyncio.wait_for(task, 3)
        assert result["code"] == ("expired" if retire == "expiry" else "owner_changed")
        assert result["count"] == 0
        assert all(entry[2]["code"] != "accepted" for entry in protocol.replies.values())
    asyncio.run(run())


@pytest.mark.parametrize("result", [("accepted", -1), ("accepted", True), ("accepted", 1000000), ("private message", 0), ("busy", 1)])
def test_invalid_worker_result_cannot_claim_success(result):
    protocol, _client, _callback = fixture(Mock(return_value=result))
    assert asyncio.run(protocol.request(packet()))["code"] == "local_error"


def test_worker_exception_and_unsupported_handler_are_fixed_and_private():
    protocol, _client, _callback = fixture(Mock(side_effect=RuntimeError("PrivateDisplay C:/PrivateReplay")))
    answer = asyncio.run(protocol.request(packet()))
    assert answer["code"] == "local_error" and "Private" not in json.dumps(answer)
    assert asyncio.run(protocol.request(packet())) == answer
    _callback.assert_called_once()
    protocol.callback = None
    assert asyncio.run(protocol.request(packet()))["code"] == "unsupported"


def test_request_memory_is_bounded_and_retirement_clears_it():
    protocol, _client, callback = fixture()
    for number in range(64):
        assert asyncio.run(protocol.request(packet(requestId=f"{number:032x}")))["code"] == "accepted"
    assert asyncio.run(protocol.request(packet(requestId="f" * 32)))["code"] == "busy"
    assert callback.call_count == 64 and len(protocol.replies) == 64
    protocol.retire(); assert not protocol.replies and protocol.binding is None


def test_cancelled_held_worker_reserves_id_and_admission_and_consumes_private_exception():
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    calls = []
    def callback(*_args):
        calls.append(1); entered.set()
        try:
            assert release.wait(3)
            raise RuntimeError("PrivateDisplay C:/PrivateReplay")
        finally:
            finished.set()
    protocol, _client, _callback = fixture(callback)
    async def run():
        loop = asyncio.get_running_loop(); errors = []
        loop.set_exception_handler(lambda _loop, context: errors.append(context))
        task = asyncio.create_task(protocol.request(packet()))
        try:
            for _ in range(300):
                if entered.is_set(): break
                await asyncio.sleep(0.001)
            assert entered.is_set()
            task.cancel()
            with pytest.raises(asyncio.CancelledError): await task
            assert (await protocol.request(packet()))["code"] == "local_error"
            for number in range(20):
                assert (await protocol.request(packet(requestId=f"{number:032x}")))["code"] == "busy"
            assert len(calls) == 1 and protocol.pending
        finally:
            release.set()
        for _ in range(300):
            if finished.is_set() and not protocol.pending: break
            await asyncio.sleep(0.001)
        await asyncio.sleep(0.01)
        assert not protocol.pending and errors == []
        assert (await protocol.request(packet()))["code"] == "local_error" and len(calls) == 1
    asyncio.run(run())


@pytest.mark.parametrize("stage", ["create_task", "executor"])
def test_proven_scheduling_failure_releases_admission_but_retains_uncertain_id(monkeypatch, stage):
    protocol, _client, callback = fixture()
    async def run():
        loop = asyncio.get_running_loop()
        with monkeypatch.context() as patch:
            if stage == "create_task":
                patch.setattr(asyncio, "create_task", Mock(side_effect=RuntimeError("synthetic scheduling")))
            else:
                patch.setattr(loop, "run_in_executor", Mock(side_effect=RuntimeError("synthetic executor")))
            assert (await protocol.request(packet()))["code"] == "local_error"
        await asyncio.sleep(0)
        assert not protocol.pending
        assert (await protocol.request(packet()))["code"] == "local_error"
        assert (await protocol.request(packet(requestId="d" * 32)))["code"] == "accepted"
        callback.assert_called_once()
    asyncio.run(run())


def test_changed_namespace_during_held_worker_retires_mutation_guard():
    protocol, client, _callback = fixture()
    def callback(_raw, _token, current):
        client._sio.get_sid = lambda **_: "changed-namespace"
        assert current() is False
        return "owner_changed", 0
    protocol.callback = callback
    assert asyncio.run(protocol.request(packet()))["code"] == "owner_changed"


def test_token_replacement_retains_callback_but_not_binding_or_request_cache():
    callback = Mock()
    client = SocketClient(base_url="https://api.example", device_token="old",
        on_recompute_games=Mock(), on_recompute_opp_build=Mock(), on_sync_retry=callback)
    client._sync_retry.binding = (DEVICE, SESSION)
    replacement = client.with_device_token("new")
    assert replacement._on_sync_retry is callback and replacement._sync_retry.callback is callback
    assert replacement._sync_retry.binding is None and replacement._sync_retry.replies == {}


def test_socket_registers_new_events_without_changing_legacy_full_resync():
    handlers, events = {}, {}
    class Socket:
        def on(self, name):
            def install(fn): handlers[name] = fn; return fn
            return install
        def event(self, fn): events[fn.__name__] = fn; return fn
        def get_sid(self, **_): return SESSION
    legacy, callback = Mock(), Mock(return_value=("accepted", 1))
    client = SocketClient(base_url="https://api.example", device_token="synthetic",
        on_recompute_games=Mock(), on_recompute_opp_build=Mock(), on_full_resync=legacy, on_sync_retry=callback)
    client._sync_retry.clock = lambda: 1.0  # packet() uses the same deterministic epoch.
    client._sio = Socket(); client._wire_handlers()
    async def run():
        await events["connect"]()
        await handlers["sync:retry-ready"]({"version": 1, "deviceId": DEVICE, "sessionId": SESSION})
        assert (await handlers["sync:retry-request"](packet()))["code"] == "accepted"
        legacy.assert_not_called()
        await handlers["resync:request"]({"reason": "existing legacy reason"})
        legacy.assert_called_once_with("existing legacy reason")
        await events["disconnect"]()
        assert client._sync_retry.binding is None
    asyncio.run(run())

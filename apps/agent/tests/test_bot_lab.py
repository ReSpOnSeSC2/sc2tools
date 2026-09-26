import asyncio
import io
import json
import threading
from types import SimpleNamespace

import pytest

from sc2tools_agent.bot_lab import BotLabController, bot_match_blocks_capture, engine_activity_guard
from sc2tools_agent import bot_lab
from sc2tools_agent.socket_client import SocketClient


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def start():
    return dict(operation="start", requestId="1" * 32, botId="a" * 24, mapId="b" * 24, humanRace="Protoss")


@pytest.fixture
def configured(tmp_path):
    write(tmp_path / "bot-lab.json", {"enabled": True, "python": "local-trusted-python", "workspace": "local-workspace"})
    return tmp_path


def test_disabled_and_invalid_remote_commands_do_not_invoke_runtime(tmp_path):
    calls = []
    controller = BotLabController(tmp_path, invoke=lambda *args: calls.append(args))
    assert controller.handle({"operation": "catalog"})["code"] == "disabled"
    assert controller.handle({**start(), "command": "arbitrary"})["code"] == "invalid_request"
    assert controller.handle({**start(), "botId": "../../private"})["status"] == "failed"
    assert calls == []


def test_status_before_start_remains_unknown_without_allocating_or_launching(configured):
    calls = []

    def invoke(config, payload):
        calls.append(payload)
        return {"ok": True, "session": {"id": payload["sessionId"], "status": "starting"}}

    controller = BotLabController(configured, invoke=invoke)
    missing = controller.handle({"operation": "status", "requestId": start()["requestId"]})
    assert missing["status"] == "unknown" and calls == []
    assert not (configured / "bot-lab-journal.json").exists()
    assert controller.handle(start())["status"] == "starting"
    assert [row["operation"] for row in calls] == ["start"]


def test_durable_start_reservation_and_reconnect_never_launch_twice(configured):
    calls = []

    def invoke(config, payload):
        calls.append(payload)
        journal = json.loads((configured / "bot-lab-journal.json").read_text())
        assert journal["activeSessionId"] == payload["sessionId"]
        return {"ok": True, "session": {"id": payload["sessionId"], "status": "playing", "pid": 123,
                                        "source_checkpoint": "private", "humanRace": "Protoss"}}

    first = BotLabController(configured, invoke=invoke).handle(start())
    assert first["id"] == start()["requestId"] and first["status"] == "playing"
    assert "pid" not in first and "private" not in str(first)
    assert bot_match_blocks_capture(configured)
    second = BotLabController(configured, invoke=invoke).handle(start())
    assert second["sessionId"] == first["sessionId"]
    assert [row["operation"] for row in calls] == ["start", "status"]
    conflict = BotLabController(configured, invoke=invoke).handle({**start(), "humanRace": "Terran"})
    assert conflict["code"] == "request_conflict" and len(calls) == 2


def test_ambiguous_runtime_failure_is_reconciled_without_relaunch(configured):
    def interrupted(*args):
        raise RuntimeError("secret-path-and-token")

    result = BotLabController(configured, invoke=interrupted).handle(start())
    assert result["code"] == "local_error" and "secret" not in str(result)
    assert result["status"] == "unknown"
    assert bot_match_blocks_capture(configured)
    calls = []

    def reconcile(config, payload):
        calls.append(payload)
        return {"ok": False, "code": "session_unavailable", "message": "Unavailable"}

    result = BotLabController(configured, invoke=reconcile).handle(start())
    assert calls[0]["operation"] == "status" and result["status"] == "failed"
    assert not bot_match_blocks_capture(configured)


@pytest.mark.parametrize("in_memory", [False, True])
def test_capture_enabled_in_either_state_blocks_start(configured, in_memory):
    write(configured / "agent.json", {"replay_capture_enabled": not in_memory})
    calls = []
    controller = BotLabController(configured, SimpleNamespace(replay_capture_enabled=in_memory), invoke=lambda *args: calls.append(args))
    assert controller.handle(start())["code"] == "replay_capture_enabled"
    assert calls == [] and not (configured / "bot-lab-journal.json").exists()


def test_stop_and_status_use_owned_request_identity_even_after_disable(configured):
    calls = []

    def invoke(config, payload):
        calls.append(payload)
        return {"ok": True, "session": {"id": payload["sessionId"], "status": "closed" if payload["operation"] == "stop" else "playing"}}

    controller = BotLabController(configured, invoke=invoke)
    controller.handle(start())
    write(configured / "bot-lab.json", {"enabled": False})
    (configured / "STOP").touch()
    result = controller.handle({"operation": "stop", "requestId": start()["requestId"]})
    assert result["status"] == "closed" and not bot_match_blocks_capture(configured)
    assert controller.handle({"operation": "status", "requestId": "9" * 32})["code"] == "session_unavailable"
    assert [row["operation"] for row in calls] == ["start", "stop"]


def test_os_engine_guard_and_same_process_guard_have_bounded_wait(tmp_path):
    entered, release = threading.Event(), threading.Event()

    def capture():
        with engine_activity_guard(tmp_path):
            entered.set()
            release.wait(5)

    thread = threading.Thread(target=capture)
    thread.start()
    try:
        assert entered.wait(1)
        with pytest.raises(TimeoutError):
            with engine_activity_guard(tmp_path, timeout=.02):
                pytest.fail("Competing operation entered capture lock")
    finally:
        release.set()
        thread.join(2)


def test_socket_bot_rpc_acks_controller_result_and_isolates_errors():
    handlers = {}

    class Socket:
        def event(self, function):
            return function

        def on(self, name):
            def register(function):
                handlers[name] = function
                return function
            return register

    client = SocketClient(base_url="http://local", device_token="test", on_recompute_games=lambda rows: None,
                          on_recompute_opp_build=lambda row: None, on_bot_lab=lambda payload: {"status": "closed"})
    client._sio = Socket()
    client._wire_handlers()
    assert asyncio.run(handlers["bot-lab:request"]({"operation": "status"})) == {"status": "closed"}
    client._on_bot_lab = lambda payload: (_ for _ in ()).throw(ValueError("private"))
    result = asyncio.run(handlers["bot-lab:request"]({}))
    assert result["status"] == "unknown" and "private" not in str(result)


def test_runtime_error_and_unknown_status_preserve_reservation(configured):
    controller = BotLabController(configured, invoke=lambda *args: {
        "ok": False, "code": "local_error", "message": "Runtime unavailable"})
    assert controller.handle(start())["status"] == "unknown"
    assert bot_match_blocks_capture(configured)
    controller.invoke = lambda config, payload: {"ok": True, "session": {"id": payload["sessionId"], "status": "unknown"}}
    result = controller.handle({"operation": "status", "requestId": start()["requestId"]})
    assert result["status"] == "unknown" and bot_match_blocks_capture(configured)


@pytest.mark.parametrize("operation", ["start", "status", "stop"])
def test_busy_engine_keeps_session_controls_recoverable(configured, monkeypatch, operation):
    controller = BotLabController(configured, invoke=lambda config, payload: {
        "ok": True, "session": {"id": payload["sessionId"], "status": "playing"}})
    assert controller.handle(start())["status"] == "playing"
    original_guard = bot_lab.engine_activity_guard
    monkeypatch.setattr(bot_lab, "engine_activity_guard", lambda *args: (_ for _ in ()).throw(TimeoutError()))
    request = start() if operation == "start" else {"operation": operation, "requestId": start()["requestId"]}
    result = controller.handle(request)
    assert result["status"] == "unknown" and result["code"] == "engine_busy"
    monkeypatch.setattr(bot_lab, "engine_activity_guard", original_guard)
    calls = []

    def stop(config, payload):
        calls.append(payload)
        return {"ok": True, "session": {"id": payload["sessionId"], "status": "closed"}}

    controller.invoke = stop
    assert controller.handle({"operation": "stop", "requestId": start()["requestId"]})["status"] == "closed"
    assert calls[0]["operation"] == "stop"
    assert not bot_match_blocks_capture(configured)


def test_capture_lazily_reconciles_finished_match_when_browser_is_closed(configured):
    BotLabController(configured, invoke=lambda config, payload: {
        "ok": True, "session": {"id": payload["sessionId"], "status": "playing"}}).handle(start())
    calls = []

    def status(config, payload):
        calls.append(payload)
        return {"ok": True, "session": {"id": payload["sessionId"], "status": "finished"}}

    with engine_activity_guard(configured):
        assert not bot_match_blocks_capture(configured, invoke=status)
        assert not bot_match_blocks_capture(configured, invoke=lambda *args: pytest.fail("No active reservation"))
    assert len(calls) == 1 and calls[0]["operation"] == "status"
    journal = json.loads((configured / "bot-lab-journal.json").read_text())
    assert journal["requests"][start()["requestId"]]["state"] == "terminal"


@pytest.mark.parametrize("status", ["unknown", "starting", "playing"])
def test_capture_never_clears_ambiguous_or_live_reservation(configured, status):
    BotLabController(configured, invoke=lambda *args: {"ok": False, "code": "local_error"}).handle(start())
    with engine_activity_guard(configured):
        assert bot_match_blocks_capture(configured, invoke=lambda config, payload: {
            "ok": True, "session": {"id": payload["sessionId"], "status": status}})
    assert json.loads((configured / "bot-lab-journal.json").read_text())["activeSessionId"]


@pytest.mark.parametrize("oversized", [False, True])
def test_fixed_hidden_helper_has_bounded_output_and_no_remote_command(tmp_path, monkeypatch, oversized):
    executable = tmp_path / "trusted-python.exe"
    executable.touch()
    shipped = tmp_path / "shipped"
    monkeypatch.setattr(bot_lab, "_runtime_source", lambda: shipped)
    calls = []

    class Child:
        def __init__(self):
            self.stdin = io.BytesIO()
            self.stdout = io.BytesIO(b"x" * (bot_lab.MAX_OUTPUT + 1) if oversized else b'{"ok":true}')
            self.returncode = 0
            self.killed = False

        def kill(self):
            self.killed = True

        def wait(self, timeout):
            assert timeout <= 30
            return self.returncode

    child = Child()
    monkeypatch.setattr(bot_lab.subprocess, "Popen", lambda command, **kwargs: calls.append((command, kwargs)) or child)
    def invoke():
        return bot_lab._invoke({"python": str(executable), "workspace": str(tmp_path)}, {"operation": "catalog"})
    if oversized:
        with pytest.raises(ValueError, match="output limit"):
            invoke()
        assert child.killed
    else:
        assert invoke() == {"ok": True}
    command, options = calls[0]
    assert command[:3] == [str(executable), "-I", "-c"]
    assert "pluto_sc2.agent_bridge" in command[3] and command[4] == str(shipped)
    assert options["shell"] is False and options["close_fds"] is True
    assert options["creationflags"] == getattr(bot_lab.subprocess, "CREATE_NO_WINDOW", 0)
    assert "PYTHONPATH" not in options["env"] and "PYTHONHOME" not in options["env"]

"""Credential startup and OBS activation using owned synthetic state only."""
import json
import logging
import threading
from types import SimpleNamespace

import pytest

from sc2tools_agent import runner
from sc2tools_agent.agent_credentials import CredentialIntent, CredentialStorageError
from sc2tools_agent.instance_lock import AgentInstanceLock
from sc2tools_agent.state import (
    _STATE_SAVE_LOCK, AgentState, commit_state_credentials, credential_revision,
    credential_status, load_state, save_state,
)
from sc2tools_agent.sync_retry import replay_ticket
from sc2tools_agent.ui import SettingsPayload
from tests.test_agent_state_credentials import synthetic_state_io


LOG = logging.getLogger("test_runner_credentials")


def test_actual_lock_migration_precedes_every_consumer_and_releases_on_return(tmp_path, monkeypatch, synthetic_state_io):
    pointer = tmp_path / "agent.json"
    pointer.write_text(json.dumps({"device_token": "private-device", "obs_password": "private-obs", "user_id": "u"}))
    events, guards = [], []
    def guard_factory(directory):
        guard = AgentInstanceLock(directory)
        guards.append(guard)
        return guard
    original = runner.migrate_legacy_state
    def migrate(directory, guard):
        assert guard is guards[0] and guard.acquired
        events.append("migration")
        return original(directory, guard)
    def consume(cfg, args, argv, *, relaunch):
        events.append("consumer")
        assert guards[0].acquired
        state = load_state(cfg.state_dir)
        assert (state.device_token, state.obs_password) == ("private-device", "private-obs")
        assert b"private-device" not in pointer.read_bytes() and b"private-obs" not in pointer.read_bytes()
        return 17
    monkeypatch.setattr(runner, "_bootstrap", lambda *a, **k: (SimpleNamespace(state_dir=tmp_path), tmp_path))
    monkeypatch.setattr(runner, "AgentInstanceLock", guard_factory)
    monkeypatch.setattr(runner, "migrate_legacy_state", migrate)
    monkeypatch.setattr(runner, "_run_locked_agent", consume)
    assert runner.run_agent(["--no-gui"]) == 17
    assert events == ["migration", "consumer"]
    assert guards[0].acquired is False


def test_migration_failure_keeps_original_bytes_and_never_constructs_consumers(tmp_path, monkeypatch, synthetic_state_io, capsys):
    pointer = tmp_path / "agent.json"
    original = b'{"device_token":"private-device","obs_password":"private-obs"}'
    pointer.write_bytes(original)
    _stores, crypto = synthetic_state_io
    def fail(_data):
        raise RuntimeError("private-password C:/private/name")
    monkeypatch.setattr(crypto, "protect", fail)
    calls = []
    monkeypatch.setattr(runner, "_bootstrap", lambda *a, **k: (SimpleNamespace(state_dir=tmp_path), tmp_path))
    monkeypatch.setattr(runner, "_run_locked_agent", lambda *a, **k: calls.append("consumer"))
    assert runner.run_agent(["--no-gui"]) == 1
    assert calls == [] and pointer.read_bytes() == original
    text = capsys.readouterr().err
    assert "could not open secure credential storage" in text
    assert "private" not in text and "C:/" not in text
    guard = AgentInstanceLock(tmp_path)
    assert guard.acquire()
    guard.release()


def test_duplicate_instance_never_attempts_migration(tmp_path, monkeypatch, synthetic_state_io):
    guard = AgentInstanceLock(tmp_path)
    assert guard.acquire()
    calls = []
    try:
        monkeypatch.setattr(runner, "_bootstrap", lambda *a, **k: (SimpleNamespace(state_dir=tmp_path), tmp_path))
        monkeypatch.setattr(runner, "migrate_legacy_state", lambda *a: calls.append("migration"))
        monkeypatch.setattr(runner, "_run_locked_agent", lambda *a, **k: calls.append("consumer"))
        assert runner.run_agent(["--no-gui"]) == 0
        assert calls == []
    finally:
        guard.release()


def test_obs_clear_commits_before_live_reconfigure_and_passes_explicit_empty(tmp_path, synthetic_state_io, monkeypatch):
    monkeypatch.delenv("SC2TOOLS_OBS_PASSWORD", raising=False)
    state = AgentState(obs_password="old-private", obs_scene_switch_enabled=True)
    save_state(tmp_path, state)
    revision = credential_revision(state, "obs")
    events = []
    class Controller:
        def set_config(self, **values):
            assert not _STATE_SAVE_LOCK._is_owned()
            assert load_state(tmp_path).obs_password is None
            events.append("config")
    class Client:
        def reconfigure(self, **values):
            assert not _STATE_SAVE_LOCK._is_owned()
            assert load_state(tmp_path).obs_password is None
            assert values == {"host": "127.0.0.1", "port": 4455, "password": ""}
            events.append("reconfigure")
    cell = SimpleNamespace(obs_scene=Controller(), obs_client=Client())
    assert runner._apply_obs_settings(state, SettingsPayload(obs_password_intent="clear", obs_credential_revision=revision),
        cell, LOG, state_dir=tmp_path) is True
    assert events == ["config", "reconfigure"]
    assert credential_status(load_state(tmp_path), "obs") == "cleared"
    assert "obs_password" not in json.loads((tmp_path / "agent.json").read_bytes())


def test_failed_obs_pointer_never_reconfigures_or_publishes_candidate(tmp_path, synthetic_state_io, monkeypatch):
    state = AgentState(obs_password="old-private", obs_scene_switch_enabled=True)
    save_state(tmp_path, state)
    original = (tmp_path / "agent.json").read_bytes()
    store = synthetic_state_io[0][tmp_path]
    def fail(*_args):
        raise CredentialStorageError("write_failed")
    monkeypatch.setattr(store, "replace_pointer", fail)
    calls = []
    cell = SimpleNamespace(obs_scene=SimpleNamespace(set_config=lambda **k: calls.append(k)),
        obs_client=SimpleNamespace(reconfigure=lambda **k: calls.append(k)))
    with pytest.raises(CredentialStorageError) as caught:
        runner._apply_obs_settings(state, SettingsPayload(obs_password="new-private", obs_password_intent="set",
            obs_credential_revision=credential_revision(state, "obs")), cell, LOG, state_dir=tmp_path)
    assert caught.value.code == "write_failed"
    assert calls == [] and state.obs_password == "old-private"
    assert (tmp_path / "agent.json").read_bytes() == original
    assert load_state(tmp_path).obs_password == "old-private"


def test_obs_environment_wins_runtime_only_and_local_slot_survives_cloud_rotation(tmp_path, synthetic_state_io, monkeypatch):
    state = AgentState(device_token="device-a", obs_password="saved-private", user_id="u")
    save_state(tmp_path, state)
    revision = credential_revision(state, "obs")
    epoch = replay_ticket(state).epoch
    monkeypatch.setenv("SC2TOOLS_OBS_PASSWORD", "environment-private")
    commit_state_credentials(tmp_path, state, device=CredentialIntent("set", "device-b"),
        expected_device_revision=credential_revision(state, "device"), expected_owner_epoch=epoch,
        device_owner=("new-u", "2026-11-02T12:00:00+00:00"))
    assert credential_revision(state, "obs") == revision
    assert runner._obs_candidate_connection(state, "127.0.0.1", 4455, None, "keep", revision)[2] == "environment-private"
    runner._apply_obs_settings(state, SettingsPayload(obs_password_intent="clear", obs_credential_revision=revision),
        SimpleNamespace(obs_scene=None, obs_client=None), LOG, state_dir=tmp_path)
    assert load_state(tmp_path).obs_password is None
    assert runner._effective_obs_connection(state)[2] == "environment-private"
    assert b"environment-private" not in (tmp_path / "agent.json").read_bytes()


def test_unreadable_obs_keep_cannot_anonymously_probe_but_clear_is_explicit(tmp_path, synthetic_state_io, monkeypatch):
    monkeypatch.delenv("SC2TOOLS_OBS_PASSWORD", raising=False)
    state = AgentState(obs_password="private-password", obs_scene_switch_enabled=True)
    save_state(tmp_path, state)
    _stores, crypto = synthetic_state_io
    crypto.plaintexts.clear()
    state = load_state(tmp_path)
    assert credential_status(state, "obs") == "unreadable"
    created = []
    monkeypatch.setattr(runner, "ObsClient", lambda **kw: created.append(kw))
    result = runner._test_obs_candidate(state, "127.0.0.1", 4455, None, "keep", credential_revision(state, "obs"), LOG)
    assert result["ok"] is False and created == []
    assert runner._build_obs_switcher(state=state, bridge=object(), log=LOG) == (None, None)
    assert created == []
    revision = credential_revision(state, "obs")
    assert runner._obs_candidate_connection(state, "127.0.0.1", 4455, None, "clear", revision)[2] == ""
    assert credential_status(state, "obs") == "unreadable"  # Test resolution never saves.


def test_held_disposable_obs_test_drops_old_slot_and_always_closes(tmp_path, synthetic_state_io, monkeypatch, caplog):
    monkeypatch.delenv("SC2TOOLS_OBS_PASSWORD", raising=False)
    state = AgentState(obs_password="held-private")
    save_state(tmp_path, state)
    revision = credential_revision(state, "obs")
    entered, release = threading.Event(), threading.Event()
    calls, results = [], []
    class Client:
        def __init__(self, **values):
            assert values["password"] == "held-private"
        def connect_now(self):
            calls.append("connect")
            entered.set()
            assert release.wait(5)
        def get_version(self):
            calls.append("version")
            return {"obs_version": "30"}
        def shutdown(self):
            calls.append("shutdown")
    monkeypatch.setattr(runner, "ObsClient", Client)
    worker = threading.Thread(target=lambda: results.append(runner._test_obs_candidate(state, "127.0.0.1", 4455,
        None, "keep", revision, LOG)))
    worker.start()
    try:
        assert entered.wait(5)
        commit_state_credentials(tmp_path, state, obs=CredentialIntent("clear"), expected_obs_revision=revision)
    finally:
        release.set()
        worker.join(5)
    assert not worker.is_alive()
    assert calls == ["connect", "shutdown"]
    assert results and results[0]["ok"] is False
    assert "held-private" not in repr(results) + caplog.text


def test_build_rechecks_captured_owner_after_overlay_lookup_before_obs_admission(tmp_path, synthetic_state_io, monkeypatch):
    state = AgentState(device_token="device-private", user_id="u", obs_password="obs-private")
    save_state(tmp_path, state)
    epoch = replay_ticket(state).epoch
    calls = []
    def lookup(*_args):
        state._owner_epoch = object()
        return "overlay-private"
    monkeypatch.setattr(runner, "_overlay_token_for_build", lookup)
    monkeypatch.setattr(runner, "ObsClient", lambda **kw: calls.append(kw))
    result = runner._handle_obs_build(cfg=SimpleNamespace(api_base="https://example.test"), state=state, log=LOG,
        request={"host": "127.0.0.1", "port": 4455, "password_intent": "keep", "password": None,
            "credential_revision": credential_revision(state, "obs"), "owner_epoch": epoch})
    assert result["ok"] is False and calls == []
    assert "private" not in repr(result)


@pytest.mark.parametrize("operation", ["clear", "set"])
@pytest.mark.parametrize("hold", ["connect", "read"])
def test_automatic_obs_repair_retires_disposable_connection_before_future_writes(tmp_path, synthetic_state_io, monkeypatch, caplog, operation, hold):
    from sc2tools_agent.live import obs_layout
    monkeypatch.delenv("SC2TOOLS_OBS_PASSWORD", raising=False)
    state = AgentState(obs_password="old-private", obs_scene_switch_enabled=True)
    save_state(tmp_path, state)
    revision = credential_revision(state, "obs")
    entered, release = threading.Event(), threading.Event()
    clients, writes = [], []
    class Client:
        def __init__(self, **values):
            self.values, self.closed = values, False
            clients.append(self)
        @property
        def connection_settings(self):
            return self.values["host"], self.values["port"], self.values["password"]
        def connection_scope(self):
            return self if not self.closed else None
        def is_connection_current(self, scope):
            return scope is self and not self.closed
        def connect_now(self):
            if hold == "connect":
                entered.set()
                assert release.wait(5)
            return True
        def get_input_list(self):
            if hold == "read":
                entered.set()
                assert release.wait(5)
            return []
        def create_scene(self, name):
            writes.append(name)
        def shutdown(self):
            self.closed = True
    def repair(client):
        client.get_input_list()
        client.create_scene("synthetic-scene")
        return False
    monkeypatch.setattr(runner, "ObsClient", Client)
    monkeypatch.setattr(obs_layout, "repair_vertical_scene_chat_alerts", repair)
    live, controller = runner._build_obs_switcher(state=state,
        bridge=SimpleNamespace(bus=SimpleNamespace(subscribe=lambda callback: None)), log=LOG)
    worker = threading.Thread(target=live.values["on_connected"])
    worker.start()
    try:
        assert entered.wait(5)
        intent = CredentialIntent(operation, "replacement-private" if operation == "set" else None)
        commit_state_credentials(tmp_path, state, obs=intent, expected_obs_revision=revision)
    finally:
        release.set()
        worker.join(5)
        controller.shutdown()
    assert not worker.is_alive()
    assert writes == []  # A real pending write path was blocked after the held operation.
    assert len(clients) == 2 and clients[1].closed and not clients[0].closed
    assert load_state(tmp_path).obs_password == ("replacement-private" if operation == "set" else None)
    assert "old-private" not in caplog.text and "replacement-private" not in caplog.text


def test_overlay_lookup_captured_auth_guard_blocks_old_bearer_retry_after_rotation(tmp_path, synthetic_state_io, monkeypatch, caplog):
    from sc2tools_agent import api_client
    state = AgentState(device_token="old-private-bearer", user_id="u")
    save_state(tmp_path, state)
    replay_ticket(state)
    requests = []
    def request(method, url, **options):
        requests.append((method, options["headers"].get("authorization")))
        return SimpleNamespace(status_code=502, text="private-response", headers={})
    def backoff(_attempt):
        state._owner_epoch = object()
        state.device_token = "new-private-bearer"
    monkeypatch.setattr(api_client.requests, "request", request)
    monkeypatch.setattr(api_client, "_backoff", backoff)
    assert runner._overlay_token_for_build(SimpleNamespace(api_base="https://example.test"), state, LOG) is None
    assert requests == [("GET", "Bearer old-private-bearer")]
    assert "old-private" not in caplog.text and "private-response" not in caplog.text


@pytest.mark.parametrize("retirement", ["shutdown", "disable"])
def test_automatic_repair_waiting_for_write_lock_keeps_original_live_connection_admission(tmp_path, synthetic_state_io, monkeypatch, retirement):
    from sc2tools_agent.live import obs_client, obs_game_overlay
    state = AgentState(obs_password="private-obs", obs_scene_switch_enabled=True)
    save_state(tmp_path, state)
    revision = credential_revision(state, "obs")
    created, io = [], []
    class Raw:
        def disconnect(self):
            io.append("disconnect")
    def factory(**values):
        client = obs_client.ObsClient(**values)
        created.append(client)
        return client
    monkeypatch.setattr(runner, "ObsClient", factory)
    live, controller = runner._build_obs_switcher(state=state,
        bridge=SimpleNamespace(bus=SimpleNamespace(subscribe=lambda callback: None)), log=LOG)
    # Own one synthetic established request handle; no network/native connect.
    live._raw = Raw()
    assert live.connection_scope() is not None
    acquired, admitted = threading.Event(), threading.Event()
    actual_lock = threading.Lock()
    class HeldWriteLock:
        def acquire(self, *, timeout):
            acquired.set()
            result = actual_lock.acquire(timeout=timeout)
            if result:
                admitted.set()
            return result
        def release(self):
            actual_lock.release()
    monkeypatch.setattr(obs_game_overlay, "OBS_GAME_WRITE_LOCK", HeldWriteLock())
    actual_lock.acquire()
    worker = threading.Thread(target=live._on_connected)
    worker.start()
    try:
        assert acquired.wait(5)  # The original admission has reached the held lock.
        if retirement == "shutdown":
            live.shutdown()
        else:
            state.obs_scene_switch_enabled = False
            save_state(tmp_path, state)
        assert credential_revision(state, "obs") == revision
    finally:
        actual_lock.release()
        worker.join(5)
    try:
        assert not worker.is_alive()
        assert admitted.is_set()  # Suppression came from retirement, never a timeout.
        assert len(created) == 1  # No disposable client was even constructed.
        assert io == (["disconnect"] if retirement == "shutdown" else [])
        assert load_state(tmp_path).obs_password == "private-obs"
    finally:
        live.shutdown()
        controller.shutdown()


def test_disconnected_live_client_cannot_admit_automatic_disposable_repair(tmp_path, synthetic_state_io, monkeypatch):
    from sc2tools_agent.live import obs_client
    state = AgentState(obs_password="private-obs", obs_scene_switch_enabled=True)
    save_state(tmp_path, state)
    created = []
    def factory(**values):
        client = obs_client.ObsClient(**values)
        created.append(client)
        return client
    monkeypatch.setattr(runner, "ObsClient", factory)
    live, controller = runner._build_obs_switcher(state=state,
        bridge=SimpleNamespace(bus=SimpleNamespace(subscribe=lambda callback: None)), log=LOG)
    try:
        assert live.connection_scope() is None
        live._on_connected()
        assert created == [live]
    finally:
        live.shutdown()
        controller.shutdown()

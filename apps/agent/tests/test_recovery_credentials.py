"""Actual recovery with encrypted synthetic persistence and inert transports."""
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sc2tools_agent.api_client import ApiClient, DeviceUnauthorized
from sc2tools_agent.heartbeat import Heartbeat
from sc2tools_agent.pairing.flow import PairingUiState
from sc2tools_agent.pairing.recovery import RuntimeRecovery
from sc2tools_agent.state import _STATE_SAVE_LOCK, commit_state_credentials, save_state
from sc2tools_agent.sync_retry import replay_ticket
from sc2tools_agent.uploader.queue import UploadQueue, _UploadSessionChanged
from tests.test_agent_state_credentials import initialized
from tests.test_upload_queue import _cfg, _game
from tests.test_upload_account_fences import accepted


class GuardedUi:
    def __init__(self, state):
        self.state, self.queued, self.delivered = state, [], []
    def on_unlinked_current(self, epoch):
        self.queued.append(("unlinked", None, epoch))
    def on_paired_current(self, owner, epoch):
        self.queued.append(("paired", owner, epoch))
    def on_pairing_state(self, value):
        pass
    def show_pairing_code(self, code):
        pass
    def settle(self):
        for kind, owner, epoch in self.queued:
            if self.state._owner_epoch is epoch:
                self.delivered.append((kind, owner))
        self.queued.clear()


def recovery(tmp_path, monkeypatch):
    state, storage, crypto = initialized(tmp_path)
    cfg = _cfg(tmp_path)
    old = ApiClient(cfg.api_base, state.device_token)
    queue = UploadQueue(cfg=cfg, state=state, api=old)
    socket = Mock()
    socket.with_device_token.return_value = Mock()
    cell = SimpleNamespace(api=old, upload=queue, heartbeat=SimpleNamespace(_api=old),
        import_ctl=SimpleNamespace(_api=old), build_checkin=SimpleNamespace(_api=old),
        socket_client=socket, live_transport=SimpleNamespace(_api=old, _transports=()), gui=object())
    ui = GuardedUi(state)
    subject = RuntimeRecovery(cell=cell, cfg=cfg, state=state, ui=ui, stop_event=threading.Event())
    monkeypatch.setattr("sc2tools_agent.pairing.recovery.commit_state_credentials",
        lambda directory, current, **kwargs: commit_state_credentials(directory, current, storage=storage, crypto=crypto, **kwargs))
    return subject, state, storage, crypto, cell, old, ui


@pytest.mark.parametrize("failure", [None, RuntimeError("synthetic-private-path and token")])
def test_unlink_retires_every_retained_real_client_even_if_clear_throws(tmp_path, monkeypatch, caplog, failure):
    subject, state, storage, crypto, cell, old, ui = recovery(tmp_path, monkeypatch)
    original_pointer = storage.pointer
    job = _game(tmp_path, "owned-pending.SC2Replay")
    assert cell.upload.submit(job)
    retained = [old]
    for service in (cell.heartbeat, cell.import_ctl, cell.build_checkin, cell.live_transport):
        service._api = ApiClient(subject.cfg.api_base, state.device_token)
        retained.append(service._api)
    if failure:
        monkeypatch.setattr("sc2tools_agent.pairing.recovery.commit_state_credentials",
            Mock(side_effect=failure))
    ticket, socket = replay_ticket(state), cell.socket_client
    assert subject.unlinked(expected_api=old, expected_epoch=ticket.epoch)
    assert state.device_token is None and state.uploaded == {"kept.SC2Replay": "2026-11-01"}
    assert cell.upload.is_paused() and cell.upload.pending_count() == 1
    assert cell.api.device_token is None and cell.upload._api is cell.api
    assert all(service._api is cell.api for service in (cell.heartbeat, cell.import_ctl, cell.build_checkin, cell.live_transport))
    for client in retained:
        with pytest.raises(DeviceUnauthorized, match="agent_device_retired"):
            client._require_authentication()
    socket.stop.assert_called_once()
    if failure:
        assert storage.pointer == original_pointer
        save_state(tmp_path, state, storage=storage, crypto=crypto)
        assert state.device_token is None  # Opaque KEEP never revives the revoked runtime credential.
    assert "synthetic-private-path" not in caplog.text
    ui.settle()
    assert ui.delivered == [("unlinked", None)]


def test_stale_unlink_origin_has_no_effect_on_current_login(tmp_path, monkeypatch):
    subject, state, storage, _crypto, cell, old, ui = recovery(tmp_path, monkeypatch)
    previous = replay_ticket(state)
    with _STATE_SAVE_LOCK:
        state._owner_epoch = object()
        current = ApiClient(subject.cfg.api_base, state.device_token)
        cell.api = current
    before, socket = storage.pointer, cell.socket_client
    assert subject.unlinked(expected_api=old, expected_epoch=previous.epoch) is False
    assert cell.api is current and state.device_token == previous.token and storage.pointer == before
    assert not cell.upload.is_paused() and ui.queued == []
    socket.stop.assert_not_called()


@pytest.mark.parametrize("success", [False, True])
def test_actual_heartbeat_captures_epoch_before_http_and_drops_aba_outcome(tmp_path, monkeypatch, success):
    subject, state, _storage, _crypto, cell, old, _ui = recovery(tmp_path, monkeypatch)
    entered, release, health, auth = threading.Event(), threading.Event(), [], []
    def post(api, *args, **kwargs):
        entered.set()
        assert release.wait(3)
        if not success:
            raise DeviceUnauthorized(401, "synthetic")
        return {"overlayTokenReplacements": []}
    monkeypatch.setattr(ApiClient, "_post", post)
    def outcome(api, epoch, exc):
        auth.append((api, epoch, exc))
        return subject.auth_outcome(api, epoch, exc)
    heartbeat = Heartbeat(old, auth_context=subject.auth_context, on_auth_outcome=outcome,
        on_success=lambda: health.append("success"), on_failure=lambda exc: health.append("failure"),
        on_overlay_tokens=lambda *args: health.append("advisory"))
    cell.heartbeat = heartbeat
    epoch = replay_ticket(state).epoch
    worker = threading.Thread(target=heartbeat._send_one)
    worker.start()
    try:
        assert entered.wait(2)
        with _STATE_SAVE_LOCK:
            state._owner_epoch = object()  # Same API/token/owner; only the actual origin epoch differs.
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and health == []
    assert len(auth) == 1 and auth[0][0] is old and auth[0][1] is epoch
    assert state.device_token is not None and subject.watchdog._failures == 0


def test_queue_origin_callbacks_reject_aba_and_do_not_double_count_current_401(tmp_path, monkeypatch):
    subject, state, _storage, _crypto, cell, old, _ui = recovery(tmp_path, monkeypatch)
    queue = cell.upload
    queue._on_auth_outcome = subject.queue_auth_outcome
    legacy = Mock()
    queue._on_auth_failure = legacy
    stale = queue._upload_context()
    with _STATE_SAVE_LOCK:
        state._owner_epoch = object()
    queue._defer_connection(DeviceUnauthorized(401, "synthetic"), context=stale)
    assert queue._connection_failures == 0 and subject.watchdog._failures == 0
    legacy.assert_not_called()
    current = queue._upload_context()
    confirmation = Mock(side_effect=DeviceUnauthorized(401, "synthetic"))
    monkeypatch.setattr(ApiClient, "get_profile", confirmation)
    queue._defer_connection(DeviceUnauthorized(401, "synthetic"), context=current)
    assert subject.watchdog._failures == 1 and confirmation.call_count == 0
    queue._defer_connection(DeviceUnauthorized(401, "synthetic"), context=current)
    assert confirmation.call_count == 1 and state.device_token is None
    assert queue._auth_held and queue._api is cell.api


def test_socket_start_rotation_stops_only_captured_worker_and_drops_paired_ui(tmp_path, monkeypatch):
    subject, state, _storage, _crypto, cell, _old, ui = recovery(tmp_path, monkeypatch)
    subject.unlinked()
    ui.queued.clear()
    started, release = threading.Event(), threading.Event()
    target = Mock()
    cell.socket_client.with_device_token.return_value = target
    def paired(**kwargs):
        with _STATE_SAVE_LOCK:
            state.device_token, state._owner_epoch = "new-synthetic", object()
            epoch = state._owner_epoch
        kwargs["on_state"](PairingUiState("paired", owner_epoch=epoch))
        return True
    def start():
        assert not _STATE_SAVE_LOCK._is_owned()
        started.set()
        assert release.wait(3)
    target.start.side_effect = start
    monkeypatch.setattr("sc2tools_agent.pairing.recovery.ensure_paired", paired)
    monkeypatch.setattr("sc2tools_agent.player_handle.refresh_from_cloud", lambda *args, **kwargs: None)
    subject.link_again()
    try:
        assert started.wait(2)
        with _STATE_SAVE_LOCK:
            state._owner_epoch = object()
            replacement = Mock()
            cell.socket_client = replacement
    finally:
        release.set()
        assert subject._link_lock.acquire(timeout=3)
        subject._link_lock.release()
    target.stop.assert_called_once()
    replacement.stop.assert_not_called()
    assert ui.queued == [] and cell.upload._auth_held


def test_relink_launch_failure_releases_only_unstarted_reservation(tmp_path, monkeypatch, caplog):
    subject, _state, _storage, _crypto, _cell, _old, _ui = recovery(tmp_path, monkeypatch)
    launches = []
    class SyntheticThread:
        def __init__(self, *, target, **_kwargs):
            self.target = target
        def start(self):
            launches.append(True)
            if len(launches) == 1:
                raise RuntimeError("synthetic-private-launch-detail")
            self.target()
    monkeypatch.setattr("sc2tools_agent.pairing.recovery.threading.Thread", SyntheticThread)
    subject.link_again()
    assert subject._link_lock.acquire(blocking=False)
    subject._link_lock.release()
    subject.stop_event.set()
    subject.link_again()
    assert launches == [True, True] and not subject._link_lock.locked()
    assert "synthetic-private-launch-detail" not in caplog.text


def test_failed_anonymous_socket_clone_still_retires_old_notifier(tmp_path, monkeypatch):
    subject, state, _storage, _crypto, cell, old, _ui = recovery(tmp_path, monkeypatch)
    socket, notified = cell.socket_client, []
    socket._on_connection = notified.append
    socket.with_device_token.side_effect = RuntimeError("synthetic clone failure")
    def stop():
        assert not _STATE_SAVE_LOCK._is_owned()
        with _STATE_SAVE_LOCK:
            state._owner_epoch = object()
            cell.api = ApiClient(subject.cfg.api_base, "current-B")
        if socket._on_connection is not None:
            socket._on_connection(False)
    socket.stop.side_effect = stop
    assert subject.unlinked(expected_api=old, expected_epoch=replay_ticket(state).epoch)
    assert notified == [] and socket._on_connection is None
    assert subject._socket_connection_template == notified.append


def test_socket_apply_failure_keeps_committed_pair_truth_and_fixed_error(tmp_path, monkeypatch, caplog):
    subject, state, _storage, _crypto, cell, _old, ui = recovery(tmp_path, monkeypatch)
    subject.unlinked()
    ui.queued.clear()
    target = Mock()
    cell.socket_client.with_device_token.return_value = target
    target.start.side_effect = RuntimeError("synthetic-private-apply-detail")
    def paired(**kwargs):
        with _STATE_SAVE_LOCK:
            state.device_token, state._owner_epoch = "known-committed-pair", object()
            epoch = state._owner_epoch
        kwargs["on_state"](PairingUiState("paired", owner_epoch=epoch))
        return True
    monkeypatch.setattr("sc2tools_agent.pairing.recovery.ensure_paired", paired)
    monkeypatch.setattr("sc2tools_agent.player_handle.refresh_from_cloud", lambda *args, **kwargs: None)
    subject.link_again()
    assert subject._link_lock.acquire(timeout=3)
    subject._link_lock.release()
    assert state.device_token == cell.api.device_token == "known-committed-pair"
    assert cell.upload._auth_held and ui.queued == []
    target.stop.assert_called_once()
    assert "device_relink_apply_unavailable" in caplog.text and "synthetic-private-apply-detail" not in caplog.text


@pytest.mark.parametrize("mode", ["single", "batch"])
def test_actual_upload_response_cannot_advance_cursor_after_same_owner_token_api_epoch_aba(tmp_path, monkeypatch, mode):
    _subject, state, _storage, _crypto, cell, old, _ui = recovery(tmp_path, monkeypatch)
    job = _game(tmp_path, "owned-epoch-aba.SC2Replay")
    job.file_path.write_bytes(b"x")
    before = replay_ticket(state)
    observed, success = [], Mock()
    cell.upload._on_success = success
    def response(api, *args, **kwargs):
        observed.append(api)
        with _STATE_SAVE_LOCK:
            state._owner_epoch = object()
        return {"accepted": [accepted(job)]}
    monkeypatch.setattr(ApiClient, "upload_game", response)
    monkeypatch.setattr(ApiClient, "upload_games_batch", response)
    with pytest.raises(_UploadSessionChanged):
        (cell.upload._upload_one(job) if mode == "single" else cell.upload._upload_batch([job]))
    assert observed == [old] and cell.api is old and cell.upload._api is old
    assert (state.user_id, state.device_token) == (before.owner, before.token) and state._owner_epoch is not before.epoch
    assert str(job.file_path) not in state.uploaded and job.game.game_id not in state.path_by_game_id
    assert cell.upload._archive_journal.pending_count() == 0 and state.last_known_mmr is None
    success.assert_not_called()

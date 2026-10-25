from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import threading
import time
from unittest.mock import Mock

import pytest

from sc2tools_agent.api_client import ApiClient, DeviceUnauthorized
from sc2tools_agent.auth_watchdog import AuthWatchdog
from sc2tools_agent.pairing.flow import PairingControls, ensure_paired
from sc2tools_agent.pairing.recovery import RuntimeRecovery
from sc2tools_agent.runner import _RuntimeCell
from sc2tools_agent.state import AgentState, load_state
from tests.test_upload_queue import _cfg, _game, _StubApi
from sc2tools_agent.uploader.queue import UploadQueue


class Clock(PairingControls):
    def __init__(self, stop, after_wait=lambda: None):
        super().__init__()
        self.value = datetime(2026, 10, 23, tzinfo=timezone.utc)
        self.waits = []
        self.stop = stop
        self.after_wait = after_wait

    def wait(self, seconds, stop):
        self.waits.append(seconds)
        self.value += timedelta(seconds=seconds)
        self.after_wait()
        if len(self.waits) > 1000:
            stop.set()


def run_pairing(tmp_path, api, clock, stop, states=None):
    state = AgentState()
    result = ensure_paired(cfg=_cfg(tmp_path), state=state, api=api, on_code=lambda code: None,
                           on_state=(states if states is not None else []).append,
                           controls=clock, stop_event=stop, now=lambda: clock.value,
                           jitter=lambda low, high: 1)
    return result, state


def test_pairing_outage_has_no_deadline_and_backoff_is_capped(tmp_path):
    stop = threading.Event()
    clock = Clock(stop)
    states = []
    api = Mock()
    api.start_pairing.side_effect = ConnectionError("offline")
    result, state = run_pairing(tmp_path, api, clock, stop, states)
    assert not result and not state.is_paired
    assert sum(clock.waits) > 600
    assert clock.waits[:5] == [2, 4, 8, 16, 32]
    assert max(clock.waits) == 60
    assert {item.kind for item in states} == {"requesting", "unreachable"}
    assert all(not item.code for item in states)


def test_code_renews_before_expiry_and_persists_poll_token(tmp_path):
    stop = threading.Event()
    clock = Clock(stop)
    api = Mock()
    api.start_pairing.side_effect = lambda: {"code": str(api.start_pairing.call_count).zfill(6),
                                            "expiresAt": (clock.value + timedelta(seconds=65)).isoformat()}
    api.poll_pairing.side_effect = lambda code: ({"status": "ready", "deviceToken": "secret", "userId": "u1"}
                                               if api.start_pairing.call_count == 2 else {"status": "pending"})
    states = []
    result, state = run_pairing(tmp_path, api, clock, stop, states)
    assert result and api.start_pairing.call_count == 2
    assert clock.waits == [3, 3]
    assert state.device_token == "secret"
    assert load_state(tmp_path).device_token == "secret"
    assert [s.kind for s in states].count("requesting") == 2


def test_failed_refresh_never_shows_stale_code(tmp_path):
    stop = threading.Event()
    clock = Clock(stop)
    api = Mock()
    api.start_pairing.side_effect = [{"code": "123456", "expiresAt": (clock.value + timedelta(seconds=61)).isoformat()}, ConnectionError()]
    api.poll_pairing.return_value = {"status": "pending"}
    states = []
    def emit(value):
        states.append(value)
        if value.kind == "expired":
            stop.set()
    ensure_paired(cfg=_cfg(tmp_path), state=AgentState(), api=api, on_code=lambda _: None,
                  on_state=emit, stop_event=stop, controls=clock, now=lambda: clock.value)
    assert states[-1].kind == "expired" and states[-1].code == ""


def test_retry_and_new_code_wake_real_pairing_wait():
    stop = threading.Event()
    controls = PairingControls()
    finished = threading.Event()
    thread = threading.Thread(target=lambda: (controls.wait(60, stop), finished.set()))
    thread.start()
    controls.request_new_code()
    assert finished.wait(1)
    assert controls.new_code.is_set()
    thread.join(1)
    finished.clear()
    thread = threading.Thread(target=lambda: (controls.wait(60, stop), finished.set()))
    thread.start()
    stop.set()
    assert finished.wait(1)
    thread.join(1)


def test_watchdog_requires_two_401s_and_confirmed_profile():
    api = Mock()
    unlinked = Mock()
    watchdog = AuthWatchdog(get_api=lambda: api, on_unlinked=unlinked)
    denied = DeviceUnauthorized(401, "revoked")
    api.get_profile.side_effect = denied
    watchdog.failure(denied)
    assert not api.get_profile.called and not unlinked.called
    watchdog.success()
    watchdog.failure(denied)
    assert not unlinked.called
    watchdog.failure(denied)
    assert unlinked.call_count == 1 and api.get_profile.call_count == 1
    watchdog.failure(denied)
    assert unlinked.call_count == 1


@pytest.mark.parametrize("confirmation", [ConnectionError(), {"battleTag": "okay"}])
def test_failed_or_successful_confirmation_does_not_unlink(confirmation):
    api = Mock()
    if isinstance(confirmation, Exception):
        api.get_profile.side_effect = confirmation
    else:
        api.get_profile.return_value = confirmation
    unlinked = Mock()
    watchdog = AuthWatchdog(get_api=lambda: api, on_unlinked=unlinked)
    for _ in range(2):
        watchdog.failure(DeviceUnauthorized(401, "revoked"))
    assert not unlinked.called


def test_actual_recovery_holds_jobs_keeps_cursor_and_rebuilds_credentials(tmp_path, monkeypatch):
    state = AgentState(device_token="old", user_id="u1", uploaded={"kept": "2026-01-01"})
    cell = _RuntimeCell()
    cell.gui = object()
    cell.api = ApiClient("http://localhost:0", "old")
    cell.upload = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi())
    job = _game(tmp_path, "pending.SC2Replay")
    assert cell.upload.submit(job)
    cell.heartbeat = SimpleNamespace(_api=cell.api)
    cell.import_ctl = SimpleNamespace(_api=cell.api)
    cell.socket_client = Mock()
    new_socket = Mock()
    cell.socket_client.with_device_token.return_value = new_socket
    ui = Mock()
    recovery = RuntimeRecovery(cell=cell, cfg=_cfg(tmp_path), state=state, ui=ui,
                               stop_event=threading.Event())
    recovery.unlinked()
    assert cell.upload.is_paused() and cell.upload.pending_count() == 1
    assert state.device_token is None and state.uploaded == {"kept": "2026-01-01"}
    assert load_state(tmp_path).uploaded == state.uploaded
    def paired(**kwargs):
        kwargs["state"].device_token = "new"
        return True
    monkeypatch.setattr("sc2tools_agent.pairing.recovery.ensure_paired", paired)
    recovery.link_again()
    deadline = time.monotonic() + 3
    while cell.api.device_token != "new" and time.monotonic() < deadline:
        time.sleep(.01)
    assert cell.api.device_token == "new"
    assert cell.upload._api is cell.api and cell.heartbeat._api is cell.api
    assert cell.import_ctl._api is cell.api and cell.socket_client is new_socket
    assert cell.upload.pending_count() == 1 and not cell.upload.is_paused()
    assert not state.paused and state.uploaded == {"kept": "2026-01-01"}
    new_socket.start.assert_called_once()
    new_socket.set_session_enabled.assert_called_once_with(state.companion_session_enabled)


def test_stopped_gui_pairing_does_not_quit_window(tmp_path):
    import logging
    from sc2tools_agent.runner import _gui_boot_worker
    cell = _RuntimeCell()
    cell.gui = Mock()
    ui = Mock()
    stop = threading.Event()
    stop.set()
    _gui_boot_worker(cfg=_cfg(tmp_path), state=AgentState(), cell=cell,
                     ui=ui, stop_event=stop, log=logging.getLogger("test"),
                     no_live=True, no_obs=True)
    cell.gui.request_quit.assert_not_called()
    assert not any("exiting" in str(call) for call in ui.on_status.call_args_list)

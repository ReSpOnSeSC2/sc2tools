"""A 503 from the API is an outage, never a revoked device token.

When the API cannot reach its database to check a device token it answers
503 ``auth_unavailable`` with Retry-After. The agent must retry and keep its
credential; only repeated 401s plus a 401 on the profile check unlink it.
"""
import json
import threading
from unittest.mock import MagicMock, Mock, patch

import pytest

from sc2tools_agent import api_client
from sc2tools_agent.api_client import ApiClient, ApiError, DeviceUnauthorized
from sc2tools_agent.auth_watchdog import AuthWatchdog
from sc2tools_agent.pairing.recovery import RuntimeRecovery
from sc2tools_agent.runner import _RuntimeCell
from sc2tools_agent.state import AgentState
from tests.test_upload_queue import _cfg


def _response(status, code, headers=None):
    response = MagicMock()
    response.status_code = status
    response.headers = headers or {}
    response.text = json.dumps({"error": {"code": code}})
    response.json.return_value = {"error": {"code": code}}
    return response


def _unavailable():
    return _response(503, "auth_unavailable", {"Retry-After": "5"})


def _revoked():
    return _response(401, "auth_failed")


@pytest.fixture
def sleeps(monkeypatch):
    recorded = []
    monkeypatch.setattr(api_client.time, "sleep", recorded.append)
    return recorded


def test_auth_unavailable_is_a_retried_server_error_not_unauthorized(sleeps):
    api = ApiClient("http://x", "tok")
    with patch("requests.request", return_value=_unavailable()) as sent:
        with pytest.raises(ApiError) as raised:
            api.get_profile()
    assert not isinstance(raised.value, DeviceUnauthorized)
    assert raised.value.status == 503 and raised.value.code == "auth_unavailable"
    assert sent.call_count == api_client.DEFAULT_RETRIES
    assert sleeps and set(sleeps) == {5.0}  # Retry-After between attempts.


def test_watchdog_never_confirms_or_unlinks_on_503s(sleeps):
    api = ApiClient("http://x", "tok")
    unlinked = Mock()
    watchdog = AuthWatchdog(get_api=lambda: api, on_unlinked=unlinked)
    with patch("requests.request", return_value=_unavailable()) as sent:
        for _ in range(10):
            with pytest.raises(ApiError) as raised:
                api.get_profile()
            watchdog.failure(raised.value)
    # Every request was one of the ten reads above: no profile confirmation ran.
    assert sent.call_count == 10 * api_client.DEFAULT_RETRIES
    assert not unlinked.called


def test_503_between_401s_resets_the_revocation_count():
    api = Mock()
    unlinked = Mock()
    watchdog = AuthWatchdog(get_api=lambda: api, on_unlinked=unlinked)
    revoked = DeviceUnauthorized(401, "revoked")
    unavailable = ApiError(503, json.dumps({"error": {"code": "auth_unavailable"}}), retry_after_seconds=5)
    for exc in (revoked, unavailable, revoked, unavailable, revoked):
        watchdog.failure(exc)
    assert not api.get_profile.called and not unlinked.called


def test_profile_check_that_gets_503_keeps_the_link(sleeps):
    api = ApiClient("http://x", "tok")
    unlinked = Mock()
    watchdog = AuthWatchdog(get_api=lambda: api, on_unlinked=unlinked)
    revoked = DeviceUnauthorized(401, "revoked")
    with patch("requests.request", return_value=_unavailable()) as sent:
        watchdog.failure(revoked)
        watchdog.failure(revoked)  # Second 401 asks the profile endpoint to confirm.
    assert sent.call_count == api_client.DEFAULT_RETRIES  # That confirmation read.
    assert not unlinked.called


@pytest.mark.parametrize("status", [503, 401])
def test_runtime_credential_survives_503s_but_not_confirmed_401s(tmp_path, sleeps, status):
    state = AgentState(device_token="tok", user_id="u1")
    cell = _RuntimeCell()
    cell.gui = object()  # A GUI session waits for the user instead of relinking.
    cell.api = api = ApiClient("http://localhost:0", "tok")
    ui = Mock()
    recovery = RuntimeRecovery(cell=cell, cfg=_cfg(tmp_path), state=state, ui=ui,
                               stop_event=threading.Event())
    epoch = recovery.auth_context(api)
    assert epoch is not None
    response = _unavailable() if status == 503 else _revoked()
    with patch("requests.request", return_value=response):
        for _ in range(5):
            with pytest.raises(ApiError) as raised:
                api.get_profile()
            recovery.auth_outcome(api, epoch, raised.value)
    if status == 503:
        assert state.device_token == "tok" and cell.api is api
        assert not ui.on_unlinked.called
    else:  # The same harness does detect a confirmed revocation.
        assert state.device_token is None and cell.api is not api
        ui.on_unlinked.assert_called_once()

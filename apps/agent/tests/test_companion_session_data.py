from __future__ import annotations

import asyncio
import sys
import time
import threading
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
import requests

from sc2tools_agent.companion import CompanionClient, CompanionError
from sc2tools_agent.api_client import ApiClient, ApiError
from sc2tools_agent.session_stats import normalize_session, session_account_key
from sc2tools_agent.socket_client import SocketClient


BASE = "https://api.example.test/"
TOKEN = "private-device-token"
SESSION = {"wins": 4, "losses": 2, "games": 6, "region": "EU", "mmrStart": 5000,
           "mmrCurrent": 5020, "sessionStartedAt": "2026-10-24T01:00:00Z",
           "streak": {"kind": "win", "count": 2}}


def cached_session(token=TOKEN):
    return {"paired": True, "accountKey": session_account_key(BASE, token),
            "session": deepcopy(SESSION), "receivedAt": time.time(), "source": "overlay-session"}


def setup_request(**fields):
    return {"action": "session_setup", "confirmed": True, "accountKey": session_account_key(BASE, TOKEN), **fields}


def test_canonical_record_is_preserved_without_today_reaggregation():
    assert normalize_session({**SESSION, "unrelated": "private"}) == SESSION
    assert normalize_session({"wins": 0, "losses": 0, "games": 0}) == {"wins": 0, "losses": 0, "games": 0}
    assert normalize_session({**SESSION, "sessionStartedAt": "2026-10-24T01:00:00"}).get("sessionStartedAt") is None
    assert normalize_session({**SESSION, "streak": {"kind": [], "count": 2}}).get("streak") is None
    assert normalize_session({**SESSION, "region": "SEA"})["region"] == "SEA"


@pytest.mark.parametrize("change", [
    {"wins": True}, {"wins": -1}, {"games": 5}, {"losses": "2"}, {"games": 1_000_001},
    {"isTest": True}, {"testNonce": "sample"}, {"wins": None},
])
def test_unknown_or_sample_records_never_become_real_counts(change):
    assert normalize_session({**SESSION, **change}) is None
    assert normalize_session({}) is None


def test_session_settings_are_local_opt_in_and_not_overlay_preferences():
    state = {"enabled": False}
    network = Mock(side_effect=AssertionError("local action made a network request"))
    client = CompanionClient(lambda: (BASE, None), transport=network,
        session_settings_provider=lambda: state["enabled"],
        save_session_settings=lambda enabled: state.update(enabled=enabled))
    assert client.action({"action": "session_settings"}) == {"enabled": False}
    assert client.action({"action": "session_settings", "enabled": True}) == {"enabled": True}
    modes = client.action({"action": "companion_modes"})
    assert modes["sessionEnabled"] is True
    assert "sessionEnabled" not in modes["preferences"]
    with pytest.raises(CompanionError, match="on or off"):
        client.action({"action": "session_settings", "enabled": 1})
    network.assert_not_called()


def test_session_setting_failure_does_not_expose_disk_error_details():
    client = CompanionClient(lambda: (BASE, TOKEN),
        save_session_settings=Mock(side_effect=OSError(TOKEN)))
    with pytest.raises(CompanionError) as error:
        client.action({"action": "session_settings", "enabled": True})
    assert TOKEN not in str(error.value)


@pytest.mark.parametrize("interactive", [False, True])
def test_owned_overlay_token_lookup_keeps_default_obs_semantics_and_bounded_native_option(monkeypatch, interactive):
    request = Mock(return_value={"items": [None, {"token": "revoked", "revokedAt": "date"},
                                         {"token": "active-owned-token"}, {"token": "other"}]})
    monkeypatch.setattr(ApiClient, "_request", request)
    api = ApiClient(base_url=BASE, device_token=TOKEN)
    assert api.get_overlay_token(interactive=interactive) == "active-owned-token"
    arguments, options = request.call_args
    assert arguments == ("GET", "/v1/overlay-tokens")
    assert options["auth"] is True
    if interactive:
        assert options["attempts"] == 1 and options["read_timeout"] == 5.0 and options["interactive"] is True
    else:
        assert "attempts" not in options and "read_timeout" not in options and "interactive" not in options


def test_interactive_overlay_token_lookup_never_retries_or_sleeps_when_api_is_down(monkeypatch):
    request = Mock(return_value=SimpleNamespace(status_code=503, headers={}, text="unavailable", json=lambda: {}))
    sleep = Mock(side_effect=AssertionError("interactive token lookup must not wait to retry"))
    monkeypatch.setattr("sc2tools_agent.api_client.requests.request", request)
    monkeypatch.setattr("sc2tools_agent.api_client.time.sleep", sleep)
    with pytest.raises(ApiError):
        ApiClient(base_url=BASE, device_token=TOKEN).get_overlay_token(interactive=True)
    request.assert_called_once()
    assert request.call_args.kwargs["timeout"] == (5.0, 5.0)
    assert request.call_args.kwargs["headers"]["authorization"] == "Bearer " + TOKEN
    sleep.assert_not_called()


@pytest.mark.parametrize("initial,enabled", [(False, True), (True, False)])
def test_replacement_socket_rechecks_current_saved_setting_instead_of_constructor_copy(tmp_path, initial, enabled):
    from sc2tools_agent.runner import _publish_companion_socket, _set_companion_session
    from sc2tools_agent.state import AgentState, load_state

    state = AgentState(companion_session_enabled=initial)
    old = socket_client(session_enabled=initial)
    replacement = socket_client(session_enabled=initial)
    cell = SimpleNamespace(socket_client=old)
    _set_companion_session(tmp_path, state, cell, enabled)
    _publish_companion_socket(cell, state, replacement)
    assert state.companion_session_enabled is enabled
    assert load_state(tmp_path).companion_session_enabled is enabled
    assert cell.socket_client is replacement and replacement._session_enabled is enabled


@pytest.mark.parametrize("first", ["save", "publish"])
def test_setting_save_and_socket_publication_are_one_serialized_transition(tmp_path, first):
    from sc2tools_agent.runner import _publish_companion_socket, _set_companion_session
    from sc2tools_agent.state import AgentState

    entered, release = threading.Event(), threading.Event()
    state = AgentState(companion_session_enabled=False)
    old, replacement = Mock(), Mock()
    cell = SimpleNamespace(socket_client=old)
    blocking_socket = old if first == "save" else replacement

    def wait_for_release(_enabled):
        entered.set()
        assert release.wait(2)

    blocking_socket.set_session_enabled.side_effect = wait_for_release
    save = lambda: _set_companion_session(tmp_path, state, cell, True)
    publish = lambda: _publish_companion_socket(cell, state, replacement)
    first_action, second_action = (save, publish) if first == "save" else (publish, save)
    workers = [threading.Thread(target=first_action), threading.Thread(target=second_action)]
    workers[0].start()
    assert entered.wait(2)
    workers[1].start()
    release.set()
    for worker in workers:
        worker.join(2)
        assert not worker.is_alive()
    assert state.companion_session_enabled is True and cell.socket_client is replacement
    assert replacement.set_session_enabled.call_args.args == (True,)


def test_failed_setting_save_cannot_toggle_current_socket_or_persist_new_choice(tmp_path, monkeypatch):
    from sc2tools_agent import runner
    from sc2tools_agent.state import AgentState

    state = AgentState(companion_session_enabled=False)
    current = Mock()
    cell = SimpleNamespace(socket_client=current)
    monkeypatch.setattr(runner, "save_state", Mock(side_effect=OSError("disk failure")))
    with pytest.raises(OSError):
        runner._set_companion_session(tmp_path, state, cell, True)
    assert state.companion_session_enabled is False
    current.set_session_enabled.assert_not_called()


def test_cached_session_is_owner_scoped_and_polling_never_forges_freshness():
    cached = cached_session()
    client = CompanionClient(lambda: (BASE, TOKEN), session_provider=lambda: cached)
    expected = {**cached, "ownRating": {"mmr": 5020, "region": "EU", "source": "overlay-session",
        "status": "latest-known", "regionStatus": "rating-region"},
        "activeRegion": None, "activeRegionSource": "unavailable"}
    assert client.action({"action": "session_stats"}) == expected
    first = client.action({"action": "session_stats"})
    first["session"]["wins"] = 100
    assert client.action({"action": "session_stats"}) == expected
    cached["accountKey"] = session_account_key(BASE, "other-user-token")
    assert client.action({"action": "session_stats"})["session"] is None
    assert TOKEN not in repr(client.action({"action": "session_stats"}))


def test_own_rating_provenance_never_uses_opponent_mmr_or_claims_configured_region_is_active():
    cached = cached_session()
    cached["session"].update(oppMmr=9999, mmr=8888, activeRegion="KR", mmrSource="live")
    cached.update(ownRating={"mmr": 7777, "status": "live"}, activeRegion="NA")
    client = CompanionClient(lambda: (BASE, TOKEN), session_provider=lambda: cached)
    result = client.action({"action": "session_stats"})
    assert result["ownRating"] == {"mmr": 5020, "region": "EU", "source": "overlay-session",
        "status": "latest-known", "regionStatus": "rating-region"}
    assert result["activeRegion"] is None and result["activeRegionSource"] == "unavailable"
    del cached["session"]["mmrCurrent"]
    assert client.action({"action": "session_stats"})["ownRating"]["mmr"] is None
    del cached["session"]["region"]
    assert client.action({"action": "session_stats"})["ownRating"]["region"] is None
    cached["accountKey"] = "previous-account"
    assert client.action({"action": "session_stats"})["ownRating"] is None


@pytest.mark.parametrize("field,value", [("receivedAt", float("nan")), ("receivedAt", True),
    ("source", "today"), ("paired", False), ("session", {"wins": 1})])
def test_cache_metadata_or_malformed_record_fails_closed(field, value):
    cached = {**cached_session(), field: value}
    client = CompanionClient(lambda: (BASE, TOKEN), session_provider=lambda: cached)
    assert client.action({"action": "session_stats"})["session"] is None


def test_unpair_does_not_read_cache_and_rotation_during_read_is_rejected():
    provider = Mock(return_value=cached_session())
    connection = [BASE, None]
    client = CompanionClient(lambda: connection, session_provider=provider)
    assert client.action({"action": "session_stats"}) == {
        "paired": False, "session": None, "receivedAt": None, "source": "overlay-session",
        "ownRating": None, "activeRegion": None, "activeRegionSource": "unavailable"}
    provider.assert_not_called()
    connection[1] = TOKEN

    def rotate():
        connection[1] = "new-device-token"
        return cached_session()

    client._session_provider = rotate
    with pytest.raises(CompanionError, match="pairing changed"):
        client.action({"action": "session_stats"})


@pytest.mark.parametrize("confirmed", [None, False, 1, "yes"])
def test_private_session_setup_requires_explicit_human_confirmation(confirmed):
    transport = Mock(side_effect=AssertionError("unconfirmed setup used the network"))
    client = CompanionClient(lambda: (BASE, TOKEN), transport=transport)
    with pytest.raises(CompanionError, match="Confirm"):
        client.action({"action": "session_setup", "confirmed": confirmed})
    transport.assert_not_called()


@pytest.mark.parametrize("items", [[], [{"token": "revoked-private-token", "revokedAt": "2026-10-01"}],
    [{"token": "existing-private-token"}]])
def test_confirmed_session_setup_reuses_owned_active_credential_or_creates_without_unrevoking(items):
    calls = []

    def transport(method, url, **options):
        calls.append((method, url, options))
        body = {"items": items} if method == "GET" else {"token": "new-private-token"}
        return SimpleNamespace(status_code=200 if method == "GET" else 201, json=lambda: body)

    client = CompanionClient(lambda: (BASE, TOKEN), transport=transport)
    result = client.action(setup_request())
    assert result == {"ready": True, "accountKey": session_account_key(BASE, TOKEN)}
    assert all(call[1] == BASE.rstrip("/") + "/v1/overlay-tokens" for call in calls)
    assert all(call[2]["headers"]["Authorization"] == "Bearer " + TOKEN for call in calls)
    assert "private-token" not in repr(result)
    if items and not items[0].get("revokedAt"):
        assert [call[0] for call in calls] == ["GET"]
    else:
        assert [call[0] for call in calls] == ["GET", "POST"]
        assert calls[1][2]["json"] == {"label": "Native Companion Session"}


@pytest.mark.parametrize("body", [{}, {"items": None}, {"items": [None]}, {"items": [{"token": None}]}])
def test_malformed_owned_list_never_causes_automatic_credential_creation(body):
    transport = Mock(return_value=SimpleNamespace(status_code=200, json=lambda: body))
    client = CompanionClient(lambda: (BASE, TOKEN), transport=transport)
    with pytest.raises(CompanionError):
        client.action(setup_request())
    transport.assert_called_once()


def test_setup_request_errors_never_retry_or_return_secrets():
    transport = Mock(side_effect=requests.ConnectionError(TOKEN))
    client = CompanionClient(lambda: (BASE, TOKEN), transport=transport)
    with pytest.raises(CompanionError) as error:
        client.action(setup_request())
    assert TOKEN not in str(error.value)
    transport.assert_called_once()


@pytest.mark.parametrize("rotate_during", ["get", "before_post", "post"])
def test_setup_account_rotation_never_creates_under_new_account_or_returns_old_owner(rotate_during):
    connection = [BASE, TOKEN]
    calls = []
    reads = []

    def owner():
        reads.append(True)
        if rotate_during == "before_post" and len(reads) == 5:
            connection[1] = "new-account-token"
        return tuple(connection)

    def transport(method, url, **options):
        calls.append((method, options["headers"]["Authorization"]))
        if rotate_during == method.lower():
            connection[1] = "new-account-token"
        payload = {"items": []} if method == "GET" else {"token": "private-overlay"}
        return SimpleNamespace(status_code=200, json=lambda: payload)

    client = CompanionClient(owner, transport=transport)
    with pytest.raises(CompanionError, match="pairing changed"):
        client.action(setup_request())
    assert all(header == "Bearer " + TOKEN for method, header in calls)
    assert len(calls) == (2 if rotate_during == "post" else 1)


@pytest.mark.parametrize("account_key", [None, "other-account"])
def test_setup_never_acts_when_confirmation_belongs_to_a_previous_or_unknown_account(account_key):
    transport = Mock(side_effect=AssertionError("stale owner started setup"))
    client = CompanionClient(lambda: (BASE, TOKEN), transport=transport)
    with pytest.raises(CompanionError, match="pairing changed"):
        client.action(setup_request(accountKey=account_key))
    transport.assert_not_called()


def test_overlapping_confirmed_setup_actions_create_only_one_owned_credential():
    started = threading.Event()
    release = threading.Event()
    items, calls, results = [], [], []

    def transport(method, url, **options):
        calls.append(method)
        if method == "GET":
            if not started.is_set():
                started.set()
                assert release.wait(2)
            payload = {"items": deepcopy(items)}
        else:
            items.append({"token": "new-private-token"})
            payload = items[-1]
        return SimpleNamespace(status_code=200, json=lambda: payload)

    client = CompanionClient(lambda: (BASE, TOKEN), transport=transport)
    workers = [threading.Thread(target=lambda: results.append(client.action(setup_request()))) for _ in range(2)]
    workers[0].start()
    assert started.wait(2)
    workers[1].start()
    release.set()
    for worker in workers:
        worker.join(2)
        assert not worker.is_alive()
    assert calls == ["GET", "POST", "GET"]
    assert results == [{"ready": True, "accountKey": session_account_key(BASE, TOKEN)}] * 2


class FakeSocket:
    def __init__(self):
        self.handlers = {}
        self.disconnect = AsyncMock()

    def event(self, handler):
        self.handlers[handler.__name__] = handler
        return handler

    def on(self, name):
        def decorate(handler):
            self.handlers[name] = handler
            return handler
        return decorate


def socket_client(**options):
    return SocketClient(base_url=BASE, device_token=TOKEN,
        on_recompute_games=lambda _: None, on_recompute_opp_build=lambda _: None, **options)


def session_channel(client):
    client._device_connected = True
    channel = FakeSocket()
    client._session_sio = channel
    client._wire_session_handlers(channel, client._session_generation)
    return channel


def test_socket_observation_is_sanitized_copied_and_samples_do_not_replace_real_stats():
    client = socket_client(session_enabled=True)
    channel = session_channel(client)
    asyncio.run(channel.handlers["overlay:session"]({**SESSION, "unknown": TOKEN}))
    snapshot = client.session_snapshot()
    assert snapshot["accountKey"] == session_account_key(BASE, TOKEN)
    assert snapshot["session"] == SESSION
    assert snapshot["source"] == "overlay-session"
    snapshot["session"]["streak"]["count"] = 99
    asyncio.run(channel.handlers["overlay:session"]({**SESSION, "wins": 100, "isTest": True}))
    assert client.session_snapshot()["session"] == SESSION
    assert TOKEN not in repr(client.session_snapshot())


@pytest.mark.parametrize("invalidate", ["disable", "overlay_disconnect", "device_disconnect", "stop"])
def test_socket_clears_private_cache_and_rejects_late_events(invalidate):
    client = socket_client(session_enabled=True)
    channel = session_channel(client)
    asyncio.run(channel.handlers["overlay:session"](SESSION))
    assert client.session_snapshot()["session"]
    if invalidate == "disable":
        client.set_session_enabled(False)
    elif invalidate == "overlay_disconnect":
        asyncio.run(channel.handlers["disconnect"]())
    elif invalidate == "device_disconnect":
        client._sio = FakeSocket()
        client._wire_handlers()
        asyncio.run(client._sio.handlers["disconnect"]())
        channel.disconnect.assert_awaited_once()
    else:
        client.stop()
    assert client.session_snapshot()["session"] is None
    asyncio.run(channel.handlers["overlay:session"](SESSION))
    assert client.session_snapshot()["session"] is None
    client.set_session_enabled(True)
    asyncio.run(channel.handlers["overlay:session"](SESSION))
    assert client.session_snapshot()["session"] is None


def test_rotation_preserves_callbacks_and_opt_in_but_never_cache_or_credentials():
    provider = Mock()
    scouting = Mock()
    client = socket_client(overlay_token_provider=provider, session_enabled=True, on_scouting_brief=scouting)
    channel = session_channel(client)
    asyncio.run(channel.handlers["overlay:session"](SESSION))
    rotated = client.with_device_token("new-device-token")
    assert rotated._session_enabled is True
    assert rotated._overlay_token_provider is provider
    assert rotated._on_scouting_brief is scouting
    assert rotated.session_snapshot()["session"] is None
    assert rotated.session_snapshot()["accountKey"] == session_account_key(BASE, "new-device-token")


def test_disabled_session_does_not_fetch_tokens_or_open_overlay_socket(monkeypatch):
    provider = Mock(side_effect=AssertionError("disabled session fetched a token"))
    client = socket_client(overlay_token_provider=provider)

    async def stop(_delay):
        client._stop.set()

    monkeypatch.setattr(asyncio, "sleep", stop)
    asyncio.run(client._connect_session_and_wait())
    provider.assert_not_called()


def test_pending_owned_token_lookup_cannot_open_after_disable(monkeypatch):
    factory = Mock(side_effect=AssertionError("late lookup opened a socket"))
    client = socket_client(overlay_token_provider=lambda token: "owned-overlay", session_enabled=True)
    client._device_connected = True

    async def lookup(provider, token):
        assert token == TOKEN
        client.set_session_enabled(False)
        client._stop.set()
        return provider(token)

    monkeypatch.setattr(asyncio, "to_thread", lookup)
    monkeypatch.setitem(sys.modules, "socketio", SimpleNamespace(AsyncClient=factory))
    asyncio.run(client._connect_session_and_wait())
    factory.assert_not_called()


def test_overlay_connection_uses_owned_token_and_actual_resync_for_idle_freshness(monkeypatch, caplog):
    provider = Mock(return_value="owned-overlay-token")
    client = socket_client(overlay_token_provider=provider, session_enabled=True)
    client._device_connected = True
    channel = FakeSocket()
    observed = []

    async def connect(base, **options):
        assert base == BASE.rstrip("/")
        assert options["auth"] == {"overlayToken": "owned-overlay-token"}
        await channel.handlers["overlay:session"](SESSION)
        observed.append(client.session_snapshot())

    async def wait():
        await asyncio.Event().wait()

    async def emit(event):
        assert event == "overlay:resync"
        await channel.handlers["overlay:session"]({**SESSION, "wins": 5, "games": 7})
        observed.append(client.session_snapshot())
        client._stop.set()

    async def timed_wait(awaitable, *, timeout):
        assert timeout == 30
        awaitable.cancel()
        raise asyncio.TimeoutError

    channel.connect = connect
    channel.wait = wait
    channel.emit = emit
    factory = Mock(return_value=channel)
    monkeypatch.setitem(sys.modules, "socketio", SimpleNamespace(AsyncClient=factory))
    monkeypatch.setattr(asyncio, "wait_for", timed_wait)
    asyncio.run(client._connect_session_and_wait())
    provider.assert_called_once_with(TOKEN)
    factory.assert_called_once_with(reconnection=False, logger=False, engineio_logger=False)
    assert observed[0]["session"] == SESSION
    assert observed[1]["session"]["wins"] == 5
    assert observed[1]["receivedAt"] >= observed[0]["receivedAt"]
    assert client.session_snapshot()["session"] is None
    assert "owned-overlay-token" not in caplog.text and TOKEN not in caplog.text

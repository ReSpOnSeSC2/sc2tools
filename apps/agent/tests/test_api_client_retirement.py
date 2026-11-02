"""Retire real immutable clients; every transport is an owned synthetic stub."""
from dataclasses import FrozenInstanceError
from pathlib import Path
from unittest.mock import Mock

import pytest
import requests

from sc2tools_agent import api_client as module
from sc2tools_agent.api_client import ApiClient, DeviceUnauthorized


def test_explicit_retirement_preserves_frozen_fields_and_blocks_new_authentication(monkeypatch):
    client = ApiClient("https://example.test", "synthetic-private-token")
    transport = Mock()
    monkeypatch.setattr(module.requests, "request", transport)
    with pytest.raises(FrozenInstanceError):
        client.device_token = None
    client.retire_authentication()
    client.retire_authentication()
    with pytest.raises(DeviceUnauthorized) as failure:
        client.get_profile()
    assert "synthetic-private-token" not in str(failure.value)
    assert client.device_token == "synthetic-private-token" and not transport.called


@pytest.mark.parametrize("retryable", ["transport", "server"])
def test_retirement_during_backoff_stops_next_captured_bearer_attempt(monkeypatch, retryable):
    client = ApiClient("https://example.test", "synthetic-private-token")
    response = Mock(status_code=503, text="synthetic outage", headers={})
    response.json.return_value = {}
    transport = Mock(side_effect=requests.ConnectionError("synthetic transport") if retryable == "transport" else None,
        return_value=response)
    monkeypatch.setattr(module.requests, "request", transport)
    monkeypatch.setattr(module, "_backoff", lambda *_args: client.retire_authentication())
    with pytest.raises(DeviceUnauthorized, match="agent_device_retired"):
        client._request("GET", "/synthetic-private", auth=True)
    assert transport.call_count == 1
    assert transport.call_args.kwargs["headers"]["authorization"] == "Bearer synthetic-private-token"


def test_response_from_already_entered_transport_is_not_returned_after_retirement(monkeypatch):
    client = ApiClient("https://example.test", "synthetic-private-token")
    response = Mock(status_code=200)
    response.json.return_value = {"private": "synthetic response must not be published"}

    def request(*args, **kwargs):
        client.retire_authentication()
        return response

    monkeypatch.setattr(module.requests, "request", request)
    with pytest.raises(DeviceUnauthorized, match="agent_device_retired"):
        client.get_profile()
    response.json.assert_not_called()


def test_retirement_stops_presigned_replay_put_retry_without_completion(tmp_path, monkeypatch):
    client = ApiClient("https://example.test", "synthetic-private-token")
    replay = tmp_path / "owned-synthetic.SC2Replay"
    replay.write_bytes(b"MPQ\x1aowned synthetic replay content")
    posts = []

    def post(self, path, **kwargs):
        posts.append(path)
        assert not path.endswith("/complete")
        return {"url": "https://objects.example.test/owned-synthetic", "uploadId": "synthetic", "headers": {}}

    put = Mock(return_value=Mock(status_code=503, text="synthetic object-store outage", headers={}))
    monkeypatch.setattr(ApiClient, "_post", post)
    monkeypatch.setattr(module.requests, "put", put)
    monkeypatch.setattr(module, "_backoff", lambda *_args: client.retire_authentication())
    with pytest.raises(DeviceUnauthorized, match="agent_device_retired"):
        client.upload_replay_file("synthetic-game", replay)
    assert len(posts) == 1 and put.call_count == 1
    assert replay.read_bytes() == b"MPQ\x1aowned synthetic replay content"


def test_retirement_while_opening_replay_stops_first_put(tmp_path, monkeypatch):
    client = ApiClient("https://example.test", "synthetic-private-token")
    replay = tmp_path / "owned-synthetic.SC2Replay"
    replay.write_bytes(b"MPQ\x1aowned synthetic replay content")
    original_open, opens, posts = Path.open, [], []

    def opened(path, *args, **kwargs):
        stream = original_open(path, *args, **kwargs)
        if path == replay and args == ("rb",):
            opens.append(True)
            if len(opens) == 2:  # Hashing succeeds; the subsequent PUT reopen hydrates late.
                client.retire_authentication()
        return stream

    def post(self, path, **kwargs):
        posts.append(path)
        return {"url": "https://objects.example.test/owned-synthetic", "uploadId": "synthetic", "headers": {}}

    put = Mock()
    monkeypatch.setattr(Path, "open", opened)
    monkeypatch.setattr(ApiClient, "_post", post)
    monkeypatch.setattr(module.requests, "put", put)
    with pytest.raises(DeviceUnauthorized, match="agent_device_retired"):
        client.upload_replay_file("synthetic-game", replay)
    assert len(opens) == 2 and len(posts) == 1
    put.assert_not_called()


@pytest.mark.parametrize("guard_failure", [False, True])
def test_disposable_client_guard_stops_backoff_retry_and_cannot_be_revived(monkeypatch, guard_failure):
    current = [True]
    def guard():
        if not current[0] and guard_failure:
            raise RuntimeError("synthetic-private-scope-details")
        return current[0]
    client = ApiClient("https://example.test", "synthetic-private-token", _auth_guard=guard)
    response = Mock(status_code=503, text="synthetic", headers={})
    response.json.return_value = {}
    request = Mock(return_value=response)
    monkeypatch.setattr(module.requests, "request", request)
    monkeypatch.setattr(module, "_backoff", lambda *_args: current.__setitem__(0, False))
    with pytest.raises(DeviceUnauthorized, match="agent_device_retired") as failure:
        client.get_overlay_token()
    assert request.call_count == 1 and "synthetic-private-scope-details" not in str(failure.value)
    current[0] = True
    with pytest.raises(DeviceUnauthorized, match="agent_device_retired"):
        client.get_overlay_token()
    assert request.call_count == 1

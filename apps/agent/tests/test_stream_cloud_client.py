from types import SimpleNamespace

import pytest

from sc2tools_agent.streaming.cloud_client import CloudGoogleAPI, CloudStreamError, CloudStreamingClient


def client(transport, token="paired-device-token"):
    return CloudStreamingClient(lambda: ("https://api.sc2tools.com", token), transport=transport)


def response(value, status=200):
    return SimpleNamespace(status_code=status, json=lambda: value)


def test_uncertain_create_is_sent_once_with_durable_operation_identity():
    calls = []
    def transport(*args, **kwargs):
        calls.append((args, kwargs))
        raise OSError("private response including secret token")
    api = CloudGoogleAPI(client(transport), lambda: "owned-channel")
    with pytest.raises(CloudStreamError, match="recover before") as error:
        api.create_broadcast({"snippet": {"title": "Title"}}, operation_id="stable-operation")
    assert len(calls) == 1
    assert calls[0][1]["json"]["operation_id"] == "stable-operation"
    assert calls[0][1]["json"]["expected_channel_id"] == "owned-channel"
    assert calls[0][1]["allow_redirects"] is False
    assert "secret" not in str(error.value)


@pytest.mark.parametrize("url", ["https://evil.example/oauth2/authorize", "http://id.twitch.tv/oauth2/authorize", "https://id.twitch.tv.evil.example/oauth2/authorize", "https://id.twitch.tv:private-secret/oauth2/authorize", "https://id.twitch.tv/other"])
def test_connect_refuses_unexpected_oauth_destination(url):
    cloud = client(lambda *args, **kwargs: response({"authorizeUrl": url}))
    with pytest.raises(CloudStreamError, match="official account") as error:
        cloud.connect("twitch")
    assert "private-secret" not in str(error.value)


def test_connect_accepts_official_provider_destination():
    url = "https://id.twitch.tv/oauth2/authorize?state=private-state"
    assert client(lambda *args, **kwargs: response({"authorizeUrl": url})).connect("twitch") == url


def test_pairing_required_before_any_remote_request():
    calls = []
    cloud = client(lambda *args, **kwargs: calls.append(args), token=None)
    with pytest.raises(CloudStreamError, match="Pair this agent"):
        cloud.statuses()
    assert calls == []


def test_old_server_reports_unavailable_without_attempting_local_oauth():
    cloud = client(lambda *args, **kwargs: response({}, 404))
    with pytest.raises(CloudStreamError, match="not available on this SC2Tools server"):
        cloud.statuses()


@pytest.mark.parametrize("status", [401, 403, 429, 502])
def test_failure_exposes_only_safe_http_status_for_backoff(status):
    cloud = client(lambda *args, **kwargs: response({"secret": "private provider body"}, status))
    with pytest.raises(CloudStreamError) as failure:
        cloud.statuses()
    assert failure.value.http_status == status
    assert "private provider" not in str(failure.value)


def test_title_save_requires_matching_platform_and_readback():
    cloud = client(lambda *args, **kwargs: response({"platforms": [{"platform": "kick", "updated": True, "title": "Old", "streamingReady": True}]}))
    with pytest.raises(CloudStreamError, match="title was not verified"):
        cloud.update_title("kick", "New")


def test_catalog_cannot_change_the_pinned_channel():
    cloud = client(lambda *args, **kwargs: response({"channel": {"id": "other"}, "streams": []}))
    api = CloudGoogleAPI(cloud, lambda: "owned")
    with pytest.raises(CloudStreamError, match="channel changed"):
        api.discover_reusable_streams_for_channel("owned")


def test_recovery_is_read_only_and_does_not_repeat_creation():
    calls = []
    def transport(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return response({"id": "owned-broadcast"})
    api = CloudGoogleAPI(client(transport), lambda: "owned")
    assert api.recover_create("durable-id")["id"] == "owned-broadcast"
    assert len(calls) == 1
    assert calls[0][0] == "GET"
    assert calls[0][2]["params"] == {"operation": "recover_create", "operation_id": "durable-id"}

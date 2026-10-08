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


def kick_title_result(**changes):
    return {"platform": "kick", "connected": True, "streamingReady": True,
        "title": "New", "requestedTitle": "New", "observedTitle": "",
        "accepted": True, "titleVerified": False, "titleStatus": "accepted_offline", "isLive": False, **changes}


def test_offline_kick_acceptance_is_explicit_and_does_not_claim_verified_readback():
    calls = []
    def transport(method, url, **kwargs):
        calls.append((method, kwargs["json"]))
        return response({"platforms": [kick_title_result(access_token="never-return")]})
    result = client(transport).update_title("kick", "New")
    assert result["connected"] is True
    assert result["titleVerified"] is False
    assert result["titleStatus"] == "accepted_offline"
    assert "never-return" not in str(result)
    assert calls == [("POST", {"title": "New", "platforms": ["kick"]})]


@pytest.mark.parametrize("changes", [
    {"accepted": False}, {"isLive": True}, {"isLive": None},
    {"requestedTitle": "Other"}, {"streamingReady": False},
])
def test_offline_exception_does_not_accept_unproven_or_live_title_changes(changes):
    cloud = client(lambda *args, **kwargs: response({"platforms": [kick_title_result(**changes)]}))
    with pytest.raises(CloudStreamError, match="title was not verified"):
        cloud.update_title("kick", "New")


def test_stale_online_readback_preserves_readiness_but_is_not_success():
    cloud = client(lambda *args, **kwargs: response({"platforms": [kick_title_result(
        title="Old", observedTitle="Old", titleStatus="pending", isLive=True)]}))
    result = cloud.update_title("kick", "New")
    assert result["connected"] is True and result["streamingReady"] is True
    assert result["title"] == "Old" and result["titleVerified"] is False
    assert result["titleStatus"] == "pending"


def test_offline_exception_is_not_used_for_twitch():
    row = {**kick_title_result(), "platform": "twitch"}
    cloud = client(lambda *args, **kwargs: response({"platforms": [row]}))
    with pytest.raises(CloudStreamError):
        cloud.update_title("twitch", "New")


def test_matching_legacy_readback_remains_verified():
    cloud = client(lambda *args, **kwargs: response({"platforms": [{
        "platform": "twitch", "title": "New", "streamingReady": True, "updated": True}]}))
    assert cloud.update_title("twitch", "New")["titleVerified"] is True


@pytest.mark.parametrize("invalid", [False, True])
def test_temporarily_unavailable_title_service_does_not_imply_revoked_oauth(invalid):
    cloud = client(lambda *args, **kwargs: response({"platforms": [{
        "platform": "kick", "streamingReady": False, "connected": False,
        "connectionInvalid": invalid, "title": None}]}))
    with pytest.raises(CloudStreamError) as failure:
        cloud.update_title("kick", "New")
    assert failure.value.connection_invalid is invalid


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


def test_obs_connection_is_one_explicit_selected_request_without_retaining_key(caplog):
    calls = []
    private_key = "fake-private-obs-key"

    def transport(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return response({"stream_id": "saved-horizontal", "server_url": "rtmps://a.rtmps.youtube.com:443/live2",
                         "stream_key": private_key, "access_token": "must-never-return"})

    api = CloudGoogleAPI(client(transport), lambda: "saved-channel")
    assert calls == []
    result = api.obs_connection("saved-channel", "saved-horizontal")
    assert set(result) == {"stream_id", "server_url", "stream_key"}
    assert result["stream_key"] == private_key
    assert len(calls) == 1
    assert calls[0][0] == "POST"
    assert calls[0][1].endswith("/v1/streaming/youtube/obs-connection")
    assert calls[0][2]["json"] == {"expected_channel_id": "saved-channel", "stream_id": "saved-horizontal"}
    assert calls[0][2]["allow_redirects"] is False
    assert private_key not in str(vars(api))
    assert private_key not in caplog.text


@pytest.mark.parametrize("changes", [
    {"stream_id": "different-stream"}, {"server_url": "rtmp://a.rtmp.youtube.com/live2"},
    {"server_url": "rtmps://evil.example/live2"}, {"server_url": "rtmps://a.rtmps.youtube.com/live2?secret=value"},
    {"server_url": "rtmps://user:private@a.rtmps.youtube.com/live2"},
    {"server_url": "rtmps://a.rtmps.youtube.com:8443/live2"},
    {"server_url": "rtmps://a.rtmps.youtube.com/live2\n"},
    {"stream_key": "fake-key\n"}, {"stream_key": "x" * 257}, {"stream_key": ""},
])
def test_obs_connection_rejects_mismatches_and_private_errors(changes):
    value = {"stream_id": "saved-horizontal", "server_url": "rtmps://a.rtmps.youtube.com/live2", "stream_key": "fake-private-key"}
    value.update(changes)
    api = CloudGoogleAPI(client(lambda *args, **kwargs: response(value)), lambda: "saved-channel")
    with pytest.raises(CloudStreamError, match="could not be verified") as failure:
        api.obs_connection("saved-channel", "saved-horizontal")
    assert "fake-private" not in str(failure.value)
    assert "secret=value" not in str(failure.value)


def test_obs_connection_refuses_changed_channel_before_request():
    calls = []
    api = CloudGoogleAPI(client(lambda *args, **kwargs: calls.append(args)), lambda: "saved-channel")
    with pytest.raises(CloudStreamError, match="Save the selected"):
        api.obs_connection("other-channel", "saved-horizontal")
    assert calls == []

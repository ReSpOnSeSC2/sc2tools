from types import SimpleNamespace

import pytest

from sc2tools_agent.streaming.cloud_client import CloudGoogleAPI, CloudStreamError, CloudStreamingClient


def api_with(payload, status=200):
    calls = []

    def transport(method, url, **kwargs):
        calls.append((method, url))
        return SimpleNamespace(status_code=status, json=lambda: payload)

    client = CloudStreamingClient(lambda: ("https://api.sc2tools.com", "paired-device-token"), transport=transport)
    return CloudGoogleAPI(client, lambda: "UCowned"), calls


def test_catalog_returns_channel_and_streams_from_one_request():
    api, calls = api_with({"channel": {"id": "UCowned", "title": "Owned"}, "streams": [{"id": "s1", "title": "Key", "channel": "UCowned"}]})
    value = api.catalog()
    assert value == {"channel": {"id": "UCowned", "title": "Owned"}, "streams": [{"id": "s1", "title": "Key", "channel": "UCowned"}]}
    assert calls == [("GET", "https://api.sc2tools.com/v1/streaming/youtube/catalog")]


@pytest.mark.parametrize("payload", [{}, {"channel": "UCowned", "streams": []}, {"channel": {"id": "UCowned"}}, [], {"channel": {"id": "x"}, "streams": {}}])
def test_catalog_rejects_incomplete_payload(payload):
    api, calls = api_with(payload)
    with pytest.raises(CloudStreamError, match="could not be verified"):
        api.catalog()


@pytest.mark.parametrize("status", [401, 403, 429, 502])
def test_catalog_failure_keeps_safe_http_status_and_hides_body(status):
    api, calls = api_with({"error": "private provider body"}, status=status)
    with pytest.raises(CloudStreamError) as failure:
        api.catalog()
    assert failure.value.http_status == status
    assert "private provider" not in str(failure.value)

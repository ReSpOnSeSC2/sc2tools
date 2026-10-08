"""YouTube channel/key discovery for an already-authorized SC2Tools account.

Authorization alone used to leave the setup dropdowns empty until the user
pressed Refresh keys. Discovery now follows every successful connection
refresh, retries failures a bounded number of times, and never chooses a
channel, key, visibility or audience on the user's behalf.
"""
from types import SimpleNamespace

import pytest

from sc2tools_agent.streaming import service as service_module
from sc2tools_agent.streaming.cloud_client import CloudStreamError
from sc2tools_agent.streaming.service import CATALOG_RETRY_DELAYS, StreamService
from sc2tools_agent.streaming.youtube_pair_backend import PairBackend

CHANNEL = {"id": "UCowned", "title": "Owned channel"}
STREAMS = [
    {"id": "stream-h", "title": "Horizontal key", "channel": "UCowned"},
    {"id": "stream-v", "title": "Vertical key", "channel": "UCowned"},
]


class FakeCloud:
    """Stands in for CloudStreamingClient: statuses() plus the raw request CloudGoogleAPI uses."""

    def __init__(self, *, youtube_ready=True, catalog_error=None):
        self.youtube_ready = youtube_ready
        self.catalog_error = catalog_error
        self.channel = dict(CHANNEL)
        self.catalog_calls = 0
        self.status_calls = 0

    def statuses(self):
        self.status_calls += 1
        return {
            "twitch": {"platform": "twitch", "streamingReady": True, "account": "tw"},
            "kick": {"platform": "kick", "streamingReady": False, "account": "kk"},
            "youtube": {"platform": "youtube", "streamingReady": self.youtube_ready,
                        "platformUserId": self.channel["id"], "account": "yt"},
        }

    def _request(self, method, path, *, params=None, body=None):
        if path == "/v1/streaming/youtube/catalog":
            self.catalog_calls += 1
            if self.catalog_error is not None:
                raise self.catalog_error
            return {"channel": dict(self.channel), "streams": [dict(row) for row in STREAMS]}
        raise AssertionError("unexpected request " + path)

    def connect(self, platform):
        return "https://accounts.google.com/o/oauth2/v2/auth?state=private"


class Reader:
    def __init__(self):
        self.values = {"horizontal": False, "portrait": False}

    def __call__(self, names):
        return dict(self.values)

    def close(self):
        pass


class Clock:
    def __init__(self):
        self.now = 1000.0

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(service_module, "time", SimpleNamespace(monotonic=lambda: clock.now))
    return clock


def make_service(tmp_path, cloud):
    backend = PairBackend(tmp_path, memory=True, config={"metadata": {
        "title": "Title", "description": "", "vertical_suffix": " | Vertical",
    }})
    return StreamService(tmp_path, lambda: {}, backend=backend, output_reader=Reader(), cloud_client=cloud)


def catalog_of(snapshot):
    return [row["title"] for row in snapshot["catalog"]["channels"]], [row["title"] for row in snapshot["catalog"]["streams"]]


def test_connection_refresh_loads_catalog_without_choosing_anything(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    assert service.status()["catalog_status"]["state"] == "idle"
    service._refresh_cloud_connections()
    snapshot = service._publish()
    assert catalog_of(snapshot) == (["Owned channel"], ["Horizontal key", "Vertical key"])
    assert snapshot["catalog_status"]["state"] == "ready"
    assert "2 reusable keys" in snapshot["catalog_status"]["message"]
    assert snapshot["configured"] is False
    assert not service.backend.config.get("expected_channel_id")
    assert service.backend.config.get("streams", {}) == {}
    assert not service.config_path.exists()
    assert cloud.catalog_calls == 1
    service._refresh_cloud_connections()
    assert cloud.catalog_calls == 1, "a loaded catalog is not re-read on every periodic check"


def test_startup_worker_loads_catalog_and_explains_next_step(tmp_path):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    service.start()
    try:
        import time
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not service.status()["catalog"]["channels"]:
            time.sleep(0.05)
    finally:
        service.close()
    snapshot = service.status()
    assert catalog_of(snapshot)[0] == ["Owned channel"]
    assert snapshot["youtube"]["connected"] is True
    assert snapshot["configured"] is False
    assert "Choose your channel and both reusable keys" in snapshot["message"]


def test_failed_discovery_is_actionable_bounded_and_recovers(tmp_path, clock):
    cloud = FakeCloud(catalog_error=CloudStreamError("private provider body with secret", http_status=502))
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    status = service.status()["catalog_status"]
    assert status["state"] == "failed" and status["http_status"] == 502
    assert "could not be loaded" in status["message"] and "Retrying automatically" in status["message"]
    assert "secret" not in str(service.status())
    assert service.status()["youtube"]["connected"] is True
    assert cloud.catalog_calls == 1
    service._refresh_cloud_connections()
    assert cloud.catalog_calls == 1, "no retry before the bounded delay elapses"
    for index, delay in enumerate(CATALOG_RETRY_DELAYS):
        clock.advance(delay + 1)
        service._refresh_cloud_connections()
        assert cloud.catalog_calls == index + 2
    final = service.status()["catalog_status"]
    assert final["attempts"] == len(CATALOG_RETRY_DELAYS) + 1
    assert "Press Refresh keys" in final["message"]
    clock.advance(10_000)
    service._refresh_cloud_connections()
    assert cloud.catalog_calls == len(CATALOG_RETRY_DELAYS) + 1, "automatic retries stop after the budget"
    cloud.catalog_error = None
    result = service.action({"action": "refresh_keys"})
    assert cloud.catalog_calls == len(CATALOG_RETRY_DELAYS) + 2
    assert result["catalog_status"]["state"] == "ready"
    assert catalog_of(result)[0] == ["Owned channel"]


@pytest.mark.parametrize("http_status, fragment", [
    (403, "permission"), (401, "permission"), (429, "limit"), (409, "still running"), (404, "does not provide"), (503, "could not be loaded"), (None, "could not be loaded"),
])
def test_refresh_keys_failure_raises_actionable_message_without_provider_text(tmp_path, clock, http_status, fragment):
    cloud = FakeCloud(catalog_error=CloudStreamError("private-provider-detail", http_status=http_status))
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    with pytest.raises(ValueError) as failure:
        service.action({"action": "refresh_keys"})
    assert fragment in str(failure.value)
    assert "private-provider" not in str(failure.value)
    assert "private-provider" not in str(service.status())
    assert service.status()["catalog_status"]["state"] == "failed"


def test_explicit_refresh_restarts_retry_budget(tmp_path, clock):
    cloud = FakeCloud(catalog_error=CloudStreamError("down", http_status=502))
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    for delay in CATALOG_RETRY_DELAYS:
        clock.advance(delay + 1)
        service._refresh_cloud_connections()
    exhausted = cloud.catalog_calls
    service.action({"action": "refresh_accounts"})
    assert cloud.catalog_calls == exhausted + 1
    assert service.status()["catalog_status"]["attempts"] == 1
    assert "Retrying automatically" in service.status()["message"]


def test_disconnect_clears_catalog_and_reconnect_reloads(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    assert service.status()["catalog"]["channels"]
    cloud.youtube_ready = False
    service._refresh_cloud_connections()
    snapshot = service.status()
    assert snapshot["youtube"]["connected"] is False
    assert snapshot["catalog"] == {"channels": [], "streams": []}
    assert snapshot["catalog_status"]["state"] == "idle"
    cloud.youtube_ready = True
    service._refresh_cloud_connections()
    assert catalog_of(service.status())[0] == ["Owned channel"]
    assert cloud.catalog_calls == 2


def test_channel_change_reloads_catalog(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    cloud.channel = {"id": "UCother", "title": "Other channel"}
    service._refresh_cloud_connections()
    assert cloud.catalog_calls == 2
    assert service.status()["catalog"]["channels"] == [{"id": "UCother", "title": "Other channel"}]


def test_connect_youtube_polls_quickly_and_resets_discovery_budget(tmp_path, clock, monkeypatch):
    cloud = FakeCloud(catalog_error=CloudStreamError("down", http_status=502))
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    assert service.next_catalog_attempt > clock.now
    monkeypatch.setattr(service_module, "webbrowser", SimpleNamespace(open=lambda url, new=1: True), raising=False)
    import webbrowser
    monkeypatch.setattr(webbrowser, "open", lambda url, new=1: True)
    result = service.action({"action": "connect_youtube"})
    assert service.consent_poll_until == clock.now + service_module.CONSENT_POLL_WINDOW
    assert service.next_platform_check == clock.now + service_module.CONSENT_POLL_SECONDS
    assert service.next_catalog_attempt == 0
    assert "updates automatically" in result["message"]


def test_status_failure_keeps_catalog_and_configuration(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()

    def broken():
        raise CloudStreamError("private status failure", http_status=503)

    cloud.statuses = broken
    with pytest.raises(CloudStreamError):
        service._refresh_cloud_connections()
    snapshot = service.status()
    assert snapshot["youtube"]["connected"] is False
    assert catalog_of(snapshot)[0] == ["Owned channel"], "names stay visible; actions remain gated by the connection flag"
    assert "private status" not in str(snapshot)


def test_configure_reports_discovery_failure_instead_of_generic_error(tmp_path, clock):
    cloud = FakeCloud(catalog_error=CloudStreamError("down", http_status=403))
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    with pytest.raises(ValueError, match="permission"):
        service.action({"action": "configure_youtube", "channel_id": "UCowned", "horizontal_id": "stream-h",
                        "portrait_id": "stream-v", "privacy": "unlisted", "made_for_kids": False})
    assert not service.config_path.exists()


def test_malformed_catalog_rows_are_rejected_without_partial_catalog(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    cloud._request = lambda method, path, **kwargs: {"channel": {"id": "UCowned", "title": "Owned channel"}, "streams": [{"title": "missing id"}]}
    service._refresh_cloud_connections()
    snapshot = service.status()
    assert snapshot["catalog"] == {"channels": [], "streams": []}
    assert snapshot["catalog_status"]["state"] == "failed"


def test_account_mode_change_resets_discovery(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    result = service.action({"action": "use_local_connections"})
    assert result["catalog"] == {"channels": [], "streams": []}
    assert result["catalog_status"]["state"] == "idle"

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
    import webbrowser
    monkeypatch.setattr(webbrowser, "open", lambda url, new=1: True)
    result = service.action({"action": "connect_youtube"})
    assert service.consent_poll_until == clock.now + service_module.CONSENT_POLL_WINDOW
    assert service.youtube_consent_until == clock.now + service_module.CONSENT_POLL_WINDOW
    assert service.next_platform_check == clock.now + service_module.CONSENT_POLL_SECONDS
    assert service.next_catalog_attempt == 0
    assert service.catalog_reload_pending is True
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


def test_loading_state_is_published_before_the_catalog_request(tmp_path, clock):
    cloud = FakeCloud(catalog_error=CloudStreamError("first", http_status=403))
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    assert service.status()["catalog_status"]["http_status"] == 403
    seen = []
    original = cloud._request

    def capturing(method, path, **kwargs):
        seen.append(service.status()["catalog_status"])
        return original(method, path, **kwargs)

    cloud._request = capturing
    cloud.catalog_error = None
    service.action({"action": "refresh_keys"})
    assert len(seen) == 1
    assert seen[0]["state"] == "loading" and seen[0]["message"].startswith("Loading")
    assert seen[0]["http_status"] is None, "a loading snapshot never carries the previous failure's status"
    assert service.status()["catalog_status"]["state"] == "ready"


def test_discovery_due_is_false_while_loading(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    service.catalog_status = {**service.catalog_status, "state": "loading"}
    service.catalog = {"channels": [], "streams": []}
    assert service._discovery_due(cloud.statuses()["youtube"]) is False
    service._refresh_cloud_connections()
    assert cloud.catalog_calls == 1


def test_discovery_not_repeated_when_status_lacks_platform_user_id(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    original = cloud.statuses

    def without_id():
        rows = original()
        rows["youtube"].pop("platformUserId")
        return rows

    cloud.statuses = without_id
    service._refresh_cloud_connections()
    assert cloud.catalog_calls == 1


def test_disconnect_after_exhausted_budget_resets_everything_and_reconnect_resumes(tmp_path, clock):
    cloud = FakeCloud(catalog_error=CloudStreamError("down", http_status=502))
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    for delay in CATALOG_RETRY_DELAYS:
        clock.advance(delay + 1)
        service._refresh_cloud_connections()
    assert service.next_catalog_attempt == float("inf")
    cloud.youtube_ready = False
    service._refresh_cloud_connections()
    assert service.status()["catalog_status"] == {"state": "idle", "message": service_module.CATALOG_IDLE_MESSAGE,
                                                  "attempts": 0, "http_status": None, "retry_pending": False}
    assert service.status()["catalog"] == {"channels": [], "streams": []}
    assert service.next_catalog_attempt == 0
    cloud.youtube_ready = True
    cloud.catalog_error = None
    service._refresh_cloud_connections()
    assert service.status()["catalog_status"]["state"] == "ready"


def test_failed_reload_after_channel_change_keeps_old_names_but_reports_failure(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    cloud.channel = {"id": "UCother", "title": "Other channel"}
    cloud.catalog_error = CloudStreamError("down", http_status=503)
    service._refresh_cloud_connections()
    snapshot = service.status()
    assert cloud.catalog_calls == 2
    assert snapshot["catalog"]["channels"] == [{"id": "UCowned", "title": "Owned channel"}]
    assert snapshot["catalog_status"]["state"] == "failed"
    assert snapshot["catalog_status"]["retry_pending"] is True


def test_catalog_defaults_missing_titles_and_single_key_guidance(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    cloud._request = lambda method, path, **kwargs: {"channel": {"id": "UCowned"}, "streams": [{"id": "s1", "title": "  ", "channel": "UCowned"}]}
    service._refresh_cloud_connections()
    snapshot = service.status()
    assert snapshot["catalog"]["channels"] == [{"id": "UCowned", "title": "YouTube"}]
    assert snapshot["catalog"]["streams"] == [{"id": "s1", "title": "Untitled key", "channel_id": "UCowned"}]
    assert snapshot["catalog_status"]["message"].startswith("Loaded 1 reusable key for YouTube. Two distinct keys are needed")


def test_empty_catalog_is_ready_with_create_keys_guidance(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    cloud._request = lambda method, path, **kwargs: {"channel": dict(CHANNEL), "streams": []}
    service._refresh_cloud_connections()
    status = service.status()["catalog_status"]
    assert status["state"] == "ready"
    assert "Create two in YouTube Studio" in status["message"]


def configured_service(tmp_path, cloud):
    backend = PairBackend(tmp_path, memory=True, config={
        "metadata": {"title": "Title", "description": "", "vertical_suffix": " | Vertical"},
        "runtime_enabled": True, "expected_channel_id": "UCowned", "mode": "separate-events",
        "user_approved_separate_events": True, "existing_reusable_keys_confirmed": True,
        "streams": {"horizontal": {"reusable_stream_id": "stream-h", "privacy": "unlisted", "made_for_kids": False},
                    "portrait": {"reusable_stream_id": "stream-v", "privacy": "unlisted", "made_for_kids": False}}})
    return StreamService(tmp_path, lambda: {}, backend=backend, output_reader=Reader(), cloud_client=cloud)


def test_refresh_accounts_message_for_configured_account_is_plain(tmp_path, clock):
    cloud = FakeCloud()
    service = configured_service(tmp_path, cloud)
    result = service.action({"action": "refresh_accounts"})
    assert result["message"] == "SC2Tools account connections checked."
    assert result["catalog_status"]["state"] == "ready"
    assert result["configured"] is True


def test_refresh_accounts_message_for_unconfigured_account_points_to_setup(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    result = service.action({"action": "refresh_accounts"})
    assert result["message"] == "SC2Tools account connections checked. Choose your channel and both reusable keys in YouTube setup, then save."


def test_refresh_accounts_reloads_a_stale_catalog_after_a_failed_explicit_refresh(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    cloud.catalog_error = CloudStreamError("down", http_status=502)
    with pytest.raises(ValueError):
        service.action({"action": "refresh_keys"})
    assert service.status()["catalog_status"]["state"] == "failed"
    assert service.status()["catalog"]["channels"], "names are kept"
    cloud.catalog_error = None
    result = service.action({"action": "refresh_accounts"})
    assert cloud.catalog_calls == 3, "an explicit check reloads even a non-empty catalog"
    assert result["catalog_status"]["state"] == "ready"


def test_configure_happy_path_still_saves_after_explicit_discovery(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    calls_before = cloud.catalog_calls
    result = service.action({"action": "configure_youtube", "channel_id": "UCowned", "horizontal_id": "stream-h",
                             "portrait_id": "stream-v", "privacy": "unlisted", "made_for_kids": False})
    assert cloud.catalog_calls == calls_before + 1, "Save setup re-reads the catalog explicitly"
    assert result["configured"] is True
    assert result["configuration"]["channel_id"] == "UCowned"
    assert service.config_path.exists()
    assert result["catalog_status"]["state"] == "ready"


def test_refresh_keys_failure_after_exhausted_budget_restarts_it(tmp_path, clock):
    cloud = FakeCloud(catalog_error=CloudStreamError("down", http_status=502))
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    for delay in CATALOG_RETRY_DELAYS:
        clock.advance(delay + 1)
        service._refresh_cloud_connections()
    assert "Press Refresh keys" in service.status()["catalog_status"]["message"]
    with pytest.raises(ValueError):
        service.action({"action": "refresh_keys"})
    status = service.status()["catalog_status"]
    assert status["attempts"] == 1 and status["retry_pending"] is True
    assert "Retrying automatically" in status["message"]
    assert service.next_catalog_attempt == clock.now + CATALOG_RETRY_DELAYS[0]


def test_missing_server_support_is_not_retried_automatically(tmp_path, clock):
    cloud = FakeCloud(catalog_error=CloudStreamError("old server", http_status=404))
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    status = service.status()["catalog_status"]
    assert "does not provide" in status["message"] and "Press Refresh keys" in status["message"]
    assert status["retry_pending"] is False
    clock.advance(10_000)
    service._refresh_cloud_connections()
    assert cloud.catalog_calls == 1


def test_connecting_twitch_keeps_the_youtube_discovery_budget(tmp_path, clock, monkeypatch):
    import webbrowser
    monkeypatch.setattr(webbrowser, "open", lambda url, new=1: True)
    cloud = FakeCloud(catalog_error=CloudStreamError("down", http_status=502))
    cloud.connect = lambda platform: "https://id.twitch.tv/oauth2/authorize?state=private"
    service = make_service(tmp_path, cloud)
    service._refresh_cloud_connections()
    armed = service.next_catalog_attempt
    service.action({"action": "connect_twitch"})
    assert service.next_catalog_attempt == armed
    assert service.catalog_reload_pending is False
    assert service.youtube_consent_until == 0
    assert service.consent_poll_until == clock.now + service_module.CONSENT_POLL_WINDOW


class LocalAPI:
    """Shape of youtube_google_oauth.GoogleAPI: no catalog(), two reads."""
    write_enabled = True

    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def owned_channel(self):
        self.calls.append("owned_channel")
        if self.error is not None:
            raise self.error
        return dict(CHANNEL)

    def discover_reusable_streams_for_channel(self, channel_id):
        self.calls.append(("streams", channel_id))
        return [dict(row) for row in STREAMS]


def local_service(tmp_path, api, monkeypatch, configured=True):
    config = {"account_mode": "local", "metadata": {"title": "Title", "description": "", "vertical_suffix": " | Vertical"}}
    if configured:
        config.update(runtime_enabled=True, expected_channel_id="UCowned", streams={
            "horizontal": {"reusable_stream_id": "stream-h", "privacy": "unlisted", "made_for_kids": False},
            "portrait": {"reusable_stream_id": "stream-v", "privacy": "unlisted", "made_for_kids": False}})
    backend = PairBackend(tmp_path, memory=True, config=config)
    service = StreamService(tmp_path, lambda: {}, backend=backend, output_reader=Reader(), cloud_client=None)
    assert service.account_mode == "local"

    def attach():
        service.backend.api = api
        service.backend.writes_enabled = service.backend.connected = True

    monkeypatch.setattr(service, "_attach_youtube", attach)
    import sc2tools_agent.streaming.title_platforms as title_platforms
    monkeypatch.setattr(title_platforms, "load_adapter", lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError()))
    return service


def test_local_mode_startup_discovers_through_two_reads_without_configuring(tmp_path, clock, monkeypatch):
    api = LocalAPI()
    service = local_service(tmp_path, api, monkeypatch)
    service._restore_local_connections()
    assert api.calls == ["owned_channel", ("streams", "UCowned")]
    snapshot = service.status()
    assert snapshot["catalog_status"]["state"] == "ready"
    assert [row["title"] for row in snapshot["catalog"]["streams"]] == ["Horizontal key", "Vertical key"]
    assert snapshot["message"] == "YouTube session automation restored."
    assert snapshot["configuration"]["horizontal_id"] == "stream-h"


def test_local_mode_unconfigured_startup_does_not_discover(tmp_path, clock, monkeypatch):
    service = local_service(tmp_path, LocalAPI(), monkeypatch, configured=False)
    monkeypatch.setattr(service, "_attach_youtube", lambda: pytest.fail("no attach without runtime_enabled"))
    service._restore_local_connections()
    assert service.status()["catalog_status"]["state"] == "idle"


def test_local_mode_failure_wording_points_at_the_local_controls(tmp_path, clock, monkeypatch):
    error = ValueError("private google body")
    error.http_status = 403
    service = local_service(tmp_path, LocalAPI(error=error), monkeypatch)
    service._restore_local_connections()
    status = service.status()["catalog_status"]
    assert status["state"] == "failed"
    assert "your own Google client" in status["message"] and "refresh keys" in status["message"]
    assert "SC2Tools" not in status["message"]
    assert "private google" not in str(service.status())

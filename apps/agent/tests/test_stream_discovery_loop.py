"""Deterministic tests for StreamService._run(): startup plus scripted loop iterations.

A scripted stop-event stand-in runs the startup section once and then exactly
one loop iteration per step, on the calling thread with a fake clock. Each step
runs just before its iteration and may advance the clock, flip the fake cloud,
or dispatch a user action. No real thread, sleep or wall-clock deadline.
"""
from types import SimpleNamespace

import pytest

from sc2tools_agent.streaming import service as service_module
from sc2tools_agent.streaming.cloud_client import CloudStreamError
from sc2tools_agent.streaming.service import (
    CATALOG_RETRY_DELAYS, CONSENT_POLL_SECONDS, CONSENT_POLL_WINDOW, CONSENT_RETRY_SECONDS, PLATFORM_CHECK_SECONDS, StreamService,
)
from sc2tools_agent.streaming.youtube_pair_backend import PairBackend

CHANNEL = {"id": "UCowned", "title": "Owned channel"}
STREAMS = [
    {"id": "stream-h", "title": "Horizontal key", "channel": "UCowned"},
    {"id": "stream-v", "title": "Vertical key", "channel": "UCowned"},
]


class FakeCloud:
    def __init__(self, *, youtube_ready=True, twitch_ready=True, catalog_error=None):
        self.youtube_ready = youtube_ready
        self.twitch_ready = twitch_ready
        self.catalog_error = catalog_error
        self.channel = dict(CHANNEL)
        self.catalog_calls = []
        self.status_calls = 0

    def statuses(self):
        self.status_calls += 1
        return {
            "twitch": {"platform": "twitch", "streamingReady": self.twitch_ready, "account": "tw"},
            "kick": {"platform": "kick", "streamingReady": False, "account": "kk"},
            "youtube": {"platform": "youtube", "streamingReady": self.youtube_ready,
                        "platformUserId": self.channel["id"], "account": "yt"},
        }

    def _request(self, method, path, *, params=None, body=None):
        if path == "/v1/streaming/youtube/catalog":
            self.catalog_calls.append(service_module.time.monotonic())
            if self.catalog_error is not None:
                raise self.catalog_error
            return {"channel": dict(self.channel), "streams": [dict(row) for row in STREAMS]}
        raise AssertionError("unexpected request " + path)

    def connect(self, platform):
        return {"youtube": "https://accounts.google.com/o/oauth2/v2/auth?state=private",
                "twitch": "https://id.twitch.tv/oauth2/authorize?state=private",
                "kick": "https://id.kick.com/oauth/authorize?state=private"}[platform]


class Reader:
    def __call__(self, names):
        return {"horizontal": False, "portrait": False}

    def close(self):
        pass


class Script:
    """Stop-event stand-in: one loop iteration per step; each step runs just before its iteration."""

    def __init__(self, steps):
        self.steps = list(steps)
        self.stopped = False

    def wait(self, timeout):
        if self.stopped or not self.steps:
            return True
        self.steps.pop(0)()
        return False

    def is_set(self):
        return self.stopped

    def set(self):
        self.stopped = True

    def clear(self):
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


@pytest.fixture
def browser(monkeypatch):
    import webbrowser
    opened = []
    monkeypatch.setattr(webbrowser, "open", lambda url, new=1: opened.append(url) or True)
    return opened


def make_service(tmp_path, cloud, config=None):
    backend = PairBackend(tmp_path, memory=True, config={"metadata": {
        "title": "Title", "description": "", "vertical_suffix": " | Vertical"}, **(config or {})})
    return StreamService(tmp_path, lambda: {}, backend=backend, output_reader=Reader(), cloud_client=cloud)


def run_scripted(service, *steps):
    service.stop_event = Script(steps)
    service._run()


def ticks(clock, seconds, count):
    """Steps that each advance the clock by `seconds` and let one iteration run."""
    return [lambda: clock.advance(seconds) for _ in range(count)]


def test_startup_discovery_is_deterministic_and_never_configures(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)
    run_scripted(service)
    snapshot = service.status()
    assert cloud.status_calls == 1 and len(cloud.catalog_calls) == 1
    assert [row["title"] for row in snapshot["catalog"]["channels"]] == ["Owned channel"]
    assert snapshot["catalog_status"]["state"] == "ready"
    assert snapshot["configured"] is False
    assert "Choose your channel and both reusable keys" in snapshot["message"]
    assert service.next_platform_check == clock.now + PLATFORM_CHECK_SECONDS
    assert not service.config_path.exists()


def test_periodic_loop_retries_failed_discovery_before_next_platform_check(tmp_path, clock):
    cloud = FakeCloud(catalog_error=CloudStreamError("down", http_status=502))
    service = make_service(tmp_path, cloud)
    seen = []

    def too_early():
        clock.advance(CATALOG_RETRY_DELAYS[0] - 1)

    def after_first_delay():
        seen.append(len(cloud.catalog_calls))
        clock.advance(2)  # 16 s after startup: before the 60 s platform check
        cloud.catalog_error = None

    run_scripted(service, too_early, after_first_delay)
    assert cloud.status_calls == 1, "the retry reads the catalog only; it is not a platform check"
    assert seen == [1], "no retry before the first delay elapsed"
    assert len(cloud.catalog_calls) == 2
    snapshot = service.status()
    assert snapshot["catalog_status"]["state"] == "ready"
    assert snapshot["message"].startswith("YouTube channel and reusable keys loaded.")
    assert "Choose your channel and both reusable keys" in snapshot["message"]
    assert snapshot["configured"] is False
    assert not service.config_path.exists()


def test_periodic_loop_retry_budget_is_bounded(tmp_path, clock):
    cloud = FakeCloud(catalog_error=CloudStreamError("down", http_status=502))
    service = make_service(tmp_path, cloud)

    def step(seconds):
        def run():
            service.next_platform_check = float("inf")  # keep the 60 s platform check out of the way
            clock.advance(seconds)
        return run

    run_scripted(service, *(step(delay + 1) for delay in CATALOG_RETRY_DELAYS), step(100_000), step(100_000))
    assert cloud.status_calls == 1
    assert len(cloud.catalog_calls) == len(CATALOG_RETRY_DELAYS) + 1, "no automatic retry after the budget"
    status = service.status()["catalog_status"]
    assert status["attempts"] == len(CATALOG_RETRY_DELAYS) + 1
    assert status["retry_pending"] is False
    assert "Press Refresh keys" in status["message"]


def test_periodic_loop_never_rereads_a_ready_catalog(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)

    def tick():
        service.next_platform_check = clock.now + 10_000
        clock.advance(1_000)

    run_scripted(service, tick, tick, tick)
    assert len(cloud.catalog_calls) == 1


def test_consent_window_polls_quickly_then_returns_to_normal_cadence(tmp_path, clock, browser):
    cloud = FakeCloud(youtube_ready=False)
    service = make_service(tmp_path, cloud)
    checks = []

    def user_clicks_connect():
        service.action({"action": "connect_youtube"})
        assert service.next_platform_check == clock.now + CONSENT_POLL_SECONDS
        clock.advance(CONSENT_POLL_SECONDS)

    def record_then_consent():
        checks.append((cloud.status_calls, service.next_platform_check - clock.now))
        cloud.youtube_ready = True  # the user approved in the browser
        clock.advance(CONSENT_POLL_SECONDS)

    def record_then_expire():
        checks.append((cloud.status_calls, service.next_platform_check - clock.now))
        clock.advance(CONSENT_POLL_WINDOW)

    def record():
        checks.append((cloud.status_calls, service.next_platform_check - clock.now))

    run_scripted(service, user_clicks_connect, record_then_consent, record_then_expire, record)
    assert checks == [(2, CONSENT_POLL_SECONDS), (3, CONSENT_POLL_SECONDS), (4, PLATFORM_CHECK_SECONDS)]
    snapshot = service.status()
    assert len(cloud.catalog_calls) == 1, "catalog loaded on the first poll that saw consent"
    assert snapshot["youtube"]["connected"] is True
    assert snapshot["catalog_status"]["state"] == "ready"
    assert snapshot["configured"] is False, "consent never configures or enables runtime"
    assert not service.config_path.exists()


def test_headline_reports_the_completed_consent_instead_of_waiting_forever(tmp_path, clock, browser):
    cloud = FakeCloud(youtube_ready=False)
    service = make_service(tmp_path, cloud)

    def connect():
        service.action({"action": "connect_youtube"})
        assert "Complete YouTube authorization" in service.status()["message"]
        clock.advance(CONSENT_POLL_SECONDS)

    def consent():
        cloud.youtube_ready = True
        clock.advance(CONSENT_POLL_SECONDS)

    run_scripted(service, connect, consent)
    message = service.status()["message"]
    assert message.startswith("YouTube connected.")
    assert "Choose your channel and both reusable keys" in message


def test_pre_consent_failures_never_spend_the_budget_and_consent_loads_promptly(tmp_path, clock, browser):
    """A stale grant reports streamingReady while the catalog answers 403 until the user re-consents."""
    cloud = FakeCloud(catalog_error=CloudStreamError("stale grant", http_status=403))
    service = make_service(tmp_path, cloud)
    consent_time = []

    def connect():
        service.action({"action": "connect_youtube"})
        assert service.status()["catalog_status"]["attempts"] == 0

    steps = [connect]
    steps += ticks(clock, CONSENT_POLL_SECONDS, 7)  # 35 s of pre-consent polling and retries

    def consent():
        cloud.catalog_error = None
        consent_time.append(clock.now)
        clock.advance(CONSENT_POLL_SECONDS)

    steps.append(consent)
    steps += ticks(clock, CONSENT_POLL_SECONDS, 4)
    run_scripted(service, *steps)
    loaded = [when for when in cloud.catalog_calls if when > consent_time[0]]
    assert loaded, "the catalog must be read after the consent completed"
    assert loaded[0] - consent_time[0] <= CONSENT_RETRY_SECONDS + CONSENT_POLL_SECONDS
    pre_consent = [when for when in cloud.catalog_calls if when <= consent_time[0]]
    assert len(pre_consent) <= 1 + 35 // CONSENT_RETRY_SECONDS + 1, "steady, bounded pacing before the consent"
    snapshot = service.status()
    assert snapshot["catalog_status"]["state"] == "ready"
    assert snapshot["message"].startswith("YouTube channel and reusable keys loaded.")


def test_consent_never_completed_falls_back_to_the_bounded_budget(tmp_path, clock, browser):
    cloud = FakeCloud(catalog_error=CloudStreamError("stale grant", http_status=403))
    service = make_service(tmp_path, cloud)

    observed = {}

    def connect():
        service.action({"action": "connect_youtube"})

    def window_closing():
        # Still inside the window: steady retries never spent the budget.
        during_window = service.status()["catalog_status"]
        assert during_window["attempts"] == 1 and during_window["retry_pending"] is True
        observed["after_window"] = len(cloud.catalog_calls)
        clock.advance(2 * CONSENT_POLL_SECONDS + CATALOG_RETRY_DELAYS[0])

    steps = [connect] + ticks(clock, CONSENT_POLL_SECONDS, CONSENT_POLL_WINDOW // CONSENT_POLL_SECONDS - 1) + [window_closing]
    steps += [lambda: clock.advance(delay + 1) for delay in CATALOG_RETRY_DELAYS] + [lambda: clock.advance(100_000)] * 2
    run_scripted(service, *steps)
    status = service.status()["catalog_status"]
    assert len(cloud.catalog_calls) - observed["after_window"] <= len(CATALOG_RETRY_DELAYS)
    assert status["retry_pending"] is False
    assert "Press Refresh keys" in status["message"]


def test_connecting_twitch_does_not_restart_the_exhausted_youtube_budget(tmp_path, clock, browser):
    cloud = FakeCloud(catalog_error=CloudStreamError("down", http_status=502))
    service = make_service(tmp_path, cloud)
    exhausted = []

    def exhaust():
        # Startup already made attempt 1; three more spend the whole budget.
        for delay in CATALOG_RETRY_DELAYS:
            clock.advance(delay + 1)
            service._refresh_cloud_connections()
        assert "Press Refresh keys" in service.status()["catalog_status"]["message"]
        exhausted.append(len(cloud.catalog_calls))
        service.action({"action": "connect_twitch"})
        clock.advance(CONSENT_POLL_SECONDS)

    run_scripted(service, exhaust, *ticks(clock, CONSENT_POLL_SECONDS, 3))
    assert len(cloud.catalog_calls) == exhausted[0]
    assert cloud.status_calls >= 7, "the fast consent poll still runs for Twitch"


def test_lost_connection_is_announced_by_the_background_check(tmp_path, clock):
    cloud = FakeCloud()
    service = make_service(tmp_path, cloud)

    def drop_twitch():
        cloud.twitch_ready = False
        clock.advance(PLATFORM_CHECK_SECONDS + 1)

    run_scripted(service, drop_twitch)
    assert service.status()["message"].startswith("Twitch needs to be connected again.")


def test_transient_status_failure_during_consent_window_keeps_sessions_and_recovers(tmp_path, clock, browser):
    cloud = FakeCloud(youtube_ready=False)
    service = make_service(tmp_path, cloud)
    good = cloud.statuses

    def broken():
        raise CloudStreamError("private status body", http_status=503)

    def connect():
        service.action({"action": "connect_youtube"})
        clock.advance(CONSENT_POLL_SECONDS)
        cloud.statuses = broken

    def observe():
        assert "could not be verified" in service.status()["message"]
        assert "private status" not in str(service.status())
        cloud.statuses = good
        cloud.youtube_ready = True
        clock.advance(31)  # the failure path defers the next check by 30 s

    run_scripted(service, connect, observe)
    assert service.status()["youtube"]["connected"] is True
    assert service.status()["catalog_status"]["state"] == "ready"

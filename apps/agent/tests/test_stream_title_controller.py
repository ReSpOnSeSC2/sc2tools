"""Actual service/controller/cloud contract; every HTTP/provider call is mocked."""
from types import SimpleNamespace
import copy
import threading

import pytest

from sc2tools_agent.streaming.cloud_client import CloudStreamingClient
from sc2tools_agent.streaming.service import StreamService
from sc2tools_agent.streaming.title_settings import configure_title_settings, load_title_settings


@pytest.fixture(autouse=True)
def deny_network(monkeypatch):
    def denied(*_args, **_kwargs):
        raise AssertionError("Real account/provider requests are forbidden")
    monkeypatch.setattr("socket.socket.connect", denied)
    monkeypatch.setattr("requests.request", denied)


@pytest.fixture
def service(tmp_path):
    calls = []
    connection = ["https://api.sc2tools.com", "fixture-agent-token"]
    stats = {"schema": 1, "mmr": 5000, "league": "Grandmaster", "session": {"wins": 2, "losses": 1}}
    def transport(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if method == "GET":
            return SimpleNamespace(status_code=200, json=lambda: copy.deepcopy(stats))
        payload = kwargs["json"]
        platform = payload["platforms"][0]
        return SimpleNamespace(status_code=200, json=lambda: {"platforms": [{"platform": platform,
            "connected": True, "streamingReady": True, "title": payload["title"],
            "requestedTitle": payload["title"], "accepted": True, "titleVerified": True, "titleStatus": "verified"}]})
    client = CloudStreamingClient(lambda: tuple(connection), transport=transport)
    instance = StreamService(tmp_path, lambda: {}, no_obs=True, cloud_client=client)
    instance.titles.worker.clock = lambda: 1200
    yield instance, calls, stats, connection
    instance.close()


def configure(service, *, enabled=True, youtube=False):
    return service.action({"action": "configure_title_automation", "enabled": enabled,
        "template": "SC2 | {mmr} | {record}", "platforms": {"twitch": True, "kick": True, "youtube": youtube}})


def refresh(instance, automatic=True):
    instance.titles.worker.preview_pending = True
    instance.titles.worker.ready = automatic
    return instance.titles.worker.run_once()


def test_default_off_and_saving_never_publishes(service):
    instance, calls, *_ = service
    assert instance.status()["title_automation"]["enabled"] is False
    assert instance.status()["title_automation"]["platforms"] == {"twitch": True, "kick": True, "youtube": False}
    configure(instance)
    assert calls == []
    refresh(instance, automatic=False)
    assert [row[0] for row in calls] == ["GET"]
    assert instance.status()["title_automation"]["values"]["mmr"] == "5000"


def test_selected_providers_receipts_unchanged_and_cooldown_survive_restart(service, tmp_path):
    instance, calls, *_ = service
    configure(instance)
    assert refresh(instance)
    writes = [call for call in calls if call[0] == "POST"]
    assert [call[2]["json"]["platforms"] for call in writes] == [["twitch"], ["kick"]]
    assert all(call[2]["json"]["title"] == "SC2 | 5000 | 2W–1L" for call in writes)
    assert instance.status()["platform_results"]["kick"]["title_verified"] is True
    instance.close()
    restored = StreamService(tmp_path, lambda: {}, no_obs=True, cloud_client=instance.cloud_client)
    try:
        assert restored.titles.worker.last_attempt == 1200
        restored.titles.worker.clock = lambda: 1800
        refresh(restored)
        assert len([call for call in calls if call[0] == "POST"]) == 2
        assert "unchanged" in restored.status()["title_automation"]["message"]
    finally:
        restored.close()


def test_disabled_and_missing_statistics_do_not_publish(service):
    instance, calls, stats, _ = service
    configure(instance, enabled=False)
    refresh(instance)
    assert not any(call[0] == "POST" for call in calls)
    configure(instance)
    stats.clear()
    stats["schema"] = 1
    instance.titles.settings["template"] = "{mmr}"
    instance.titles.worker.clock = lambda: 1800
    refresh(instance)
    assert not any(call[0] == "POST" for call in calls)
    assert "unavailable" in instance.status()["title_automation"]["message"]


@pytest.mark.parametrize("change", ["account", "shutdown", "mode"])
def test_pending_snapshot_is_fenced_before_provider_write(service, change):
    instance, calls, stats, connection = service
    configure(instance, youtube=True)
    entered, release = threading.Event(), threading.Event()
    original = instance.cloud_client.transport
    def held(*args, **kwargs):
        if args[0] == "GET":
            entered.set()
            assert release.wait(3)
        return original(*args, **kwargs)
    instance.cloud_client.transport = held
    thread = threading.Thread(target=lambda: refresh(instance))
    thread.start()
    assert entered.wait(3)
    if change == "account":
        connection[1] = "different-fixture-token"
    elif change == "mode":
        instance.action({"action": "use_local_connections"})
    else:
        instance.stop_event.set()
    release.set()
    thread.join(3)
    assert not thread.is_alive()
    assert not any(call[0] == "POST" for call in calls)
    if change != "shutdown":
        instance._publish()
        assert instance.status()["title_automation"]["enabled"] is False


def test_same_title_is_marked_before_ambiguous_write_and_not_retried(service):
    instance, calls, *_ = service
    configure(instance)
    def ambiguous(*_args, **_kwargs):
        raise RuntimeError("private provider token")
    instance._apply_title = ambiguous
    refresh(instance)
    assert "could not be completed" in instance.status()["title_automation"]["message"]
    instance.titles.worker.clock = lambda: 1800
    refresh(instance)
    assert "unchanged" in instance.status()["title_automation"]["message"]
    assert "private provider" not in str(instance.status())


def test_strict_boolean_and_account_settings_validation():
    settings = load_title_settings({}, "fixture-owner")
    for bad in [1, "true", None]:
        with pytest.raises(ValueError):
            configure_title_settings(settings, {"enabled": bad}, "fixture-owner")
    assert load_title_settings({"enabled": True, "owner": "old"}, "new")["enabled"] is False

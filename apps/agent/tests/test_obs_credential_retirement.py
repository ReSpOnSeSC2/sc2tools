"""Shared OBS clients discard only their own retired synthetic connections."""
import threading
from types import SimpleNamespace

import pytest

from sc2tools_agent.live.obs_client import ObsClient, ObsUnavailable
from tests.test_live_obs_client import _RawObs, _RawEvents


@pytest.mark.parametrize("retirement", ["clear", "set", "shutdown"])
def test_held_connect_never_publishes_retired_password_or_healthy_callback(retirement):
    entered, release, connected, states, calls = threading.Event(), threading.Event(), [], [], []
    old, current = _RawObs(), _RawObs()
    def factory(**kwargs):
        calls.append(kwargs["password"])
        if len(calls) == 1:
            entered.set()
            assert release.wait(3)
            return old
        return current
    subject = ObsClient(password="synthetic-old-private", connect_factory=factory,
        subscribe_events=False, on_connected=lambda: connected.append(True),
        on_state=lambda *args: states.append(args))
    results = []
    worker = threading.Thread(target=lambda: results.append(subject.connect_now()))
    worker.start()
    try:
        assert entered.wait(2)
        if retirement == "shutdown":
            subject.shutdown()
        else:
            subject.reconfigure(password="" if retirement == "clear" else "synthetic-new-private")
        states.clear()
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and results == [False]
    assert old.disconnected and subject._raw is None and not subject.is_connected
    assert connected == states == [] and subject.scene_names == []
    if retirement != "shutdown":
        assert subject.connect_now()
        assert calls[-1] == ("" if retirement == "clear" else "synthetic-new-private")
        assert subject._raw is current and connected == [True]
    subject.shutdown()


def test_retired_connect_error_cannot_poison_new_connection_auth_state():
    entered, release, old_results = threading.Event(), threading.Event(), []
    current, calls = _RawObs(), []
    def factory(**kwargs):
        calls.append(kwargs["password"])
        if len(calls) == 1:
            entered.set()
            assert release.wait(3)
            raise RuntimeError("synthetic old password authentication denied")
        return current
    subject = ObsClient(password="old", connect_factory=factory, subscribe_events=False)
    worker = threading.Thread(target=lambda: old_results.append(subject.connect_now()))
    worker.start()
    try:
        assert entered.wait(2)
        subject.reconfigure(password="new")
        assert subject.connect_now()
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and old_results == [False]
    assert subject._raw is current and subject.is_connected and not subject.auth_failed
    assert current.disconnected is False
    subject.shutdown()


def test_held_event_factory_and_old_event_callback_cannot_attach_after_clear():
    entered, release, scenes = threading.Event(), threading.Event(), []
    raw, events = _RawObs(), _RawEvents()
    def factory(**kwargs):
        entered.set()
        assert release.wait(3)
        return events
    subject = ObsClient(password="old", connect_factory=lambda **kwargs: raw, event_factory=factory,
        on_program_scene_changed=scenes.append)
    results = []
    worker = threading.Thread(target=lambda: results.append(subject.connect_now()))
    worker.start()
    try:
        assert entered.wait(2)
        subject.reconfigure(password="")
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and results == [False]
    assert events.disconnected and subject._events is None and scenes == []
    subject.shutdown()


def test_retired_registered_event_cannot_publish_into_reconfigured_client():
    raw, events, scenes = _RawObs(), _RawEvents(), []
    subject = ObsClient(connect_factory=lambda **kwargs: raw, event_factory=lambda **kwargs: events,
        on_program_scene_changed=scenes.append)
    assert subject.connect_now()
    callback = events.registered
    callback(SimpleNamespace(scene_name="current synthetic scene"))
    assert scenes == ["current synthetic scene"]
    subject.reconfigure(password="new")
    callback(SimpleNamespace(scene_name="stale synthetic scene"))
    assert scenes == ["current synthetic scene"] and events.disconnected
    subject.shutdown()


def test_held_scene_inventory_cannot_restore_old_cache_after_new_connection():
    entered, release, failures = threading.Event(), threading.Event(), []
    old, current = _RawObs(), _RawObs()
    subject = ObsClient(connect_factory=lambda **kwargs: old, subscribe_events=False)
    assert subject.connect_now()
    def old_scenes():
        entered.set()
        assert release.wait(3)
        return SimpleNamespace(scenes=[{"sceneName": "old-private-scene"}])
    old.get_scene_list = old_scenes
    def refresh():
        try:
            subject.refresh_scenes()
        except ObsUnavailable:
            failures.append(True)
    worker = threading.Thread(target=refresh)
    worker.start()
    try:
        assert entered.wait(2)
        subject.reconfigure(password="new")
        subject._connect_factory = lambda **kwargs: current
        current.get_scene_list = lambda: SimpleNamespace(scenes=[{"sceneName": "current scene"}])
        assert subject.connect_now()
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and failures == [True]
    assert subject._raw is current and current.disconnected is False
    assert subject.scene_names == ["current scene"]
    subject.shutdown()

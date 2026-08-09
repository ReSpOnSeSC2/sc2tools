"""Boundary tests for the obsws-python response normalisation layer."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sc2tools_agent.live.obs_client import ObsClient, ObsUnavailable


class _RawObs:
    def __init__(self) -> None:
        self.disconnected = False
        self.enabled_calls = []

    def get_scene_list(self):
        return SimpleNamespace(scenes=[])

    def get_scene_item_list(self, scene_name):
        assert scene_name == "SC2 Tools — In Game"
        return SimpleNamespace(
            scene_items=[
                {
                    "sourceName": "SC2 Tools Manual Override",
                    "sceneItemId": 42,
                    "sceneItemIndex": 3,
                    "sceneItemEnabled": False,
                    "inputKind": "browser_source",
                    "sceneItemTransform": {
                        "positionX": 0.0,
                        "positionY": 0.0,
                    },
                },
            ],
        )

    def get_input_settings(self, input_name):
        assert input_name == "SC2 Tools Manual Override"
        return SimpleNamespace(
            input_settings={"url": "https://sc2tools.com/overlay/t/scene/manual"},
        )

    def set_scene_item_enabled(self, scene_name, item_id, enabled):
        self.enabled_calls.append((scene_name, item_id, enabled))

    def disconnect(self):
        self.disconnected = True


class _RawEvents:
    def __init__(self) -> None:
        self.disconnected = False
        self.registered = None
        self.callback = SimpleNamespace(register=self._register)

    def _register(self, callback):
        self.registered = callback

    def disconnect(self):
        self.disconnected = True


def _client(raw: _RawObs) -> ObsClient:
    client = ObsClient(
        connect_factory=lambda **_kwargs: raw,
        subscribe_events=False,
    )
    assert client.connect_now() is True
    return client


def test_scene_item_and_input_settings_responses_are_normalised() -> None:
    raw = _RawObs()
    client = _client(raw)
    try:
        assert client.get_scene_item_list("SC2 Tools — In Game") == [
            {
                "source_name": "SC2 Tools Manual Override",
                "item_id": 42,
                "index": 3,
                "input_kind": "browser_source",
                "enabled": False,
                "transform": {"positionX": 0.0, "positionY": 0.0},
            },
        ]
        assert client.get_input_settings("SC2 Tools Manual Override") == {
            "url": "https://sc2tools.com/overlay/t/scene/manual",
        }

        client.set_scene_item_enabled(
            scene_name="SC2 Tools — In Game",
            item_id=42,
            enabled=True,
        )
        assert raw.enabled_calls == [("SC2 Tools — In Game", 42, True)]
    finally:
        client.shutdown()


def test_failed_request_disconnects_the_failed_socket() -> None:
    class BrokenRaw(_RawObs):
        def get_current_program_scene(self):
            raise RuntimeError("socket died")

    raw = BrokenRaw()
    client = _client(raw)

    with pytest.raises(ObsUnavailable, match="get_current_program_scene failed"):
        client.current_program_scene()

    assert raw.disconnected is True
    assert client.is_connected is False


def test_post_connect_request_failure_reports_an_unhealthy_connection() -> None:
    """The reconnect loop must back off if migration loses its request socket."""
    class BrokenRaw(_RawObs):
        def get_current_program_scene(self):
            raise RuntimeError("socket died during post-connect work")

    raw = BrokenRaw()
    holder = {}
    client = ObsClient(
        connect_factory=lambda **_kwargs: raw,
        on_connected=lambda: holder["client"].current_program_scene(),
        subscribe_events=False,
    )
    holder["client"] = client

    assert client.connect_now() is False
    assert raw.disconnected is True
    assert client.is_connected is False


def test_reconnect_replaces_and_closes_the_old_event_socket() -> None:
    class FirstRaw(_RawObs):
        def get_current_program_scene(self):
            raise RuntimeError("request socket died")

    request_clients = iter([FirstRaw(), _RawObs()])
    event_clients = [_RawEvents(), _RawEvents()]
    event_iter = iter(event_clients)
    client = ObsClient(
        connect_factory=lambda **_kwargs: next(request_clients),
        event_factory=lambda **_kwargs: next(event_iter),
        on_program_scene_changed=lambda _name: None,
    )
    try:
        assert client.connect_now() is True
        with pytest.raises(ObsUnavailable):
            client.current_program_scene()

        assert client.connect_now() is True
        assert event_clients[0].disconnected is True
        assert event_clients[1].disconnected is False
    finally:
        client.shutdown()
    assert event_clients[1].disconnected is True


def test_connection_settings_follow_reconfigure() -> None:
    client = ObsClient(
        host="127.0.0.1",
        port=4455,
        password="old",
        subscribe_events=False,
    )

    client.reconfigure(host="10.0.0.8", port=4466, password="new")

    assert client.connection_settings == ("10.0.0.8", 4466, "new")

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

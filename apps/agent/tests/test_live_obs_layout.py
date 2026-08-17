"""Unit tests for ``sc2tools_agent.live.obs_layout`` — the one-click
scene builder.

This is the only code in the agent that writes to a user's OBS, and it
runs against a live stream setup, so the tests lean hard on the safety
contract: it creates its own scenes, it reuses existing inputs rather
than duplicating captures, and it never touches anything it did not
name.

As with the switcher tests, the OBS client is injected — nothing here
needs a running OBS, which matters because the agent suite runs on
``windows-latest`` in CI.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Optional

import pytest

from sc2tools_agent.live.obs_layout import (
    BETWEEN_GAMES_LAYOUT,
    CHAT_ALERTS_BROWSER_PATH,
    CHAT_ALERTS_INPUT_NAME,
    CHAT_ALERTS_RECT,
    IN_GAME_LAYOUT,
    MANUAL_OVERRIDE_BROWSER_PATH,
    MANUAL_OVERRIDE_INPUT_NAME,
    REF_HEIGHT,
    REF_WIDTH,
    SCENE_NAME_PREFIX,
    SceneBuildError,
    build_scenes,
    discover_manual_override_url,
    discover_sources,
    discover_widget_only_broll_url,
    manual_override_scenes_needing_update,
    plan_scenes,
    repair_broll_audio_roles,
    repair_chat_alert_audio_roles,
    repair_manual_scene_overrides,
    repair_vertical_scene_chat_alerts,
    VERTICAL_SCENE_NAME,
)
from sc2tools_agent.live.obs_scene import (
    DEFAULT_SCENE_MAP,
    SCENE_BETWEEN_GAMES,
    SCENE_IN_GAME,
)

BASE_URL = "https://sc2tools.com"
TOKEN = "tok123"


class FakeObs:
    """Records every mutating call so the tests can assert on them."""

    def __init__(
        self,
        *,
        scenes: Optional[List[str]] = None,
        inputs: Optional[List[Dict[str, Any]]] = None,
        canvas: tuple = (1920, 1080),
    ) -> None:
        self._scenes = list(scenes or [])
        self._inputs = list(
            inputs
            if inputs is not None
            else [
                {"name": "Logitech Brio", "kind": "dshow_input"},
                {"name": "StarCraft II", "kind": "game_capture"},
                {"name": "Desktop Audio", "kind": "wasapi_output_capture"},
            ],
        )
        self.input_settings: Dict[str, Dict[str, Any]] = {
            str(row.get("name") or ""): dict(row.get("settings") or {})
            for row in self._inputs
            if row.get("name")
        }
        self._canvas = canvas
        self._next_item_id = 100

        self.created_scenes: List[str] = []
        self.removed_scenes: List[str] = []
        self.created_items: List[Dict[str, Any]] = []
        self.created_inputs: List[Dict[str, Any]] = []
        self.removed_items: List[Dict[str, Any]] = []
        self.transforms: List[Dict[str, Any]] = []
        self.indexes: List[Dict[str, Any]] = []
        self.enabled_updates: List[Dict[str, Any]] = []
        self.input_setting_updates: List[Dict[str, Any]] = []
        self.refreshed_browser_inputs: List[str] = []

    # ---- reads ----
    def get_video_settings(self) -> Dict[str, Any]:
        return {"base_width": self._canvas[0], "base_height": self._canvas[1]}

    def get_input_list(self, kind: Optional[str] = None) -> List[Dict[str, Any]]:
        return list(self._inputs)

    def get_input_settings(self, name: str) -> Dict[str, Any]:
        return dict(self.input_settings.get(name, {}))

    def set_input_settings(
        self, name: str, settings: Dict[str, Any],
    ) -> None:
        self.input_settings[name].update(settings)
        self.input_setting_updates.append(
            {"name": name, "settings": dict(settings)},
        )

    def refresh_scenes(self) -> List[str]:
        return list(self._scenes)

    @property
    def scene_names(self) -> List[str]:
        return list(self._scenes)

    # ---- writes ----
    def create_scene(self, name: str) -> None:
        self._scenes.append(name)
        self.created_scenes.append(name)

    def remove_scene(self, name: str) -> None:
        if name in self._scenes:
            self._scenes.remove(name)
        self.removed_scenes.append(name)

    def create_scene_item(
        self, *, scene_name: str, source_name: str, enabled: bool = True,
    ) -> int:
        self._next_item_id += 1
        self.created_items.append(
            {
                "scene": scene_name,
                "source": source_name,
                "id": self._next_item_id,
                "enabled": enabled,
            },
        )
        return self._next_item_id

    def remove_scene_item(self, *, scene_name: str, item_id: int) -> None:
        self.removed_items.append({"scene": scene_name, "id": item_id})

    def create_input(
        self,
        *,
        scene_name: str,
        input_name: str,
        input_kind: str,
        settings: Dict[str, Any],
        enabled: bool = True,
    ) -> int:
        self._next_item_id += 1
        self._inputs.append({"name": input_name, "kind": input_kind})
        self.input_settings[input_name] = dict(settings)
        self.created_inputs.append(
            {
                "scene": scene_name,
                "name": input_name,
                "kind": input_kind,
                "settings": settings,
                "id": self._next_item_id,
            },
        )
        return self._next_item_id

    def set_scene_item_transform(
        self, *, scene_name: str, item_id: int, transform: Dict[str, Any],
    ) -> None:
        self.transforms.append(
            {"scene": scene_name, "id": item_id, **transform},
        )

    def set_scene_item_index(
        self, *, scene_name: str, item_id: int, index: int,
    ) -> None:
        self.indexes.append(
            {"scene": scene_name, "id": item_id, "index": index},
        )

    def set_scene_item_enabled(
        self, *, scene_name: str, item_id: int, enabled: bool,
    ) -> None:
        self.enabled_updates.append(
            {"scene": scene_name, "id": item_id, "enabled": enabled},
        )

    def refresh_browser_input(self, name: str) -> None:
        self.refreshed_browser_inputs.append(name)



class LegacyObs(FakeObs):
    """Models the pre-manual-cover scene collection from the regression.

    Unlike ``FakeObs``, this fake maintains the final OBS stack after every
    move. That lets the repair tests assert what is actually topmost instead
    of merely checking which indices the builder requested.
    """

    def __init__(self, *, colliding_manual_input: bool = False) -> None:
        browser_inputs = [
            {"name": "SC2 Tools Backdrop", "kind": "browser_source"},
            {"name": "SC2 Tools Session Stats", "kind": "browser_source"},
            {"name": "SC2 Tools Chat", "kind": "browser_source"},
            {"name": "Stats Ticker", "kind": "browser_source"},
        ]
        if colliding_manual_input:
            browser_inputs.append(
                {"name": MANUAL_OVERRIDE_INPUT_NAME, "kind": "browser_source"},
            )
        super().__init__(
            scenes=[SCENE_BETWEEN_GAMES, SCENE_IN_GAME],
            inputs=[
                {"name": "Logitech Brio", "kind": "dshow_input"},
                {"name": "StarCraft II", "kind": "game_capture"},
                *browser_inputs,
            ],
        )
        self.input_settings: Dict[str, Dict[str, Any]] = {
            "SC2 Tools Backdrop": {
                "url": f"{BASE_URL}/overlay/{TOKEN}/scene/between-games",
            },
            "SC2 Tools Session Stats": {
                "url": f"{BASE_URL}/overlay/{TOKEN}/widget/session",
            },
            "SC2 Tools Chat": {
                "url": f"{BASE_URL}/overlay/{TOKEN}/widget/multichat",
            },
            "Stats Ticker": {
                "url": f"{BASE_URL}/overlay/{TOKEN}/widget/stats-ticker",
            },
        }
        if colliding_manual_input:
            self.input_settings[MANUAL_OVERRIDE_INPUT_NAME] = {
                "url": "https://example.com/not-the-manual-cover",
            }
        self.scene_items: Dict[str, List[Dict[str, Any]]] = {
            SCENE_BETWEEN_GAMES: self._items(
                [
                    ("SC2 Tools Backdrop", "browser_source"),
                    ("Logitech Brio", "dshow_input"),
                    ("StarCraft II", "game_capture"),
                    ("SC2 Tools Session Stats", "browser_source"),
                    ("SC2 Tools Chat", "browser_source"),
                    # Added by the streamer after the original build. A
                    # destructive rebuild would lose it.
                    ("Stats Ticker", "browser_source"),
                ],
            ),
            SCENE_IN_GAME: self._items(
                [
                    ("StarCraft II", "game_capture"),
                    ("Logitech Brio", "dshow_input"),
                ],
            ),
        }

    def _items(self, sources: List[tuple]) -> List[Dict[str, Any]]:
        out = []
        for index, (source_name, input_kind) in enumerate(sources):
            self._next_item_id += 1
            out.append(
                {
                    "source_name": source_name,
                    "item_id": self._next_item_id,
                    "index": index,
                    "input_kind": input_kind,
                    "enabled": True,
                    "transform": {},
                },
            )
        return out

    def get_input_settings(self, name: str) -> Dict[str, Any]:
        return dict(self.input_settings.get(name, {}))

    def get_scene_item_list(self, scene_name: str) -> List[Dict[str, Any]]:
        return [dict(item) for item in self.scene_items.get(scene_name, [])]

    def create_input(self, **kw: Any) -> int:
        item_id = super().create_input(**kw)
        name = str(kw["input_name"])
        self.input_settings[name] = dict(kw["settings"])
        self.scene_items[kw["scene_name"]].append(
            {
                "source_name": name,
                "item_id": item_id,
                "index": len(self.scene_items[kw["scene_name"]]),
                "input_kind": kw["input_kind"],
                "enabled": bool(kw.get("enabled", True)),
                "transform": {},
            },
        )
        return item_id

    def create_scene_item(self, **kw: Any) -> int:
        item_id = super().create_scene_item(**kw)
        source_name = str(kw["source_name"])
        kind = next(
            row["kind"] for row in self._inputs
            if row["name"] == source_name
        )
        self.scene_items[kw["scene_name"]].append(
            {
                "source_name": source_name,
                "item_id": item_id,
                "index": len(self.scene_items[kw["scene_name"]]),
                "input_kind": kind,
                "enabled": bool(kw.get("enabled", True)),
                "transform": {},
            },
        )
        return item_id

    def remove_scene_item(self, **kw: Any) -> None:
        super().remove_scene_item(**kw)
        scene_name = str(kw["scene_name"])
        item_id = int(kw["item_id"])
        self.scene_items[scene_name] = [
            item for item in self.scene_items[scene_name]
            if int(item["item_id"]) != item_id
        ]
        for index, item in enumerate(sorted(
            self.scene_items[scene_name],
            key=lambda item: int(item["index"]),
        )):
            item["index"] = index

    def set_scene_item_transform(self, **kw: Any) -> None:
        super().set_scene_item_transform(**kw)
        item = self._item(kw["scene_name"], kw["item_id"])
        item["transform"] = dict(kw["transform"])

    def set_scene_item_index(self, **kw: Any) -> None:
        super().set_scene_item_index(**kw)
        items = sorted(
            self.scene_items[kw["scene_name"]],
            key=lambda item: item["index"],
        )
        moving = next(item for item in items if item["item_id"] == kw["item_id"])
        items.remove(moving)
        items.insert(max(0, min(int(kw["index"]), len(items))), moving)
        for index, item in enumerate(items):
            item["index"] = index
        self.scene_items[kw["scene_name"]] = items

    def set_scene_item_enabled(self, **kw: Any) -> None:
        super().set_scene_item_enabled(**kw)
        item = self._item(kw["scene_name"], kw["item_id"])
        item["enabled"] = bool(kw["enabled"])

    def _item(self, scene_name: str, item_id: int) -> Dict[str, Any]:
        return next(
            item for item in self.scene_items[scene_name]
            if item["item_id"] == item_id
        )


class VerticalAlertObs(LegacyObs):
    """Exact legacy Live/Vertical fingerprint from the user's collection."""

    def __init__(self) -> None:
        super().__init__()
        self._scenes.extend(["Live Scene", VERTICAL_SCENE_NAME])
        self._inputs.extend(
            [
                {"name": "Alert Box", "kind": "browser_source"},
                {"name": "BRB/Starting Soon - Vertical", "kind": "browser_source"},
            ],
        )
        self.input_settings["Alert Box"] = {
            "url": f"{BASE_URL}/overlay/{TOKEN}/{CHAT_ALERTS_BROWSER_PATH}",
            "width": 800,
            "height": 600,
        }
        self.input_settings["BRB/Starting Soon - Vertical"] = {
            "url": f"{BASE_URL}/overlay/{TOKEN}/widget/stream-scene",
            "width": 1080,
            "height": 1920,
        }
        self.scene_items["Live Scene"] = self._items(
            [
                ("Logitech Brio", "dshow_input"),
                ("Alert Box", "browser_source"),
                ("Stats Ticker", "browser_source"),
            ],
        )
        live_alert = self.scene_items["Live Scene"][1]
        live_alert["enabled"] = False
        live_alert["transform"] = {
            "positionX": 592,
            "positionY": 343,
            "scaleX": 2.245,
            "custom": "preserve exactly",
        }
        self.scene_items[VERTICAL_SCENE_NAME] = self._items(
            [
                ("StarCraft II", "game_capture"),
                ("SC2 Tools Chat", "browser_source"),
                ("BRB/Starting Soon - Vertical", "browser_source"),
                ("Stats Ticker", "browser_source"),
            ],
        )


class BrollAudioObs(VerticalAlertObs):
    """The user's three-player topology plus a foreign-token control."""

    def __init__(self) -> None:
        super().__init__()
        self._inputs.extend(
            [
                {"name": "BRB/Starting Soon", "kind": "browser_source"},
                {"name": "Foreign B-roll", "kind": "browser_source"},
            ],
        )
        self.input_settings["BRB/Starting Soon"] = {
            "url": (
                f"{BASE_URL}/overlay/{TOKEN}/widget/stream-scene"
                "?theme=violet"
            ),
            "width": 1920,
            "height": 1080,
            "reroute_audio": False,
            "shutdown": False,
        }
        self.input_settings["BRB/Starting Soon - Vertical"][
            "reroute_audio"
        ] = False
        self.input_settings["BRB/Starting Soon - Vertical"]["shutdown"] = False
        self.input_settings["Foreign B-roll"] = {
            "url": f"{BASE_URL}/overlay/another/widget/stream-scene",
            "width": 1920,
            "height": 1080,
            "reroute_audio": False,
            "shutdown": False,
        }
        live_items = self.scene_items["Live Scene"]
        live_widget = self._items(
            [("BRB/Starting Soon", "browser_source")],
        )[0]
        live_widget["index"] = len(live_items)
        live_items.append(live_widget)


class WidgetOnlyBrollObs(LegacyObs):
    """Standalone horizontal/portrait widgets without generated scenes."""

    def __init__(self) -> None:
        super().__init__()
        self._scenes = ["Horizontal", "Horizontal Backup", "Portrait"]
        self._inputs = [
            {"name": "Horizontal Primary", "kind": "browser_source"},
            {"name": "Horizontal Secondary", "kind": "browser_source"},
            {"name": "Portrait", "kind": "browser_source"},
        ]
        route = f"{BASE_URL}/overlay/{TOKEN}/widget/stream-scene"
        self.input_settings = {
            "Horizontal Primary": {
                "url": route + "?theme=violet",
                "width": 1920,
                "height": 1080,
                "reroute_audio": False,
                "shutdown": False,
            },
            "Horizontal Secondary": {
                "url": route,
                "width": 1920,
                "height": 1080,
                "reroute_audio": False,
                "shutdown": False,
            },
            "Portrait": {
                "url": route,
                "width": 1080,
                "height": 1920,
                "reroute_audio": False,
                "shutdown": False,
            },
        }
        self.scene_items = {
            "Horizontal": self._items(
                [("Horizontal Primary", "browser_source")],
            ),
            "Horizontal Backup": self._items(
                [("Horizontal Secondary", "browser_source")],
            ),
            "Portrait": self._items([("Portrait", "browser_source")]),
        }


class CurrentAudioObs(VerticalAlertObs):
    """Live collection with shared portrait audio plus an old chat copy.

    ``SC2 Tools Chat`` models the generated-only renderer created by the old
    builder. ``Chat`` and ``Alert Box`` are the user's existing authenticated
    inputs shared by Live/Aitum and must survive Replace unchanged.
    """

    def __init__(self) -> None:
        super().__init__()
        self._inputs.append({"name": "Chat", "kind": "browser_source"})
        self.input_settings["Chat"] = {
            "url": f"{BASE_URL}/overlay/{TOKEN}/widget/multichat",
            "width": 800,
            "height": 1400,
            "shutdown": True,
            "custom": "preserve chat settings",
        }
        self.input_settings["Alert Box"]["shutdown"] = True
        self.input_settings["SC2 Tools Chat"].update({
            "width": BETWEEN_GAMES_LAYOUT["chat"].w,
            "height": BETWEEN_GAMES_LAYOUT["chat"].h,
        })

        # The real collection shares Chat between horizontal and portrait.
        vertical_chat = next(
            item for item in self.scene_items[VERTICAL_SCENE_NAME]
            if item["source_name"] == "SC2 Tools Chat"
        )
        vertical_chat["source_name"] = "Chat"
        self.scene_items["Live Scene"].insert(
            1,
            self._items([("Chat", "browser_source")])[0],
        )
        live_alert = next(
            item for item in self.scene_items["Live Scene"]
            if item["source_name"] == "Alert Box"
        )
        self.scene_items["Live Scene"].remove(live_alert)
        live_alert["enabled"] = True
        self.scene_items["Live Scene"].append(live_alert)
        for index, item in enumerate(self.scene_items["Live Scene"]):
            item["index"] = index
        vertical_alert = self._items([("Alert Box", "browser_source")])[0]
        vertical_alert["transform"] = {
            "positionX": 60,
            "positionY": 107,
            "alignment": 5,
            "boundsType": "OBS_BOUNDS_SCALE_INNER",
            "boundsAlignment": 0,
            "boundsWidth": 960,
            "boundsHeight": 720,
        }
        self.scene_items[VERTICAL_SCENE_NAME].append(vertical_alert)
        for index, item in enumerate(self.scene_items[VERTICAL_SCENE_NAME]):
            item["index"] = index

    def remove_scene(self, name: str) -> None:
        removed_sources = {
            str(item.get("source_name") or "")
            for item in self.scene_items.get(name, [])
        }
        super().remove_scene(name)
        self.scene_items[name] = []

        # OBS releases a private input when its last scene-item reference is
        # removed. Model that here so Replace can prove the old generated-only
        # multichat renderer disappears instead of remaining a second owner.
        referenced = {
            str(item.get("source_name") or "")
            for items in self.scene_items.values()
            for item in items
        }
        retired = removed_sources - referenced
        self._inputs = [
            row for row in self._inputs
            if str(row.get("name") or "") not in retired
        ]
        for source_name in retired:
            self.input_settings.pop(source_name, None)

    def create_scene(self, name: str) -> None:
        super().create_scene(name)
        self.scene_items[name] = []


def _plan(obs: FakeObs, **kw: Any):
    params: Dict[str, Any] = {
        "overlay_base_url": BASE_URL,
        "overlay_token": TOKEN,
        "webcam_source": "Logitech Brio",
        "game_source": "StarCraft II",
    }
    params.update(kw)
    return plan_scenes(obs, **params)


# ---------------- discovery ----------------


def test_discovery_separates_webcam_from_game_capture() -> None:
    found = discover_sources(FakeObs())
    assert found["webcam"] == ["Logitech Brio"]
    assert found["game"] == ["StarCraft II"]


def test_discovery_ignores_unrelated_inputs() -> None:
    """Audio, media and text sources must not be offered as a camera."""
    obs = FakeObs(
        inputs=[
            {"name": "Desktop Audio", "kind": "wasapi_output_capture"},
            {"name": "Mic", "kind": "wasapi_input_capture"},
            {"name": "Alert Box", "kind": "browser_source"},
            {"name": "Cam", "kind": "dshow_input"},
        ],
    )
    found = discover_sources(obs)
    assert found["webcam"] == ["Cam"]
    assert found["game"] == []


def test_discovery_prefers_game_capture_over_window_capture() -> None:
    obs = FakeObs(
        inputs=[
            {"name": "Window", "kind": "window_capture"},
            {"name": "Game", "kind": "game_capture"},
        ],
    )
    assert discover_sources(obs)["game"] == ["Game", "Window"]


def test_manual_override_url_is_discovered_from_a_legacy_generated_scene() -> None:
    obs = LegacyObs()

    assert discover_manual_override_url(obs) == (
        f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"
    )


def test_manual_override_url_discovery_ignores_foreign_browser_routes() -> None:
    obs = LegacyObs()
    obs.input_settings = {
        name: {"url": "https://example.com/overlay/stolen/scene/not-ours"}
        for name in obs.input_settings
    }

    assert discover_manual_override_url(obs) is None


def test_manual_override_url_discovery_ignores_custom_overlay_sources() -> None:
    obs = LegacyObs()
    obs._inputs.append({"name": "Sponsor Overlay", "kind": "browser_source"})
    obs.input_settings["Sponsor Overlay"] = {
        "url": "https://evil.example/overlay/stolen/scene/manual",
    }
    obs.scene_items[SCENE_BETWEEN_GAMES].insert(
        0,
        {
            "source_name": "Sponsor Overlay",
            "item_id": 999,
            "index": -1,
            "input_kind": "browser_source",
            "enabled": True,
            "transform": {},
        },
    )

    assert discover_manual_override_url(obs) == (
        f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"
    )


def test_manual_override_url_discovery_rejects_a_same_named_foreign_scene() -> None:
    obs = LegacyObs()
    obs.scene_items[SCENE_BETWEEN_GAMES] = [
        {
            "source_name": "Stats Ticker",
            "item_id": 999,
            "index": 0,
            "input_kind": "browser_source",
            "enabled": True,
            "transform": {},
        },
    ]

    assert discover_manual_override_url(obs) is None


def test_manual_override_url_discovery_rejects_non_http_urls() -> None:
    obs = LegacyObs()
    for name, settings in obs.input_settings.items():
        route = str(settings["url"]).split(f"/overlay/{TOKEN}/", 1)[-1]
        settings["url"] = f"ftp://example.com/overlay/{TOKEN}/{route}"

    assert discover_manual_override_url(obs) is None


def test_manual_override_url_discovery_preserves_a_base_path() -> None:
    obs = LegacyObs()
    obs.input_settings.update(
        {
            "SC2 Tools Backdrop": {
                "url": "https://example.com/app/overlay/tok/scene/"
                "between-games?preview=1",
            },
            "SC2 Tools Session Stats": {
                "url": "https://example.com/app/overlay/tok/widget/session",
            },
            "SC2 Tools Chat": {
                "url": "https://example.com/app/overlay/tok/widget/multichat",
            },
        },
    )

    assert discover_manual_override_url(obs) == (
        "https://example.com/app/overlay/tok/scene/manual"
    )


def test_broll_audio_roles_choose_one_owner_with_two_landscape_players() -> None:
    """Manual and widget video copies stay separate, but sound is singular."""
    obs = BrollAudioObs()
    manual_url = f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"
    repair_manual_scene_overrides(obs, browser_url=manual_url)
    manual_name = next(
        name for name, settings in obs.input_settings.items()
        if "/scene/manual" in str(settings.get("url") or "")
    )
    # The already-audible landscape widget remains the sole owner while the
    # legacy repair creates and references the future manual owner.
    assert obs.input_settings[manual_name]["url"].endswith("?audio=0")

    owner, updated = repair_broll_audio_roles(obs, browser_url=manual_url)

    assert owner == manual_name
    assert set(updated) == {
        manual_name,
        "BRB/Starting Soon",
        "BRB/Starting Soon - Vertical",
    }
    assert obs.input_setting_updates[-1]["name"] == manual_name
    assert obs.input_settings[manual_name]["width"] == 1920
    assert obs.input_settings[manual_name]["height"] == 1080
    assert obs.input_settings[manual_name]["reroute_audio"] is False
    assert obs.input_settings[manual_name]["shutdown"] is False
    assert obs.input_settings["BRB/Starting Soon"]["reroute_audio"] is False
    assert obs.input_settings["BRB/Starting Soon"]["shutdown"] is False
    assert obs.input_settings["BRB/Starting Soon - Vertical"][
        "reroute_audio"
    ] is False
    assert any(
        item["source_name"] == "BRB/Starting Soon"
        for item in obs.scene_items["Live Scene"]
    )
    assert obs.input_settings[manual_name]["url"].endswith("?audio=1")
    assert obs.input_settings["BRB/Starting Soon"]["url"].endswith(
        "?theme=violet&audio=0",
    )
    assert obs.input_settings["BRB/Starting Soon - Vertical"]["url"].endswith(
        "?audio=0",
    )
    assert obs.input_settings["Foreign B-roll"]["url"] == (
        f"{BASE_URL}/overlay/another/widget/stream-scene"
    )

    # A second pass does not rewrite or reload any Browser Source.
    assert repair_broll_audio_roles(obs, browser_url=manual_url) == (
        manual_name,
        [],
    )


def test_rerouted_browser_is_never_used_as_a_hidden_audio_owner() -> None:
    obs = BrollAudioObs()
    manual_url = f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"
    repair_manual_scene_overrides(obs, browser_url=manual_url)
    manual_name = next(
        name for name, settings in obs.input_settings.items()
        if "/scene/manual" in str(settings.get("url") or "")
    )
    obs.input_settings[manual_name]["reroute_audio"] = True

    owner, _updated = repair_broll_audio_roles(obs, browser_url=manual_url)

    assert owner == "BRB/Starting Soon"
    assert obs.input_settings[manual_name]["url"].endswith("?audio=0")
    assert obs.input_settings["BRB/Starting Soon"]["url"].endswith(
        "?theme=violet&audio=1",
    )

    # With every landscape renderer rerouted, abort atomically: changing a
    # role here could either duplicate sound or silently erase it.
    obs.input_settings["BRB/Starting Soon"]["reroute_audio"] = True
    urls_before = {
        name: str(settings.get("url") or "")
        for name, settings in obs.input_settings.items()
    }
    writes_before = len(obs.input_setting_updates)
    with pytest.raises(SceneBuildError, match="Control audio via OBS"):
        repair_broll_audio_roles(obs, browser_url=manual_url)
    assert len(obs.input_setting_updates) == writes_before
    assert {
        name: str(settings.get("url") or "")
        for name, settings in obs.input_settings.items()
    } == urls_before


def test_broll_role_write_failure_cannot_leave_two_audio_owners() -> None:
    class FailingOwnerObs(BrollAudioObs):
        fail_on: Optional[str] = None

        def set_input_settings(
            self, name: str, settings: Dict[str, Any],
        ) -> None:
            if name == self.fail_on:
                raise RuntimeError("injected owner write failure")
            super().set_input_settings(name, settings)

    obs = FailingOwnerObs()
    manual_url = f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"
    repair_manual_scene_overrides(obs, browser_url=manual_url)
    manual_name = next(
        name for name, settings in obs.input_settings.items()
        if "/scene/manual" in str(settings.get("url") or "")
    )
    obs.fail_on = manual_name

    with pytest.raises(RuntimeError, match="owner write failure"):
        repair_broll_audio_roles(obs, browser_url=manual_url)

    # The future owner write was last and failed. Both followers were already
    # explicitly muted and the newly created manual stays muted, so an
    # interrupted migration may be silent but can never duplicate sound.
    assert obs.input_settings[manual_name]["url"].endswith("?audio=0")
    assert obs.input_settings["BRB/Starting Soon"]["url"].endswith(
        "?theme=violet&audio=0",
    )
    assert obs.input_settings["BRB/Starting Soon - Vertical"]["url"].endswith(
        "?audio=0",
    )
    assert [row["name"] for row in obs.input_setting_updates] == [
        "BRB/Starting Soon",
        "BRB/Starting Soon - Vertical",
    ]


def test_widget_only_broll_keeps_exactly_one_landscape_audio_owner() -> None:
    """Standalone widget users keep sound without relying on scene activity."""
    obs = WidgetOnlyBrollObs()

    manual_url = discover_widget_only_broll_url(obs)
    assert manual_url == (
        f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"
    )
    owner, updated = repair_broll_audio_roles(obs, browser_url=manual_url)

    assert owner == "Horizontal Primary"
    assert set(updated) == {
        "Horizontal Primary", "Horizontal Secondary", "Portrait",
    }
    assert obs.input_settings["Horizontal Primary"]["url"].endswith(
        "?theme=violet&audio=1",
    )
    assert obs.input_settings["Horizontal Secondary"]["url"].endswith(
        "?audio=0",
    )
    assert obs.input_settings["Portrait"]["url"].endswith("?audio=0")


# ---------------- planning ----------------


def test_plan_touches_nothing() -> None:
    obs = FakeObs()
    _plan(obs)
    assert obs.created_scenes == []
    assert obs.removed_scenes == []
    assert obs.created_inputs == []


def test_plan_covers_both_scenes_with_the_expected_items() -> None:
    plan = _plan(FakeObs())
    names = [s.name for s in plan.scenes]
    assert names == [SCENE_BETWEEN_GAMES, SCENE_IN_GAME]

    between = plan.scenes[0]
    assert [i.label for i in between.items] == [
        "SC2 backdrop",
        "Webcam",
        "Game inset",
        "Session stats",
        "Chat",
        "Chat alerts",
        "Manual scene override",
    ]
    assert [i.label for i in plan.scenes[1].items] == [
        "Game capture",
        "Webcam",
        "Chat alerts",
        "Manual scene override",
    ]


def test_stream_dock_override_covers_every_auto_switch_target() -> None:
    """Starting Soon / BRB is a manual broadcast choice, so every scene
    the automatic switcher can select needs the transparent manual cover
    above all normal content. The transparent alert toaster is the only
    intentional exception so recognition remains visible during BRB."""
    plan = _plan(FakeObs())
    planned_by_name = {scene.name: scene for scene in plan.scenes}

    for target in set(DEFAULT_SCENE_MAP.values()):
        scene = planned_by_name[target]
        override = next(
            item for item in scene.items
            if item.label == "Manual scene override"
        )
        assert override.browser_path == (
            f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"
            "?audio=1"
        )
        assert override.rect.x == 0 and override.rect.y == 0
        assert override.rect.w == plan.canvas_width
        assert override.rect.h == plan.canvas_height
        alerts = next(item for item in scene.items if item.label == "Chat alerts")
        assert alerts.z == max(item.z for item in scene.items)
        assert alerts.z > override.z
        assert all(
            override.z > item.z
            for item in scene.items
            if item is not override and item is not alerts
        )


def test_between_games_puts_the_camera_above_the_game_inset() -> None:
    """The whole point of the downtime layout: the streamer is big and
    the game is a small corner panel."""
    between = _plan(FakeObs()).scenes[0]
    cam = next(i for i in between.items if i.label == "Webcam")
    game = next(i for i in between.items if i.label == "Game inset")
    assert cam.rect.w * cam.rect.h > game.rect.w * game.rect.h * 4


def test_in_game_inverts_the_relationship() -> None:
    in_game = _plan(FakeObs()).scenes[1]
    cam = next(i for i in in_game.items if i.label == "Webcam")
    game = next(i for i in in_game.items if i.label == "Game capture")
    assert game.rect.w == REF_WIDTH and game.rect.h == REF_HEIGHT
    assert cam.rect.w < game.rect.w / 4


def test_in_game_keeps_alerts_without_covering_gameplay_with_full_chat() -> None:
    """Persistent chat lives in the Dock; gameplay only gets compact alerts."""
    labels = [item.label for item in _plan(FakeObs()).scenes[1].items]
    assert "Chat alerts" in labels
    assert "Chat" not in labels


def test_chat_column_is_tall_and_readable() -> None:
    between = _plan(FakeObs()).scenes[0]
    chat = next(i for i in between.items if i.label == "Chat")
    # Full-height column, not a squat box — viewers have to be able to
    # read it from a couch.
    assert chat.rect.h > REF_HEIGHT * 0.8
    assert chat.rect.w > 400


def test_backdrop_sits_behind_everything() -> None:
    between = _plan(FakeObs()).scenes[0]
    backdrop = next(i for i in between.items if i.label == "SC2 backdrop")
    assert backdrop.z == 0
    assert all(i.z > 0 for i in between.items if i is not backdrop)
    assert backdrop.rect.w == REF_WIDTH and backdrop.rect.h == REF_HEIGHT


def test_no_items_overlap_in_the_between_games_layout() -> None:
    """A camera clipped by the chat column would be shipped straight to
    someone's live stream."""
    between = _plan(FakeObs()).scenes[0]
    boxes = [
        i for i in between.items
        if i.label not in {
            "SC2 backdrop", "Chat alerts", "Manual scene override",
        }
    ]
    for a in boxes:
        for b in boxes:
            if a is b:
                continue
            overlap_x = min(a.rect.x + a.rect.w, b.rect.x + b.rect.w) - max(
                a.rect.x, b.rect.x,
            )
            overlap_y = min(a.rect.y + a.rect.h, b.rect.y + b.rect.h) - max(
                a.rect.y, b.rect.y,
            )
            assert overlap_x <= 0 or overlap_y <= 0, (
                f"{a.label} overlaps {b.label}"
            )


def test_layout_stays_inside_the_canvas() -> None:
    between = _plan(FakeObs()).scenes[0]
    for item in between.items:
        assert item.rect.x >= 0 and item.rect.y >= 0
        assert item.rect.x + item.rect.w <= REF_WIDTH
        assert item.rect.y + item.rect.h <= REF_HEIGHT


@pytest.mark.parametrize(
    "canvas", [(1920, 1080), (2560, 1440), (1280, 720), (3840, 2160)],
)
def test_geometry_scales_to_the_real_canvas(canvas) -> None:
    obs = FakeObs(canvas=canvas)
    plan = _plan(obs)
    assert (plan.canvas_width, plan.canvas_height) == canvas
    backdrop = next(
        i for i in plan.scenes[0].items if i.label == "SC2 backdrop"
    )
    assert backdrop.rect.w == canvas[0]
    assert backdrop.rect.h == canvas[1]

    scale = canvas[0] / REF_WIDTH
    cam = next(i for i in plan.scenes[0].items if i.label == "Webcam")
    assert cam.rect.w == round(BETWEEN_GAMES_LAYOUT["webcam"].w * scale)


def test_missing_sources_warn_rather_than_fail() -> None:
    plan = _plan(FakeObs(), webcam_source=None, game_source=None)
    assert len(plan.warnings) == 2
    labels = [i.label for i in plan.scenes[0].items]
    assert "Webcam" not in labels and "Game inset" not in labels
    # The browser panels are still worth building on their own.
    assert "SC2 backdrop" in labels and "Chat" in labels


def test_browser_urls_are_resolved_in_the_plan() -> None:
    """What the user confirms has to be literally what gets sent."""
    plan = _plan(FakeObs())
    between = plan.scenes[0]
    urls = {
        i.label: i.browser_path for i in between.items if i.browser_path
    }
    assert urls["SC2 backdrop"] == f"{BASE_URL}/overlay/{TOKEN}/scene/between-games"
    assert urls["Chat"] == (
        f"{BASE_URL}/overlay/{TOKEN}/widget/multichat?audio=1"
    )
    assert urls["Chat alerts"] == (
        f"{BASE_URL}/overlay/{TOKEN}/{CHAT_ALERTS_BROWSER_PATH}?audio=1"
    )
    assert urls["Session stats"] == f"{BASE_URL}/overlay/{TOKEN}/widget/session"
    assert urls["Manual scene override"] == (
        f"{BASE_URL}/overlay/{TOKEN}/scene/manual?audio=1"
    )

    in_game = plan.scenes[1]
    alerts = next(i for i in in_game.items if i.label == "Chat alerts")
    assert alerts.browser_path == (
        f"{BASE_URL}/overlay/{TOKEN}/{CHAT_ALERTS_BROWSER_PATH}?audio=1"
    )
    manual = next(
        i for i in in_game.items if i.label == "Manual scene override"
    )
    assert manual.browser_path == (
        f"{BASE_URL}/overlay/{TOKEN}/scene/manual?audio=1"
    )


def test_plan_flags_existing_scenes_as_conflicts() -> None:
    obs = FakeObs(scenes=["Gameplay", SCENE_BETWEEN_GAMES])
    plan = _plan(obs)
    assert plan.conflicts == [SCENE_BETWEEN_GAMES]


# ---------------- building ----------------


def test_build_creates_both_scenes() -> None:
    obs = FakeObs()
    created = build_scenes(obs, _plan(obs))
    assert created == [SCENE_BETWEEN_GAMES, SCENE_IN_GAME]
    assert obs.created_scenes == [SCENE_BETWEEN_GAMES, SCENE_IN_GAME]


def test_build_without_canonical_inputs_elects_generated_audio_owners() -> None:
    obs = FakeObs()
    build_scenes(obs, _plan(obs))

    audio_urls = [
        str(item["settings"].get("url") or "")
        for item in obs.created_inputs
        if "/widget/multichat" in str(item["settings"].get("url") or "")
        or "/widget/chat-alerts" in str(item["settings"].get("url") or "")
    ]
    assert sorted(audio_urls) == sorted([
        f"{BASE_URL}/overlay/{TOKEN}/widget/multichat?audio=1",
        f"{BASE_URL}/overlay/{TOKEN}/widget/chat-alerts?audio=1",
    ])


def test_build_mutes_new_manual_until_existing_landscape_is_demoted() -> None:
    """Creating the future owner must not briefly create two audible CEFs."""
    obs = CurrentAudioObs()
    source_name = "BRB/Starting Soon"
    obs._inputs.append({"name": source_name, "kind": "browser_source"})
    obs.input_settings[source_name] = {
        "url": (
            f"{BASE_URL}/overlay/{TOKEN}/widget/stream-scene?audio=1"
        ),
        "width": 1920,
        "height": 1080,
        "reroute_audio": False,
        "shutdown": False,
    }
    live_item = obs._items([(source_name, "browser_source")])[0]
    live_item["index"] = len(obs.scene_items["Live Scene"])
    obs.scene_items["Live Scene"].append(live_item)

    plan = _plan(obs)
    planned_manual_urls = {
        str(item.browser_path)
        for scene in plan.scenes
        for item in scene.items
        if item.share_key == "manual_scene_override"
    }
    assert planned_manual_urls == {
        f"{BASE_URL}/overlay/{TOKEN}/scene/manual?audio=0",
    }

    build_scenes(obs, plan, rebuild=True)
    created_manual = next(
        item for item in obs.created_inputs
        if "/scene/manual" in str(item["settings"].get("url") or "")
    )
    manual_name = str(created_manual["name"])
    assert created_manual["settings"]["url"].endswith("?audio=0")
    assert obs.input_settings[source_name]["url"].endswith("?audio=1")

    owner, updated = repair_broll_audio_roles(
        obs,
        browser_url=f"{BASE_URL}/overlay/{TOKEN}/scene/manual",
    )

    assert owner == manual_name
    assert updated == [
        source_name,
        "BRB/Starting Soon - Vertical",
        manual_name,
    ]
    assert [row["name"] for row in obs.input_setting_updates] == updated
    assert obs.input_settings[source_name]["url"].endswith("?audio=0")
    assert obs.input_settings[manual_name]["url"].endswith("?audio=1")


@pytest.mark.parametrize(
    ("reroute_audio", "shutdown"),
    [(True, False), (False, True), (True, True)],
)
def test_build_starts_new_manual_silent_with_scene_dependent_player(
    reroute_audio: bool,
    shutdown: bool,
) -> None:
    """Even an unsafe current player may still be audible in its live scene."""
    obs = CurrentAudioObs()
    source_name = "Scene-dependent BRB"
    obs._inputs.append({"name": source_name, "kind": "browser_source"})
    obs.input_settings[source_name] = {
        "url": (
            f"{BASE_URL}/overlay/{TOKEN}/widget/stream-scene?audio=1"
        ),
        "width": 1920,
        "height": 1080,
        "reroute_audio": reroute_audio,
        "shutdown": shutdown,
    }
    live_item = obs._items([(source_name, "browser_source")])[0]
    live_item["index"] = len(obs.scene_items["Live Scene"])
    obs.scene_items["Live Scene"].append(live_item)

    plan = _plan(obs)
    planned_manual_urls = {
        str(item.browser_path)
        for scene in plan.scenes
        for item in scene.items
        if item.share_key == "manual_scene_override"
    }
    assert planned_manual_urls == {
        f"{BASE_URL}/overlay/{TOKEN}/scene/manual?audio=0",
    }

    build_scenes(obs, plan, rebuild=True)
    created_manual = next(
        item for item in obs.created_inputs
        if "/scene/manual" in str(item["settings"].get("url") or "")
    )
    manual_name = str(created_manual["name"])
    assert created_manual["settings"]["url"].endswith("?audio=0")

    owner, _updated = repair_broll_audio_roles(
        obs,
        browser_url=f"{BASE_URL}/overlay/{TOKEN}/scene/manual",
    )

    assert owner == manual_name
    assert obs.input_settings[source_name]["url"].endswith("?audio=0")
    assert obs.input_settings[manual_name]["url"].endswith("?audio=1")


def test_build_reuses_existing_inputs_instead_of_duplicating_captures() -> None:
    """A second Game Capture input would cost real CPU. Referencing the
    same source from a second scene costs nothing."""
    obs = FakeObs()
    build_scenes(obs, _plan(obs))

    reused = [i["source"] for i in obs.created_items]
    assert reused.count("StarCraft II") == 2  # inset + fullscreen
    assert reused.count("Logitech Brio") == 2  # big + corner
    # Nothing new was created for them.
    kinds = [i["kind"] for i in obs.created_inputs]
    assert set(kinds) == {"browser_source"}


def test_manual_override_reuses_one_browser_input_in_both_scenes() -> None:
    """The always-loaded cover must not double its CEF renderer, socket and
    studio-state poll just because it is present in two layouts."""
    obs = FakeObs()
    build_scenes(obs, _plan(obs))

    created = [
        item for item in obs.created_inputs
        if item["name"].startswith("SC2 Tools Manual Override")
    ]
    assert len(created) == 1
    assert created[0]["scene"] == SCENE_BETWEEN_GAMES

    reused = [
        item for item in obs.created_items
        if item["source"] == created[0]["name"]
    ]
    assert len(reused) == 1
    assert reused[0]["scene"] == SCENE_IN_GAME
    assert reused[0]["source"] == created[0]["name"]


def test_chat_alerts_reuses_one_silent_native_browser_in_both_scenes() -> None:
    """The same-size landscape scenes may share one explicit silent copy."""
    obs = FakeObs()
    plan = _plan(obs)
    build_scenes(obs, plan)

    created = [
        item for item in obs.created_inputs
        if item["name"].startswith(CHAT_ALERTS_INPUT_NAME)
    ]
    assert len(created) == 1
    assert created[0]["scene"] == SCENE_BETWEEN_GAMES
    assert created[0]["settings"]["url"] == (
        f"{BASE_URL}/overlay/{TOKEN}/{CHAT_ALERTS_BROWSER_PATH}?audio=1"
    )
    assert created[0]["settings"]["width"] == CHAT_ALERTS_RECT.w
    assert created[0]["settings"]["height"] == CHAT_ALERTS_RECT.h
    assert created[0]["settings"]["reroute_audio"] is False

    reused = [
        item for item in obs.created_items
        if item["source"] == created[0]["name"]
    ]
    assert len(reused) == 1
    assert reused[0]["scene"] == SCENE_IN_GAME


def test_build_keeps_native_silent_chat_and_alert_copies() -> None:
    obs = CurrentAudioObs()
    alert_settings = dict(obs.input_settings["Alert Box"])
    chat_settings = dict(obs.input_settings["Chat"])

    build_scenes(obs, _plan(obs), rebuild=True)

    assert obs.input_settings["Alert Box"] == alert_settings
    assert obs.input_settings["Chat"] == chat_settings
    audio_created = {
        item["name"]: item["settings"]
        for item in obs.created_inputs
        if "/widget/multichat" in str(item["settings"].get("url") or "")
        or "/widget/chat-alerts" in str(item["settings"].get("url") or "")
    }
    chat_name, chat_copy = next(
        (name, settings)
        for name, settings in audio_created.items()
        if "/widget/multichat" in settings["url"]
    )
    alert_name, alert_copy = next(
        (name, settings)
        for name, settings in audio_created.items()
        if "/widget/chat-alerts" in settings["url"]
    )
    assert chat_copy["url"].endswith("/widget/multichat?audio=0")
    assert (chat_copy["width"], chat_copy["height"]) == (
        BETWEEN_GAMES_LAYOUT["chat"].w,
        BETWEEN_GAMES_LAYOUT["chat"].h,
    )
    assert alert_copy["url"].endswith("/widget/chat-alerts?audio=0")
    assert (alert_copy["width"], alert_copy["height"]) == (
        CHAT_ALERTS_RECT.w,
        CHAT_ALERTS_RECT.h,
    )
    assert (CHAT_ALERTS_RECT.w, CHAT_ALERTS_RECT.h) == (1792, 360)

    between_sources = {
        item["source_name"]
        for item in obs.scene_items[SCENE_BETWEEN_GAMES]
    }
    in_game_sources = {
        item["source_name"]
        for item in obs.scene_items[SCENE_IN_GAME]
    }
    assert chat_name in between_sources
    assert alert_name in between_sources
    assert alert_name in in_game_sources
    assert "Chat" not in between_sources
    assert "Alert Box" not in between_sources | in_game_sources

    chat_id = next(
        item["id"] for item in obs.created_inputs
        if item["scene"] == SCENE_BETWEEN_GAMES
        and item["name"] == chat_name
    )
    chat_transform = next(
        row for row in obs.transforms if row["id"] == chat_id
    )
    assert (
        chat_transform["boundsWidth"],
        chat_transform["boundsHeight"],
    ) == (
        BETWEEN_GAMES_LAYOUT["chat"].w,
        BETWEEN_GAMES_LAYOUT["chat"].h,
    )


def test_rebuild_keeps_canonical_dimensions_and_regenerates_silent_copies() -> None:
    obs = CurrentAudioObs()
    build_scenes(obs, _plan(obs), rebuild=True)
    build_scenes(obs, _plan(obs), rebuild=True)

    assert (
        obs.input_settings["Chat"]["width"],
        obs.input_settings["Chat"]["height"],
    ) == (800, 1400)
    assert (
        obs.input_settings["Alert Box"]["width"],
        obs.input_settings["Alert Box"]["height"],
    ) == (800, 600)
    latest_chat = [
        item for item in obs.created_inputs
        if "/widget/multichat" in str(item["settings"].get("url") or "")
    ][-1]
    latest_alert = [
        item for item in obs.created_inputs
        if "/widget/chat-alerts" in str(item["settings"].get("url") or "")
    ][-1]
    assert latest_chat["settings"]["url"].endswith("?audio=0")
    assert latest_alert["settings"]["url"].endswith("?audio=0")


def test_build_preserves_name_collisions_and_audio_role_variants() -> None:
    alert_url = f"{BASE_URL}/overlay/{TOKEN}/{CHAT_ALERTS_BROWSER_PATH}"
    obs = FakeObs(
        inputs=[
            {
                "name": CHAT_ALERTS_INPUT_NAME,
                "kind": "browser_source",
                "settings": {
                    "url": alert_url + "?audio=1",
                    "width": 800,
                    "height": 600,
                },
            },
            {
                "name": "SC2 Tools Chat",
                "kind": "browser_source",
                "settings": {
                    "url": f"{BASE_URL}/overlay/wrong/widget/multichat",
                    "height": 456,
                },
            },
            {"name": "Logitech Brio", "kind": "dshow_input"},
            {"name": "StarCraft II", "kind": "game_capture"},
        ],
    )
    original_alert = dict(obs.input_settings[CHAT_ALERTS_INPUT_NAME])
    original_chat = dict(obs.input_settings["SC2 Tools Chat"])

    build_scenes(obs, _plan(obs))

    assert obs.input_settings[CHAT_ALERTS_INPUT_NAME] == original_alert
    assert obs.input_settings["SC2 Tools Chat"] == original_chat
    created = {
        str(item["settings"].get("url") or ""): item
        for item in obs.created_inputs
    }
    alert_copy = created[alert_url + "?audio=1"]
    chat_copy = created[
        f"{BASE_URL}/overlay/{TOKEN}/widget/multichat?audio=1"
    ]
    assert alert_copy["name"] == f"{CHAT_ALERTS_INPUT_NAME} 2"
    assert chat_copy["name"] == "SC2 Tools Chat 2"
    assert (
        alert_copy["settings"]["width"],
        alert_copy["settings"]["height"],
    ) == (1792, 360)



def test_shared_manual_override_uses_its_collision_safe_name() -> None:
    obs = FakeObs(
        inputs=[
            {"name": "SC2 Tools Manual Override", "kind": "browser_source"},
            {"name": "Logitech Brio", "kind": "dshow_input"},
            {"name": "StarCraft II", "kind": "game_capture"},
        ],
    )
    build_scenes(obs, _plan(obs))

    created = next(
        item for item in obs.created_inputs
        if item["name"].startswith("SC2 Tools Manual Override")
    )
    assert created["name"] == "SC2 Tools Manual Override 2"
    assert any(
        item["scene"] == SCENE_IN_GAME
        and item["source"] == "SC2 Tools Manual Override 2"
        for item in obs.created_items
    )


def test_legacy_scene_repair_preserves_custom_sources_and_covers_both_scenes() -> None:
    obs = LegacyObs()
    manual_url = f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"

    assert manual_override_scenes_needing_update(obs) == [
        SCENE_BETWEEN_GAMES,
        SCENE_IN_GAME,
    ]
    original_between = [
        item["source_name"] for item in obs.scene_items[SCENE_BETWEEN_GAMES]
    ]

    repaired = repair_manual_scene_overrides(obs, browser_url=manual_url)

    assert repaired == [SCENE_BETWEEN_GAMES, SCENE_IN_GAME]
    assert obs.created_scenes == []
    assert obs.removed_scenes == []
    manual_inputs = [
        item for item in obs.created_inputs
        if item["settings"].get("url") == manual_url
    ]
    assert len(manual_inputs) == 1
    manual_name = manual_inputs[0]["name"]
    alert_inputs = [
        item for item in obs.created_inputs
        if item["settings"].get("url") == (
            f"{BASE_URL}/overlay/{TOKEN}/{CHAT_ALERTS_BROWSER_PATH}?audio=1"
        )
    ]
    assert len(alert_inputs) == 1
    alert_name = alert_inputs[0]["name"]
    for scene_name in (SCENE_BETWEEN_GAMES, SCENE_IN_GAME):
        assert obs.scene_items[scene_name][-2]["source_name"] == manual_name
        assert obs.scene_items[scene_name][-1]["source_name"] == alert_name
    assert [
        item["source_name"]
        for item in obs.scene_items[SCENE_BETWEEN_GAMES][:-2]
    ] == original_between
    assert "Stats Ticker" in original_between
    assert manual_override_scenes_needing_update(obs) == []


def test_legacy_scene_repair_is_idempotent() -> None:
    obs = LegacyObs()
    manual_url = f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"
    repair_manual_scene_overrides(obs, browser_url=manual_url)
    writes_after_first = (
        len(obs.created_inputs),
        len(obs.created_items),
        len(obs.transforms),
        len(obs.indexes),
    )

    assert repair_manual_scene_overrides(obs, browser_url=manual_url) == []
    assert (
        len(obs.created_inputs),
        len(obs.created_items),
        len(obs.transforms),
        len(obs.indexes),
    ) == writes_after_first


def test_legacy_scene_repair_reenables_and_fully_resets_a_broken_cover() -> None:
    obs = LegacyObs()
    manual_url = f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"
    repair_manual_scene_overrides(obs, browser_url=manual_url)
    cover = obs.scene_items[SCENE_BETWEEN_GAMES][-2]

    # A disabled, cropped or rotated top item still exposes the camera. OBS
    # merges transform updates, so repair must explicitly reset every field.
    cover["enabled"] = False
    cover["transform"].update(
        {"rotation": 17.0, "scaleX": 0.5, "cropLeft": 120},
    )
    assert manual_override_scenes_needing_update(obs) == [
        SCENE_BETWEEN_GAMES,
    ]

    assert repair_manual_scene_overrides(obs, browser_url=manual_url) == [
        SCENE_BETWEEN_GAMES,
    ]
    assert cover["enabled"] is True
    assert cover["transform"]["rotation"] == 0.0
    assert cover["transform"]["scaleX"] == 1.0
    assert cover["transform"]["cropLeft"] == 0
    assert obs.enabled_updates[-1]["enabled"] is True
    assert manual_override_scenes_needing_update(obs) == []


def test_manual_cover_stretches_even_if_reused_browser_dimensions_are_old() -> None:
    obs = LegacyObs()
    manual_url = f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"
    repair_manual_scene_overrides(obs, browser_url=manual_url)
    cover = obs.scene_items[SCENE_BETWEEN_GAMES][-2]
    manual_name = cover["source_name"]

    # A Browser Source can retain dimensions from an old canvas. STRETCH is
    # deliberate for the opaque manual card so no letterbox reveals sources.
    obs.input_settings[manual_name]["width"] = 640
    obs.input_settings[manual_name]["height"] = 480
    assert cover["transform"]["boundsType"] == "OBS_BOUNDS_STRETCH"
    assert manual_override_scenes_needing_update(obs) == []


def test_legacy_scene_repair_moves_an_existing_cover_above_later_sources() -> None:
    obs = LegacyObs()
    manual_url = f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"
    repair_manual_scene_overrides(obs, browser_url=manual_url)
    manual_name = obs.scene_items[SCENE_BETWEEN_GAMES][-2]["source_name"]
    alert_name = obs.scene_items[SCENE_BETWEEN_GAMES][-1]["source_name"]
    created_inputs = len(obs.created_inputs)
    created_items = len(obs.created_items)

    # Model a streamer adding another source after the upgrade. It lands
    # above the cover; Update should lift the existing cover, not duplicate it.
    obs._inputs.append({"name": "Sponsor Bug", "kind": "browser_source"})
    obs.input_settings["Sponsor Bug"] = {"url": "https://example.com/sponsor"}
    obs.scene_items[SCENE_BETWEEN_GAMES].append(
        {
            "source_name": "Sponsor Bug",
            "item_id": 999,
            "index": len(obs.scene_items[SCENE_BETWEEN_GAMES]),
            "input_kind": "browser_source",
            "transform": {},
        },
    )

    repaired = repair_manual_scene_overrides(obs, browser_url=manual_url)

    assert repaired == [SCENE_BETWEEN_GAMES]
    assert obs.scene_items[SCENE_BETWEEN_GAMES][-2]["source_name"] == manual_name
    assert obs.scene_items[SCENE_BETWEEN_GAMES][-1]["source_name"] == alert_name
    assert len(obs.created_inputs) == created_inputs
    assert len(obs.created_items) == created_items


def test_legacy_scene_repair_does_not_hijack_a_same_named_foreign_input() -> None:
    obs = LegacyObs(colliding_manual_input=True)
    manual_url = f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"

    repair_manual_scene_overrides(obs, browser_url=manual_url)

    created = next(
        item for item in obs.created_inputs
        if item["settings"].get("url") == manual_url
    )
    assert created["name"] == f"{MANUAL_OVERRIDE_INPUT_NAME} 2"
    assert obs.input_settings[MANUAL_OVERRIDE_INPUT_NAME]["url"] == (
        "https://example.com/not-the-manual-cover"
    )


def test_legacy_scene_repair_refuses_non_builder_owned_vertical_scene() -> None:
    obs = LegacyObs()
    obs._scenes.append("Vertical Scene")
    obs.scene_items["Vertical Scene"] = []
    manual_url = f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"

    with pytest.raises(SceneBuildError, match="non-generated OBS scenes"):
        repair_manual_scene_overrides(
            obs,
            browser_url=manual_url,
            scene_names=[SCENE_BETWEEN_GAMES, "Vertical Scene"],
        )

    assert obs.created_inputs == []
    assert obs.created_items == []


def test_vertical_repair_reuses_live_alert_input_and_preserves_other_items() -> None:
    obs = VerticalAlertObs()
    original = [
        item["source_name"] for item in obs.scene_items[VERTICAL_SCENE_NAME]
    ]
    original_live_transform = dict(obs.scene_items["Live Scene"][1]["transform"])

    assert repair_vertical_scene_chat_alerts(obs) is True

    assert obs.created_inputs == []
    assert len(obs.created_items) == 1
    assert obs.created_items[0]["scene"] == VERTICAL_SCENE_NAME
    assert obs.created_items[0]["source"] == "Alert Box"
    live = obs.scene_items["Live Scene"]
    assert [item["source_name"] for item in live[:-1]] == [
        "Logitech Brio", "Stats Ticker",
    ]
    assert live[-1]["source_name"] == "Alert Box"
    assert live[-1]["enabled"] is True
    assert live[-1]["transform"] == original_live_transform
    final = obs.scene_items[VERTICAL_SCENE_NAME]
    assert [item["source_name"] for item in final[:-1]] == original
    assert final[-1]["source_name"] == "Alert Box"
    assert final[-1]["transform"] == {
        "positionX": 60,
        "positionY": 107,
        "alignment": 5,
        "boundsType": "OBS_BOUNDS_SCALE_INNER",
        "boundsAlignment": 0,
        "boundsWidth": 960,
        "boundsHeight": 720,
    }


def test_vertical_repair_is_idempotent() -> None:
    obs = VerticalAlertObs()
    repair_vertical_scene_chat_alerts(obs)
    writes = (
        len(obs.created_inputs),
        len(obs.created_items),
        len(obs.transforms),
        len(obs.indexes),
        len(obs.enabled_updates),
    )

    assert repair_vertical_scene_chat_alerts(obs) is False
    assert (
        len(obs.created_inputs),
        len(obs.created_items),
        len(obs.transforms),
        len(obs.indexes),
        len(obs.enabled_updates),
    ) == writes


def test_vertical_repair_fails_closed_on_token_mismatch() -> None:
    obs = VerticalAlertObs()
    obs.input_settings["Alert Box"]["url"] = (
        f"{BASE_URL}/overlay/different/{CHAT_ALERTS_BROWSER_PATH}"
    )

    assert repair_vertical_scene_chat_alerts(obs) is False
    assert obs.created_inputs == []
    assert obs.created_items == []


def test_vertical_repair_requires_the_portrait_stream_scene_fingerprint() -> None:
    obs = VerticalAlertObs()
    obs.input_settings["BRB/Starting Soon - Vertical"]["height"] = 720

    assert repair_vertical_scene_chat_alerts(obs) is False
    assert obs.created_inputs == []
    assert obs.created_items == []


def _add_generated_alert_items(
    obs: CurrentAudioObs,
    *,
    size: tuple[int, int] = (1792, 360),
) -> str:
    source_name = "Old Generated Chat Alerts"
    obs._inputs.append({"name": source_name, "kind": "browser_source"})
    obs.input_settings[source_name] = {
        "url": f"{BASE_URL}/overlay/{TOKEN}/{CHAT_ALERTS_BROWSER_PATH}",
        "width": size[0],
        "height": size[1],
    }
    for offset, scene_name in enumerate(
        (SCENE_BETWEEN_GAMES, SCENE_IN_GAME),
    ):
        item = obs._items([(source_name, "browser_source")])[0]
        item["enabled"] = offset == 0
        item["transform"] = {
            "positionX": 64 + offset,
            "positionY": 48 + offset,
            "alignment": 5,
            "boundsType": "OBS_BOUNDS_SCALE_INNER",
            "boundsAlignment": 0,
            "boundsWidth": 1792,
            "boundsHeight": 360,
        }
        item["index"] = len(obs.scene_items[scene_name])
        obs.scene_items[scene_name].append(item)
    return source_name


def _manual_url() -> str:
    return f"{BASE_URL}/overlay/{TOKEN}/{MANUAL_OVERRIDE_BROWSER_PATH}"


def test_startup_assigns_one_owner_per_route_without_resizing_copies() -> None:
    obs = CurrentAudioObs()
    alert_copy = _add_generated_alert_items(obs)
    chat_item = next(
        item for item in obs.scene_items[SCENE_BETWEEN_GAMES]
        if item["source_name"] == "SC2 Tools Chat"
    )
    chat_item["enabled"] = False
    chat_item["transform"] = {
        "positionX": 1320,
        "positionY": 48,
        "alignment": 5,
        "boundsType": "OBS_BOUNDS_SCALE_INNER",
        "boundsAlignment": 0,
        "boundsWidth": 552,
        "boundsHeight": 984,
    }
    expected_chat_state = (
        chat_item["enabled"],
        chat_item["index"],
        dict(chat_item["transform"]),
    )

    owners, updated, changed = repair_chat_alert_audio_roles(
        obs,
        browser_url=_manual_url(),
    )

    assert owners == {"chat_alerts": "Alert Box", "multichat": "Chat"}
    assert changed == []
    assert set(updated) == {
        "Alert Box",
        "Chat",
        "SC2 Tools Chat",
        alert_copy,
    }
    assert obs.refreshed_browser_inputs == []
    assert obs.input_settings["Alert Box"]["url"].endswith("?audio=1")
    assert obs.input_settings["Chat"]["url"].endswith("?audio=1")
    assert obs.input_settings["Alert Box"]["shutdown"] is False
    assert obs.input_settings["Chat"]["shutdown"] is False
    assert obs.input_settings[alert_copy]["url"].endswith("?audio=0")
    assert obs.input_settings["SC2 Tools Chat"]["url"].endswith("?audio=0")
    assert (
        obs.input_settings["Alert Box"]["width"],
        obs.input_settings["Alert Box"]["height"],
    ) == (800, 600)
    assert (
        obs.input_settings[alert_copy]["width"],
        obs.input_settings[alert_copy]["height"],
    ) == (1792, 360)
    assert (
        obs.input_settings["Chat"]["width"],
        obs.input_settings["Chat"]["height"],
    ) == (800, 1400)
    assert (
        obs.input_settings["SC2 Tools Chat"]["width"],
        obs.input_settings["SC2 Tools Chat"]["height"],
    ) == (552, 984)
    final_chat = next(
        item for item in obs.scene_items[SCENE_BETWEEN_GAMES]
        if item["source_name"] == "SC2 Tools Chat"
    )
    assert (
        final_chat["enabled"],
        final_chat["index"],
        final_chat["transform"],
    ) == expected_chat_state

    writes = (
        len(obs.input_setting_updates),
        len(obs.created_inputs),
        len(obs.created_items),
        len(obs.removed_items),
    )
    assert repair_chat_alert_audio_roles(
        obs,
        browser_url=_manual_url(),
    ) == (owners, [], [])
    assert (
        len(obs.input_setting_updates),
        len(obs.created_inputs),
        len(obs.created_items),
        len(obs.removed_items),
    ) == writes


@pytest.mark.parametrize("owner_name", ["Alert Box", "Chat"])
def test_audio_role_repair_rejects_rerouted_owner_before_any_mutation(
    owner_name: str,
) -> None:
    obs = CurrentAudioObs()
    # A wrong native size proves the later geometry path would mutate OBS if
    # the owner-routing preflight did not stop the transaction first.
    _add_generated_alert_items(obs, size=(400, 300))
    obs.input_settings[owner_name]["reroute_audio"] = True
    settings_before = deepcopy(obs.input_settings)
    scene_items_before = deepcopy(obs.scene_items)
    writes_before = (
        len(obs.input_setting_updates),
        len(obs.created_inputs),
        len(obs.created_items),
        len(obs.removed_items),
        len(obs.transforms),
        len(obs.indexes),
        len(obs.enabled_updates),
    )

    with pytest.raises(SceneBuildError, match="Control audio via OBS"):
        repair_chat_alert_audio_roles(obs, browser_url=_manual_url())

    assert obs.input_settings == settings_before
    assert obs.scene_items == scene_items_before
    assert (
        len(obs.input_setting_updates),
        len(obs.created_inputs),
        len(obs.created_items),
        len(obs.removed_items),
        len(obs.transforms),
        len(obs.indexes),
        len(obs.enabled_updates),
    ) == writes_before


def test_startup_replaces_wrong_viewport_alerts_but_preserves_item_state() -> None:
    obs = CurrentAudioObs()
    old_alert = _add_generated_alert_items(obs, size=(400, 300))
    expected = {
        scene_name: next(
            (
                bool(item["enabled"]),
                int(item["index"]),
                dict(item["transform"]),
            )
            for item in obs.scene_items[scene_name]
            if item["source_name"] == old_alert
        )
        for scene_name in (SCENE_BETWEEN_GAMES, SCENE_IN_GAME)
    }

    owners, _updated, changed = repair_chat_alert_audio_roles(
        obs,
        browser_url=_manual_url(),
    )

    assert owners["chat_alerts"] == "Alert Box"
    assert set(changed) == {SCENE_BETWEEN_GAMES, SCENE_IN_GAME}
    created = next(
        item for item in obs.created_inputs
        if "/widget/chat-alerts" in item["settings"]["url"]
    )
    assert created["settings"]["url"].endswith("?audio=0")
    assert (
        created["settings"]["width"],
        created["settings"]["height"],
    ) == (1792, 360)
    for scene_name in (SCENE_BETWEEN_GAMES, SCENE_IN_GAME):
        item = next(
            item for item in obs.scene_items[scene_name]
            if item["source_name"] == created["name"]
        )
        assert (
            bool(item["enabled"]),
            int(item["index"]),
            item["transform"],
        ) == expected[scene_name]
        assert not any(
            row["source_name"] in {old_alert, "Alert Box"}
            for row in obs.scene_items[scene_name]
        )


def test_startup_splits_previously_shared_canonical_items() -> None:
    obs = CurrentAudioObs()
    old_chat = next(
        item for item in obs.scene_items[SCENE_BETWEEN_GAMES]
        if item["source_name"] == "SC2 Tools Chat"
    )
    old_chat["source_name"] = "Chat"
    old_chat["enabled"] = False
    old_chat["transform"] = {
        "positionX": 1320,
        "positionY": 48,
        "alignment": 5,
        "boundsType": "OBS_BOUNDS_SCALE_INNER",
        "boundsAlignment": 0,
        "boundsWidth": 552,
        "boundsHeight": 984,
    }
    expected = (
        old_chat["enabled"],
        old_chat["index"],
        dict(old_chat["transform"]),
    )

    _owners, _updated, changed = repair_chat_alert_audio_roles(
        obs,
        browser_url=_manual_url(),
    )

    assert changed == [SCENE_BETWEEN_GAMES]
    replacement = next(
        item for item in obs.scene_items[SCENE_BETWEEN_GAMES]
        if item["source_name"] == "SC2 Tools Chat"
    )
    assert (
        replacement["enabled"],
        replacement["index"],
        replacement["transform"],
    ) == expected
    assert not any(
        item["source_name"] == "Chat"
        for item in obs.scene_items[SCENE_BETWEEN_GAMES]
    )


def test_startup_audio_roles_fail_closed_on_external_ambiguity() -> None:
    obs = CurrentAudioObs()
    _add_generated_alert_items(obs)
    duplicate = "Other Live Chat"
    obs._inputs.append({"name": duplicate, "kind": "browser_source"})
    obs.input_settings[duplicate] = dict(obs.input_settings["Chat"])
    obs._scenes.append("Custom Chat")
    obs.scene_items["Custom Chat"] = obs._items(
        [(duplicate, "browser_source")],
    )

    with pytest.raises(SceneBuildError, match="Expected one canonical"):
        repair_chat_alert_audio_roles(obs, browser_url=_manual_url())

    assert obs.input_setting_updates == []
    assert obs.created_items == []
    assert obs.removed_items == []
    assert obs.refreshed_browser_inputs == []


@pytest.mark.parametrize("boundary", ["transform", "index"])
def test_startup_audio_role_restart_keeps_intact_geometry_after_cleanup_failure(
    boundary: str,
) -> None:
    class InterruptedObs(CurrentAudioObs):
        failed_boundary = False
        fail_cleanup = True

        def _is_new_native_chat(self, item_id: int) -> bool:
            return any(
                int(item["item_id"]) == int(item_id)
                and item["source_name"].startswith("SC2 Tools Chat")
                for item in self.scene_items[SCENE_BETWEEN_GAMES]
            )

        def set_scene_item_transform(self, **kw: Any) -> None:
            if (
                boundary == "transform"
                and not self.failed_boundary
                and self._is_new_native_chat(int(kw["item_id"]))
            ):
                self.failed_boundary = True
                raise RuntimeError("transform interrupted")
            super().set_scene_item_transform(**kw)

        def set_scene_item_index(self, **kw: Any) -> None:
            if (
                boundary == "index"
                and not self.failed_boundary
                and self._is_new_native_chat(int(kw["item_id"]))
            ):
                self.failed_boundary = True
                raise RuntimeError("index interrupted")
            super().set_scene_item_index(**kw)

        def remove_scene_item(self, **kw: Any) -> None:
            if (
                self.fail_cleanup
                and self._is_new_native_chat(int(kw["item_id"]))
                and any(
                    item["source_name"] == "Chat"
                    for item in self.scene_items[SCENE_BETWEEN_GAMES]
                )
            ):
                raise RuntimeError("cleanup interrupted")
            super().remove_scene_item(**kw)

    obs = InterruptedObs()
    original = next(
        item for item in obs.scene_items[SCENE_BETWEEN_GAMES]
        if item["source_name"] == "SC2 Tools Chat"
    )
    original["source_name"] = "Chat"
    original["enabled"] = False
    original["transform"] = {
        "positionX": 1320,
        "positionY": 48,
        "alignment": 5,
        "boundsType": "OBS_BOUNDS_SCALE_INNER",
        "boundsAlignment": 0,
        "boundsWidth": 552,
        "boundsHeight": 984,
    }
    expected = (
        original["enabled"],
        original["index"],
        dict(original["transform"]),
    )
    obs._inputs = [
        row for row in obs._inputs if row["name"] != "SC2 Tools Chat"
    ]
    obs.input_settings.pop("SC2 Tools Chat", None)

    with pytest.raises(SceneBuildError, match="duplicate audio widget"):
        repair_chat_alert_audio_roles(obs, browser_url=_manual_url())

    assert any(
        item["source_name"] == "Chat"
        for item in obs.scene_items[SCENE_BETWEEN_GAMES]
    )
    obs.fail_cleanup = False
    repair_chat_alert_audio_roles(obs, browser_url=_manual_url())

    items = obs.scene_items[SCENE_BETWEEN_GAMES]
    native = [
        item for item in items
        if item["source_name"].startswith("SC2 Tools Chat")
    ]
    assert len(native) == 1
    assert not any(item["source_name"] == "Chat" for item in items)
    assert (
        native[0]["enabled"],
        native[0]["index"],
        native[0]["transform"],
    ) == expected
    assert obs.input_settings["Chat"]["url"].endswith("?audio=1")
    assert obs.input_settings[native[0]["source_name"]]["url"].endswith(
        "?audio=0",
    )



def test_build_never_touches_pre_existing_scenes() -> None:
    obs = FakeObs(scenes=["My Gameplay", "My BRB"])
    build_scenes(obs, _plan(obs))
    assert obs.removed_scenes == []
    assert "My Gameplay" in obs.scene_names
    assert "My BRB" in obs.scene_names


def test_build_refuses_to_clobber_without_rebuild() -> None:
    obs = FakeObs(scenes=[SCENE_BETWEEN_GAMES])
    with pytest.raises(SceneBuildError, match="already exist"):
        build_scenes(obs, _plan(obs))
    assert obs.created_scenes == []
    assert obs.removed_scenes == []


def test_rebuild_replaces_only_our_own_scenes() -> None:
    obs = FakeObs(scenes=[SCENE_BETWEEN_GAMES, "Untouched"])
    build_scenes(obs, _plan(obs), rebuild=True)
    assert obs.removed_scenes == [SCENE_BETWEEN_GAMES]
    assert "Untouched" in obs.scene_names


def test_rebuild_guard_rejects_a_foreign_scene_name() -> None:
    """Belt and braces on the one destructive call in the module."""
    obs = FakeObs(scenes=["Someone Else's Scene"])
    plan = _plan(obs)
    plan.scenes[0].name = "Someone Else's Scene"
    plan.scenes[0].exists = True
    with pytest.raises(SceneBuildError, match="Refusing to remove"):
        build_scenes(obs, plan, rebuild=True)
    assert obs.removed_scenes == []


def test_every_created_scene_name_carries_our_prefix() -> None:
    for name in build_scenes(FakeObs(), _plan(FakeObs())):
        assert name.startswith(SCENE_NAME_PREFIX)


def test_transforms_anchor_top_left_and_preserve_aspect() -> None:
    obs = FakeObs()
    build_scenes(obs, _plan(obs))
    assert obs.transforms
    manual_ids = {
        item["id"] for item in obs.created_inputs
        if item["name"].startswith(MANUAL_OVERRIDE_INPUT_NAME)
    }
    manual_ids.update(
        item["id"] for item in obs.created_items
        if item["source"].startswith(MANUAL_OVERRIDE_INPUT_NAME)
    )
    for t in obs.transforms:
        assert t["alignment"] == 5  # OBS_ALIGN_TOP | OBS_ALIGN_LEFT
        assert t["boundsWidth"] >= 1 and t["boundsHeight"] >= 1
        if t["id"] in manual_ids:
            # The opaque manual card must cover every pixel even if OBS
            # reuses a Browser Source from an older canvas/aspect ratio.
            assert t["boundsType"] == "OBS_BOUNDS_STRETCH"
            assert t["rotation"] == 0.0
            assert t["cropLeft"] == t["cropRight"] == 0
        else:
            # SCALE_INNER letterboxes a 4:3 webcam instead of stretching it.
            assert t["boundsType"] == "OBS_BOUNDS_SCALE_INNER"


def test_browser_sources_are_sized_to_their_box() -> None:
    """Rendering at the on-canvas size keeps chat text crisp instead of
    scaling a small render up and going soft."""
    obs = FakeObs()
    plan = _plan(obs)
    build_scenes(obs, plan)
    chat_item = next(i for i in plan.scenes[0].items if i.label == "Chat")
    chat_input = next(
        i for i in obs.created_inputs if i["name"] == "SC2 Tools Chat"
    )
    assert chat_input["settings"]["width"] == chat_item.rect.w
    assert chat_input["settings"]["height"] == chat_item.rect.h


def test_browser_sources_do_not_reload_on_scene_activate() -> None:
    """The switcher fires many times a session; a source that refreshes
    on activate would flash on air every single time."""
    obs = FakeObs()
    build_scenes(obs, _plan(obs))
    for created in obs.created_inputs:
        assert created["settings"]["shutdown"] is False
        assert created["settings"]["restart_when_active"] is False


def test_input_name_collision_gets_a_suffix() -> None:
    """OBS rejects duplicate input names outright, which would abort
    the build partway and leave a half-populated scene behind."""
    obs = FakeObs(
        inputs=[
            {"name": "SC2 Tools Chat", "kind": "browser_source"},
            {"name": "Logitech Brio", "kind": "dshow_input"},
            {"name": "StarCraft II", "kind": "game_capture"},
        ],
    )
    build_scenes(obs, _plan(obs))
    chat_names = [
        i["name"] for i in obs.created_inputs
        if i["name"] == "SC2 Tools Chat 2"
    ]
    assert chat_names == ["SC2 Tools Chat 2"]


def test_z_order_is_applied_bottom_up() -> None:
    obs = FakeObs()
    build_scenes(obs, _plan(obs))
    between = [i for i in obs.indexes if i["scene"] == SCENE_BETWEEN_GAMES]
    assert [i["index"] for i in between] == sorted(i["index"] for i in between)


def test_missing_optional_sources_still_use_valid_contiguous_indexes() -> None:
    obs = FakeObs()
    plan = _plan(obs, webcam_source=None, game_source=None)
    build_scenes(obs, plan)

    for scene in plan.scenes:
        indexes = [
            item["index"]
            for item in obs.indexes
            if item["scene"] == scene.name
        ]
        assert indexes == list(range(len(indexes)))


def test_build_without_the_in_game_scene() -> None:
    """A streamer who already has a gameplay scene they like points the
    phase map at it and skips this half."""
    obs = FakeObs()
    plan = _plan(obs, include_in_game=False)
    created = build_scenes(obs, plan)
    assert created == [SCENE_BETWEEN_GAMES]


def test_in_game_layout_reference_is_full_canvas() -> None:
    assert IN_GAME_LAYOUT["game"] == BETWEEN_GAMES_LAYOUT["backdrop"]

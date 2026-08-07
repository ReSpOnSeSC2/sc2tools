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

from typing import Any, Dict, List, Optional

import pytest

from sc2tools_agent.live.obs_layout import (
    BETWEEN_GAMES_LAYOUT,
    IN_GAME_LAYOUT,
    MANUAL_OVERRIDE_BROWSER_PATH,
    MANUAL_OVERRIDE_INPUT_NAME,
    REF_HEIGHT,
    REF_WIDTH,
    SCENE_NAME_PREFIX,
    SceneBuildError,
    build_scenes,
    discover_sources,
    manual_override_scenes_needing_update,
    plan_scenes,
    repair_manual_scene_overrides,
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
        self._canvas = canvas
        self._next_item_id = 100

        self.created_scenes: List[str] = []
        self.removed_scenes: List[str] = []
        self.created_items: List[Dict[str, Any]] = []
        self.created_inputs: List[Dict[str, Any]] = []
        self.transforms: List[Dict[str, Any]] = []
        self.indexes: List[Dict[str, Any]] = []
        self.enabled_updates: List[Dict[str, Any]] = []

    # ---- reads ----
    def get_video_settings(self) -> Dict[str, Any]:
        return {"base_width": self._canvas[0], "base_height": self._canvas[1]}

    def get_input_list(self, kind: Optional[str] = None) -> List[Dict[str, Any]]:
        return list(self._inputs)

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

    def create_scene_item(self, *, scene_name: str, source_name: str) -> int:
        self._next_item_id += 1
        self.created_items.append(
            {"scene": scene_name, "source": source_name, "id": self._next_item_id},
        )
        return self._next_item_id

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
                "enabled": True,
                "transform": {},
            },
        )
        return item_id

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
        "Manual scene override",
    ]
    assert [i.label for i in plan.scenes[1].items] == [
        "Game capture",
        "Webcam",
        "Manual scene override",
    ]


def test_stream_dock_override_covers_every_auto_switch_target() -> None:
    """Starting Soon / BRB is a manual broadcast choice, so every scene
    the automatic switcher can select needs the transparent manual cover
    above all of its normal content."""
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
        )
        assert override.rect.x == 0 and override.rect.y == 0
        assert override.rect.w == plan.canvas_width
        assert override.rect.h == plan.canvas_height
        assert override.z == max(item.z for item in scene.items)
        assert all(
            override.z > item.z
            for item in scene.items
            if item is not override
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
        if i.label not in {"SC2 backdrop", "Manual scene override"}
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
    assert urls["Chat"] == f"{BASE_URL}/overlay/{TOKEN}/widget/multichat"
    assert urls["Session stats"] == f"{BASE_URL}/overlay/{TOKEN}/widget/session"
    assert urls["Manual scene override"] == (
        f"{BASE_URL}/overlay/{TOKEN}/scene/manual"
    )

    in_game = plan.scenes[1]
    manual = next(
        i for i in in_game.items if i.label == "Manual scene override"
    )
    assert manual.browser_path == f"{BASE_URL}/overlay/{TOKEN}/scene/manual"


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
    for scene_name in (SCENE_BETWEEN_GAMES, SCENE_IN_GAME):
        assert obs.scene_items[scene_name][-1]["source_name"] == manual_name
    assert [
        item["source_name"]
        for item in obs.scene_items[SCENE_BETWEEN_GAMES][:-1]
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
    cover = obs.scene_items[SCENE_BETWEEN_GAMES][-1]

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
    cover = obs.scene_items[SCENE_BETWEEN_GAMES][-1]
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
    manual_name = obs.scene_items[SCENE_BETWEEN_GAMES][-1]["source_name"]
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
    assert obs.scene_items[SCENE_BETWEEN_GAMES][-1]["source_name"] == manual_name
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
    chat_input = next(i for i in obs.created_inputs if i["name"].startswith("SC2 Tools Chat"))
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
        i["name"] for i in obs.created_inputs if i["name"].startswith("SC2 Tools Chat")
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

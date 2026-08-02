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
    REF_HEIGHT,
    REF_WIDTH,
    SCENE_NAME_PREFIX,
    SceneBuildError,
    build_scenes,
    discover_sources,
    plan_scenes,
)
from sc2tools_agent.live.obs_scene import SCENE_BETWEEN_GAMES, SCENE_IN_GAME

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
    ]
    assert [i.label for i in plan.scenes[1].items] == ["Game capture", "Webcam"]


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
    boxes = [i for i in between.items if i.label != "SC2 backdrop"]
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
    between = _plan(FakeObs()).scenes[0]
    urls = {
        i.label: i.browser_path for i in between.items if i.browser_path
    }
    assert urls["SC2 backdrop"] == f"{BASE_URL}/overlay/{TOKEN}/scene/between-games"
    assert urls["Chat"] == f"{BASE_URL}/overlay/{TOKEN}/widget/multichat"
    assert urls["Session stats"] == f"{BASE_URL}/overlay/{TOKEN}/widget/session"


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
    for t in obs.transforms:
        # SCALE_INNER letterboxes a 4:3 webcam instead of stretching it.
        assert t["boundsType"] == "OBS_BOUNDS_SCALE_INNER"
        assert t["alignment"] == 5  # OBS_ALIGN_TOP | OBS_ALIGN_LEFT
        assert t["boundsWidth"] >= 1 and t["boundsHeight"] >= 1


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


def test_build_without_the_in_game_scene() -> None:
    """A streamer who already has a gameplay scene they like points the
    phase map at it and skips this half."""
    obs = FakeObs()
    plan = _plan(obs, include_in_game=False)
    created = build_scenes(obs, plan)
    assert created == [SCENE_BETWEEN_GAMES]


def test_in_game_layout_reference_is_full_canvas() -> None:
    assert IN_GAME_LAYOUT["game"] == BETWEEN_GAMES_LAYOUT["backdrop"]

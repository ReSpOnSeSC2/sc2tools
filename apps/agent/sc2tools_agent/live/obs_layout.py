"""One-click OBS scene builder for the auto-switching layouts.

``obs_scene.py`` switches between two scenes. This module creates them.

The whole point is the thing a browser-source overlay physically
cannot do: change the *layout*. A Browser Source can only paint inside
its own rectangle — it cannot move the streamer's webcam or shrink the
game capture. Only OBS can, so the downtime layout (big camera, big
readable chat, small game inset, backdrop behind everything) has to be
a real OBS scene.

Two scenes rather than retransforming one
-----------------------------------------

OBS lets the *same* webcam and *same* game capture appear in several
scenes at different sizes and positions, and a scene item is a
reference rather than a second capture — so the duplicate costs
nothing. That buys three things retransforming in place does not:

* the streamer's configured transition plays on every switch, with no
  frame-stepping over a websocket;
* their original source scene is never touched, so automatic switching
  is read-only with respect to scene *contents*;
* if the agent dies mid-stream OBS is simply parked on a valid scene,
  rather than stranded halfway through a move.

Safety contract
---------------

Building or replacing a layout runs **only** when the user explicitly
clicks Build or Replace. The agent may also repair the shared manual-
override cover when it connects to OBS. That repair is deliberately
narrow: it can add, enable, resize, or raise the cover inside the two
exact generated scenes, but it never creates a scene or removes or
reorders any other item. Replacing an existing SC2 Tools scene requires
an explicit flag, and even then it will only remove a scene whose name
it owns.

Geometry
--------

Positions below are authored against a 1920×1080 reference and scaled
by whatever ``GetVideoSettings`` reports, so a 1440p or ultrawide
canvas lands correctly. Capture/panel sizing uses
``OBS_BOUNDS_SCALE_INNER`` rather than a raw scale factor: bounds
produce the right result regardless of the source's native resolution.
The full-screen manual cover deliberately uses ``OBS_BOUNDS_STRETCH``
so even a Browser Source retained from an older canvas covers every pixel.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import urlsplit

from .metrics import METRICS
from .obs_scene import SCENE_BETWEEN_GAMES, SCENE_IN_GAME

_log = logging.getLogger("sc2tools_agent.live.obs_layout")

#: Only scenes carrying this prefix are ever eligible for removal.
SCENE_NAME_PREFIX = "SC2 Tools — "

#: Reference canvas the geometry below is authored against.
REF_WIDTH = 1920
REF_HEIGHT = 1080

# OBS alignment bit flags (libobs ``OBS_ALIGN_*``).
_ALIGN_CENTER = 0
_ALIGN_LEFT = 1
_ALIGN_TOP = 4
_ALIGN_TOP_LEFT = _ALIGN_TOP | _ALIGN_LEFT

#: Input kinds that plausibly carry a webcam, most likely first. OBS
#: names these per platform; we search in order and let the user
#: confirm, because picking the wrong capture is worse than asking.
WEBCAM_INPUT_KINDS: Sequence[str] = (
    "dshow_input",          # Windows
    "av_capture_input",     # macOS
    "av_capture_input_v2",  # macOS (newer)
    "v4l2_input",           # Linux
)

#: Input kinds that plausibly carry the game.
GAME_INPUT_KINDS: Sequence[str] = (
    "game_capture",       # Windows, the right answer for SC2
    "window_capture",     # Windows / Linux fallback
    "xcomposite_input",   # Linux
    "screen_capture",     # macOS / Windows 11 fallback
    "monitor_capture",
    "display_capture",
)

BROWSER_INPUT_KIND = "browser_source"


@dataclass(frozen=True)
class Rect:
    """A box on the reference canvas, in reference pixels."""

    x: int
    y: int
    w: int
    h: int

    def scaled(self, sx: float, sy: float) -> "Rect":
        return Rect(
            x=round(self.x * sx),
            y=round(self.y * sy),
            w=round(self.w * sx),
            h=round(self.h * sy),
        )


@dataclass(frozen=True)
class PlannedItem:
    """One scene item the builder intends to create.

    ``source_name`` set  → reuse an existing input (webcam, game).
    ``browser_path`` set → create a new browser source at that overlay
    path. Exactly one of the two is populated.
    """

    label: str
    rect: Rect
    z: int
    source_name: Optional[str] = None
    browser_path: Optional[str] = None
    input_name: Optional[str] = None
    # Browser items carrying the same explicit key share one OBS input and
    # get separate scene-item references. No key means always create a
    # distinct input, even if two labels happen to request the same name.
    share_key: Optional[str] = None


@dataclass
class PlannedScene:
    name: str
    items: List[PlannedItem] = field(default_factory=list)
    exists: bool = False


@dataclass
class BuildPlan:
    """Everything the builder will do, before it does any of it.

    Handed to the GUI so the user sees exactly what is about to be
    created — with their own source names filled in — and confirms
    before a single request goes out.
    """

    canvas_width: int
    canvas_height: int
    scenes: List[PlannedScene] = field(default_factory=list)
    webcam_source: Optional[str] = None
    game_source: Optional[str] = None
    warnings: List[str] = field(default_factory=list)

    @property
    def conflicts(self) -> List[str]:
        """Names that already exist and would need an explicit rebuild."""
        return [s.name for s in self.scenes if s.exists]


# ---------------------------------------------------------------------
# The layouts
# ---------------------------------------------------------------------

_MARGIN = 48

#: Downtime layout. Big camera and a full-height chat column dominate;
#: the game inset is small but stays comfortably legible for reading a
#: matchmaking screen, which is the whole reason it is on screen.
BETWEEN_GAMES_LAYOUT: Dict[str, Rect] = {
    "backdrop": Rect(0, 0, REF_WIDTH, REF_HEIGHT),
    "webcam": Rect(_MARGIN, _MARGIN, 1224, 688),
    "game": Rect(_MARGIN, 760, 484, 272),
    "stats": Rect(556, 760, 716, 272),
    "chat": Rect(1320, _MARGIN, 552, 984),
}

#: Gameplay layout. Game fills the canvas, camera tucks bottom-right.
IN_GAME_LAYOUT: Dict[str, Rect] = {
    "game": Rect(0, 0, REF_WIDTH, REF_HEIGHT),
    "webcam": Rect(1568, 861, 304, 171),
}

# Transparent during normal Live operation; becomes an opaque Starting
# Soon / BRB canvas when the streamer explicitly selects one in the Stream
# Dock. The builder places this above every other item in both layouts, so an
# automatic program-scene cut can never cover a manual dock selection.
MANUAL_OVERRIDE_RECT = Rect(0, 0, REF_WIDTH, REF_HEIGHT)
MANUAL_OVERRIDE_BROWSER_PATH = "scene/manual"
MANUAL_OVERRIDE_INPUT_NAME = "SC2 Tools Manual Override"
_MANUAL_OVERRIDE_BOUNDS_TYPE = "OBS_BOUNDS_STRETCH"
MANUAL_OVERRIDE_SCENES: Sequence[str] = (
    SCENE_BETWEEN_GAMES,
    SCENE_IN_GAME,
)
_GENERATED_BROWSER_ROUTES = {
    "SC2 Tools Backdrop": ("scene", "between-games"),
    "SC2 Tools Session Stats": ("widget", "session"),
    "SC2 Tools Chat": ("widget", "multichat"),
    MANUAL_OVERRIDE_INPUT_NAME: ("scene", "manual"),
}


def _overlay_url(base_url: str, token: str, path: str) -> str:
    return f"{base_url.rstrip('/')}/overlay/{token}/{path}"


# ---------------------------------------------------------------------
# Source discovery
# ---------------------------------------------------------------------


def discover_sources(client: Any) -> Dict[str, List[str]]:
    """Return candidate webcam / game inputs from the user's OBS.

    Deliberately returns *lists* rather than a best guess. The GUI
    shows them as dropdowns: a wrong game capture produces a scene
    showing the desktop on stream, which is worse than one extra
    click at setup time.
    """
    inputs = client.get_input_list()
    by_kind: Dict[str, List[str]] = {}
    for row in inputs:
        by_kind.setdefault(str(row.get("kind") or ""), []).append(
            str(row.get("name")),
        )

    def _ordered(kinds: Sequence[str]) -> List[str]:
        out: List[str] = []
        for kind in kinds:
            out.extend(by_kind.get(kind, []))
        return out

    return {
        "webcam": _ordered(WEBCAM_INPUT_KINDS),
        "game": _ordered(GAME_INPUT_KINDS),
    }


# ---------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------


def plan_scenes(
    client: Any,
    *,
    overlay_base_url: str,
    overlay_token: str,
    webcam_source: Optional[str] = None,
    game_source: Optional[str] = None,
    include_in_game: bool = True,
) -> BuildPlan:
    """Work out what would be created. Touches nothing.

    Missing a webcam or a game capture is a warning, not an error —
    the scene is still worth building without it, and the user can
    drag the source in afterwards like any other OBS scene.
    """
    video = client.get_video_settings()
    canvas_w = int(video.get("base_width") or REF_WIDTH) or REF_WIDTH
    canvas_h = int(video.get("base_height") or REF_HEIGHT) or REF_HEIGHT
    sx = canvas_w / REF_WIDTH
    sy = canvas_h / REF_HEIGHT

    existing = set(client.refresh_scenes())
    warnings: List[str] = []
    if not webcam_source:
        warnings.append(
            "No webcam source selected — the Between Games scene will "
            "be built without one. Add it in OBS afterwards.",
        )
    if not game_source:
        warnings.append(
            "No game capture selected — the game inset and the In Game "
            "scene will be built without it.",
        )

    between = PlannedScene(
        name=SCENE_BETWEEN_GAMES,
        exists=SCENE_BETWEEN_GAMES in existing,
    )
    between.items.append(
        PlannedItem(
            label="SC2 backdrop",
            rect=BETWEEN_GAMES_LAYOUT["backdrop"].scaled(sx, sy),
            z=0,
            browser_path="scene/between-games",
            input_name="SC2 Tools Backdrop",
        ),
    )
    if webcam_source:
        between.items.append(
            PlannedItem(
                label="Webcam",
                rect=BETWEEN_GAMES_LAYOUT["webcam"].scaled(sx, sy),
                z=1,
                source_name=webcam_source,
            ),
        )
    if game_source:
        between.items.append(
            PlannedItem(
                label="Game inset",
                rect=BETWEEN_GAMES_LAYOUT["game"].scaled(sx, sy),
                z=2,
                source_name=game_source,
            ),
        )
    between.items.append(
        PlannedItem(
            label="Session stats",
            rect=BETWEEN_GAMES_LAYOUT["stats"].scaled(sx, sy),
            z=3,
            browser_path="widget/session",
            input_name="SC2 Tools Session Stats",
        ),
    )
    between.items.append(
        PlannedItem(
            label="Chat",
            rect=BETWEEN_GAMES_LAYOUT["chat"].scaled(sx, sy),
            z=4,
            browser_path="widget/multichat",
            input_name="SC2 Tools Chat",
        ),
    )
    between.items.append(
        PlannedItem(
            label="Manual scene override",
            rect=MANUAL_OVERRIDE_RECT.scaled(sx, sy),
            z=5,
            browser_path=MANUAL_OVERRIDE_BROWSER_PATH,
            # The identical name on both planned scenes is intentional:
            # build_scenes creates this Browser Source once, then adds a
            # reference to that same source in the second scene.
            input_name=MANUAL_OVERRIDE_INPUT_NAME,
            share_key="manual_scene_override",
        ),
    )

    scenes = [between]

    if include_in_game:
        in_game = PlannedScene(
            name=SCENE_IN_GAME, exists=SCENE_IN_GAME in existing,
        )
        if game_source:
            in_game.items.append(
                PlannedItem(
                    label="Game capture",
                    rect=IN_GAME_LAYOUT["game"].scaled(sx, sy),
                    z=0,
                    source_name=game_source,
                ),
            )
        if webcam_source:
            in_game.items.append(
                PlannedItem(
                    label="Webcam",
                    rect=IN_GAME_LAYOUT["webcam"].scaled(sx, sy),
                    z=1,
                    source_name=webcam_source,
                ),
            )
        in_game.items.append(
            PlannedItem(
                label="Manual scene override",
                rect=MANUAL_OVERRIDE_RECT.scaled(sx, sy),
                z=2,
                browser_path=MANUAL_OVERRIDE_BROWSER_PATH,
                input_name=MANUAL_OVERRIDE_INPUT_NAME,
                share_key="manual_scene_override",
            ),
        )
        scenes.append(in_game)

    # Resolve browser URLs now so the plan the user confirms is
    # literally what gets sent.
    for scene in scenes:
        for i, item in enumerate(scene.items):
            if item.browser_path:
                scene.items[i] = PlannedItem(
                    label=item.label,
                    rect=item.rect,
                    z=item.z,
                    browser_path=_overlay_url(
                        overlay_base_url, overlay_token, item.browser_path,
                    ),
                    input_name=item.input_name,
                    share_key=item.share_key,
                )

    return BuildPlan(
        canvas_width=canvas_w,
        canvas_height=canvas_h,
        scenes=scenes,
        webcam_source=webcam_source,
        game_source=game_source,
        warnings=warnings,
    )


# ---------------------------------------------------------------------
# Building
# ---------------------------------------------------------------------


class SceneBuildError(RuntimeError):
    """Raised when the build cannot safely proceed."""


def build_scenes(
    client: Any, plan: BuildPlan, *, rebuild: bool = False,
) -> List[str]:
    """Execute ``plan``. Returns the scene names created.

    Raises ``SceneBuildError`` when a planned scene already exists and
    ``rebuild`` was not set, rather than silently mutating or silently
    skipping — both of which leave the user guessing about what
    happened to their OBS.
    """
    conflicts = plan.conflicts
    if conflicts and not rebuild:
        raise SceneBuildError(
            "These scenes already exist: "
            + ", ".join(conflicts)
            + ". Re-run with rebuild to replace them.",
        )

    created: List[str] = []
    # Browser Sources carrying the same explicit ``share_key`` are shared
    # between scenes. In particular, the full-canvas manual override sits in
    # both generated layouts but should consume one CEF renderer/socket/poll
    # loop, not two. Values are the collision-safe names actually created in
    # OBS.
    shared_browser_inputs: Dict[str, str] = {}
    for scene in plan.scenes:
        if scene.exists:
            _assert_ours(scene.name)
            _log.info("obs_scene_rebuild removing=%r", scene.name)
            client.remove_scene(scene.name)
        client.create_scene(scene.name)
        created.append(scene.name)
        _log.info(
            "obs_scene_created name=%r items=%d", scene.name, len(scene.items),
        )

        # OBS requires scene-item indices to be contiguous. Authored ``z``
        # values can contain gaps when an optional webcam/game source was not
        # selected, so compact them while preserving the intended order.
        scene_index = 0
        for item in sorted(scene.items, key=lambda i: i.z):
            item_id = _create_item(
                client,
                scene.name,
                item,
                shared_browser_inputs=shared_browser_inputs,
            )
            if item_id is None:
                continue
            client.set_scene_item_transform(
                scene_name=scene.name,
                item_id=item_id,
                transform=(
                    _manual_override_transform_for(item.rect)
                    if item.share_key == "manual_scene_override"
                    else _transform_for(item.rect)
                ),
            )
            client.set_scene_item_index(
                scene_name=scene.name, item_id=item_id, index=scene_index,
            )
            _log.info(
                "obs_scene_item_placed scene=%r item=%r x=%d y=%d w=%d h=%d z=%d",
                scene.name,
                item.label,
                item.rect.x,
                item.rect.y,
                item.rect.w,
                item.rect.h,
                scene_index,
            )
            scene_index += 1

    client.refresh_scenes()
    METRICS.incr("obs.build.ok")
    return created


def manual_override_scenes_needing_update(
    client: Any,
    *,
    scene_names: Sequence[str] = MANUAL_OVERRIDE_SCENES,
) -> List[str]:
    """Inspect generated scenes without changing OBS.

    A scene needs an update when it has no ``/scene/manual`` Browser
    Source, when that source is not the top OBS layer, or when its scene-item
    transform no longer fills the current canvas. The URL, rather than the
    source's display name, is authoritative so a user's unrelated source with
    the same name is never mistaken for our cover.
    """
    targets = _existing_manual_override_targets(client, scene_names)
    if not targets:
        return []
    rect = _manual_override_rect_for_canvas(client)
    settings_cache: Dict[str, Dict[str, Any]] = {}
    needs_update: List[str] = []
    for scene_name in targets:
        items = client.get_scene_item_list(scene_name)
        covers = _manual_cover_items(
            client,
            items,
            settings_cache=settings_cache,
        )
        top_index = max((int(item.get("index", 0)) for item in items), default=-1)
        cover = max(covers, key=lambda item: int(item.get("index", 0))) if covers else None
        if (
            cover is None
            or not bool(cover.get("enabled", True))
            or int(cover.get("index", -1)) != top_index
            or not _transform_fills_rect(cover.get("transform"), rect)
        ):
            needs_update.append(scene_name)
    return needs_update


def discover_manual_override_url(
    client: Any,
    *,
    scene_names: Sequence[str] = MANUAL_OVERRIDE_SCENES,
) -> Optional[str]:
    """Derive the manual-cover URL from an existing generated layout.

    Older layouts already contain authenticated SC2 Tools Browser Sources,
    but predate ``/scene/manual``. Reusing their origin and overlay token lets
    startup migrate those layouts without a cloud request or persisting the
    token in the agent. Automatic authorization requires the complete legacy
    builder fingerprint inside the exact Between Games scene.
    """
    targets = _existing_manual_override_targets(client, scene_names)
    if SCENE_BETWEEN_GAMES not in targets:
        return None

    # A name alone is not proof that a scene belongs to the builder. Require
    # the three Browser Sources every legacy Between Games layout contained,
    # with their collision-safe names, exact routes, and one shared
    # origin/token. A customized or same-named foreign scene then falls back
    # to the explicit Test -> Update flow rather than being changed at startup.
    required_routes = {
        ("scene", "between-games"),
        ("widget", "session"),
        ("widget", "multichat"),
    }
    settings_cache: Dict[str, Dict[str, Any]] = {}
    candidates: Dict[tuple[str, str], List[str]] = {
        route: [] for route in required_routes
    }
    for item in client.get_scene_item_list(SCENE_BETWEEN_GAMES):
        if item.get("input_kind") != BROWSER_INPUT_KIND:
            continue
        source_name = str(item.get("source_name") or "")
        expected_route = _generated_browser_route_for_input_name(source_name)
        if expected_route not in required_routes:
            continue
        settings = settings_cache.get(source_name)
        if settings is None:
            settings = client.get_input_settings(source_name)
            settings_cache[source_name] = settings
        manual_url = _manual_override_url_from_overlay_url(
            str(settings.get("url") or ""),
            expected_route=expected_route,
        )
        if manual_url is not None:
            candidates[expected_route].append(manual_url)

    if any(len(urls) != 1 for urls in candidates.values()):
        return None
    unique_urls = {
        _overlay_url_key(urls[0]) for urls in candidates.values()
    }
    if len(unique_urls) != 1:
        return None
    return candidates[("scene", "between-games")][0]


def repair_manual_scene_overrides(
    client: Any,
    *,
    browser_url: str,
    scene_names: Sequence[str] = MANUAL_OVERRIDE_SCENES,
) -> List[str]:
    """Non-destructively put the Stream Dock cover atop generated scenes.

    This is the upgrade path for layouts created before ``/scene/manual``
    existed. It never creates, removes, or reorders any other scene/source:
    one Browser Source is created (or reused), referenced from each existing
    generated scene, stretched to the canvas, and moved to the top layer.

    The operation is idempotent and verifies the final OBS stack before it
    reports success, so an interrupted first attempt can be safely retried.
    """
    _assert_manual_override_url(browser_url)
    targets = _existing_manual_override_targets(client, scene_names)
    if not targets:
        return []

    rect = _manual_override_rect_for_canvas(client)
    expected_url_key = _overlay_url_key(browser_url)
    settings_cache: Dict[str, Dict[str, Any]] = {}
    inventories: Dict[str, List[Dict[str, Any]]] = {
        scene_name: client.get_scene_item_list(scene_name)
        for scene_name in targets
    }

    # Prefer a correct cover already present in either generated scene. If a
    # prior attempt stopped after creating the input but before adding both
    # scene items, the global input scan below finds and reuses it.
    shared_source: Optional[str] = None
    covers_by_scene: Dict[str, List[Dict[str, Any]]] = {}
    for scene_name, items in inventories.items():
        covers = _manual_cover_items(
            client,
            items,
            settings_cache=settings_cache,
            expected_url_key=expected_url_key,
        )
        covers_by_scene[scene_name] = covers
        if covers and shared_source is None:
            shared_source = str(covers[0]["source_name"])

    if shared_source is None:
        shared_source = _find_manual_cover_input(
            client,
            expected_url_key=expected_url_key,
            settings_cache=settings_cache,
        )

    changed: List[str] = []
    manual_item = PlannedItem(
        label="Manual scene override",
        rect=rect,
        z=0,
        browser_path=browser_url,
        input_name=MANUAL_OVERRIDE_INPUT_NAME,
        share_key="manual_scene_override",
    )

    for scene_name in targets:
        items = inventories[scene_name]
        covers = covers_by_scene[scene_name]
        cover = max(covers, key=lambda item: int(item.get("index", 0))) if covers else None
        top_index = max((int(item.get("index", 0)) for item in items), default=-1)

        if cover is None:
            if shared_source is None:
                shared_source = _unique_input_name(
                    client, MANUAL_OVERRIDE_INPUT_NAME,
                )
                item_id = client.create_input(
                    scene_name=scene_name,
                    input_name=shared_source,
                    input_kind=BROWSER_INPUT_KIND,
                    settings=_browser_settings(manual_item),
                )
                settings_cache[shared_source] = {
                    "url": browser_url,
                    "width": rect.w,
                    "height": rect.h,
                }
            else:
                item_id = client.create_scene_item(
                    scene_name=scene_name,
                    source_name=shared_source,
                )
            cover = {
                "source_name": shared_source,
                "item_id": item_id,
                # Force an explicit index write below instead of assuming
                # which layer a particular OBS version uses for new items.
                "index": -1,
                "input_kind": BROWSER_INPUT_KIND,
                "enabled": True,
                "transform": {},
            }
            top_index += 1
            changed.append(scene_name)

        if not bool(cover.get("enabled", True)):
            client.set_scene_item_enabled(
                scene_name=scene_name,
                item_id=int(cover["item_id"]),
                enabled=True,
            )
            if scene_name not in changed:
                changed.append(scene_name)

        transform = _manual_override_transform_for(rect)
        if not _transform_fills_rect(cover.get("transform"), rect):
            client.set_scene_item_transform(
                scene_name=scene_name,
                item_id=int(cover["item_id"]),
                transform=transform,
            )
            if scene_name not in changed:
                changed.append(scene_name)
        if int(cover.get("index", -1)) != top_index:
            client.set_scene_item_index(
                scene_name=scene_name,
                item_id=int(cover["item_id"]),
                index=top_index,
            )
            if scene_name not in changed:
                changed.append(scene_name)

    # Read the authoritative final order back from OBS. Merely asserting the
    # indices we requested would repeat the test gap that let the legacy
    # layout ship without a usable top cover.
    for scene_name in targets:
        items = client.get_scene_item_list(scene_name)
        covers = _manual_cover_items(
            client,
            items,
            settings_cache=settings_cache,
            expected_url_key=expected_url_key,
        )
        top_index = max((int(item.get("index", 0)) for item in items), default=-1)
        if not covers:
            raise SceneBuildError(
                f"OBS did not add the manual scene override to {scene_name!r}.",
            )
        cover = max(covers, key=lambda item: int(item.get("index", 0)))
        if (
            not bool(cover.get("enabled", True))
            or int(cover.get("index", -1)) != top_index
            or not _transform_fills_rect(cover.get("transform"), rect)
        ):
            raise SceneBuildError(
                f"OBS did not place the manual scene override on top of {scene_name!r}.",
            )

    if changed:
        METRICS.incr("obs.repair.manual_override.ok")
    return changed


def _existing_manual_override_targets(
    client: Any, scene_names: Sequence[str],
) -> List[str]:
    allowed = set(MANUAL_OVERRIDE_SCENES)
    requested = list(dict.fromkeys(str(name) for name in scene_names))
    foreign = [name for name in requested if name not in allowed]
    if foreign:
        raise SceneBuildError(
            "Refusing to modify non-generated OBS scenes: " + ", ".join(foreign),
        )
    existing = set(client.refresh_scenes())
    return [name for name in requested if name in existing]


def _manual_override_rect_for_canvas(client: Any) -> Rect:
    video = client.get_video_settings()
    canvas_w = int(video.get("base_width") or REF_WIDTH) or REF_WIDTH
    canvas_h = int(video.get("base_height") or REF_HEIGHT) or REF_HEIGHT
    return MANUAL_OVERRIDE_RECT.scaled(
        canvas_w / REF_WIDTH,
        canvas_h / REF_HEIGHT,
    )


def _manual_cover_items(
    client: Any,
    items: Sequence[Dict[str, Any]],
    *,
    settings_cache: Dict[str, Dict[str, Any]],
    expected_url_key: Optional[tuple] = None,
) -> List[Dict[str, Any]]:
    covers: List[Dict[str, Any]] = []
    for item in items:
        if item.get("input_kind") != BROWSER_INPUT_KIND:
            continue
        source_name = str(item.get("source_name") or "")
        if not source_name:
            continue
        settings = settings_cache.get(source_name)
        if settings is None:
            settings = client.get_input_settings(source_name)
            settings_cache[source_name] = settings
        url = str(settings.get("url") or "")
        matches = (
            _overlay_url_key(url) == expected_url_key
            if expected_url_key is not None
            else _is_manual_override_url(url)
        )
        if matches:
            covers.append(item)
    return covers


def _find_manual_cover_input(
    client: Any,
    *,
    expected_url_key: tuple,
    settings_cache: Dict[str, Dict[str, Any]],
) -> Optional[str]:
    for row in client.get_input_list(BROWSER_INPUT_KIND):
        source_name = str(row.get("name") or "")
        if not source_name:
            continue
        settings = settings_cache.get(source_name)
        if settings is None:
            settings = client.get_input_settings(source_name)
            settings_cache[source_name] = settings
        if _overlay_url_key(str(settings.get("url") or "")) == expected_url_key:
            return source_name
    return None


def _overlay_url_key(value: str) -> tuple:
    try:
        parsed = urlsplit(value)
    except (TypeError, ValueError):
        return ("", "", "")
    return (
        parsed.scheme.lower(),
        parsed.netloc.lower(),
        parsed.path.rstrip("/"),
    )


def _generated_browser_route_for_input_name(
    source_name: str,
) -> Optional[tuple[str, str]]:
    for base_name, route in _GENERATED_BROWSER_ROUTES.items():
        if source_name == base_name:
            return route
        prefix = base_name + " "
        if (
            source_name.startswith(prefix)
            and source_name[len(prefix):].isdigit()
        ):
            return route
    return None


def _manual_override_url_from_overlay_url(
    value: str,
    *,
    expected_route: tuple[str, str],
) -> Optional[str]:
    """Convert one authenticated overlay scene/widget URL to the cover URL."""
    try:
        parsed = urlsplit(value)
    except (TypeError, ValueError):
        return None
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        return None

    # Expected route: [/optional-prefix]/overlay/<token>/(scene|widget)/<name>.
    # Keep the token opaque and never log or return it separately.
    parts = parsed.path.rstrip("/").split("/")
    for index in range(len(parts) - 3, -1, -1):
        if (
            parts[index] == "overlay"
            and parts[index + 1]
            and (parts[index + 2], parts[index + 3]) == expected_route
            and index + 3 == len(parts) - 1
        ):
            path = "/".join(parts[: index + 2] + ["scene", "manual"])
            return parsed._replace(path=path, query="", fragment="").geturl()
    return None


def _is_manual_override_url(value: str) -> bool:
    return _overlay_url_key(value)[2].endswith(
        "/" + MANUAL_OVERRIDE_BROWSER_PATH,
    )


def _assert_manual_override_url(value: str) -> None:
    key = _overlay_url_key(value)
    if not key[0] or not key[1] or not _is_manual_override_url(value):
        raise SceneBuildError("Manual override URL is not a valid overlay scene URL.")


def _transform_fills_rect(raw: Any, rect: Rect) -> bool:
    if not isinstance(raw, dict):
        return False

    def _same_number(key: str, expected: int) -> bool:
        try:
            return abs(float(raw.get(key)) - float(expected)) < 0.5
        except (TypeError, ValueError):
            return False

    def _same_int(key: str, expected: int) -> bool:
        try:
            return int(raw.get(key, -1)) == expected
        except (TypeError, ValueError):
            return False

    return (
        _same_number("positionX", rect.x)
        and _same_number("positionY", rect.y)
        and _same_number("rotation", 0)
        and _same_number("scaleX", 1)
        and _same_number("scaleY", 1)
        and _same_int("alignment", _ALIGN_TOP_LEFT)
        and raw.get("boundsType") == _MANUAL_OVERRIDE_BOUNDS_TYPE
        and _same_int("boundsAlignment", _ALIGN_CENTER)
        and _same_number("boundsWidth", rect.w)
        and _same_number("boundsHeight", rect.h)
        and _same_number("cropLeft", 0)
        and _same_number("cropRight", 0)
        and _same_number("cropTop", 0)
        and _same_number("cropBottom", 0)
    )


def _assert_ours(name: str) -> None:
    """Refuse to remove anything we did not name.

    The only path that reaches ``remove_scene`` is a rebuild of a
    scene the planner found already present, and the planner only ever
    plans our own names — but this is destructive against a live
    stream setup, so it gets a second lock.
    """
    if not name.startswith(SCENE_NAME_PREFIX):
        raise SceneBuildError(
            f"Refusing to remove {name!r}: the builder only ever "
            f"replaces scenes it created (prefix {SCENE_NAME_PREFIX!r}).",
        )


def _create_item(
    client: Any,
    scene_name: str,
    item: PlannedItem,
    *,
    shared_browser_inputs: Dict[str, str],
) -> Optional[int]:
    if item.source_name:
        # Reference the user's existing input. Not a copy — OBS shares
        # the capture between scenes at no extra cost.
        return client.create_scene_item(
            scene_name=scene_name, source_name=item.source_name,
        )
    if item.browser_path and item.input_name:
        existing_name = (
            shared_browser_inputs.get(item.share_key)
            if item.share_key
            else None
        )
        if existing_name:
            return client.create_scene_item(
                scene_name=scene_name,
                source_name=existing_name,
            )
        actual_name = _unique_input_name(client, item.input_name)
        item_id = client.create_input(
            scene_name=scene_name,
            input_name=actual_name,
            input_kind=BROWSER_INPUT_KIND,
            settings=_browser_settings(item),
        )
        if item.share_key:
            shared_browser_inputs[item.share_key] = actual_name
        return item_id
    return None


def _unique_input_name(client: Any, base: str) -> str:
    """Avoid colliding with an input the user already owns.

    OBS rejects a duplicate input name outright, which would abort the
    build partway through and leave a half-populated scene on their
    machine.
    """
    try:
        existing = {row.get("name") for row in client.get_input_list()}
    except Exception:  # noqa: BLE001 — discovery is best-effort
        return base
    if base not in existing:
        return base
    for n in range(2, 100):
        candidate = f"{base} {n}"
        if candidate not in existing:
            return candidate
    return base


def _browser_settings(item: PlannedItem) -> Dict[str, Any]:
    """Browser source settings for one overlay panel.

    ``width``/``height`` match the on-canvas box exactly so text
    rasterises at native size instead of being scaled up and going
    soft — the chat column in particular has to stay readable at
    streaming bitrate.

    ``shutdown`` and ``restart_when_active`` are both off on purpose:
    a browser source that reloads when its scene activates flashes on
    air every single time the switcher fires, which is many times a
    session.
    """
    return {
        "url": item.browser_path,
        "width": max(1, item.rect.w),
        "height": max(1, item.rect.h),
        "shutdown": False,
        "restart_when_active": False,
        "reroute_audio": False,
    }


def _transform_for(rect: Rect) -> Dict[str, Any]:
    return {
        "positionX": rect.x,
        "positionY": rect.y,
        # Anchor the item by its top-left so positionX/Y are the box's
        # corner, matching how the layout table above is written.
        "alignment": _ALIGN_TOP_LEFT,
        # SCALE_INNER fits the source inside the box preserving aspect,
        # so a 4:3 webcam letterboxes rather than stretching.
        "boundsType": "OBS_BOUNDS_SCALE_INNER",
        "boundsAlignment": _ALIGN_CENTER,
        "boundsWidth": max(1, rect.w),
        "boundsHeight": max(1, rect.h),
    }


def _manual_override_transform_for(rect: Rect) -> Dict[str, Any]:
    """Return a reset, full-canvas transform for the manual cover.

    Unlike camera/game items, this source must cover every pixel even if an
    older Browser Source was authored at a different aspect ratio. Stretching
    is intentional here, and explicitly resetting rotation, scale and crop
    prevents stale OBS transform fields from exposing sources underneath.
    """
    return {
        "positionX": rect.x,
        "positionY": rect.y,
        "rotation": 0.0,
        "scaleX": 1.0,
        "scaleY": 1.0,
        "alignment": _ALIGN_TOP_LEFT,
        "boundsType": _MANUAL_OVERRIDE_BOUNDS_TYPE,
        "boundsAlignment": _ALIGN_CENTER,
        "boundsWidth": max(1, rect.w),
        "boundsHeight": max(1, rect.h),
        "cropLeft": 0,
        "cropRight": 0,
        "cropTop": 0,
        "cropBottom": 0,
    }


__all__ = [
    "BROWSER_INPUT_KIND",
    "BETWEEN_GAMES_LAYOUT",
    "BuildPlan",
    "IN_GAME_LAYOUT",
    "MANUAL_OVERRIDE_BROWSER_PATH",
    "MANUAL_OVERRIDE_INPUT_NAME",
    "MANUAL_OVERRIDE_RECT",
    "MANUAL_OVERRIDE_SCENES",
    "PlannedItem",
    "PlannedScene",
    "Rect",
    "SCENE_NAME_PREFIX",
    "SceneBuildError",
    "build_scenes",
    "discover_manual_override_url",
    "discover_sources",
    "manual_override_scenes_needing_update",
    "plan_scenes",
    "repair_manual_scene_overrides",
]

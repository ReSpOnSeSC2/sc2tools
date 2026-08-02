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
* their existing scene is never touched, so switching is read-only
  with respect to scene *contents*;
* if the agent dies mid-stream OBS is simply parked on a valid scene,
  rather than stranded halfway through a move.

Safety contract
---------------

This module runs **only** when the user clicks "Build my scenes". It
creates new scenes named with the ``SC2 Tools — `` prefix and never
edits, renames or deletes anything else. Rebuilding an existing
SC2 Tools scene requires an explicit flag, and even then it will only
remove a scene whose name it owns.

Geometry
--------

Positions below are authored against a 1920×1080 reference and scaled
by whatever ``GetVideoSettings`` reports, so a 1440p or ultrawide
canvas lands correctly. Sizing uses ``OBS_BOUNDS_SCALE_INNER`` rather
than a raw scale factor: bounds produce the right result regardless of
the source's native resolution, so a 720p and a 1080p webcam both fill
their box without the caller having to know which one is plugged in.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

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

        for item in sorted(scene.items, key=lambda i: i.z):
            item_id = _create_item(client, scene.name, item)
            if item_id is None:
                continue
            client.set_scene_item_transform(
                scene_name=scene.name,
                item_id=item_id,
                transform=_transform_for(item.rect),
            )
            client.set_scene_item_index(
                scene_name=scene.name, item_id=item_id, index=item.z,
            )
            _log.info(
                "obs_scene_item_placed scene=%r item=%r x=%d y=%d w=%d h=%d z=%d",
                scene.name,
                item.label,
                item.rect.x,
                item.rect.y,
                item.rect.w,
                item.rect.h,
                item.z,
            )

    client.refresh_scenes()
    METRICS.incr("obs.build.ok")
    return created


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


def _create_item(client: Any, scene_name: str, item: PlannedItem) -> Optional[int]:
    if item.source_name:
        # Reference the user's existing input. Not a copy — OBS shares
        # the capture between scenes at no extra cost.
        return client.create_scene_item(
            scene_name=scene_name, source_name=item.source_name,
        )
    if item.browser_path and item.input_name:
        return client.create_input(
            scene_name=scene_name,
            input_name=_unique_input_name(client, item.input_name),
            input_kind=BROWSER_INPUT_KIND,
            settings=_browser_settings(item),
        )
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


__all__ = [
    "BROWSER_INPUT_KIND",
    "BETWEEN_GAMES_LAYOUT",
    "BuildPlan",
    "IN_GAME_LAYOUT",
    "PlannedItem",
    "PlannedScene",
    "Rect",
    "SCENE_NAME_PREFIX",
    "SceneBuildError",
    "build_scenes",
    "discover_sources",
    "plan_scenes",
]

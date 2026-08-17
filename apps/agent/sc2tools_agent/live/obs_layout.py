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
override cover and shared chat-alert toaster when it connects to OBS.
That repair is deliberately narrow: it can add, enable, resize, or raise
those two authenticated overlay routes inside the two exact generated
scenes, but it never creates a scene or removes another item. Replacing
an existing SC2 Tools scene requires an explicit flag, and even then it
will only remove a scene whose name it owns. A separate portrait repair
may reference Live's existing alert input in the exact ``Vertical Scene``
only when matching SC2 Tools routes, token, and portrait dimensions prove
the current legacy layout; it never creates another Browser Source.

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
from urllib.parse import parse_qsl, urlencode, urlsplit

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

#: Gameplay layout. Game fills the canvas, camera tucks bottom-right. The
#: full-height merged-chat column deliberately stays in Between Games (and in
#: the always-available Stream Dock); gameplay gets the compact alerts toaster
#: so follows/subs/gifts are acknowledged without covering the battlefield.
IN_GAME_LAYOUT: Dict[str, Rect] = {
    "game": Rect(0, 0, REF_WIDTH, REF_HEIGHT),
    "webcam": Rect(1568, 861, 304, 171),
}

# Wide transparent toaster shared by the two generated landscape scenes. Its
# Browser Source keeps this native viewport instead of borrowing Live's 800x600
# alert renderer; the explicit ``?audio=0`` role makes the visual copy silent.
CHAT_ALERTS_RECT = Rect(64, _MARGIN, 1792, 360)
CHAT_ALERTS_BROWSER_PATH = "widget/chat-alerts"
CHAT_ALERTS_INPUT_NAME = "SC2 Tools Chat Alerts"
_CHAT_ALERTS_SHARE_KEY = "chat_alerts"
_AUDIO_WIDGET_ROUTES = {
    "chat_alerts": ("widget", "chat-alerts"),
    "multichat": ("widget", "multichat"),
}
# Kept only for the private interrupted-migration reader below. New builds and
# startup repair use independent inputs plus explicit audio roles.
_GLOBAL_AUDIO_BROWSER_ROUTES = {
    _CHAT_ALERTS_SHARE_KEY: _AUDIO_WIDGET_ROUTES["chat_alerts"],
    "multichat_audio": _AUDIO_WIDGET_ROUTES["multichat"],
}

# The user's Aitum portrait scene predates the scene builder. It is not part of
# the broad generated-scene allowlist; the dedicated repair below may reference
# an existing alerts input there only after a much stricter route/token
# fingerprint proves that both scenes belong to this SC2 Tools overlay.
LIVE_SCENE_NAME = "Live Scene"
VERTICAL_SCENE_NAME = "Vertical Scene"
VERTICAL_ALERTS_MARGIN_RATIO = 1 / 18
VERTICAL_ALERTS_WIDTH_RATIO = 8 / 9

# Transparent during normal Live operation; becomes an opaque Starting
# Soon / BRB canvas when the streamer explicitly selects one in the Stream
# Dock. The builder places this above normal scene content; the transparent
# alerts toaster is the sole intentional layer above it so supporters remain
# visible during Starting Soon and BRB.
MANUAL_OVERRIDE_RECT = Rect(0, 0, REF_WIDTH, REF_HEIGHT)
MANUAL_OVERRIDE_BROWSER_PATH = "scene/manual"
MANUAL_OVERRIDE_INPUT_NAME = "SC2 Tools Manual Override"
_MANUAL_OVERRIDE_BOUNDS_TYPE = "OBS_BOUNDS_STRETCH"
_BROLL_AUDIO_PARAM = "audio"
MANUAL_OVERRIDE_SCENES: Sequence[str] = (
    SCENE_BETWEEN_GAMES,
    SCENE_IN_GAME,
)
_GENERATED_BROWSER_ROUTES = {
    "SC2 Tools Backdrop": ("scene", "between-games"),
    "SC2 Tools Session Stats": ("widget", "session"),
    "SC2 Tools Chat": ("widget", "multichat"),
    CHAT_ALERTS_INPUT_NAME: ("widget", "chat-alerts"),
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
            label="Chat alerts",
            rect=CHAT_ALERTS_RECT.scaled(sx, sy),
            z=7,
            browser_path=CHAT_ALERTS_BROWSER_PATH,
            input_name=CHAT_ALERTS_INPUT_NAME,
            share_key=_CHAT_ALERTS_SHARE_KEY,
        ),
    )
    between.items.append(
        PlannedItem(
            label="Manual scene override",
            rect=MANUAL_OVERRIDE_RECT.scaled(sx, sy),
            z=6,
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
                label="Chat alerts",
                rect=CHAT_ALERTS_RECT.scaled(sx, sy),
                z=4,
                browser_path=CHAT_ALERTS_BROWSER_PATH,
                input_name=CHAT_ALERTS_INPUT_NAME,
                share_key=_CHAT_ALERTS_SHARE_KEY,
            ),
        )
        in_game.items.append(
            PlannedItem(
                label="Manual scene override",
                rect=MANUAL_OVERRIDE_RECT.scaled(sx, sy),
                z=3,
                browser_path=MANUAL_OVERRIDE_BROWSER_PATH,
                input_name=MANUAL_OVERRIDE_INPUT_NAME,
                share_key="manual_scene_override",
            ),
        )
        scenes.append(in_game)

    external_audio_owners = {
        route_path: _has_external_audio_widget_owner(
            client,
            expected_url=_overlay_url(
                overlay_base_url,
                overlay_token,
                route_path,
            ),
            route=route,
        )
        for route_path, route in (
            ("widget/multichat", _AUDIO_WIDGET_ROUTES["multichat"]),
            (CHAT_ALERTS_BROWSER_PATH, _AUDIO_WIDGET_ROUTES["chat_alerts"]),
        )
    }
    raw_manual_url = _overlay_url(
        overlay_base_url,
        overlay_token,
        MANUAL_OVERRIDE_BROWSER_PATH,
    )
    initial_manual_owns_audio = not (
        _has_existing_landscape_broll_candidate(
            client,
            expected_url=raw_manual_url,
        )
    )

    # Resolve browser URLs now so the plan the user confirms is
    # literally what gets sent.
    for scene in scenes:
        for i, item in enumerate(scene.items):
            if item.browser_path:
                browser_url = _overlay_url(
                    overlay_base_url, overlay_token, item.browser_path,
                )
                if item.share_key == "manual_scene_override":
                    # A fresh layout starts audible. When any landscape player
                    # already carries this token, create the future manual
                    # owner muted; the post-build follower-first repair demotes
                    # the old player before safely promoting this one.
                    browser_url = _url_with_broll_audio_role(
                        browser_url,
                        owns_audio=initial_manual_owns_audio,
                    )
                elif item.browser_path in {
                    "widget/multichat",
                    CHAT_ALERTS_BROWSER_PATH,
                }:
                    # Generated layouts keep native, geometry-specific browser
                    # viewports. Live/Vertical's canonical inputs own sound;
                    # these landscape renderers are visual followers only.
                    browser_url = _url_with_widget_audio_role(
                        browser_url,
                        owns_audio=not external_audio_owners[item.browser_path],
                    )
                scene.items[i] = PlannedItem(
                    label=item.label,
                    rect=item.rect,
                    z=item.z,
                    browser_path=browser_url,
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


def _strict_browser_url_key(value: str) -> tuple[str, str, str, str, str]:
    """Identity used only when sharing an existing audio-capable browser.

    The broader overlay helpers intentionally ignore query strings while
    discovering routes. Reusing an audio renderer needs a stricter contract:
    a source with ``?audio=0`` (or any other behavior-changing query) is not
    interchangeable with the plan's exact URL.
    """
    try:
        parsed = urlsplit(value)
    except (TypeError, ValueError):
        return ("", "", "", "", "")
    return (
        parsed.scheme.lower(),
        parsed.netloc.lower(),
        parsed.path.rstrip("/"),
        parsed.query,
        parsed.fragment,
    )


def _browser_url_key_without_audio(
    value: str,
) -> tuple[str, str, str, str, str]:
    """Strict browser identity with only the explicit audio role removed.

    This is intentionally narrower than ``_overlay_url_key``: origin, route,
    token, every unrelated query parameter, and the fragment must still match.
    It exists solely so an authorized partial build can reference a legacy
    native alert input whose only difference is bare/``audio=1`` versus the
    planned follower role ``audio=0``. Post-build role repair then writes the
    authoritative role in place.
    """
    try:
        parsed = urlsplit(value)
    except (TypeError, ValueError):
        return ("", "", "", "", "")
    query = urlencode(
        [
            (key, item)
            for key, item in parse_qsl(
                parsed.query, keep_blank_values=True,
            )
            if key.casefold() != _BROLL_AUDIO_PARAM
        ],
        doseq=True,
    )
    return (
        parsed.scheme.lower(),
        parsed.netloc.lower(),
        parsed.path.rstrip("/"),
        query,
        parsed.fragment,
    )


def _has_external_audio_widget_owner(
    client: Any,
    *,
    expected_url: str,
    route: tuple[str, str],
) -> bool:
    """Whether a same-token route is referenced outside generated scenes.

    Inventory/read failures choose silence for the new copy. That conservative
    fallback cannot create duplicate sound; a later startup repair can promote
    the correct owner once OBS provides an authoritative inventory.
    """
    expected_manual = _manual_override_url_from_overlay_url(
        expected_url,
        expected_route=route,
    )
    if expected_manual is None:
        return True
    expected_identity = _overlay_url_key(expected_manual)
    try:
        candidates: set[str] = set()
        for row in client.get_input_list(BROWSER_INPUT_KIND):
            if str(row.get("kind") or "") != BROWSER_INPUT_KIND:
                continue
            source_name = str(row.get("name") or "")
            if not source_name:
                continue
            settings = client.get_input_settings(source_name)
            manual_url = _manual_override_url_from_overlay_url(
                str(settings.get("url") or ""),
                expected_route=route,
            )
            if (
                manual_url is not None
                and _overlay_url_key(manual_url) == expected_identity
            ):
                candidates.add(source_name)
        if not candidates:
            return False
        generated = set(MANUAL_OVERRIDE_SCENES)
        for scene_name in client.refresh_scenes():
            if scene_name in generated:
                continue
            if any(
                str(item.get("source_name") or "") in candidates
                for item in client.get_scene_item_list(scene_name)
            ):
                return True
        return False
    except Exception:  # noqa: BLE001 - conservative no-duplicate fallback
        return True


def _has_existing_landscape_broll_candidate(
    client: Any,
    *,
    expected_url: str,
) -> bool:
    """Whether any same-token landscape B-roll player already exists.

    The future manual owner must start silent while any such player exists;
    otherwise creating the Browser Source itself opens a duplicate-audio
    window before :func:`repair_broll_audio_roles` can demote followers. That
    includes sources with Control Audio via OBS or shutdown-when-hidden set:
    either can still be audible while its scene is active even though it is not
    eligible to become the final hidden global owner. Unknown inventory state
    also chooses a silent new source, which is the only fail-safe choice when
    duplicate sound cannot be ruled out.
    """
    expected_identity = _overlay_url_key(expected_url)
    try:
        for row in client.get_input_list(BROWSER_INPUT_KIND):
            if str(row.get("kind") or "") != BROWSER_INPUT_KIND:
                continue
            source_name = str(row.get("name") or "")
            if not source_name:
                continue
            settings = client.get_input_settings(source_name)
            if _is_portrait_browser_settings(settings):
                continue
            source_url = str(settings.get("url") or "")
            for route in (
                ("scene", "manual"),
                ("widget", "stream-scene"),
            ):
                canonical = _manual_override_url_from_overlay_url(
                    source_url,
                    expected_route=route,
                )
                if (
                    canonical is not None
                    and _overlay_url_key(canonical) == expected_identity
                ):
                    return True
        return False
    except Exception:  # noqa: BLE001 - conservative no-duplicate fallback
        return True


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
    # A partial build (for example, creating a missing In Game counterpart)
    # must reconnect to the already-generated shared inputs. Otherwise the
    # second invocation creates another alert/B-roll renderer with an
    # independent timeline and, before role repair, potentially another audio
    # owner. Exact URL *and* native viewport are required so an 800x600 Live
    # alert source can never be reused in the 1792x360 generated toast region.
    # Full rebuilds start from a clean map because their old scene references
    # are about to be removed.
    shared_browser_inputs: Dict[str, str] = (
        {}
        if rebuild
        else _discover_existing_shared_browser_inputs(client, plan)
    )
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


def _discover_existing_shared_browser_inputs(
    client: Any,
    plan: BuildPlan,
) -> Dict[str, str]:
    """Find unique, geometry-compatible inputs for explicit share keys.

    Names are deliberately ignored. Reuse is authorized only by the exact
    authenticated URL, browser viewport, and an unambiguous global inventory.
    Generated alerts and the shared manual cover permit one legacy exception:
    ``audio`` is ignored during discovery because role repair immediately
    normalizes the reused native source after this authorized build. Every
    other query value remains strict. If interrupted work left both an orphan
    and one referenced source, the referenced source is authoritative; two
    live candidates fail closed and are left untouched.
    """
    grouped: Dict[str, List[PlannedItem]] = {}
    for scene in plan.scenes:
        for item in scene.items:
            if item.share_key and item.browser_path and item.input_name:
                grouped.setdefault(item.share_key, []).append(item)
    if not grouped:
        return {}

    wanted: Dict[
        str,
        tuple[tuple[str, str, str, str, str], int, int],
    ] = {}
    for share_key, items in grouped.items():
        identity_key = (
            _browser_url_key_without_audio
            if share_key in {
                _CHAT_ALERTS_SHARE_KEY,
                "manual_scene_override",
            }
            else _strict_browser_url_key
        )
        identities = {
            (
                identity_key(str(item.browser_path or "")),
                max(1, item.rect.w),
                max(1, item.rect.h),
            )
            for item in items
        }
        if len(identities) != 1:
            raise SceneBuildError(
                f"Internal scene plan reused {share_key!r} across "
                "incompatible Browser Source settings.",
            )
        wanted[share_key] = next(iter(identities))

    try:
        candidates: Dict[str, List[str]] = {
            share_key: [] for share_key in wanted
        }
        for row in client.get_input_list(BROWSER_INPUT_KIND):
            if str(row.get("kind") or "") != BROWSER_INPUT_KIND:
                continue
            source_name = str(row.get("name") or "")
            if not source_name:
                continue
            settings = client.get_input_settings(source_name)
            try:
                native_width = int(settings.get("width") or 800)
                native_height = int(settings.get("height") or 600)
            except (TypeError, ValueError):
                continue
            for share_key, expected in wanted.items():
                identity_key = (
                    _browser_url_key_without_audio
                    if share_key in {
                        _CHAT_ALERTS_SHARE_KEY,
                        "manual_scene_override",
                    }
                    else _strict_browser_url_key
                )
                identity = identity_key(str(settings.get("url") or ""))
                if (identity, native_width, native_height) == expected:
                    candidates[share_key].append(source_name)

        referenced: set[str] = set()
        all_candidates = {
            name for names in candidates.values() for name in names
        }
        if all_candidates:
            for scene_name in client.refresh_scenes():
                for item in client.get_scene_item_list(scene_name):
                    source_name = str(item.get("source_name") or "")
                    if source_name in all_candidates:
                        referenced.add(source_name)
    except Exception as exc:  # noqa: BLE001 - fail closed on OBS inventory
        raise SceneBuildError(
            "Could not safely inventory existing shared Browser Sources; "
            "OBS was left unchanged.",
        ) from exc

    resolved: Dict[str, str] = {}
    for share_key, names in candidates.items():
        live_names = [name for name in names if name in referenced]
        authoritative = live_names or names
        if len(authoritative) > 1:
            raise SceneBuildError(
                f"Found multiple exact Browser Sources for shared input "
                f"{share_key!r}; existing sources were left unchanged.",
            )
        if authoritative:
            resolved[share_key] = authoritative[0]
    return resolved


def manual_override_scenes_needing_update(
    client: Any,
    *,
    scene_names: Sequence[str] = MANUAL_OVERRIDE_SCENES,
) -> List[str]:
    """Inspect generated scenes without changing OBS.

    A scene needs an update when it has no ``/scene/manual`` cover or compact
    ``/widget/chat-alerts`` toaster, when either item is disabled or malformed,
    or when alerts are not immediately above the cover at the top of the OBS
    stack. URLs, rather than display names, are authoritative so unrelated
    user sources with colliding names are never mistaken for ours.
    """
    targets = _existing_manual_override_targets(client, scene_names)
    if not targets:
        return []
    rect = _manual_override_rect_for_canvas(client)
    alert_rect = _chat_alerts_rect_for_canvas(client)
    settings_cache: Dict[str, Dict[str, Any]] = {}
    needs_update: List[str] = []
    for scene_name in targets:
        items = client.get_scene_item_list(scene_name)
        covers = _manual_cover_items(
            client,
            items,
            settings_cache=settings_cache,
        )
        alerts = _browser_items_matching(
            client,
            items,
            settings_cache=settings_cache,
            route=CHAT_ALERTS_BROWSER_PATH,
        )
        top_index = max((int(item.get("index", 0)) for item in items), default=-1)
        cover = max(covers, key=lambda item: int(item.get("index", 0))) if covers else None
        alert = max(alerts, key=lambda item: int(item.get("index", 0))) if alerts else None
        if (
            cover is None
            or alert is None
            or not bool(cover.get("enabled", True))
            or not bool(alert.get("enabled", True))
            or int(cover.get("index", -1)) != top_index - 1
            or int(alert.get("index", -1)) != top_index
            or not _transform_fills_rect(cover.get("transform"), rect)
            or not _transform_matches_rect(alert.get("transform"), alert_rect)
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
    """Non-destructively upgrade the generated scenes' top overlay layers.

    This is the upgrade path for layouts created before ``/scene/manual`` and
    ``/widget/chat-alerts`` existed. It never creates or removes a scene and
    never removes or directly reorders an unrelated item. One shared Browser
    Source per route is created (or reused) and referenced from each existing
    generated scene. The manual cover occupies the penultimate layer and the
    compact alerts toaster the top layer, keeping acknowledgements visible
    during Starting Soon and BRB without duplicating their audio renderer.

    The operation is idempotent and verifies the final OBS stack before it
    reports success, so an interrupted first attempt can be safely retried.
    """
    _assert_manual_override_url(browser_url)
    targets = _existing_manual_override_targets(client, scene_names)
    if not targets:
        return []

    rect = _manual_override_rect_for_canvas(client)
    alert_rect = _chat_alerts_rect_for_canvas(client)
    expected_url_key = _overlay_url_key(browser_url)
    raw_alert_url = _chat_alerts_url_from_manual_url(browser_url)
    owns_alert_audio = not _has_external_audio_widget_owner(
        client,
        expected_url=raw_alert_url,
        route=_AUDIO_WIDGET_ROUTES["chat_alerts"],
    )
    alert_url = _url_with_widget_audio_role(
        raw_alert_url,
        owns_audio=owns_alert_audio,
    )
    manual_create_url = browser_url
    if _has_existing_landscape_broll_candidate(
        client,
        expected_url=browser_url,
    ):
        manual_create_url = _url_with_broll_audio_role(
            browser_url,
            owns_audio=False,
        )
    expected_alert_url_key = _overlay_url_key(raw_alert_url)
    settings_cache: Dict[str, Dict[str, Any]] = {}
    inventories: Dict[str, List[Dict[str, Any]]] = {
        scene_name: client.get_scene_item_list(scene_name)
        for scene_name in targets
    }

    # Prefer a correct cover already present in either generated scene. If a
    # prior attempt stopped after creating the input but before adding both
    # scene items, the global input scan below finds and reuses it.
    shared_source: Optional[str] = None
    shared_alert_source: Optional[str] = None
    covers_by_scene: Dict[str, List[Dict[str, Any]]] = {}
    alerts_by_scene: Dict[str, List[Dict[str, Any]]] = {}

    def _native_alerts(
        items: Sequence[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        matches = _browser_items_matching(
            client,
            items,
            settings_cache=settings_cache,
            expected_url_key=expected_alert_url_key,
        )
        native: List[Dict[str, Any]] = []
        for item in matches:
            settings = settings_cache.get(
                str(item.get("source_name") or ""),
                {},
            )
            try:
                size = (
                    int(settings.get("width") or 0),
                    int(settings.get("height") or 0),
                )
            except (TypeError, ValueError):
                continue
            if size == (alert_rect.w, alert_rect.h):
                native.append(item)
        return native

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
        alerts = _native_alerts(items)
        if len(alerts) > 1:
            raise SceneBuildError(
                f"Multiple native chat-alert items exist in {scene_name!r}; "
                "existing sources were left unchanged.",
            )
        alerts_by_scene[scene_name] = alerts
        if alerts and shared_alert_source is None:
            shared_alert_source = str(alerts[0]["source_name"])

    referenced_alert_sources = {
        str(alert["source_name"])
        for alerts in alerts_by_scene.values()
        for alert in alerts
    }
    if len(referenced_alert_sources) > 1:
        raise SceneBuildError(
            "Generated scenes reference multiple native chat-alert Browser "
            "Sources; existing sources were left unchanged.",
        )

    if shared_source is None:
        shared_source = _find_manual_cover_input(
            client,
            expected_url_key=expected_url_key,
            settings_cache=settings_cache,
        )
    if shared_alert_source is None:
        matching_alert_inputs = _find_browser_inputs(
            client,
            settings_cache=settings_cache,
            expected_url_key=expected_alert_url_key,
            expected_size=(alert_rect.w, alert_rect.h),
        )
        if len(matching_alert_inputs) > 1:
            raise SceneBuildError(
                "Multiple native chat-alert Browser Sources match this "
                "overlay; existing sources were left unchanged.",
            )
        if matching_alert_inputs:
            shared_alert_source = matching_alert_inputs[0]

    alert_role_updated = False
    if shared_alert_source is not None:
        existing_alert_settings = settings_cache.get(shared_alert_source)
        if existing_alert_settings is None:
            existing_alert_settings = client.get_input_settings(
                shared_alert_source,
            )
        desired_existing_url = _url_with_widget_audio_role(
            str(existing_alert_settings.get("url") or ""),
            owns_audio=owns_alert_audio,
        )
        if desired_existing_url != existing_alert_settings.get("url"):
            client.set_input_settings(
                shared_alert_source,
                {"url": desired_existing_url},
            )
            settings_cache[shared_alert_source] = {
                **existing_alert_settings,
                "url": desired_existing_url,
            }
            alert_role_updated = True

    changed: List[str] = []
    manual_item = PlannedItem(
        label="Manual scene override",
        rect=rect,
        z=0,
        browser_path=manual_create_url,
        input_name=MANUAL_OVERRIDE_INPUT_NAME,
        share_key="manual_scene_override",
    )
    alert_item = PlannedItem(
        label="Chat alerts",
        rect=alert_rect,
        z=0,
        browser_path=alert_url,
        input_name=CHAT_ALERTS_INPUT_NAME,
        share_key=_CHAT_ALERTS_SHARE_KEY,
    )

    for scene_name in targets:
        items = inventories[scene_name]
        covers = covers_by_scene[scene_name]
        cover = max(covers, key=lambda item: int(item.get("index", 0))) if covers else None
        alerts = alerts_by_scene[scene_name]
        alert = max(alerts, key=lambda item: int(item.get("index", 0))) if alerts else None
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
                    "url": manual_create_url,
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

        if alert is None:
            if shared_alert_source is None:
                shared_alert_source = _unique_input_name(
                    client, CHAT_ALERTS_INPUT_NAME,
                )
                alert_id = client.create_input(
                    scene_name=scene_name,
                    input_name=shared_alert_source,
                    input_kind=BROWSER_INPUT_KIND,
                    settings=_browser_settings(alert_item),
                )
                settings_cache[shared_alert_source] = {
                    "url": alert_url,
                    "width": alert_rect.w,
                    "height": alert_rect.h,
                }
            else:
                alert_id = client.create_scene_item(
                    scene_name=scene_name,
                    source_name=shared_alert_source,
                )
            alert = {
                "source_name": shared_alert_source,
                "item_id": alert_id,
                "index": -1,
                "input_kind": BROWSER_INPUT_KIND,
                "enabled": True,
                "transform": {},
            }
            top_index += 1
            if scene_name not in changed:
                changed.append(scene_name)
        elif (
            alert_role_updated
            and str(alert.get("source_name") or "") == shared_alert_source
            and scene_name not in changed
        ):
            changed.append(scene_name)

        if not bool(cover.get("enabled", True)):
            client.set_scene_item_enabled(
                scene_name=scene_name,
                item_id=int(cover["item_id"]),
                enabled=True,
            )
            if scene_name not in changed:
                changed.append(scene_name)
        if not bool(alert.get("enabled", True)):
            client.set_scene_item_enabled(
                scene_name=scene_name,
                item_id=int(alert["item_id"]),
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

        alert_transform = _transform_for(alert_rect)
        if not _transform_matches_rect(alert.get("transform"), alert_rect):
            client.set_scene_item_transform(
                scene_name=scene_name,
                item_id=int(alert["item_id"]),
                transform=alert_transform,
            )
            if scene_name not in changed:
                changed.append(scene_name)

        # Move the cover to the top first, then alerts to the top. Moving the
        # latter downshifts the cover to exactly one layer below without ever
        # addressing or reordering a user's unrelated item directly.
        stack_correct = (
            int(cover.get("index", -1)) == top_index - 1
            and int(alert.get("index", -1)) == top_index
        )
        if not stack_correct:
            client.set_scene_item_index(
                scene_name=scene_name,
                item_id=int(cover["item_id"]),
                index=top_index,
            )
            if scene_name not in changed:
                changed.append(scene_name)
            client.set_scene_item_index(
                scene_name=scene_name,
                item_id=int(alert["item_id"]),
                index=top_index,
            )

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
        alerts = _native_alerts(items)
        top_index = max((int(item.get("index", 0)) for item in items), default=-1)
        if not covers:
            raise SceneBuildError(
                f"OBS did not add the manual scene override to {scene_name!r}.",
            )
        cover = max(covers, key=lambda item: int(item.get("index", 0)))
        if not alerts:
            raise SceneBuildError(
                f"OBS did not add chat alerts to {scene_name!r}.",
            )
        alert = max(alerts, key=lambda item: int(item.get("index", 0)))
        alert_source_name = str(alert.get("source_name") or "")
        # Do not validate against the optimistic cache populated above: an
        # OBS request can return without applying, especially while CEF is
        # reloading after a URL migration.
        alert_settings = client.get_input_settings(alert_source_name)
        settings_cache[alert_source_name] = alert_settings
        if (
            not bool(cover.get("enabled", True))
            or not bool(alert.get("enabled", True))
            or int(cover.get("index", -1)) != top_index - 1
            or int(alert.get("index", -1)) != top_index
            or not _transform_fills_rect(cover.get("transform"), rect)
            or not _transform_matches_rect(alert.get("transform"), alert_rect)
            or (
                _widget_audio_role(str(alert_settings.get("url") or ""))
                is not owns_alert_audio
            )
        ):
            raise SceneBuildError(
                f"OBS did not place chat alerts above the manual cover in {scene_name!r}.",
            )

    if changed:
        METRICS.incr("obs.repair.manual_override.ok")
    return changed


def repair_vertical_scene_chat_alerts(client: Any) -> bool:
    """Reference the existing horizontal alert renderer in Vertical Scene.

    This exception is intentionally narrower than the generated-scene repair:

    * both exact ``Live Scene`` and ``Vertical Scene`` names must exist;
    * Vertical must contain one authenticated SC2 Tools multichat and one
      portrait stream-scene source using the same origin, prefix, and token;
    * Live must already reference exactly one chat-alert source for that same
      overlay identity; it is re-enabled and raised without changing geometry;
      and
    * no Browser Source is created or copied -- Vertical receives a scene-item
      reference to Live's existing input, keeping a single browser/audio owner.

    Returns whether OBS was changed. Ambiguous or foreign layouts fail closed.
    """
    scenes = set(client.refresh_scenes())
    if LIVE_SCENE_NAME not in scenes or VERTICAL_SCENE_NAME not in scenes:
        return False

    settings_cache: Dict[str, Dict[str, Any]] = {}
    vertical_items = client.get_scene_item_list(VERTICAL_SCENE_NAME)
    chats = _browser_items_matching(
        client,
        vertical_items,
        settings_cache=settings_cache,
        route="widget/multichat",
    )
    stream_scenes = _browser_items_matching(
        client,
        vertical_items,
        settings_cache=settings_cache,
        route="widget/stream-scene",
    )
    if len(chats) != 1 or len(stream_scenes) != 1:
        return False

    chat_settings = settings_cache[str(chats[0]["source_name"])]
    stream_settings = settings_cache[str(stream_scenes[0]["source_name"])]
    chat_url = str(chat_settings.get("url") or "")
    stream_url = str(stream_settings.get("url") or "")
    if not _is_sc2tools_overlay_url(chat_url):
        return False
    manual_url = _manual_override_url_from_overlay_url(
        chat_url,
        expected_route=("widget", "multichat"),
    )
    stream_manual_url = _manual_override_url_from_overlay_url(
        stream_url,
        expected_route=("widget", "stream-scene"),
    )
    if (
        manual_url is None
        or stream_manual_url is None
        or _overlay_url_key(manual_url) != _overlay_url_key(stream_manual_url)
    ):
        return False

    try:
        portrait_width = int(stream_settings.get("width") or 0)
        portrait_height = int(stream_settings.get("height") or 0)
    except (TypeError, ValueError):
        return False
    if portrait_width <= 0 or portrait_height <= portrait_width:
        return False

    alert_url_key = _overlay_url_key(
        _chat_alerts_url_from_manual_url(manual_url),
    )
    live_items = client.get_scene_item_list(LIVE_SCENE_NAME)
    live_alerts = _browser_items_matching(
        client,
        live_items,
        settings_cache=settings_cache,
        expected_url_key=alert_url_key,
    )
    if len(live_alerts) != 1:
        return False
    alert_source = str(live_alerts[0].get("source_name") or "")
    if not alert_source:
        return False

    vertical_alerts = _browser_items_matching(
        client,
        vertical_items,
        settings_cache=settings_cache,
        expected_url_key=alert_url_key,
    )
    if len(vertical_alerts) > 1:
        return False
    if vertical_alerts and str(vertical_alerts[0].get("source_name") or "") != alert_source:
        return False

    changed = False
    live_alert = live_alerts[0]
    if not bool(live_alert.get("enabled", True)):
        client.set_scene_item_enabled(
            scene_name=LIVE_SCENE_NAME,
            item_id=int(live_alert["item_id"]),
            enabled=True,
        )
        changed = True
    live_top = max(
        (int(item.get("index", 0)) for item in live_items),
        default=-1,
    )
    if int(live_alert.get("index", -1)) != live_top:
        # Preserve its authored size/position exactly; only its visibility and
        # stack order are part of this repair.
        client.set_scene_item_index(
            scene_name=LIVE_SCENE_NAME,
            item_id=int(live_alert["item_id"]),
            index=live_top,
        )
        changed = True

    if vertical_alerts:
        alert = vertical_alerts[0]
    else:
        item_id = client.create_scene_item(
            scene_name=VERTICAL_SCENE_NAME,
            source_name=alert_source,
        )
        alert = {
            "source_name": alert_source,
            "item_id": item_id,
            "index": -1,
            "input_kind": BROWSER_INPUT_KIND,
            "enabled": True,
            "transform": {},
        }
        changed = True

    rect = _vertical_alert_rect(portrait_width, portrait_height)
    if not bool(alert.get("enabled", True)):
        client.set_scene_item_enabled(
            scene_name=VERTICAL_SCENE_NAME,
            item_id=int(alert["item_id"]),
            enabled=True,
        )
        changed = True
    if not _transform_matches_rect(alert.get("transform"), rect):
        client.set_scene_item_transform(
            scene_name=VERTICAL_SCENE_NAME,
            item_id=int(alert["item_id"]),
            transform=_transform_for(rect),
        )
        changed = True

    top_index = max(
        (int(item.get("index", 0)) for item in vertical_items),
        default=-1,
    ) + (1 if not vertical_alerts else 0)
    if int(alert.get("index", -1)) != top_index:
        client.set_scene_item_index(
            scene_name=VERTICAL_SCENE_NAME,
            item_id=int(alert["item_id"]),
            index=top_index,
        )
        changed = True

    final_live_items = client.get_scene_item_list(LIVE_SCENE_NAME)
    final_live_alerts = _browser_items_matching(
        client,
        final_live_items,
        settings_cache=settings_cache,
        expected_url_key=alert_url_key,
    )
    final_live_top = max(
        (int(item.get("index", 0)) for item in final_live_items),
        default=-1,
    )
    if len(final_live_alerts) != 1:
        raise SceneBuildError("OBS lost the shared alert item from Live Scene.")
    final_live_alert = final_live_alerts[0]
    if (
        str(final_live_alert.get("source_name") or "") != alert_source
        or not bool(final_live_alert.get("enabled", True))
        or int(final_live_alert.get("index", -1)) != final_live_top
    ):
        raise SceneBuildError("OBS did not place the shared alert item atop Live Scene.")

    final_items = client.get_scene_item_list(VERTICAL_SCENE_NAME)
    final_alerts = _browser_items_matching(
        client,
        final_items,
        settings_cache=settings_cache,
        expected_url_key=alert_url_key,
    )
    final_top = max(
        (int(item.get("index", 0)) for item in final_items),
        default=-1,
    )
    if len(final_alerts) != 1:
        raise SceneBuildError("OBS did not add one shared alert item to Vertical Scene.")
    final_alert = final_alerts[0]
    if (
        str(final_alert.get("source_name") or "") != alert_source
        or not bool(final_alert.get("enabled", True))
        or int(final_alert.get("index", -1)) != final_top
        or not _transform_matches_rect(final_alert.get("transform"), rect)
    ):
        raise SceneBuildError("OBS did not place the shared alert item atop Vertical Scene.")

    if changed:
        METRICS.incr("obs.repair.vertical_chat_alerts.ok")
    return changed


_SCENE_ITEM_TRANSFORM_FIELDS = frozenset({
    "positionX",
    "positionY",
    "rotation",
    "scaleX",
    "scaleY",
    "alignment",
    "boundsType",
    "boundsAlignment",
    "boundsWidth",
    "boundsHeight",
    "cropLeft",
    "cropRight",
    "cropTop",
    "cropBottom",
})


def _writable_scene_item_transform(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    return {
        key: value for key, value in raw.items()
        if key in _SCENE_ITEM_TRANSFORM_FIELDS
    }


def _repair_generated_audio_browser_references_legacy(
    client: Any,
    *,
    refresh_alert_if_reused: bool = False,
) -> tuple[List[str], List[str]]:
    """Replace generated chat/alert copies with Live/Aitum's exact inputs.

    MultiChatWidget owns message dings/TTS and ChatAlertsWidget owns event
    sounds. Two Browser Sources with the same authenticated route therefore
    produce duplicate audio even if their scene-item geometry differs. This
    startup repair keeps the generated scenes' authored item state while
    swapping only the source reference to the one exact same-token input used
    outside the fixed generated-scene allowlist.

    Every decision is completed before the first write. Multiple external
    candidates, mixed generated overlay identities, duplicate route items in
    one generated scene, query differences, and unreadable inventories fail
    closed. Existing input settings are never changed. A reused source is
    refreshed through OBS's ``refreshnocache`` property button once during the
    successful migration, ensuring a pre-deploy Chat/Alert browser loads the
    current code without persisting a cache-busting URL.

    Returns ``(changed_scene_names, refreshed_input_names)``. Calling it again
    after a successful repair is a no-op unless the caller explicitly reports
    that the preceding manual-cover repair newly reused Alert Box.
    """
    existing_scenes = list(client.refresh_scenes())
    generated_scope = set(MANUAL_OVERRIDE_SCENES)
    generated_scenes = [
        name for name in MANUAL_OVERRIDE_SCENES if name in existing_scenes
    ]
    if not generated_scenes:
        return [], []

    inventories: Dict[str, List[Dict[str, Any]]] = {
        scene_name: client.get_scene_item_list(scene_name)
        for scene_name in existing_scenes
    }
    references: Dict[str, set[str]] = {}
    for scene_name, items in inventories.items():
        for item in items:
            source_name = str(item.get("source_name") or "")
            if source_name:
                references.setdefault(source_name, set()).add(scene_name)

    source_meta: Dict[str, Dict[str, Any]] = {}
    for row in client.get_input_list(BROWSER_INPUT_KIND):
        if str(row.get("kind") or "") != BROWSER_INPUT_KIND:
            continue
        source_name = str(row.get("name") or "")
        if not source_name:
            continue
        settings = client.get_input_settings(source_name)
        url = str(settings.get("url") or "")
        for share_key, route in _GLOBAL_AUDIO_BROWSER_ROUTES.items():
            manual_url = _manual_override_url_from_overlay_url(
                url,
                expected_route=route,
            )
            if manual_url is None:
                continue
            source_meta[source_name] = {
                "share_key": share_key,
                "identity": _overlay_url_key(manual_url),
                "url_key": _strict_browser_url_key(url),
            }
            break

    generated_items: Dict[tuple[str, str], List[Dict[str, Any]]] = {}
    generated_identities: set[tuple] = set()
    for scene_name in generated_scenes:
        for item in inventories[scene_name]:
            source_name = str(item.get("source_name") or "")
            meta = source_meta.get(source_name)
            if meta is None:
                continue
            share_key = str(meta["share_key"])
            generated_items.setdefault((scene_name, share_key), []).append(
                item,
            )
            generated_identities.add(meta["identity"])

    if len(generated_identities) > 1:
        raise SceneBuildError(
            "Generated chat/alert Browser Sources use different overlay "
            "identities; they were left unchanged.",
        )
    def _outside_candidates(share_key: str, identity: tuple) -> List[str]:
        return list(dict.fromkeys(
            source_name
            for source_name, meta in source_meta.items()
            if meta["share_key"] == share_key
            and meta["identity"] == identity
            and references.get(source_name, set()) - generated_scope
        ))

    # A process interruption can leave the just-created canonical item beside
    # the still-intact old duplicate. That state is recoverable without
    # guessing only when the pair has one exact URL and exactly one member is
    # the unique external canonical source. Roll that new item back first,
    # then retry the normal old -> canonical replacement below.
    recovery_rollbacks: List[Dict[str, Any]] = []
    normalized_generated_items: Dict[
        tuple[str, str], List[Dict[str, Any]]
    ] = {}
    for (scene_name, share_key), items in generated_items.items():
        if len(items) == 1:
            normalized_generated_items[(scene_name, share_key)] = items
            continue
        metas = [
            source_meta[str(item.get("source_name") or "")]
            for item in items
        ]
        identities = {meta["identity"] for meta in metas}
        url_keys = {meta["url_key"] for meta in metas}
        canonical_candidates = (
            _outside_candidates(share_key, next(iter(identities)))
            if len(identities) == 1
            else []
        )
        canonical = (
            canonical_candidates[0]
            if len(canonical_candidates) == 1
            else None
        )
        canonical_items = [
            item for item in items
            if str(item.get("source_name") or "") == canonical
        ]
        old_items = [
            item for item in items
            if str(item.get("source_name") or "") != canonical
        ]
        if (
            len(items) == 2
            and len(identities) == 1
            and len(url_keys) == 1
            and canonical is not None
            and len(canonical_items) == 1
            and len(old_items) == 1
        ):
            recovery_rollbacks.append(
                {
                    "scene": scene_name,
                    "item_id": int(canonical_items[0]["item_id"]),
                    "old_id": int(old_items[0]["item_id"]),
                },
            )
            normalized_generated_items[(scene_name, share_key)] = old_items
            continue
        route = "/".join(_GLOBAL_AUDIO_BROWSER_ROUTES[share_key])
        raise SceneBuildError(
            f"Generated scene {scene_name!r} contains ambiguous exact "
            f"{route!r} items; they were left unchanged.",
        )
    generated_items = normalized_generated_items

    replacements: List[Dict[str, Any]] = []
    canonical_by_share_key: Dict[str, str] = {}
    for (scene_name, share_key), items in generated_items.items():
        old_item = items[0]
        old_source = str(old_item.get("source_name") or "")
        old_meta = source_meta[old_source]
        outside_same_identity = _outside_candidates(
            share_key, old_meta["identity"],
        )
        if len(outside_same_identity) > 1:
            route = "/".join(_GLOBAL_AUDIO_BROWSER_ROUTES[share_key])
            raise SceneBuildError(
                f"Multiple Browser Sources outside generated scenes match "
                f"the same authenticated {route!r} route; no items changed.",
            )
        if not outside_same_identity:
            continue
        canonical = outside_same_identity[0]
        if source_meta[canonical]["url_key"] != old_meta["url_key"]:
            # Same token/route with different query or fragment can have
            # different behavior. It is not an exact reusable input.
            continue
        previous = canonical_by_share_key.get(share_key)
        if previous is not None and previous != canonical:
            raise SceneBuildError(
                "Generated audio widgets do not agree on one external "
                "Browser Source; no items changed.",
            )
        canonical_by_share_key[share_key] = canonical
        if old_source == canonical:
            continue
        replacements.append(
            {
                "scene": scene_name,
                "share_key": share_key,
                "old_id": int(old_item["item_id"]),
                "old_source": old_source,
                "canonical": canonical,
                "enabled": bool(old_item.get("enabled", True)),
                "index": int(old_item.get("index", 0)),
                "transform": _writable_scene_item_transform(
                    old_item.get("transform"),
                ),
            },
        )

    refresh_sources = list(dict.fromkeys(
        str(replacement["canonical"])
        for replacement in replacements
    ))
    if refresh_alert_if_reused and generated_identities:
        generated_identity = next(iter(generated_identities))
        outside_alerts = [
            source_name
            for source_name, meta in source_meta.items()
            if meta["share_key"] == _CHAT_ALERTS_SHARE_KEY
            and meta["identity"] == generated_identity
            and references.get(source_name, set()) - generated_scope
        ]
        outside_alerts = list(dict.fromkeys(outside_alerts))
        if len(outside_alerts) > 1:
            raise SceneBuildError(
                "Multiple external chat-alert Browser Sources match the "
                "generated overlay; none were refreshed.",
            )
        if outside_alerts:
            alert_source = outside_alerts[0]
            if any(
                str(item.get("source_name") or "") == alert_source
                for scene_name in generated_scenes
                for item in inventories[scene_name]
            ) and alert_source not in refresh_sources:
                refresh_sources.append(alert_source)

    # Finish a recognizable rollback left by an interrupted prior call. This
    # happens before any new refresh/create request and is itself verified, so
    # the next retry always starts from the original single old item.
    for rollback in recovery_rollbacks:
        scene_name = str(rollback["scene"])
        stale_id = int(rollback["item_id"])
        old_id = int(rollback["old_id"])
        try:
            client.remove_scene_item(
                scene_name=scene_name,
                item_id=stale_id,
            )
        except Exception as exc:  # noqa: BLE001 - request may have applied
            final_items = client.get_scene_item_list(scene_name)
            if (
                any(int(item["item_id"]) == stale_id for item in final_items)
                or not any(
                    int(item["item_id"]) == old_id for item in final_items
                )
            ):
                raise SceneBuildError(
                    f"OBS could not roll back an interrupted audio repair in "
                    f"{scene_name!r}.",
                ) from exc
        final_items = client.get_scene_item_list(scene_name)
        old_item = next(
            (
                item for item in final_items
                if int(item["item_id"]) == old_id
            ),
            None,
        )
        if (
            any(int(item["item_id"]) == stale_id for item in final_items)
            or old_item is None
        ):
            raise SceneBuildError(
                f"OBS did not roll back an interrupted audio repair in "
                f"{scene_name!r}.",
            )
        # Moving the stale new item may have temporarily shifted the old
        # item's index. Snapshot its authoritative post-rollback state before
        # constructing the retry so the original geometry/order is preserved.
        for replacement in replacements:
            if (
                str(replacement["scene"]) == scene_name
                and int(replacement["old_id"]) == old_id
            ):
                replacement["enabled"] = bool(
                    old_item.get("enabled", True),
                )
                replacement["index"] = int(old_item.get("index", 0))
                replacement["transform"] = _writable_scene_item_transform(
                    old_item.get("transform"),
                )

    # Reload before replacing items: a failed refresh leaves the generated
    # stack untouched and retryable on the next OBS connection.
    for source_name in refresh_sources:
        client.refresh_browser_input(source_name)

    def _matching_new_items(
        items: Sequence[Dict[str, Any]], expected: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        return [
            item for item in items
            if str(item.get("source_name") or "")
            == str(expected["canonical"])
            and int(item["item_id"]) != int(expected["old_id"])
        ]

    def _item_state_matches(
        item: Dict[str, Any], expected: Dict[str, Any],
    ) -> bool:
        return (
            bool(item.get("enabled", True)) == bool(expected["enabled"])
            and int(item.get("index", -1)) == int(expected["index"])
            and _writable_scene_item_transform(item.get("transform"))
            == dict(expected["transform"])
        )

    changed: List[str] = []
    replacement_results: List[Dict[str, Any]] = []
    for replacement in sorted(
        replacements,
        key=lambda row: (str(row["scene"]), int(row["index"])),
    ):
        scene_name = str(replacement["scene"])
        new_id: Optional[int] = None
        try:
            new_id = client.create_scene_item(
                scene_name=scene_name,
                source_name=str(replacement["canonical"]),
                enabled=bool(replacement["enabled"]),
            )
            transform = dict(replacement["transform"])
            if transform:
                client.set_scene_item_transform(
                    scene_name=scene_name,
                    item_id=new_id,
                    transform=transform,
                )
            client.set_scene_item_index(
                scene_name=scene_name,
                item_id=new_id,
                index=int(replacement["index"]),
            )
            client.remove_scene_item(
                scene_name=scene_name,
                item_id=int(replacement["old_id"]),
            )
        except Exception as exc:  # noqa: BLE001 - reconcile applied requests
            final_items = client.get_scene_item_list(scene_name)
            old_exists = any(
                int(item["item_id"]) == int(replacement["old_id"])
                for item in final_items
            )
            new_items = _matching_new_items(final_items, replacement)
            if old_exists:
                # The old item is still authoritative. Remove every canonical
                # item created by this attempt; even a create call that raised
                # after applying is discoverable by its unique source.
                cleanup_failed = False
                for item in new_items:
                    try:
                        client.remove_scene_item(
                            scene_name=scene_name,
                            item_id=int(item["item_id"]),
                        )
                    except Exception:  # noqa: BLE001 - verify below
                        cleanup_failed = True
                rolled_back = client.get_scene_item_list(scene_name)
                old_exists = any(
                    int(item["item_id"]) == int(replacement["old_id"])
                    for item in rolled_back
                )
                new_items = _matching_new_items(rolled_back, replacement)
                if old_exists and not new_items:
                    raise SceneBuildError(
                        f"OBS interrupted the audio repair in {scene_name!r}; "
                        "the original item was restored and can be retried.",
                    ) from exc
                detail = "cleanup request failed" if cleanup_failed else "cleanup was not applied"
                raise SceneBuildError(
                    f"OBS interrupted the audio repair in {scene_name!r} and "
                    f"{detail}; startup will recover the exact pair next time.",
                ) from exc

            # RemoveSceneItem may apply and then lose its response. With the
            # old item gone, one canonical item is the committed result. Retry
            # its idempotent state writes, verify, and accept instead of
            # manufacturing a duplicate on the next startup.
            if len(new_items) == 1:
                committed = new_items[0]
                committed_id = int(committed["item_id"])
                try:
                    client.set_scene_item_enabled(
                        scene_name=scene_name,
                        item_id=committed_id,
                        enabled=bool(replacement["enabled"]),
                    )
                    transform = dict(replacement["transform"])
                    if transform:
                        client.set_scene_item_transform(
                            scene_name=scene_name,
                            item_id=committed_id,
                            transform=transform,
                        )
                    client.set_scene_item_index(
                        scene_name=scene_name,
                        item_id=committed_id,
                        index=int(replacement["index"]),
                    )
                except Exception as recovery_exc:  # noqa: BLE001
                    raise SceneBuildError(
                        f"OBS committed the new audio item in {scene_name!r} "
                        "but its preserved state could not be verified.",
                    ) from recovery_exc
                committed_items = client.get_scene_item_list(scene_name)
                committed = next(
                    (
                        item for item in committed_items
                        if int(item["item_id"]) == committed_id
                    ),
                    None,
                )
                if committed is not None and _item_state_matches(
                    committed, replacement,
                ):
                    new_id = committed_id
                else:
                    raise SceneBuildError(
                        f"OBS committed the new audio item in {scene_name!r} "
                        "without its preserved state.",
                    ) from exc
            else:
                raise SceneBuildError(
                    f"OBS lost both sides of the audio repair in "
                    f"{scene_name!r}.",
                ) from exc

        if new_id is None:
            raise SceneBuildError(
                f"OBS did not return the repaired audio item in {scene_name!r}.",
            )
        replacement_results.append({**replacement, "new_id": new_id})
        if scene_name not in changed:
            changed.append(scene_name)

    # Read authoritative OBS state back. Success means the new reference has
    # the original enabled/transform/index and the duplicate item is gone.
    for expected in replacement_results:
        final_items = client.get_scene_item_list(str(expected["scene"]))
        old_ids = {
            int(item["item_id"]) for item in final_items
            if int(item["item_id"]) == int(expected["old_id"])
        }
        final = next(
            (
                item for item in final_items
                if int(item["item_id"]) == int(expected["new_id"])
                and str(item.get("source_name") or "")
                == str(expected["canonical"])
            ),
            None,
        )
        if (
            old_ids
            or final is None
            or bool(final.get("enabled", True)) != bool(expected["enabled"])
            or int(final.get("index", -1)) != int(expected["index"])
            or _writable_scene_item_transform(final.get("transform"))
            != dict(expected["transform"])
        ):
            raise SceneBuildError(
                f"OBS did not preserve the repaired audio widget in "
                f"{expected['scene']!r}.",
            )

    if changed:
        METRICS.incr("obs.repair.generated_audio_references.ok")
    if refresh_sources:
        METRICS.incr("obs.repair.audio_browser_refresh.ok")
    return changed, refresh_sources


def _audio_widget_url_from_manual_url(
    manual_url: str,
    route: tuple[str, str],
    *,
    owns_audio: bool,
) -> str:
    """Derive a same-token widget URL with one explicit sound role."""
    _assert_manual_override_url(manual_url)
    parsed = urlsplit(manual_url)
    parts = parsed.path.rstrip("/").split("/")
    parts[-2:] = list(route)
    return _url_with_widget_audio_role(
        parsed._replace(
            path="/".join(parts),
            query="",
            fragment="",
        ).geturl(),
        owns_audio=owns_audio,
    )


def _audio_widget_target_rect(client: Any, route_key: str) -> Rect:
    video = client.get_video_settings()
    canvas_w = int(video.get("base_width") or REF_WIDTH) or REF_WIDTH
    canvas_h = int(video.get("base_height") or REF_HEIGHT) or REF_HEIGHT
    sx = canvas_w / REF_WIDTH
    sy = canvas_h / REF_HEIGHT
    source_rect = (
        BETWEEN_GAMES_LAYOUT["chat"]
        if route_key == "multichat"
        else CHAT_ALERTS_RECT
    )
    return source_rect.scaled(sx, sy)


def _audio_widget_inventory(
    client: Any,
    *,
    expected_identity: tuple,
) -> tuple[
    Dict[str, List[Dict[str, Any]]],
    Dict[str, List[Dict[str, Any]]],
    Dict[str, set[str]],
]:
    """Read same-token chat/alert inputs and every scene reference."""
    inventories = {
        scene_name: client.get_scene_item_list(scene_name)
        for scene_name in client.refresh_scenes()
    }
    references: Dict[str, set[str]] = {}
    for scene_name, items in inventories.items():
        for item in items:
            source_name = str(item.get("source_name") or "")
            if source_name:
                references.setdefault(source_name, set()).add(scene_name)

    candidates: Dict[str, List[Dict[str, Any]]] = {
        route_key: [] for route_key in _AUDIO_WIDGET_ROUTES
    }
    for row in client.get_input_list(BROWSER_INPUT_KIND):
        if str(row.get("kind") or "") != BROWSER_INPUT_KIND:
            continue
        source_name = str(row.get("name") or "")
        if not source_name:
            continue
        settings = client.get_input_settings(source_name)
        url = str(settings.get("url") or "")
        for route_key, route in _AUDIO_WIDGET_ROUTES.items():
            manual_url = _manual_override_url_from_overlay_url(
                url,
                expected_route=route,
            )
            if (
                manual_url is not None
                and _overlay_url_key(manual_url) == expected_identity
            ):
                candidates[route_key].append({
                    "name": source_name,
                    "settings": settings,
                })
                break
    return inventories, candidates, references


def _replace_generated_audio_item(
    client: Any,
    *,
    scene_name: str,
    old_item: Dict[str, Any],
    source_name: str,
    create_settings: Optional[Dict[str, Any]] = None,
) -> None:
    """Swap one source reference while preserving item state and geometry."""
    old_id = int(old_item["item_id"])
    old_enabled = bool(old_item.get("enabled", True))
    old_index = int(old_item.get("index", 0))
    old_transform = _writable_scene_item_transform(
        old_item.get("transform"),
    )
    before_ids = {
        int(item["item_id"])
        for item in client.get_scene_item_list(scene_name)
    }
    new_id: Optional[int] = None

    def _new_items() -> List[Dict[str, Any]]:
        return [
            item
            for item in client.get_scene_item_list(scene_name)
            if str(item.get("source_name") or "") == source_name
            and int(item["item_id"]) not in before_ids
        ]

    def _finish(item_id: int) -> None:
        if not old_enabled:
            client.set_scene_item_enabled(
                scene_name=scene_name,
                item_id=item_id,
                enabled=False,
            )
        if old_transform:
            client.set_scene_item_transform(
                scene_name=scene_name,
                item_id=item_id,
                transform=old_transform,
            )
        client.set_scene_item_index(
            scene_name=scene_name,
            item_id=item_id,
            index=old_index,
        )

    try:
        if create_settings is None:
            new_id = client.create_scene_item(
                scene_name=scene_name,
                source_name=source_name,
                enabled=old_enabled,
            )
        else:
            new_id = client.create_input(
                scene_name=scene_name,
                input_name=source_name,
                input_kind=BROWSER_INPUT_KIND,
                settings=create_settings,
                enabled=old_enabled,
            )
        if old_transform:
            client.set_scene_item_transform(
                scene_name=scene_name,
                item_id=new_id,
                transform=old_transform,
            )
        # Stage the authored index while the original still exists. It is
        # written again after removal because OBS compacts indices, but keeping
        # this boundary before the destructive call makes an index failure
        # fully rollback-safe.
        client.set_scene_item_index(
            scene_name=scene_name,
            item_id=new_id,
            index=old_index,
        )
        client.remove_scene_item(
            scene_name=scene_name,
            item_id=old_id,
        )
        client.set_scene_item_index(
            scene_name=scene_name,
            item_id=new_id,
            index=old_index,
        )
    except Exception as exc:  # noqa: BLE001 - reconcile request boundaries
        current = client.get_scene_item_list(scene_name)
        old_exists = any(
            int(item["item_id"]) == old_id for item in current
        )
        created = _new_items()
        if old_exists:
            for item in created:
                try:
                    client.remove_scene_item(
                        scene_name=scene_name,
                        item_id=int(item["item_id"]),
                    )
                except Exception:  # noqa: BLE001 - readback below decides
                    pass
            if _new_items():
                raise SceneBuildError(
                    f"OBS left a duplicate audio widget in {scene_name!r}.",
                ) from exc
            raise SceneBuildError(
                f"OBS interrupted the audio-widget migration in "
                f"{scene_name!r}; the original item was restored.",
            ) from exc
        if len(created) != 1:
            raise SceneBuildError(
                f"OBS left an ambiguous audio-widget migration in "
                f"{scene_name!r}.",
            ) from exc
        new_id = int(created[0]["item_id"])
        try:
            _finish(new_id)
        except Exception as finish_exc:  # noqa: BLE001
            raise SceneBuildError(
                f"OBS removed the original widget in {scene_name!r} but "
                "did not preserve its replacement.",
            ) from finish_exc

    final_items = client.get_scene_item_list(scene_name)
    final = next(
        (
            item for item in final_items
            if new_id is not None
            and int(item["item_id"]) == int(new_id)
        ),
        None,
    )
    if (
        final is None
        or str(final.get("source_name") or "") != source_name
        or bool(final.get("enabled", True)) != old_enabled
        or int(final.get("index", -1)) != old_index
        or _writable_scene_item_transform(final.get("transform"))
        != old_transform
        or any(int(item["item_id"]) == old_id for item in final_items)
    ):
        raise SceneBuildError(
            f"OBS did not preserve the native-size widget in "
            f"{scene_name!r}.",
        )


def repair_chat_alert_audio_roles(
    client: Any,
    *,
    browser_url: str,
) -> tuple[Dict[str, str], List[str], List[str]]:
    """Keep independent viewports but elect one chat and one alert owner.

    Live/Vertical's shared Chat and Alert Box inputs remain the sound owners.
    Generated scenes retain native 552x984 chat and 1792x360 alert renderers,
    both explicitly silent. Existing width/height settings and scene-item
    transforms are never resized to force incompatible viewports to share.
    """
    _assert_manual_override_url(browser_url)
    expected_identity = _overlay_url_key(browser_url)
    generated_scope = set(MANUAL_OVERRIDE_SCENES)
    inventories, candidates, references = _audio_widget_inventory(
        client,
        expected_identity=expected_identity,
    )

    owners: Dict[str, str] = {}
    external_owner: Dict[str, bool] = {}
    original_sizes: Dict[str, tuple[Any, Any]] = {}
    for route_key, route_candidates in candidates.items():
        for candidate in route_candidates:
            settings = candidate["settings"]
            original_sizes[str(candidate["name"])] = (
                settings.get("width"),
                settings.get("height"),
            )
        if not route_candidates:
            continue
        external = list(dict.fromkeys(
            str(candidate["name"])
            for candidate in route_candidates
            if references.get(str(candidate["name"]), set()) - generated_scope
        ))
        if len(external) > 1:
            route = "/".join(_AUDIO_WIDGET_ROUTES[route_key])
            raise SceneBuildError(
                f"Expected one canonical {route!r} Browser Source outside "
                "the generated scenes. Existing sources were left unchanged.",
            )
        if external:
            owners[route_key] = external[0]
            external_owner[route_key] = True
            continue
        generated_candidates = list(dict.fromkeys(
            str(candidate["name"])
            for candidate in route_candidates
            if references.get(str(candidate["name"]), set()) & generated_scope
        ))
        if len(generated_candidates) != 1:
            route = "/".join(_AUDIO_WIDGET_ROUTES[route_key])
            raise SceneBuildError(
                f"Expected one generated {route!r} Browser Source when no "
                "external owner exists. Existing sources were left unchanged.",
            )
        owners[route_key] = generated_candidates[0]
        external_owner[route_key] = False
    if not owners:
        return {}, [], []

    # Browser audio routed through OBS is active-scene dependent. Generated
    # scenes deliberately keep their own native, silent visual copies, so an
    # external owner with Control Audio via OBS enabled would disappear from
    # the mix whenever one of those generated scenes is Program. Do not change
    # the streamer's routing choice behind their back; reject the topology
    # before geometry, references, URLs, or shutdown settings are mutated.
    for route_key, owner in owners.items():
        owner_candidate = next(
            candidate for candidate in candidates[route_key]
            if str(candidate["name"]) == owner
        )
        if _browser_reroutes_audio(owner_candidate["settings"]):
            route = "/".join(_AUDIO_WIDGET_ROUTES[route_key])
            raise SceneBuildError(
                f"Cannot safely assign {route!r} audio owner {owner!r}: "
                "Control audio via OBS is enabled. Existing sources were "
                "left unchanged.",
            )

    changed_scenes: List[str] = []
    for route_key, owner in owners.items():
        rect = _audio_widget_target_rect(client, route_key)
        desired_size = (rect.w, rect.h)
        compatible = [
            candidate
            for candidate in candidates[route_key]
            if (
                not external_owner[route_key]
                or str(candidate["name"]) != owner
            )
            and references.get(str(candidate["name"]), set()) <= generated_scope
            and (
                int(candidate["settings"].get("width") or 0),
                int(candidate["settings"].get("height") or 0),
            ) == desired_size
        ]
        if len(compatible) > 1:
            raise SceneBuildError(
                f"Multiple native-size {route_key} Browser Sources exist; "
                "they were left unchanged.",
            )
        silent_source = (
            str(compatible[0]["name"]) if compatible else None
        )

        # If an interrupted earlier migration left both inputs in one scene,
        # the native-size item is authoritative; discard only the extra owner.
        for scene_name in generated_scope:
            route_names = {
                str(candidate["name"])
                for candidate in candidates[route_key]
            }
            items = [
                item for item in inventories.get(scene_name, [])
                if str(item.get("source_name") or "") in route_names
            ]
            owner_items = [
                item for item in items
                if str(item.get("source_name") or "") == owner
            ]
            native_items = [
                item for item in items
                if silent_source is not None
                and str(item.get("source_name") or "") == silent_source
            ]
            incompatible_items = [
                item for item in items
                if silent_source is not None
                and str(item.get("source_name") or "") != silent_source
            ]
            if native_items and incompatible_items and not owner_items:
                if len(native_items) != 1 or len(incompatible_items) != 1:
                    raise SceneBuildError(
                        f"Ambiguous {route_key} items in {scene_name!r}.",
                    )
                client.remove_scene_item(
                    scene_name=scene_name,
                    item_id=int(incompatible_items[0]["item_id"]),
                )
                readback = [
                    item for item in client.get_scene_item_list(scene_name)
                    if str(item.get("source_name") or "") in route_names
                ]
                if (
                    len(readback) != 1
                    or str(readback[0].get("source_name") or "")
                    != silent_source
                ):
                    raise SceneBuildError(
                        f"OBS did not retire the wrong-size {route_key} "
                        f"item in {scene_name!r}.",
                    )
                changed_scenes.append(scene_name)
                continue
            if owner_items and native_items and owner != silent_source:
                if len(owner_items) != 1 or len(native_items) != 1:
                    raise SceneBuildError(
                        f"Ambiguous {route_key} items in {scene_name!r}.",
                    )
                owner_item = owner_items[0]
                native_item = native_items[0]
                owner_transform = _writable_scene_item_transform(
                    owner_item.get("transform"),
                )
                native_transform = _writable_scene_item_transform(
                    native_item.get("transform"),
                )
                owner_enabled = bool(owner_item.get("enabled", True))
                native_enabled = bool(native_item.get("enabled", True))

                # The intact item is recognizable at a failed create/transform
                # boundary. If both carry the same authored state, finish the
                # pivot by preserving the old owner's index on the native copy.
                if (
                    owner_transform
                    and (
                        not native_transform
                        or native_enabled != owner_enabled
                    )
                ):
                    kept_source = owner
                    client.remove_scene_item(
                        scene_name=scene_name,
                        item_id=int(native_item["item_id"]),
                    )
                elif (
                    native_transform
                    and not owner_transform
                ):
                    kept_source = silent_source
                    client.remove_scene_item(
                        scene_name=scene_name,
                        item_id=int(owner_item["item_id"]),
                    )
                    client.set_scene_item_index(
                        scene_name=scene_name,
                        item_id=int(native_item["item_id"]),
                        index=int(owner_item.get("index", 0)),
                    )
                elif (
                    native_transform == owner_transform
                    and native_enabled == owner_enabled
                ):
                    kept_source = silent_source
                    try:
                        client.remove_scene_item(
                            scene_name=scene_name,
                            item_id=int(owner_item["item_id"]),
                        )
                        client.set_scene_item_index(
                            scene_name=scene_name,
                            item_id=int(native_item["item_id"]),
                            index=int(owner_item.get("index", 0)),
                        )
                    except Exception as exc:  # noqa: BLE001
                        readback = client.get_scene_item_list(scene_name)
                        owner_exists = any(
                            int(item["item_id"])
                            == int(owner_item["item_id"])
                            for item in readback
                        )
                        if owner_exists:
                            try:
                                client.remove_scene_item(
                                    scene_name=scene_name,
                                    item_id=int(native_item["item_id"]),
                                )
                            except Exception:  # noqa: BLE001
                                pass
                            raise SceneBuildError(
                                f"OBS could not roll back the interrupted "
                                f"{route_key} migration in {scene_name!r}.",
                            ) from exc
                        # Removal committed but its response (or the first
                        # index write) failed. Complete from authoritative
                        # readback rather than creating a third item.
                        client.set_scene_item_index(
                            scene_name=scene_name,
                            item_id=int(native_item["item_id"]),
                            index=int(owner_item.get("index", 0)),
                        )
                else:
                    raise SceneBuildError(
                        f"Conflicting interrupted {route_key} items in "
                        f"{scene_name!r}; neither was removed.",
                    )
                pair_readback = [
                    item for item in client.get_scene_item_list(scene_name)
                    if str(item.get("source_name") or "") in route_names
                ]
                if (
                    len(pair_readback) != 1
                    or str(pair_readback[0].get("source_name") or "")
                    != kept_source
                ):
                    raise SceneBuildError(
                        f"OBS did not reconcile the interrupted {route_key} "
                        f"migration in {scene_name!r}.",
                    )
                changed_scenes.append(scene_name)

        inventories, candidates, references = _audio_widget_inventory(
            client,
            expected_identity=expected_identity,
        )
        route_sources = {
            str(candidate["name"])
            for candidate in candidates[route_key]
        }
        items_to_replace = [
            (scene_name, item)
            for scene_name in generated_scope
            for item in inventories.get(scene_name, [])
            if str(item.get("source_name") or "") in route_sources
            and (
                silent_source is None
                or str(item.get("source_name") or "") != silent_source
            )
        ]
        counts: Dict[str, int] = {}
        for scene_name, _item in items_to_replace:
            counts[scene_name] = counts.get(scene_name, 0) + 1
        if any(count > 1 for count in counts.values()):
            raise SceneBuildError(
                f"A generated scene contains multiple incompatible "
                f"{route_key} items; nothing was removed.",
            )
        for scene_name, old_item in items_to_replace:
            create_settings: Optional[Dict[str, Any]] = None
            if silent_source is None:
                base_name = (
                    "SC2 Tools Chat"
                    if route_key == "multichat"
                    else CHAT_ALERTS_INPUT_NAME
                )
                silent_source = _unique_input_name(client, base_name)
                silent_url = _audio_widget_url_from_manual_url(
                    browser_url,
                    _AUDIO_WIDGET_ROUTES[route_key],
                    owns_audio=not external_owner[route_key],
                )
                create_settings = _browser_settings(PlannedItem(
                    label=route_key,
                    rect=rect,
                    z=0,
                    browser_path=silent_url,
                    input_name=silent_source,
                ))
            _replace_generated_audio_item(
                client,
                scene_name=scene_name,
                old_item=old_item,
                source_name=silent_source,
                create_settings=create_settings,
            )
            if scene_name not in changed_scenes:
                changed_scenes.append(scene_name)
        inventories, candidates, references = _audio_widget_inventory(
            client,
            expected_identity=expected_identity,
        )
        if not external_owner[route_key] and silent_source is not None:
            owners[route_key] = silent_source

    # Revalidate owners after item migration. Then mute every follower before
    # enabling owners, so a failed write can produce silence but never twins.
    for route_key, owner in owners.items():
        external = list(dict.fromkeys(
            str(candidate["name"])
            for candidate in candidates[route_key]
            if references.get(str(candidate["name"]), set()) - generated_scope
        ))
        if external_owner[route_key]:
            if external != [owner]:
                raise SceneBuildError(
                    f"The canonical {route_key} source changed during repair.",
                )
            if any(
                str(item.get("source_name") or "") == owner
                for scene_name in generated_scope
                for item in inventories.get(scene_name, [])
            ):
                raise SceneBuildError(
                    f"A generated scene still references the {route_key} owner.",
                )
        elif external or not any(
            str(item.get("source_name") or "") == owner
            for scene_name in generated_scope
            for item in inventories.get(scene_name, [])
        ):
            raise SceneBuildError(
                f"The generated {route_key} sound owner changed during repair.",
            )

    ordered: List[tuple[str, Dict[str, Any], bool]] = []
    for route_key, owner in owners.items():
        ordered.extend(
            (route_key, candidate, False)
            for candidate in sorted(
                candidates[route_key],
                key=lambda row: str(row["name"]).casefold(),
            )
            if str(candidate["name"]) != owner
        )
    for route_key, owner in owners.items():
        ordered.append((
            route_key,
            next(
                candidate for candidate in candidates[route_key]
                if str(candidate["name"]) == owner
            ),
            True,
        ))

    updated: List[str] = []
    for _route_key, candidate, owns_audio in ordered:
        source_name = str(candidate["name"])
        settings = dict(candidate["settings"])
        desired_url = _url_with_widget_audio_role(
            str(settings.get("url") or ""),
            owns_audio=owns_audio,
        )
        patch: Dict[str, Any] = {}
        if desired_url != settings.get("url"):
            patch["url"] = desired_url
        if owns_audio and settings.get("shutdown") is not False:
            patch["shutdown"] = False
        if patch:
            client.set_input_settings(source_name, patch)
            updated.append(source_name)

    one_owner: Dict[str, List[str]] = {
        route_key: [] for route_key in owners
    }
    for route_key, route_candidates in candidates.items():
        if route_key not in owners:
            continue
        for candidate in route_candidates:
            source_name = str(candidate["name"])
            final = client.get_input_settings(source_name)
            if source_name in original_sizes and (
                final.get("width"),
                final.get("height"),
            ) != original_sizes[source_name]:
                raise SceneBuildError(
                    f"OBS changed {source_name!r}'s native viewport.",
                )
            role = _widget_audio_role(str(final.get("url") or ""))
            if role is True:
                one_owner[route_key].append(source_name)
            elif role is not False:
                raise SceneBuildError(
                    f"OBS did not apply an audio role to {source_name!r}.",
                )
            if (
                source_name == owners[route_key]
                and _browser_shuts_down(final)
            ):
                raise SceneBuildError(
                    f"OBS did not keep {source_name!r} active while hidden.",
                )
            if (
                source_name == owners[route_key]
                and _browser_reroutes_audio(final)
            ):
                raise SceneBuildError(
                    f"OBS enabled Control audio via OBS on {source_name!r} "
                    "during audio-role repair.",
                )
    for route_key, names in one_owner.items():
        if names != [owners[route_key]]:
            raise SceneBuildError(
                f"OBS did not retain exactly one {route_key} sound owner.",
            )

    if updated:
        METRICS.incr("obs.repair.chat_alert_audio_roles.ok")
    if changed_scenes:
        METRICS.incr("obs.repair.generated_audio_geometry.ok")
    return owners, updated, changed_scenes


def repair_generated_audio_browser_references(
    client: Any,
    *,
    refresh_alert_if_reused: bool = False,
) -> tuple[List[str], List[str]]:
    """Compatibility wrapper for the former shared-renderer migration."""
    del refresh_alert_if_reused
    browser_url = (
        discover_manual_override_url(client)
        or discover_widget_only_broll_url(client)
    )
    if browser_url is None:
        return [], []
    _owners, updated, changed = repair_chat_alert_audio_roles(
        client,
        browser_url=browser_url,
    )
    return changed, updated


def discover_widget_only_broll_url(client: Any) -> Optional[str]:
    """Find one unambiguous production overlay identity from stream widgets.

    This is the fallback for streamers who use only the standalone horizontal
    and portrait ``/widget/stream-scene`` sources and never built the generated
    manual-cover scenes. Exactly one identity must be present and it must have
    at least one non-portrait (or legacy default-sized) source. Ambiguous OBS
    collections fail closed rather than assigning one token's audio role to
    another token's Browser Source.
    """
    identities: Dict[tuple, List[str]] = {}
    for row in client.get_input_list(BROWSER_INPUT_KIND):
        if row.get("kind") != BROWSER_INPUT_KIND:
            continue
        source_name = str(row.get("name") or "")
        if not source_name:
            continue
        settings = client.get_input_settings(source_name)
        url = str(settings.get("url") or "")
        if not _is_sc2tools_overlay_url(url):
            continue
        manual_url = _manual_override_url_from_overlay_url(
            url,
            expected_route=("widget", "stream-scene"),
        )
        if manual_url is None or _is_portrait_browser_settings(settings):
            continue
        identities.setdefault(_overlay_url_key(manual_url), []).append(
            manual_url,
        )
    if len(identities) != 1:
        return None
    return next(iter(identities.values()))[0]


def repair_broll_audio_roles(
    client: Any,
    *,
    browser_url: str,
) -> tuple[Optional[str], List[str]]:
    """Assign exactly one explicit B-roll audio owner for one overlay token.

    Independent Browser Sources remain independent video players and continue
    following the shared server timeline. Audio is different: every matching
    manual/stream-scene source receives an explicit ``?audio=`` role, so two
    1920×1080 CEF renderers cannot both play the same highlight.

    The shared manual cover referenced by a generated scene wins. In a
    widget-only setup, one deterministic non-portrait stream-scene source wins.
    All portrait sources and all other matching landscape copies are muted.
    URLs from another origin, prefix, token, or route are never changed.

    A hidden source is eligible to own sound only while OBS leaves browser
    audio on Windows/Desktop Audio (``reroute_audio=false``) and keeps the
    browser running while hidden (``shutdown=false``). Those are the builder
    defaults and make ownership global rather than program-scene dependent.
    If no safe landscape candidate remains, the preflight aborts before any
    URL changes instead of guessing.

    Returns ``(owner_name, updated_input_names)``. A portrait-only collection
    intentionally has no owner: vertical must remain video-only.
    """
    _assert_manual_override_url(browser_url)
    expected_identity = _overlay_url_key(browser_url)
    settings_cache: Dict[str, Dict[str, Any]] = {}
    candidates: List[Dict[str, Any]] = []

    for row in client.get_input_list(BROWSER_INPUT_KIND):
        if row.get("kind") != BROWSER_INPUT_KIND:
            continue
        source_name = str(row.get("name") or "")
        if not source_name:
            continue
        settings = client.get_input_settings(source_name)
        settings_cache[source_name] = settings
        url = str(settings.get("url") or "")
        route: Optional[str] = None
        for route_kind, route_name in (
            ("scene", "manual"),
            ("widget", "stream-scene"),
        ):
            canonical = _manual_override_url_from_overlay_url(
                url,
                expected_route=(route_kind, route_name),
            )
            if (
                canonical is not None
                and _overlay_url_key(canonical) == expected_identity
            ):
                route = f"{route_kind}/{route_name}"
                break
        if route is None:
            continue
        candidates.append(
            {
                "name": source_name,
                "route": route,
                "url": url,
                "portrait": _is_portrait_browser_settings(settings),
                "reroutes_audio": _browser_reroutes_audio(settings),
                "shutdowns_when_hidden": _browser_shuts_down(settings),
            },
        )

    if not candidates:
        return None, []

    # A manual source counts only when an exact generated scene references it;
    # an orphaned same-token input must not steal sound from a widget-only setup.
    manual_names = {
        str(candidate["name"])
        for candidate in candidates
        if candidate["route"] == MANUAL_OVERRIDE_BROWSER_PATH
        and not bool(candidate["portrait"])
        and not bool(candidate["reroutes_audio"])
        and not bool(candidate["shutdowns_when_hidden"])
    }
    manual_references = {name: 0 for name in manual_names}
    existing_scenes = set(client.refresh_scenes())
    for scene_name in MANUAL_OVERRIDE_SCENES:
        if scene_name not in existing_scenes:
            continue
        for item in client.get_scene_item_list(scene_name):
            source_name = str(item.get("source_name") or "")
            if source_name in manual_references:
                manual_references[source_name] += 1

    referenced_manuals = [
        name for name, count in manual_references.items() if count > 0
    ]
    owner: Optional[str]
    if referenced_manuals:
        owner = min(
            referenced_manuals,
            key=lambda name: (-manual_references[name], name.casefold()),
        )
    else:
        landscape_widgets = [
            str(candidate["name"])
            for candidate in candidates
            if candidate["route"] == "widget/stream-scene"
            and not bool(candidate["portrait"])
            and not bool(candidate["reroutes_audio"])
            and not bool(candidate["shutdowns_when_hidden"])
        ]
        owner = min(landscape_widgets, key=str.casefold) if landscape_widgets else None

    landscape_candidates = [
        candidate for candidate in candidates
        if not bool(candidate["portrait"])
    ]
    if owner is None and landscape_candidates:
        if all(
            bool(candidate["reroutes_audio"])
            for candidate in landscape_candidates
        ):
            detail = (
                "every landscape Browser Source has Control audio via OBS "
                "enabled"
            )
        elif all(
            bool(candidate["shutdowns_when_hidden"])
            for candidate in landscape_candidates
        ):
            detail = "every landscape Browser Source shuts down while hidden"
        else:
            detail = "no active landscape ownership path could be proved"
        raise SceneBuildError(
            "No safe global B-roll audio owner is available: "
            f"{detail}. Existing Browser Source URLs were left unchanged.",
        )

    updated: List[str] = []
    desired_roles: Dict[str, bool] = {
        str(candidate["name"]): str(candidate["name"]) == owner
        for candidate in candidates
    }
    # Mute followers before enabling/changing the owner. An interrupted
    # migration may briefly be silent, but can never create a duplicate-audio
    # interval by bringing the new owner up before the old one is down.
    ordered_candidates = sorted(
        candidates,
        key=lambda candidate: (
            str(candidate["name"]) == owner,
            str(candidate["name"]).casefold(),
        ),
    )
    for candidate in ordered_candidates:
        source_name = str(candidate["name"])
        owns_audio = desired_roles[source_name]
        desired_url = _url_with_broll_audio_role(
            str(candidate["url"]),
            owns_audio=owns_audio,
        )
        if desired_url == candidate["url"]:
            continue
        client.set_input_settings(source_name, {"url": desired_url})
        settings_cache[source_name] = {
            **settings_cache[source_name],
            "url": desired_url,
        }
        updated.append(source_name)

    # Read OBS back after mutation. A request that returned success but did not
    # apply the URL would otherwise leave duplicate audio while reporting repair.
    for source_name, owns_audio in desired_roles.items():
        final_url = str(client.get_input_settings(source_name).get("url") or "")
        if _broll_audio_role(final_url) is not owns_audio:
            raise SceneBuildError(
                f"OBS did not apply the B-roll audio role to {source_name!r}.",
            )

    if updated:
        METRICS.incr("obs.repair.broll_audio_roles.ok")
    return owner, updated


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


def _chat_alerts_rect_for_canvas(client: Any) -> Rect:
    video = client.get_video_settings()
    canvas_w = int(video.get("base_width") or REF_WIDTH) or REF_WIDTH
    canvas_h = int(video.get("base_height") or REF_HEIGHT) or REF_HEIGHT
    return CHAT_ALERTS_RECT.scaled(
        canvas_w / REF_WIDTH,
        canvas_h / REF_HEIGHT,
    )


def _vertical_alert_rect(canvas_width: int, canvas_height: int) -> Rect:
    width = max(1, round(canvas_width * VERTICAL_ALERTS_WIDTH_RATIO))
    height = max(1, round(width * 3 / 4))
    return Rect(
        x=round((canvas_width - width) / 2),
        y=round(canvas_height * VERTICAL_ALERTS_MARGIN_RATIO),
        w=width,
        h=height,
    )


def _manual_cover_items(
    client: Any,
    items: Sequence[Dict[str, Any]],
    *,
    settings_cache: Dict[str, Dict[str, Any]],
    expected_url_key: Optional[tuple] = None,
) -> List[Dict[str, Any]]:
    return _browser_items_matching(
        client,
        items,
        settings_cache=settings_cache,
        expected_url_key=expected_url_key,
        route=None if expected_url_key is not None else MANUAL_OVERRIDE_BROWSER_PATH,
    )


def _browser_items_matching(
    client: Any,
    items: Sequence[Dict[str, Any]],
    *,
    settings_cache: Dict[str, Dict[str, Any]],
    expected_url_key: Optional[tuple] = None,
    expected_strict_url_key: Optional[tuple] = None,
    route: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Return Browser Source scene items matching one exact owned route."""
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
        if expected_strict_url_key is not None:
            matches = _strict_browser_url_key(url) == expected_strict_url_key
        else:
            matches = _overlay_url_key(url) == expected_url_key
        if expected_url_key is None and expected_strict_url_key is None:
            matches = bool(route) and _overlay_url_key(url)[2].endswith(
                "/" + str(route),
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
    return _find_browser_input(
        client,
        expected_url_key=expected_url_key,
        settings_cache=settings_cache,
    )


def _find_browser_input(
    client: Any,
    *,
    settings_cache: Dict[str, Dict[str, Any]],
    expected_url_key: Optional[tuple] = None,
    expected_strict_url_key: Optional[tuple] = None,
    expected_size: Optional[tuple[int, int]] = None,
) -> Optional[str]:
    matches = _find_browser_inputs(
        client,
        settings_cache=settings_cache,
        expected_url_key=expected_url_key,
        expected_strict_url_key=expected_strict_url_key,
        expected_size=expected_size,
    )
    return matches[0] if matches else None


def _find_browser_inputs(
    client: Any,
    *,
    settings_cache: Dict[str, Dict[str, Any]],
    expected_url_key: Optional[tuple] = None,
    expected_strict_url_key: Optional[tuple] = None,
    expected_size: Optional[tuple[int, int]] = None,
) -> List[str]:
    matches_out: List[str] = []
    for row in client.get_input_list(BROWSER_INPUT_KIND):
        source_name = str(row.get("name") or "")
        if not source_name:
            continue
        settings = settings_cache.get(source_name)
        if settings is None:
            settings = client.get_input_settings(source_name)
            settings_cache[source_name] = settings
        url = str(settings.get("url") or "")
        matches = (
            _strict_browser_url_key(url) == expected_strict_url_key
            if expected_strict_url_key is not None
            else _overlay_url_key(url) == expected_url_key
        )
        if not matches:
            continue
        if expected_size is not None:
            try:
                actual_size = (
                    int(settings.get("width") or 0),
                    int(settings.get("height") or 0),
                )
            except (TypeError, ValueError):
                continue
            if actual_size != expected_size:
                continue
        matches_out.append(source_name)
    return matches_out


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


def _url_with_widget_audio_role(value: str, *, owns_audio: bool) -> str:
    """Return ``value`` with one canonical, explicit browser-audio role.

    Browser Source URLs may carry unrelated preview/theme parameters. Keep
    those in their original order, remove every stale/duplicate ``audio``
    parameter case-insensitively, then append the one role OBS should load.
    Changing the URL also makes OBS load the current overlay document instead
    of leaving a long-lived CEF instance on an older JavaScript bundle.
    """
    parsed = urlsplit(value)
    query = [
        (key, item)
        for key, item in parse_qsl(parsed.query, keep_blank_values=True)
        if key.casefold() != _BROLL_AUDIO_PARAM
    ]
    query.append((_BROLL_AUDIO_PARAM, "1" if owns_audio else "0"))
    return parsed._replace(query=urlencode(query, doseq=True)).geturl()


def _url_with_broll_audio_role(value: str, *, owns_audio: bool) -> str:
    """B-roll-specific spelling retained for the role-repair contract."""
    return _url_with_widget_audio_role(value, owns_audio=owns_audio)


def _widget_audio_role(value: str) -> Optional[bool]:
    """Read an explicit browser-audio role, failing closed if malformed."""
    try:
        parsed = urlsplit(value)
    except (TypeError, ValueError):
        return None
    for key, raw in parse_qsl(parsed.query, keep_blank_values=True):
        if key.casefold() != _BROLL_AUDIO_PARAM:
            continue
        normalized = raw.strip().casefold()
        if normalized in {"1", "true", "on", "yes"}:
            return True
        if normalized in {"0", "false", "off", "no"}:
            return False
        return None
    return None


def _broll_audio_role(value: str) -> Optional[bool]:
    """B-roll-specific spelling retained for focused repair tests."""
    return _widget_audio_role(value)


def _is_portrait_browser_settings(settings: Dict[str, Any]) -> bool:
    """Whether OBS reports a known portrait viewport for this input.

    Missing legacy dimensions are intentionally treated as non-portrait. That
    lets a widget-only collection retain one deterministic sound owner instead
    of silently muting every player. Known portrait copies always stay muted.
    """
    try:
        width = float(settings.get("width") or 0)
        height = float(settings.get("height") or 0)
    except (TypeError, ValueError):
        return False
    return width > 0 and height > width


def _browser_reroutes_audio(settings: Dict[str, Any]) -> bool:
    """Read OBS's browser-audio routing flag conservatively.

    Missing is OBS's historical/default ``false``. Unknown explicit values are
    treated as rerouted so they can never become a hidden global sound owner.
    """
    raw = settings.get("reroute_audio")
    if raw is None:
        raw = settings.get("rerouteAudio")
    if raw is None or raw is False or raw == 0:
        return False
    if isinstance(raw, str):
        normalized = raw.strip().casefold()
        if normalized in {"", "0", "false", "off", "no"}:
            return False
        if normalized in {"1", "true", "on", "yes"}:
            return True
    return True


def _browser_shuts_down(settings: Dict[str, Any]) -> bool:
    """Read OBS's shutdown-when-hidden setting conservatively."""
    raw = settings.get("shutdown")
    if raw is None:
        return False
    if raw is False or raw == 0:
        return False
    if isinstance(raw, str):
        normalized = raw.strip().casefold()
        if normalized in {"", "0", "false", "off", "no"}:
            return False
        if normalized in {"1", "true", "on", "yes"}:
            return True
    return True


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


def _chat_alerts_url_from_manual_url(value: str) -> str:
    """Derive the authenticated alerts route without exposing its token."""
    _assert_manual_override_url(value)
    parsed = urlsplit(value)
    parts = parsed.path.rstrip("/").split("/")
    parts[-2:] = CHAT_ALERTS_BROWSER_PATH.split("/")
    return parsed._replace(
        path="/".join(parts), query="", fragment="",
    ).geturl()


def _is_manual_override_url(value: str) -> bool:
    return _overlay_url_key(value)[2].endswith(
        "/" + MANUAL_OVERRIDE_BROWSER_PATH,
    )


def _is_sc2tools_overlay_url(value: str) -> bool:
    try:
        parsed = urlsplit(value)
    except (TypeError, ValueError):
        return False
    return (
        parsed.scheme.lower() == "https"
        and (parsed.hostname or "").lower() in {"sc2tools.com", "www.sc2tools.com"}
        and "/overlay/" in parsed.path
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


def _transform_matches_rect(raw: Any, rect: Rect) -> bool:
    """Whether a normal SCALE_INNER item matches the authored rectangle."""
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
        and _same_int("alignment", _ALIGN_TOP_LEFT)
        and raw.get("boundsType") == "OBS_BOUNDS_SCALE_INNER"
        and _same_int("boundsAlignment", _ALIGN_CENTER)
        and _same_number("boundsWidth", rect.w)
        and _same_number("boundsHeight", rect.h)
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
    "CHAT_ALERTS_BROWSER_PATH",
    "CHAT_ALERTS_INPUT_NAME",
    "CHAT_ALERTS_RECT",
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
    "discover_widget_only_broll_url",
    "manual_override_scenes_needing_update",
    "plan_scenes",
    "repair_broll_audio_roles",
    "repair_chat_alert_audio_roles",
    "repair_generated_audio_browser_references",
    "repair_manual_scene_overrides",
    "repair_vertical_scene_chat_alerts",
    "VERTICAL_SCENE_NAME",
]

"""Desktop view for build check-in: the loading card and the end card.

Two halves, split by thread:

* :class:`CheckinViewProxy` implements the controller's
  :class:`~sc2tools_agent.build_checkin.view.BuildCheckinView`. The
  controller calls it from its state thread; every call only forwards
  ``(method, args)`` to ``GuiUI``, which emits one Qt signal so the work
  lands on the GUI thread. It never touches a widget and never blocks.
* :class:`BuildCheckinHost` lives on the GUI thread. It creates the two
  parentless card windows on first use (``build_checkin_cards``), paints
  the controller's models into them, routes their buttons back to the
  controller and keeps the Settings group in sync.

The placement helpers at the bottom are pure functions over plain
rectangles so they are testable without a display. This module imports
no Qt at load time, so ``GuiUI`` can hand the proxy to the boot worker
on any install.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

log = logging.getLogger(__name__)

LOADING = "loading"
POSTGAME = "postgame"

CARD_MARGIN = 24
"""Logical pixels between a card and the screen's right edge."""
CARD_TOP_RATIO = 0.12
"""Default top offset, as a share of the screen height."""
MIN_VISIBLE = 48
"""How much of a saved position must still be on a screen to reuse it."""

Rect = Tuple[int, int, int, int]
"""``(x, y, width, height)`` in logical pixels."""
Point = Tuple[int, int]

_VIEW_METHODS = frozenset({
    "show_loading",
    "update_loading",
    "hide_loading",
    "show_postgame",
    "update_postgame",
    "hide_postgame",
    "update_prefs",
    "bind_controller",
})


class CheckinViewProxy:
    """The controller's view, forwarding every call to the GUI thread.

    ``emit(method, args)`` must be thread-safe and non-blocking
    (``GuiUI._emit_build_checkin``). The proxy also remembers the bound
    controller so GUI-thread widgets can route actions to it.
    """

    def __init__(self, emit: Callable[[str, tuple], None]) -> None:
        self._emit = emit
        self.controller: Optional[Any] = None

    def bind_controller(self, controller: Any) -> None:
        self.controller = controller
        self._forward("bind_controller")

    def show_loading(self, model: Any) -> None:
        self._forward("show_loading", model)

    def update_loading(self, model: Any) -> None:
        self._forward("update_loading", model)

    def hide_loading(self, game_key: str, reason: str) -> None:
        self._forward("hide_loading", game_key, reason)

    def show_postgame(self, model: Any) -> None:
        self._forward("show_postgame", model)

    def update_postgame(self, model: Any) -> None:
        self._forward("update_postgame", model)

    def hide_postgame(self, card_id: str, reason: str) -> None:
        self._forward("hide_postgame", card_id, reason)

    def update_prefs(self, prefs: Any) -> None:
        self._forward("update_prefs", prefs)

    def _forward(self, method: str, *args: Any) -> None:
        try:
            self._emit(method, args)
        except Exception:  # noqa: BLE001
            log.exception("build_checkin_view_forward_failed method=%s", method)


class BuildCheckinHost:
    """GUI-thread owner of the card windows and the Settings group.

    ``controller`` returns the bound controller (or ``None`` before the
    boot worker attached one). ``positions`` seeds the dragged positions
    (``AgentState.build_checkin_card_positions``); ``on_moved(kind, x,
    y)`` persists a new one. ``window_factory(kind, host)`` builds a card
    window; the default imports the Qt cards lazily.
    """

    def __init__(
        self,
        *,
        controller: Callable[[], Optional[Any]],
        positions: Optional[Mapping[str, Sequence[int]]] = None,
        on_moved: Optional[Callable[[str, int, int], None]] = None,
        settings: Optional[Any] = None,
        window_factory: Optional[Callable[[str, "BuildCheckinHost"], Any]] = None,
    ) -> None:
        self._controller = controller
        self._positions: Dict[str, Point] = {}
        for kind, point in dict(positions or {}).items():
            if isinstance(point, (list, tuple)) and len(point) == 2:
                self._positions[str(kind)] = (int(point[0]), int(point[1]))
        self._on_moved = on_moved
        self._settings = settings
        self._window_factory = window_factory or _qt_card_window
        self._windows: Dict[str, Any] = {}
        self._closed = False

    # ---------------------------------------------------------- dispatch

    def dispatch(self, method: str, args: Any = ()) -> None:
        """Run one forwarded view call. Never raises into Qt."""
        if self._closed or method not in _VIEW_METHODS:
            return
        try:
            getattr(self, "_" + method)(*tuple(args or ()))
        except Exception:  # noqa: BLE001
            log.exception("build_checkin_view_failed method=%s", method)

    def _show_loading(self, model: Any) -> None:
        self.window(LOADING).show_model(model)

    def _update_loading(self, model: Any) -> None:
        window = self._windows.get(LOADING)
        if window is not None and window.owns(model.game_key):
            window.update_model(model)

    def _hide_loading(self, game_key: str, reason: str) -> None:
        window = self._windows.get(LOADING)
        if window is not None and window.owns(game_key):
            window.dismiss(reason)

    def _show_postgame(self, model: Any) -> None:
        self.window(POSTGAME).show_model(model)

    def _update_postgame(self, model: Any) -> None:
        window = self._windows.get(POSTGAME)
        if window is not None and window.owns(model.card_id):
            window.update_model(model)

    def _hide_postgame(self, card_id: str, reason: str) -> None:
        window = self._windows.get(POSTGAME)
        if window is not None and window.owns(card_id):
            window.dismiss(reason)

    def _update_prefs(self, prefs: Any) -> None:
        if self._settings is not None:
            self._settings.apply_prefs(prefs)

    def _bind_controller(self) -> None:
        if self._settings is not None:
            self._settings.controller_bound()

    # ---------------------------------------------------------- windows

    def window(self, kind: str) -> Any:
        """The card window for ``kind``, created on first use."""
        window = self._windows.get(kind)
        if window is None:
            window = self._window_factory(kind, self)
            self._windows[kind] = window
        return window

    def existing_window(self, kind: str) -> Optional[Any]:
        return self._windows.get(kind)

    def act(self, action: str, *args: Any) -> None:
        """Call a controller action; a missing controller is a no-op."""
        controller = self._controller()
        fn = getattr(controller, action, None) if controller is not None else None
        if not callable(fn):
            return
        try:
            fn(*args)
        except Exception:  # noqa: BLE001
            log.exception("build_checkin_action_failed action=%s", action)

    def saved_position(self, kind: str) -> Optional[Point]:
        return self._positions.get(kind)

    def remember_position(self, kind: str, x: int, y: int) -> None:
        point = (int(x), int(y))
        if self._positions.get(kind) == point:
            return
        self._positions[kind] = point
        if self._on_moved is None:
            return
        try:
            self._on_moved(kind, point[0], point[1])
        except Exception:  # noqa: BLE001
            log.exception("build_checkin_position_save_failed")

    def close(self) -> None:
        """App shutdown: hide both cards and stop their timers."""
        self._closed = True
        for window in self._windows.values():
            try:
                window.shutdown()
            except Exception:  # noqa: BLE001
                log.exception("build_checkin_window_close_failed")


def _qt_card_window(kind: str, host: BuildCheckinHost) -> Any:
    from .build_checkin_cards import LoadingCardWindow, PostgameCardWindow

    cls = LoadingCardWindow if kind == LOADING else PostgameCardWindow
    return cls(host=host)


# ------------------------------------------------------------- placement


def default_card_position(
    available: Rect,
    screen: Rect,
    size: Tuple[int, int],
    *,
    margin: int = CARD_MARGIN,
    top_ratio: float = CARD_TOP_RATIO,
) -> Point:
    """Right edge of ``available`` (the screen minus taskbars), about
    12 % of the full screen height from its top, kept inside
    ``available``."""
    ax, ay, aw, ah = available
    _sx, sy, _sw, sh = screen
    width, height = size
    x = ax + aw - width - margin
    y = sy + round(sh * top_ratio)
    x = max(ax, min(x, ax + aw - width))
    y = max(ay, min(y, ay + ah - height))
    return x, y


def _overlap(a: Rect, b: Rect) -> Tuple[int, int]:
    width = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    height = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return max(0, width), max(0, height)


def clamp_card_position(
    point: Point,
    size: Tuple[int, int],
    screens: Iterable[Rect],
    *,
    min_visible: int = MIN_VISIBLE,
) -> Optional[Point]:
    """A saved position moved fully onto the screen it mostly sits on.

    ``None`` when too little of the card would be visible on any screen
    (a monitor was unplugged), so the caller uses the default spot.
    """
    width, height = size
    rect = (point[0], point[1], width, height)
    best: Optional[Rect] = None
    best_area = 0
    for screen in screens:
        w, h = _overlap(rect, screen)
        if w >= min(min_visible, width) and h >= min(min_visible, height) and w * h > best_area:
            best, best_area = screen, w * h
    if best is None:
        return None
    sx, sy, sw, sh = best
    x = max(sx, min(point[0], sx + sw - width))
    y = max(sy, min(point[1], sy + sh - height))
    return x, y


def match_screen(
    screens: Sequence[Any],
    device: Optional[str],
    bounds: Optional[Tuple[int, int, int, int]],
) -> Optional[Any]:
    """The ``QScreen`` showing the monitor Win32 reported.

    ``bounds`` is ``(left, top, right, bottom)`` in physical pixels. Qt
    keeps each screen's origin in physical pixels and scales only its
    size, so the device name and then the top-left corner identify the
    screen even on mixed-DPI desktops; a containment test is the last
    resort.
    """
    name = (device or "").casefold()
    if name:
        for screen in screens:
            if str(screen.name()).casefold() == name:
                return screen
    if bounds is None:
        return None
    left, top, right, bottom = bounds
    for screen in screens:
        geometry = screen.geometry()
        if (geometry.x(), geometry.y()) == (left, top):
            return screen
    cx, cy = (left + right) // 2, (top + bottom) // 2
    for screen in screens:
        geometry = screen.geometry()
        ratio = float(screen.devicePixelRatio() or 1.0)
        if (
            geometry.x() <= cx < geometry.x() + geometry.width() * ratio
            and geometry.y() <= cy < geometry.y() + geometry.height() * ratio
        ):
            return screen
    return None


def rect_of(qrect: Any) -> Rect:
    """``QRect`` → ``(x, y, width, height)``."""
    return (qrect.x(), qrect.y(), qrect.width(), qrect.height())


def screen_rects(screens: Iterable[Any]) -> List[Rect]:
    return [rect_of(screen.availableGeometry()) for screen in screens]


__all__ = [
    "BuildCheckinHost",
    "CARD_MARGIN",
    "CARD_TOP_RATIO",
    "CheckinViewProxy",
    "LOADING",
    "POSTGAME",
    "clamp_card_position",
    "default_card_position",
    "match_screen",
    "rect_of",
    "screen_rects",
]

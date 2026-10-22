"""Qt-free half of the build check-in view (``ui/build_checkin_window.py``):
the cross-thread proxy, the GUI-thread host's dispatch and the card
placement math."""

from __future__ import annotations

import threading
from typing import Any, List, Optional, Tuple

import pytest

from sc2tools_agent.build_checkin.models import (
    CheckinPrefs,
    LoadingCardModel,
    PostgameCardModel,
)
from sc2tools_agent.build_checkin.view import BuildCheckinView
from sc2tools_agent.ui.build_checkin_window import (
    CARD_MARGIN,
    LOADING,
    POSTGAME,
    BuildCheckinHost,
    CheckinViewProxy,
    clamp_card_position,
    default_card_position,
    match_screen,
)

# ------------------------------------------------------------------- proxy


def test_proxy_implements_the_view_protocol() -> None:
    proxy = CheckinViewProxy(lambda method, args: None)
    assert isinstance(proxy, BuildCheckinView)


def test_proxy_forwards_every_call_with_its_arguments() -> None:
    sent: List[Tuple[str, tuple]] = []
    proxy = CheckinViewProxy(lambda method, args: sent.append((method, args)))
    loading = LoadingCardModel(game_key="k|1")
    card = PostgameCardModel(card_id="checkin-1")
    prefs = CheckinPrefs(ask_at_loading=False)
    controller = object()

    proxy.bind_controller(controller)
    proxy.show_loading(loading)
    proxy.update_loading(loading)
    proxy.hide_loading("k|1", "in_game")
    proxy.show_postgame(card)
    proxy.update_postgame(card)
    proxy.hide_postgame("checkin-1", "later")
    proxy.update_prefs(prefs)

    assert proxy.controller is controller
    assert sent == [
        ("bind_controller", ()),
        ("show_loading", (loading,)),
        ("update_loading", (loading,)),
        ("hide_loading", ("k|1", "in_game")),
        ("show_postgame", (card,)),
        ("update_postgame", (card,)),
        ("hide_postgame", ("checkin-1", "later")),
        ("update_prefs", (prefs,)),
    ]


def test_proxy_never_raises_into_the_controller() -> None:
    def broken(method: str, args: tuple) -> None:
        raise RuntimeError("signals gone")

    proxy = CheckinViewProxy(broken)
    proxy.show_loading(LoadingCardModel(game_key="k|1"))  # must not raise


def test_proxy_is_callable_from_any_thread() -> None:
    sent: List[str] = []
    lock = threading.Lock()

    def emit(method: str, args: tuple) -> None:
        with lock:
            sent.append(method)

    proxy = CheckinViewProxy(emit)
    threads = [
        threading.Thread(target=proxy.hide_loading, args=("k", "menu")) for _ in range(8)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sent == ["hide_loading"] * 8


# -------------------------------------------------------------------- host


class FakeWindow:
    def __init__(self, kind: str) -> None:
        self.kind = kind
        self.identity: Optional[str] = None
        self.visible = False
        self.calls: List[Tuple[str, Any]] = []

    def owns(self, identity: Optional[str]) -> bool:
        return self.visible and identity == self.identity

    def show_model(self, model: Any) -> None:
        self.identity = getattr(model, "game_key" if self.kind == LOADING else "card_id")
        self.visible = True
        self.calls.append(("show", model))

    def update_model(self, model: Any) -> None:
        self.calls.append(("update", model))

    def dismiss(self, reason: str) -> None:
        self.visible = False
        self.identity = None
        self.calls.append(("dismiss", reason))

    def shutdown(self) -> None:
        self.calls.append(("shutdown", None))


class FakeSettings:
    def __init__(self) -> None:
        self.prefs: List[Any] = []
        self.bound = 0

    def apply_prefs(self, prefs: Any) -> None:
        self.prefs.append(prefs)

    def controller_bound(self) -> None:
        self.bound += 1


class Controller:
    def __init__(self) -> None:
        self.calls: List[Tuple[str, tuple]] = []

    def declare(self, *args: Any) -> None:
        self.calls.append(("declare", args))

    def later(self, *args: Any) -> None:
        raise RuntimeError("controller stopped")


@pytest.fixture
def host_parts():
    windows: dict = {}
    settings = FakeSettings()
    moved: List[tuple] = []
    controller = Controller()
    cell = {"controller": controller}

    def factory(kind: str, _host: BuildCheckinHost) -> FakeWindow:
        windows[kind] = FakeWindow(kind)
        return windows[kind]

    host = BuildCheckinHost(
        controller=lambda: cell["controller"],
        positions={"loading": [10, 20], "postgame": (30, 40), "bad": [1]},
        on_moved=lambda kind, x, y: moved.append((kind, x, y)),
        settings=settings,
        window_factory=factory,
    )
    return host, windows, settings, moved, cell


def test_windows_are_created_lazily_on_first_show(host_parts) -> None:
    host, windows, *_ = host_parts
    host.dispatch("update_loading", (LoadingCardModel(game_key="k|1"),))
    host.dispatch("hide_postgame", ("checkin-1", "later"))
    assert windows == {}
    host.dispatch("show_loading", (LoadingCardModel(game_key="k|1"),))
    assert list(windows) == [LOADING]
    assert host.window(LOADING) is windows[LOADING]


def test_updates_and_hides_only_reach_the_card_on_screen(host_parts) -> None:
    host, windows, *_ = host_parts
    first = LoadingCardModel(game_key="k|1")
    host.dispatch("show_loading", (first,))
    loading = windows[LOADING]
    host.dispatch("update_loading", (LoadingCardModel(game_key="k|0"),))
    host.dispatch("hide_loading", ("k|0", "new_game"))
    assert [name for name, _ in loading.calls] == ["show"]
    host.dispatch("update_loading", (first,))
    host.dispatch("hide_loading", ("k|1", "in_game"))
    assert [name for name, _ in loading.calls] == ["show", "update", "dismiss"]

    card = PostgameCardModel(card_id="checkin-2")
    host.dispatch("show_postgame", (card,))
    host.dispatch("update_postgame", (PostgameCardModel(card_id="checkin-1"),))
    host.dispatch("update_postgame", (card,))
    host.dispatch("hide_postgame", ("checkin-2", "confirmed"))
    assert [name for name, _ in windows[POSTGAME].calls] == ["show", "update", "dismiss"]


def test_prefs_and_binding_reach_the_settings_group(host_parts) -> None:
    host, _windows, settings, *_ = host_parts
    prefs = CheckinPrefs(enabled=False)
    host.dispatch("bind_controller", ())
    host.dispatch("update_prefs", (prefs,))
    assert settings.bound == 1
    assert settings.prefs == [prefs]


def test_unknown_methods_and_failures_never_escape(host_parts, caplog) -> None:
    host, windows, *_ = host_parts
    host.dispatch("__init__", ())
    host.dispatch("act", ("declare",))
    host.dispatch("show_loading", ())  # wrong arity
    assert "build_checkin_view_failed" in caplog.text
    assert windows == {}


def test_actions_route_to_the_controller_and_tolerate_its_absence(host_parts, caplog) -> None:
    host, _windows, _settings, _moved, cell = host_parts
    controller = cell["controller"]
    host.act("declare", "k|1", "custom:dt")
    host.act("no_such_action", 1)
    host.act("later", "checkin-1", "")  # raises inside the controller
    assert controller.calls == [("declare", ("k|1", "custom:dt"))]
    assert "build_checkin_action_failed" in caplog.text
    cell["controller"] = None
    host.act("declare", "k|1", "custom:dt")  # no controller yet: no-op
    assert controller.calls == [("declare", ("k|1", "custom:dt"))]


def test_positions_are_seeded_and_persisted_once_per_change(host_parts) -> None:
    host, _windows, _settings, moved, _cell = host_parts
    assert host.saved_position(LOADING) == (10, 20)
    assert host.saved_position(POSTGAME) == (30, 40)
    assert host.saved_position("bad") is None
    host.remember_position(LOADING, 10, 20)
    host.remember_position(LOADING, 1650.0, 120)
    host.remember_position(LOADING, 1650, 120)
    assert moved == [(LOADING, 1650, 120)]
    assert host.saved_position(LOADING) == (1650, 120)


def test_position_save_errors_are_contained(caplog) -> None:
    def broken(kind: str, x: int, y: int) -> None:
        raise OSError("disk full")

    host = BuildCheckinHost(controller=lambda: None, on_moved=broken, window_factory=lambda k, h: FakeWindow(k))
    host.remember_position(POSTGAME, 1, 2)
    assert host.saved_position(POSTGAME) == (1, 2)
    assert "build_checkin_position_save_failed" in caplog.text


def test_close_shuts_windows_and_ignores_later_calls(host_parts) -> None:
    host, windows, *_ = host_parts
    host.dispatch("show_loading", (LoadingCardModel(game_key="k|1"),))
    host.close()
    assert windows[LOADING].calls[-1] == ("shutdown", None)
    host.dispatch("show_postgame", (PostgameCardModel(card_id="checkin-1"),))
    assert POSTGAME not in windows


# --------------------------------------------------------------- placement


def test_default_position_is_right_edge_twelve_percent_down() -> None:
    available = (0, 0, 1920, 1040)  # taskbar at the bottom
    screen = (0, 0, 1920, 1080)
    x, y = default_card_position(available, screen, (320, 400))
    assert x == 1920 - 320 - CARD_MARGIN
    assert y == round(1080 * 0.12)


def test_default_position_on_a_secondary_screen_left_of_primary() -> None:
    screen = (-2560, 200, 2560, 1440)
    x, y = default_card_position(screen, screen, (360, 500))
    assert x == -360 - CARD_MARGIN
    assert y == 200 + round(1440 * 0.12)


def test_default_position_stays_inside_a_small_screen() -> None:
    available = (0, 0, 1280, 680)
    x, y = default_card_position(available, (0, 0, 1280, 720), (360, 640))
    assert 0 <= x <= 1280 - 360
    assert y == 680 - 640  # pushed up so the bottom stays visible
    x, y = default_card_position((0, 0, 300, 400), (0, 0, 300, 400), (360, 900))
    assert (x, y) == (0, 0)


def test_saved_position_on_a_live_screen_is_kept() -> None:
    screens = [(0, 0, 1920, 1040), (1920, 0, 2560, 1400)]
    assert clamp_card_position((2000, 100), (320, 300), screens) == (2000, 100)


def test_saved_position_partly_off_screen_is_pulled_back() -> None:
    screens = [(0, 0, 1920, 1040)]
    assert clamp_card_position((1800, -40), (320, 300), screens) == (1600, 0)
    assert clamp_card_position((-100, 900), (320, 300), screens) == (0, 740)


def test_saved_position_on_an_unplugged_monitor_is_dropped() -> None:
    screens = [(0, 0, 1920, 1040)]
    assert clamp_card_position((2500, 100), (320, 300), screens) is None
    # A sliver at the edge is not enough to grab the card again.
    assert clamp_card_position((1900, 100), (320, 300), screens) is None
    assert clamp_card_position((10, 10), (320, 300), []) is None


def test_saved_position_picks_the_screen_holding_most_of_the_card() -> None:
    screens = [(0, 0, 1920, 1080), (1920, 0, 1920, 1080)]
    assert clamp_card_position((1800, 1000), (320, 300), screens) == (1920, 780)


class Rect:
    def __init__(self, x: int, y: int, w: int, h: int) -> None:
        self._r = (x, y, w, h)

    def x(self) -> int:
        return self._r[0]

    def y(self) -> int:
        return self._r[1]

    def width(self) -> int:
        return self._r[2]

    def height(self) -> int:
        return self._r[3]


class Screen:
    def __init__(self, name: str, x: int, y: int, w: int, h: int, ratio: float = 1.0) -> None:
        self._name = name
        self._geometry = Rect(x, y, w, h)
        self._ratio = ratio

    def name(self) -> str:
        return self._name

    def geometry(self) -> Rect:
        return self._geometry

    def devicePixelRatio(self) -> float:  # noqa: N802 — Qt API
        return self._ratio


def test_screen_is_matched_by_device_name_first() -> None:
    primary = Screen("\\\\.\\DISPLAY1", 0, 0, 1920, 1080)
    second = Screen("\\\\.\\DISPLAY2", 1920, 0, 1707, 960, ratio=1.5)
    assert match_screen([primary, second], "\\\\.\\display2", (0, 0, 1, 1)) is second


def test_screen_is_matched_by_native_origin_on_mixed_dpi() -> None:
    # Qt keeps the origin in physical pixels and scales only the size.
    primary = Screen("Dell U2720Q", 0, 0, 2560, 1440, ratio=1.5)
    second = Screen("LG 27GL850", 3840, 0, 2560, 1440)
    assert match_screen([primary, second], "\\\\.\\DISPLAY9", (3840, 0, 6400, 1440)) is second
    assert match_screen([primary, second], None, (0, 0, 3840, 2160)) is primary


def test_screen_falls_back_to_containment_then_none() -> None:
    scaled = Screen("A", 0, 0, 1280, 720, ratio=1.5)  # 1920×1080 physical
    assert match_screen([scaled], None, (100, 100, 1800, 1000)) is scaled
    assert match_screen([scaled], None, (5000, 0, 6000, 1000)) is None
    assert match_screen([scaled], None, None) is None
    assert match_screen([], "\\\\.\\DISPLAY1", (0, 0, 1, 1)) is None

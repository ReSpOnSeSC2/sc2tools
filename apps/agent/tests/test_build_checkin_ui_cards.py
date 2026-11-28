"""The build check-in card windows (``ui/build_checkin_cards.py``),
rendered offscreen from the controller's view models."""

from __future__ import annotations

import os
from dataclasses import replace
from typing import Any, List, Optional, Tuple

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest  # noqa: E402

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtTest, QtWidgets  # noqa: E402

from sc2tools_agent.build_checkin.models import (  # noqa: E402
    PICKED_ON_WEB,
    RANDOMIZER_ROLLED,
    RANDOMIZER_WILL_ROLL,
    BuildOptionModel,
    LoadingCardModel,
    PostgameCardModel,
    RandomizerStripModel,
    format_record,
)
from sc2tools_agent.ui import build_checkin_cards as cards  # noqa: E402
from sc2tools_agent.ui import win32_window  # noqa: E402
from sc2tools_agent.ui.build_checkin_window import (  # noqa: E402
    CARD_MARGIN,
    LOADING,
    POSTGAME,
    BuildCheckinHost,
)

KEY = "Foo|Me|1790000000000"


def option(key: str, name: str, wins: int = 0, losses: int = 0, **flags: Any) -> BuildOptionModel:
    return BuildOptionModel(
        key=key, name=name, source="catalog", group=flags.pop("group", "yours"),
        record=format_record(wins, losses, wins + losses), games=wins + losses,
        wins=wins, losses=losses, **flags,
    )


FEATURED = (
    option("custom:dt-3-gate", "DT into 3 Gate", 7, 5),
    option("pvz-2-stargate-phoenix", "PvZ - 2 Stargate Phoenix", 3, 2, rolled=True),
    option("pvz-chargelot", "PvZ - Chargelot All-in", 1, 0, usual=True),
)
MORE = tuple(option(f"catalog-{i}", f"Catalog build {i}", group="catalog") for i in range(8))


def loading_model(**changes: Any) -> LoadingCardModel:
    base = LoadingCardModel(
        game_key=KEY, title="PvZ · vs Foo", matchup="PvZ", opponent_name="Foo",
        waiting_for_matchup=False, featured=FEATURED, more=MORE,
        randomizer=RandomizerStripModel(label=RANDOMIZER_WILL_ROLL, can_roll_now=True),
    )
    return replace(base, **changes)


def postgame_model(**changes: Any) -> PostgameCardModel:
    base = PostgameCardModel(
        card_id="checkin-1", game_key=KEY, title="Victory · PvZ · vs Foo",
        result="Victory", result_tone="success", matchup="PvZ", opponent_name="Foo",
        featured=tuple(replace(o, suggested=o.key == "pvz-chargelot") for o in FEATURED),
        more=MORE, selection="pvz-2-stargate-phoenix", reason="randomizer",
        reason_label="Randomizer roll",
        detected_label="Replay classified as: PvZ - Macro Transition (Unclassified)",
    )
    return replace(base, **changes)


class Recorder:
    """Stands in for the controller: records every action call."""

    def __init__(self) -> None:
        self.calls: List[Tuple[str, tuple]] = []

    def __getattr__(self, name: str):
        return lambda *args: self.calls.append((name, args))

    def named(self, name: str) -> List[tuple]:
        return [args for call, args in self.calls if call == name]


class Win32Spy:
    def __init__(self) -> None:
        self.excluded: List[Optional[int]] = []
        self.topmost: List[Optional[int]] = []
        self.restored: List[Tuple[Optional[int], Optional[int]]] = []
        self.foreground: Optional[int] = None
        self.sc2: Optional[int] = None
        self.monitor: Optional[win32_window.MonitorInfo] = None


@pytest.fixture
def app():
    return QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


@pytest.fixture
def w32(monkeypatch: pytest.MonkeyPatch) -> Win32Spy:
    spy = Win32Spy()
    monkeypatch.setattr(win32_window, "exclude_from_capture", lambda h: spy.excluded.append(h) or 0x11)
    monkeypatch.setattr(win32_window, "keep_topmost", lambda h: spy.topmost.append(h) or True)
    monkeypatch.setattr(win32_window, "foreground_window", lambda: spy.foreground)
    monkeypatch.setattr(win32_window, "find_sc2_window", lambda: spy.sc2)
    monkeypatch.setattr(win32_window, "monitor_of_window", lambda h: spy.monitor)
    monkeypatch.setattr(
        win32_window, "restore_foreground", lambda own, prev: spy.restored.append((own, prev)) or True,
    )
    return spy


@pytest.fixture
def harness(app, w32):
    controller = Recorder()
    moved: List[tuple] = []
    host = BuildCheckinHost(
        controller=lambda: controller,
        on_moved=lambda kind, x, y: moved.append((kind, x, y)),
    )
    yield host, controller, moved, w32
    host.close()
    for kind in (LOADING, POSTGAME):
        window = host.existing_window(kind)
        if window is not None:
            window.deleteLater()
    app.processEvents()


def labels_text(widget: QtWidgets.QWidget) -> List[str]:
    return [
        label.text() for label in widget.findChildren(QtWidgets.QLabel)
        if label.isVisibleTo(widget) and label.text()
    ]


def visible_texts(widget: QtWidgets.QWidget) -> str:
    buttons = [
        b.text() for b in widget.findChildren(QtWidgets.QAbstractButton) if b.isVisibleTo(widget)
    ]
    return " | ".join(labels_text(widget) + buttons)


# =================================================================== loading


def show_loading(host: BuildCheckinHost, model: Optional[LoadingCardModel] = None):
    host.dispatch("show_loading", (model or loading_model(),))
    return host.window(LOADING)


def test_loading_card_window_flags_and_attributes(harness) -> None:
    host, *_ = harness
    window = show_loading(host)
    flags = window.windowFlags()
    for flag in (
        QtCore.Qt.Tool, QtCore.Qt.WindowStaysOnTopHint,
        QtCore.Qt.FramelessWindowHint, QtCore.Qt.WindowDoesNotAcceptFocus,
    ):
        assert flags & flag == flag
    assert window.testAttribute(QtCore.Qt.WA_ShowWithoutActivating)
    assert window.testAttribute(QtCore.Qt.WA_TranslucentBackground)
    assert window.parent() is None
    card = window.findChild(QtWidgets.QFrame, "card")
    assert card is window.card and card.parent() is window
    assert window.isVisible()


def test_end_card_flags_allow_focus_but_show_without_activating(harness) -> None:
    host, *_ = harness
    host.dispatch("show_postgame", (postgame_model(),))
    window = host.window(POSTGAME)
    flags = window.windowFlags()
    for flag in (QtCore.Qt.Tool, QtCore.Qt.WindowStaysOnTopHint, QtCore.Qt.FramelessWindowHint):
        assert flags & flag == flag
    assert not flags & QtCore.Qt.WindowDoesNotAcceptFocus
    assert window.testAttribute(QtCore.Qt.WA_ShowWithoutActivating)
    assert window.testAttribute(QtCore.Qt.WA_TranslucentBackground)
    assert window.parent() is None


def test_flags_are_never_toggled_at_runtime(harness, app) -> None:
    host, *_ = harness
    window = show_loading(host)
    flags, native = window.windowFlags(), window.winId()
    host.dispatch("update_loading", (loading_model(collapsed=True, locked_label="Locked in: X"),))
    host.dispatch("hide_loading", (KEY, "in_game"))
    show_loading(host, loading_model(game_key="Foo|Me|2"))
    app.processEvents()
    assert window.windowFlags() == flags
    assert window.winId() == native


def test_loading_card_renders_header_strip_and_rows(harness) -> None:
    host, *_ = harness
    window = show_loading(host, loading_model(show_intro=True))
    text = visible_texts(window)
    assert "WHAT'S THE PLAN?" in text
    assert "PvZ · vs Foo" in text
    assert "New: tell us your plan" in text and "Got it" in text
    assert RANDOMIZER_WILL_ROLL in text and "Randomize" in text
    assert "YOUR BUILDS" in text
    assert "More builds…  (8)" in text
    assert "Not now" in text and "Don't ask at loading" in text
    featured, more = window.builds.keys()
    assert featured == [o.key for o in FEATURED]
    assert more == [o.key for o in MORE]
    row = window.builds.row("custom:dt-3-gate")
    assert (row.name, row.record) == ("DT into 3 Gate", "7–5")
    assert row.accessibleName() == "DT into 3 Gate, 7 wins, 5 losses"
    assert window.builds.row("pvz-2-stargate-phoenix").chips == [("Rolled", "rolled")]
    assert window.builds.row("pvz-chargelot").chips == [("Usual", "usual")]
    # More builds… is collapsed until asked for, then scrolls.
    assert not window.builds.more_area.isVisibleTo(window)
    window.builds.more_toggle.click()
    assert window.builds.more_area.isVisibleTo(window)
    assert window.builds.more_area.height() <= 6 * 32


def test_loading_card_has_no_text_input_and_never_takes_focus(harness) -> None:
    host, *_ = harness
    window = show_loading(host, loading_model(show_intro=True))
    for cls in (QtWidgets.QLineEdit, QtWidgets.QPlainTextEdit, QtWidgets.QTextEdit):
        assert window.findChildren(cls) == []
    for widget in window.findChildren(QtWidgets.QAbstractButton):
        assert widget.focusPolicy() == QtCore.Qt.NoFocus, widget.text()
    assert window.builds.more_area.focusPolicy() == QtCore.Qt.NoFocus


def test_server_and_user_strings_are_plain_text(harness) -> None:
    host, *_ = harness
    window = show_loading(host, loading_model(title="PvZ · vs <b>Foo</b>"))
    for label in window.findChildren(QtWidgets.QLabel):
        assert label.textFormat() == QtCore.Qt.PlainText, label.objectName()
    assert window.title.text() == "PvZ · vs <b>Foo</b>"
    host.dispatch("show_postgame", (postgame_model(title="Victory · PvZ · vs <i>x</i>"),))
    end = host.window(POSTGAME)
    for label in end.findChildren(QtWidgets.QLabel):
        assert label.textFormat() == QtCore.Qt.PlainText, label.objectName()
    assert end.title.text() == "PvZ · vs <i>x</i>"


def test_loading_card_actions_reach_the_controller(harness) -> None:
    host, controller, *_ = harness
    window = show_loading(host, loading_model(show_intro=True))
    QtTest.QTest.mouseClick(window.builds.row("custom:dt-3-gate"), QtCore.Qt.LeftButton)
    window.roll_now.click()
    window.not_now.click()
    window.dont_ask.click()
    window.intro_dismiss.click()
    assert controller.calls == [
        ("declare", (KEY, "custom:dt-3-gate")),
        ("roll_now", (KEY,)),
        ("not_now", (KEY,)),
        ("disable", ("loading",)),
        ("dismiss_intro", ()),
    ]


def test_rolled_strip_marks_the_row_in_place(harness) -> None:
    host, *_ = harness
    window = show_loading(host)
    before = window.builds.keys()
    rolled = tuple(replace(o, rolled=o.key == "custom:dt-3-gate") for o in FEATURED)
    host.dispatch("update_loading", (loading_model(
        featured=rolled,
        randomizer=RandomizerStripModel(
            label=RANDOMIZER_ROLLED.format(name="DT into 3 Gate"),
            rolled_key="custom:dt-3-gate", rolled_name="DT into 3 Gate",
        ),
    ),))
    assert window.strip_label.text() == "🎲 Randomizer: DT into 3 Gate"
    assert not window.roll_now.isVisibleTo(window)
    assert window.builds.keys() == before
    assert window.builds.row("custom:dt-3-gate").chips == [("Rolled", "rolled")]
    assert window.builds.row("pvz-2-stargate-phoenix").chips == []


def test_rows_never_reorder_after_first_paint(harness) -> None:
    host, *_ = harness
    window = show_loading(host)
    reshuffled = tuple(reversed(FEATURED)) + (option("new-build", "New build", 1, 1),)
    renamed = tuple(
        replace(o, record="9–9") if o.key == "pvz-chargelot" else o for o in reshuffled
    )
    host.dispatch("update_loading", (loading_model(featured=renamed, more=tuple(reversed(MORE))),))
    featured, more = window.builds.keys()
    assert featured == [o.key for o in FEATURED] + ["new-build"]
    assert more == [o.key for o in MORE]
    assert window.builds.row("pvz-chargelot").record == "9–9"
    # A different game starts from scratch.
    show_loading(host, loading_model(game_key="Foo|Me|2", featured=reshuffled))
    assert window.builds.keys()[0] == [o.key for o in reshuffled]


def test_waiting_for_matchup_then_filling_in(harness) -> None:
    host, *_ = harness
    window = show_loading(host, loading_model(
        title="vs Foo", matchup=None, waiting_for_matchup=True,
        featured=(), more=(), randomizer=None,
    ))
    text = visible_texts(window)
    assert "Waiting for matchup…" in text
    assert not window.builds.isVisibleTo(window)
    small = window.height()
    host.dispatch("update_loading", (loading_model(),))
    assert not window.waiting.isVisibleTo(window)
    assert window.builds.isVisibleTo(window)
    assert window.height() > small


def test_loading_status_and_options_loading_states(harness) -> None:
    host, *_ = harness
    window = show_loading(host, loading_model(featured=(), more=(), options_loading=True, randomizer=None))
    assert window.loading.isVisibleTo(window)
    host.dispatch("update_loading", (loading_model(
        featured=(), more=(), status="Couldn't load your builds. We'll ask after the game.",
    ),))
    assert not window.loading.isVisibleTo(window)
    assert window.status.isVisibleTo(window)
    assert window.status.property("tone") == "warning"
    assert not window.empty.isVisibleTo(window)


def test_locked_in_collapses_to_a_slim_bar_with_change(harness) -> None:
    host, controller, *_ = harness
    window = show_loading(host)
    full_height = window.height()
    host.dispatch("update_loading", (loading_model(
        collapsed=True, locked_label="Locked in: DT into 3 Gate",
        locked_key="custom:dt-3-gate", can_change=True, saving=True,
    ),))
    assert not window.full.isVisibleTo(window)
    assert window.bar.isVisibleTo(window)
    assert window.locked.text() == "Locked in: DT into 3 Gate"
    assert window.saving.isVisibleTo(window)
    assert window.height() < full_height / 3
    window.change.click()
    assert controller.calls == [("undeclare", (KEY,))]
    host.dispatch("update_loading", (loading_model(
        collapsed=True, locked_label=PICKED_ON_WEB.format(name="DT into 3 Gate"),
        declared_elsewhere=True, can_change=True,
    ),))
    assert window.locked.text() == "Picked on sc2tools.com: DT into 3 Gate"
    assert not window.saving.isVisibleTo(window)
    # Change reopens the list with the same rows in the same order.
    host.dispatch("update_loading", (loading_model(),))
    assert window.full.isVisibleTo(window)
    assert window.builds.keys()[0] == [o.key for o in FEATURED]


def test_hide_only_hides_the_matching_game(harness) -> None:
    host, *_ = harness
    window = show_loading(host)
    host.dispatch("hide_loading", ("Foo|Me|0", "new_game"))
    assert window.isVisible()
    host.dispatch("hide_loading", (KEY, "in_game"))
    assert not window.isVisible()
    host.dispatch("update_loading", (loading_model(),))
    assert not window.isVisible()


# ==================================================================== win32


def test_capture_exclusion_and_topmost_while_visible(harness) -> None:
    host, _controller, _moved, w32 = harness
    window = show_loading(host)
    hwnd = window.native_handle()
    assert hwnd and w32.excluded == [hwnd]
    assert w32.topmost == [hwnd]
    assert window._topmost_timer.isActive()
    assert window._topmost_timer.interval() == 1000
    window._tick()
    assert w32.topmost == [hwnd, hwnd]
    host.dispatch("hide_loading", (KEY, "menu"))
    assert not window._topmost_timer.isActive()
    show_loading(host)
    assert w32.excluded == [hwnd]  # once per native window


def test_end_card_hands_focus_back_to_the_window_it_took_it_from(harness) -> None:
    host, _controller, _moved, w32 = harness
    w32.foreground = 4242  # SC2, when the card appears
    host.dispatch("show_postgame", (postgame_model(),))
    window = host.window(POSTGAME)
    w32.foreground = 5151  # the player alt-tabbed, then clicked the card
    window._tick()
    host.dispatch("hide_postgame", ("checkin-1", "later"))
    assert w32.restored == [(window.native_handle(), 5151)]
    assert not window.isVisible()


def test_loading_card_never_restores_focus(harness) -> None:
    host, _controller, _moved, w32 = harness
    w32.foreground = 4242
    show_loading(host)
    host.dispatch("hide_loading", (KEY, "in_game"))
    assert w32.restored == []


# ================================================================ placement


def test_default_placement_is_right_edge_of_the_screen(harness) -> None:
    host, *_ = harness
    window = show_loading(host)
    screen = QtGui.QGuiApplication.primaryScreen()
    available, full = screen.availableGeometry(), screen.geometry()
    expected_x = available.x() + available.width() - window.width() - CARD_MARGIN
    assert window.x() == max(available.x(), expected_x)
    assert window.y() == max(available.y(), min(
        full.y() + round(full.height() * 0.12),
        available.y() + available.height() - window.height(),
    ))


def test_placement_follows_the_sc2_monitor(harness, monkeypatch) -> None:
    host, _controller, _moved, w32 = harness
    primary = QtGui.QGuiApplication.primaryScreen()
    w32.sc2 = 77
    geometry = primary.geometry()
    w32.monitor = win32_window.MonitorInfo(
        "nope", (geometry.x(), geometry.y(), geometry.right() + 1, geometry.bottom() + 1),
        (0, 0, 0, 0),
    )
    picked = []
    real = cards.match_screen
    monkeypatch.setattr(cards, "match_screen", lambda *a: picked.append(a[1:]) or real(*a))
    show_loading(host)
    assert picked == [("nope", w32.monitor.bounds)]


def test_saved_position_is_reused_and_drag_persists(harness, app) -> None:
    host, _controller, moved, _w32 = harness
    host.remember_position(LOADING, 40, 50)
    moved.clear()
    window = show_loading(host)
    assert (window.x(), window.y()) == (40, 50)

    def send(kind: QtCore.QEvent.Type, local: QtCore.QPoint, buttons) -> None:
        global_pos = window.header.mapToGlobal(local)
        event = QtGui.QMouseEvent(
            kind, QtCore.QPointF(local), QtCore.QPointF(global_pos),
            QtCore.Qt.LeftButton, buttons, QtCore.Qt.NoModifier,
        )
        QtWidgets.QApplication.sendEvent(window.header, event)

    send(QtCore.QEvent.MouseButtonPress, QtCore.QPoint(10, 10), QtCore.Qt.LeftButton)
    send(QtCore.QEvent.MouseMove, QtCore.QPoint(40, 30), QtCore.Qt.LeftButton)
    assert (window.x(), window.y()) == (70, 70)
    send(QtCore.QEvent.MouseButtonRelease, QtCore.QPoint(40, 30), QtCore.Qt.NoButton)
    assert moved == [(LOADING, 70, 70)]
    assert host.saved_position(LOADING) == (70, 70)
    # A click without movement is not a drag.
    send(QtCore.QEvent.MouseButtonPress, QtCore.QPoint(5, 5), QtCore.Qt.LeftButton)
    send(QtCore.QEvent.MouseButtonRelease, QtCore.QPoint(5, 5), QtCore.Qt.NoButton)
    assert moved == [(LOADING, 70, 70)]


def test_off_screen_saved_position_falls_back_to_default(harness) -> None:
    host, *_ = harness
    host.remember_position(POSTGAME, 90000, 90000)
    host.dispatch("show_postgame", (postgame_model(),))
    window = host.window(POSTGAME)
    available = QtGui.QGuiApplication.primaryScreen().availableGeometry()
    assert available.contains(window.geometry().topLeft())

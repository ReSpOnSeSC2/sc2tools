"""The Randomizer draw as a still on the loading card (``ui/build_checkin_draw.py``)
and its way there through the view proxy and the card host."""

from __future__ import annotations

import os
from textwrap import dedent
from typing import Any, List, Tuple

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest  # noqa: E402

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui  # noqa: E402

from sc2tools_agent.build_checkin.models import LOCKED_IN, RANDOMIZER_ROLLED, RandomizerStripModel  # noqa: E402
from sc2tools_agent.build_checkin.randomizer_draw import DrawStep, RandomizerDraw  # noqa: E402
from sc2tools_agent.ui.build_checkin_draw import UNITS_ALONE_LABEL, step_line, units_line  # noqa: E402
from sc2tools_agent.ui.build_checkin_window import LOADING, BuildCheckinHost, CheckinViewProxy  # noqa: E402
from tests._gui_offscreen import run_gui_check  # noqa: E402
from tests.test_build_checkin_ui_cards import KEY, Recorder, loading_model  # noqa: E402
from tests.test_build_checkin_ui_cards import app, w32  # noqa: E402,F401 - pytest fixtures
from tests.test_companion_resize_shell import THEMED_SETUP  # noqa: E402

PICK = "pvp-2-gate-expand"
ROLLED = RandomizerStripModel(
    label=RANDOMIZER_ROLLED.format(name="PvP - 2 Gate Expand"), rolled_key=PICK,
    rolled_name="PvP - 2 Gate Expand", can_play=True, can_reroll=True,
)
STEPS = (DrawStep("Pylon", "0:18", "14"), DrawStep("Gateway", "0:40", "16"), DrawStep("CyberneticsCore", "1:15"))
PAIR = RandomizerDraw(game_key=KEY, build_key=PICK, steps=STEPS, units=("Adept", "Stalker"), race="Protoss")
ALONE = RandomizerDraw(game_key=KEY, build_key=None, units=("Reaper", "Hellion"), race="Terran")


@pytest.fixture
def host(app, w32):
    card_host = BuildCheckinHost(controller=lambda: Recorder())
    yield card_host
    card_host.close()


def rolled(host: BuildCheckinHost, draw: RandomizerDraw = PAIR, **changes: Any):
    host.dispatch("show_loading", (loading_model(matchup="PvP", randomizer=ROLLED, **changes),))
    host.dispatch("show_randomizer_draw", (draw,))
    return host.window(LOADING)


def test_the_still_lists_the_first_steps_then_the_opening_pair(host) -> None:
    window = rolled(host)
    still = window.strip_draw
    assert still.isVisibleTo(window)
    assert still.steps.text() == "0:18 \N{MIDDLE DOT} 14 Pylon\n0:40 \N{MIDDLE DOT} 16 Gateway\n1:15 \N{MIDDLE DOT} Cybernetics Core"
    assert still.units.text() == "Opening pair: Gate 1 Adept, Gate 2 Stalker"
    layout = still.layout()
    assert layout.indexOf(still.steps) < layout.indexOf(still.units)


def test_a_one_gateway_build_names_its_first_unit_and_other_builds_show_steps_only(host) -> None:
    window = rolled(host, RandomizerDraw(game_key=KEY, build_key=PICK, units=("Stalker",)))
    assert window.strip_draw.units.text() == "First unit: Stalker"
    assert not window.strip_draw.steps.isVisibleTo(window)
    host.dispatch("show_randomizer_draw", (RandomizerDraw(game_key=KEY, build_key=PICK, steps=STEPS[:1]),))
    assert window.strip_draw.steps.text() == "0:18 \N{MIDDLE DOT} 14 Pylon"
    assert not window.strip_draw.units.isVisibleTo(window)


@pytest.mark.parametrize("draw", [
    RandomizerDraw(game_key="Other|Me|1790000000999", build_key=PICK, units=("Zealot",)),
    RandomizerDraw(game_key=KEY, build_key="pvp-proxy-gate", units=("Zealot",)),
    RandomizerDraw(game_key=KEY, build_key=PICK),
], ids=["another game", "another pick", "nothing to show"])
def test_a_draw_that_is_not_this_picks_or_is_empty_stays_hidden(host, draw: RandomizerDraw) -> None:
    window = rolled(host, draw)
    assert not window.strip_draw.isVisibleTo(window)


def test_the_locked_in_bar_keeps_the_draw_of_the_played_pick(host) -> None:
    window = rolled(host)

    def lock(key: str) -> None:
        host.dispatch("update_loading", (loading_model(
            matchup="PvP", randomizer=None, collapsed=True, locked_key=key,
            locked_label=LOCKED_IN.format(name="Some build"),
        ),))

    lock(PICK)
    assert window.bar.isVisibleTo(window) and window.bar_draw.isVisibleTo(window)
    assert window.bar_draw.units.text() == "Opening pair: Gate 1 Adept, Gate 2 Stalker"
    lock("pvp-blink-stalkers")
    assert not window.bar_draw.isVisibleTo(window)


def test_updates_keep_the_draw_and_a_reroll_drops_it(host) -> None:
    window = rolled(host)
    host.dispatch("update_loading", (loading_model(matchup="PvP", randomizer=ROLLED, status="Saving"),))
    assert window.strip_draw.isVisibleTo(window)
    reroll = RandomizerStripModel(label="", rolled_key="pvp-proxy-gate", rolled_name="PvP - Proxy Gate")
    host.dispatch("update_loading", (loading_model(matchup="PvP", randomizer=reroll),))
    assert not window.strip_draw.isVisibleTo(window)


def test_turning_the_randomizer_off_takes_the_draw_from_the_strip_and_the_bar(host) -> None:
    window = rolled(host)
    gates = {"randomizer": False, "preGameSelector": True, "postGameSelector": True}
    host.set_feature_gates(gates)
    assert not window.strip.isVisibleTo(window)
    assert not window.strip_draw.isVisibleTo(window)
    # The row the widget rolled stays marked, and playing it collapses the card.
    host.dispatch("update_loading", (loading_model(
        matchup="PvP", randomizer=ROLLED, collapsed=True, locked_key=PICK,
        locked_label=LOCKED_IN.format(name="PvP - 2 Gate Expand"),
    ),))
    assert window.bar.isVisibleTo(window)
    assert not window.bar_draw.isVisibleTo(window)
    host.set_feature_gates({**gates, "randomizer": True})
    assert window.bar_draw.isVisibleTo(window), "turning it back on shows the draw already read"


def test_screen_readers_hear_the_steps_themselves(host) -> None:
    steps = rolled(host).strip_draw.steps
    spoken = QtGui.QAccessible.queryAccessibleInterface(steps)
    assert spoken.text(QtGui.QAccessible.Text.Name) == steps.text()
    assert spoken.text(QtGui.QAccessible.Text.Description) == "First steps of the drawn build"


def test_a_draw_arriving_after_the_card_shows_grows_the_card_to_fit(host) -> None:
    host.dispatch("show_loading", (loading_model(matchup="PvP", randomizer=ROLLED),))
    window = host.window(LOADING)
    before = window.content_scroll.height()
    host.dispatch("show_randomizer_draw", (PAIR,))
    assert window.content_scroll.height() > before
    assert window.content_scroll.verticalScrollBar().maximum() == 0
    viewport = window.content_scroll.viewport()
    for control in (window.strip_draw.units, window.not_now, window.dont_ask):
        top = control.mapTo(viewport, QtCore.QPoint()).y()
        assert 0 <= top and top + control.height() <= viewport.height(), (control.text(), top, viewport.height())


def test_the_still_has_no_timer_or_animation_of_its_own(host) -> None:
    window = rolled(host)
    for still in (window.strip_draw, window.bar_draw):
        assert still.findChildren(QtCore.QTimer) == []
        assert still.findChildren(QtCore.QAbstractAnimation) == []


def test_step_lines_leave_out_what_the_build_does_not_store() -> None:
    assert step_line(DrawStep("Pylon", None, "14")) == "14 Pylon"
    assert step_line(DrawStep("WarpGateResearch", "1:40")) == "1:40 \N{MIDDLE DOT} Warp Gate Research"
    assert units_line(("Sentry",), "Protoss") == "First unit: Sentry"


def test_only_a_protoss_pair_names_its_gateways() -> None:
    assert units_line(("Zealot", "Adept"), "Protoss") == "Opening pair: Gate 1 Zealot, Gate 2 Adept"
    assert units_line(("Reaper", "Hellion"), "Terran") == "Opening pair: Reaper, then Hellion"
    assert units_line(("Zergling",), "Zerg") == "First unit: Zergling"


class FakeDraws:
    def __init__(self) -> None:
        self.models: List[Any] = []

    def request(self, model: Any, deliver: Any) -> None:
        self.models.append(model)
        deliver(PAIR)


def test_the_proxy_asks_for_the_draw_and_forwards_it_to_the_gui_thread() -> None:
    sent: List[Tuple[str, tuple]] = []
    proxy = CheckinViewProxy(lambda method, args: sent.append((method, args)))
    model = loading_model(matchup="PvP", randomizer=ROLLED)
    proxy.show_loading(model)
    assert [method for method, _ in sent] == ["show_loading"], "no reader bound yet"
    draws = FakeDraws()
    proxy.bind_randomizer_draws(draws)
    proxy.update_loading(model)
    assert draws.models == [model]
    assert sent[1:] == [("update_loading", (model,)), ("show_randomizer_draw", (PAIR,))]


@pytest.mark.parametrize("scale", ["1.25", "1.5"])
def test_the_card_with_its_draw_fits_without_sideways_scrolling(tmp_path, monkeypatch, scale) -> None:
    monkeypatch.setenv("QT_SCALE_FACTOR", scale)
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "9") + dedent("""
        from sc2tools_agent.build_checkin.models import LoadingCardModel, RandomizerStripModel
        from sc2tools_agent.build_checkin.randomizer_draw import DrawStep, RandomizerDraw
        from sc2tools_agent.ui.build_checkin_window import BuildCheckinHost, LOADING

        host = BuildCheckinHost(controller=lambda: None)
        strip = RandomizerStripModel(label="Randomizer: PvP - 2 Gate Expand into Robotics Facility", rolled_key="pick",
                                     rolled_name="PvP - 2 Gate Expand", can_play=True, can_reroll=True)
        host.dispatch("show_loading", (LoadingCardModel(game_key="g", title="PvP", matchup="PvP",
                                                        waiting_for_matchup=False, randomizer=strip),))
        steps = tuple(DrawStep("CyberneticsCore" * 3, "12:34", "\\N{ALMOST EQUAL TO}199") for _ in range(4))
        host.dispatch("show_randomizer_draw", (RandomizerDraw("g", "pick", steps, ("Sentry", "Stalker"), "Protoss"),))
        app.processEvents()
        card = host.window(LOADING)
        assert card.strip_draw.isVisible()
        assert card.content_scroll.horizontalScrollBar().maximum() == 0
        for control in (card.strip_draw.units, card.play_roll, card.reroll):
            card.content_scroll.ensureWidgetVisible(control)
            app.processEvents()
            viewport = card.content_scroll.viewport()
            bounds = QtCore.QRect(control.mapTo(viewport, QtCore.QPoint()), control.size())
            assert viewport.rect().contains(bounds), (control.objectName(), bounds, viewport.rect())
        screen = card.screen().availableGeometry()
        assert card.height() <= screen.height() and card.width() <= screen.width()
        host.close()
    """))


def units_alone(host: BuildCheckinHost, **changes: Any):
    host.dispatch("show_loading", (loading_model(matchup="TvZ", randomizer=None, **changes),))
    host.dispatch("show_randomizer_draw", (ALONE,))
    return host.window(LOADING)


def test_units_drawn_without_a_build_get_the_randomizer_row_with_no_actions(host) -> None:
    window = units_alone(host)
    assert window.strip.isVisibleTo(window) and window.strip_label.text() == UNITS_ALONE_LABEL
    assert window.strip_draw.units.text() == "Opening pair: Reaper, then Hellion"
    assert not window.strip_draw.steps.isVisibleTo(window)
    for action in (window.roll_now, window.play_roll, window.reroll):
        assert not action.isVisibleTo(window)


def test_units_drawn_alone_stay_in_the_bar_whatever_build_is_locked_in(host) -> None:
    locked = LOCKED_IN.format(name="TvZ - 3 CC Bio")
    window = units_alone(host, collapsed=True, locked_key="tvz-3-cc-bio", locked_label=locked)
    assert window.bar.isVisibleTo(window) and window.bar_draw.units.text() == "Opening pair: Reaper, then Hellion"


def test_units_drawn_alone_wait_for_their_draw_and_hide_with_the_randomizer(host) -> None:
    host.dispatch("show_loading", (loading_model(matchup="TvZ", randomizer=None),))
    window = host.window(LOADING)
    assert not window.strip.isVisibleTo(window), "no row before the draw arrives"
    host.dispatch("show_randomizer_draw", (ALONE,))
    assert window.strip.isVisibleTo(window)
    host.set_feature_gates({"randomizer": False, "preGameSelector": True, "postGameSelector": True})
    assert not window.strip.isVisibleTo(window)
    rolled_pick = RandomizerStripModel(label="", rolled_key=PICK, rolled_name="Pick")
    host.set_feature_gates({"randomizer": True, "preGameSelector": True, "postGameSelector": True})
    host.dispatch("update_loading", (loading_model(matchup="TvZ", randomizer=rolled_pick),))
    assert not window.strip_draw.isVisibleTo(window), "a saved pick shows its own draw, not the units alone"


def test_units_drawn_alone_fit_the_smallest_card_without_sideways_scrolling(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("QT_SCALE_FACTOR", "1.5")
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "9") + dedent("""
        from sc2tools_agent.build_checkin.models import LoadingCardModel
        from sc2tools_agent.build_checkin.randomizer_draw import RandomizerDraw
        from sc2tools_agent.ui.build_checkin_window import BuildCheckinHost, LOADING

        host = BuildCheckinHost(controller=lambda: None)
        host.dispatch("show_loading", (LoadingCardModel(game_key="g", title="TvZ", matchup="TvZ",
                                                        waiting_for_matchup=False, randomizer=None),))
        host.dispatch("show_randomizer_draw", (RandomizerDraw("g", None, (), ("Siege Tank", "Widow Mine"), "Terran"),))
        app.processEvents()
        card = host.window(LOADING)
        assert card.strip.isVisible() and card.strip_draw.isVisible()
        assert card.content_scroll.horizontalScrollBar().maximum() == 0
        for control in (card.strip_label, card.strip_draw.units):
            card.content_scroll.ensureWidgetVisible(control)
            app.processEvents()
            viewport = card.content_scroll.viewport()
            bounds = QtCore.QRect(control.mapTo(viewport, QtCore.QPoint()), control.size())
            assert viewport.rect().contains(bounds), (control.objectName(), bounds, viewport.rect())
        host.close()
    """))

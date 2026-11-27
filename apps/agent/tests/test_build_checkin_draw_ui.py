"""The Randomizer draw as a still on the loading card (``ui/build_checkin_draw.py``)
and its way there through the view proxy and the card host."""

from __future__ import annotations

import os
from textwrap import dedent
from typing import Any, List, Tuple

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest  # noqa: E402

pytest.importorskip("PySide6")
from PySide6 import QtCore  # noqa: E402

from sc2tools_agent.build_checkin.models import LOCKED_IN, RANDOMIZER_ROLLED, RandomizerStripModel  # noqa: E402
from sc2tools_agent.build_checkin.randomizer_draw import DrawStep, RandomizerDraw  # noqa: E402
from sc2tools_agent.ui.build_checkin_draw import step_line, units_line  # noqa: E402
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
PAIR = RandomizerDraw(game_key=KEY, build_key=PICK, steps=STEPS, units=("Adept", "Stalker"))


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


def test_turning_the_randomizer_off_takes_the_draw_with_the_strip(host) -> None:
    window = rolled(host)
    host.set_feature_gates({"randomizer": False, "preGameSelector": True, "postGameSelector": True})
    assert not window.strip.isVisibleTo(window)
    assert not window.strip_draw.isVisibleTo(window)


def test_the_still_has_no_timer_or_animation_of_its_own(host) -> None:
    window = rolled(host)
    for still in (window.strip_draw, window.bar_draw):
        assert still.findChildren(QtCore.QTimer) == []
        assert still.findChildren(QtCore.QAbstractAnimation) == []


def test_step_lines_leave_out_what_the_build_does_not_store() -> None:
    assert step_line(DrawStep("Pylon", None, "14")) == "14 Pylon"
    assert step_line(DrawStep("WarpGateResearch", "1:40")) == "1:40 \N{MIDDLE DOT} Warp Gate Research"
    assert units_line(("Sentry",)) == "First unit: Sentry"


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
        host.dispatch("show_randomizer_draw", (RandomizerDraw("g", "pick", steps, ("Sentry", "Stalker")),))
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

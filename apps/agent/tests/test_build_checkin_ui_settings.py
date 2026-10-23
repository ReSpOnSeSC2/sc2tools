"""Settings tab group "Build check-in" (``ui/build_checkin_settings.py``)
and its wiring into ``GuiUI`` / the main window."""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any, List, Optional

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest  # noqa: E402

pytest.importorskip("PySide6")
from PySide6 import QtWidgets  # noqa: E402

from sc2tools_agent.build_checkin.models import CheckinPrefs  # noqa: E402
from sc2tools_agent.ui.build_checkin_settings import (  # noqa: E402
    HINT_CONNECTING,
    HINT_LOADING,
    HINT_NO_LIVE,
    HINT_READY,
    HINT_SAVE_FAILED,
    HINT_UNSUPPORTED,
    CheckinSettingsGroup,
)
from sc2tools_agent.ui.build_checkin_window import BuildCheckinHost, CheckinViewProxy  # noqa: E402
from tests.build_checkin_fakes import Harness, api_error  # noqa: E402


class Controller:
    def __init__(self, available: Optional[bool] = True) -> None:
        self.available = available
        self.changes: List[dict] = []
        self.refreshes = 0

    def set_prefs(self, **change: bool) -> None:
        self.changes.append(change)

    def refresh_prefs(self) -> None:
        self.refreshes += 1


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def app():
    return QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


@pytest.fixture
def make(app):
    made: List[CheckinSettingsGroup] = []

    def build(controller: Any = None, *, available: bool = True, clock: Any = None):
        cell = {"controller": controller}
        group = CheckinSettingsGroup(
            controller=lambda: cell["controller"], available=available,
            **({"clock": clock} if clock else {}),
        )
        group.cell = cell
        made.append(group)
        return group

    yield build
    for group in made:
        group.deleteLater()
    app.processEvents()


def boxes(group: CheckinSettingsGroup):
    return group.enabled_box, group.loading_box, group.after_box


def test_no_live_session_disables_the_group_with_a_hint(make) -> None:
    group = make(Controller(), available=False)
    group.apply_prefs(CheckinPrefs())
    assert group.state == "no_live"
    assert group.hint.text() == HINT_NO_LIVE
    assert not any(box.isEnabled() for box in boxes(group))


def test_waits_for_the_controller_then_the_preference(make) -> None:
    group = make(None)
    assert group.hint.text() == HINT_CONNECTING
    assert not group.enabled_box.isEnabled()
    controller = Controller(available=None)
    group.cell["controller"] = controller
    group.controller_bound()
    assert group.hint.text() == HINT_LOADING
    assert not group.enabled_box.isEnabled()
    group.apply_prefs(CheckinPrefs(ask_at_loading=False))
    assert group.state == "ready"
    assert group.hint.text() == HINT_READY
    assert [box.isChecked() for box in boxes(group)] == [True, False, True]
    assert all(box.isEnabled() for box in boxes(group))


def test_showing_the_group_retries_an_unloaded_preference(make) -> None:
    controller = Controller(available=None)
    group = make(controller)
    group.show()
    assert controller.refreshes == 1
    group.hide()
    controller.available = False  # the API answered 404: too old
    group.show()
    assert group.hint.text() == HINT_UNSUPPORTED
    assert controller.refreshes == 1
    assert not group.enabled_box.isEnabled()
    group.hide()


def test_children_follow_the_master_switch(make) -> None:
    controller = Controller()
    group = make(controller)
    group.apply_prefs(CheckinPrefs(enabled=False))
    assert not group.enabled_box.isChecked()
    assert group.enabled_box.isEnabled()
    assert not group.loading_box.isEnabled() and not group.after_box.isEnabled()
    assert group.loading_box.isChecked() and group.after_box.isChecked()
    group.enabled_box.click()
    assert controller.changes == [{"enabled": True}]
    assert group.loading_box.isEnabled() and group.after_box.isEnabled()


def test_each_box_writes_its_own_field(make) -> None:
    controller = Controller()
    group = make(controller)
    group.apply_prefs(CheckinPrefs())
    group.loading_box.click()
    group.after_box.click()
    group.enabled_box.click()
    assert controller.changes == [
        {"ask_at_loading": False}, {"ask_after_game": False}, {"enabled": False},
    ]


def test_outside_changes_sync_without_writing_back(make) -> None:
    controller = Controller()
    group = make(controller)
    group.apply_prefs(CheckinPrefs())
    group.apply_prefs(CheckinPrefs(ask_after_game=False))  # card link / website
    assert not group.after_box.isChecked()
    assert controller.changes == []


def test_a_reverted_save_is_explained(make) -> None:
    clock = Clock()
    controller = Controller()
    group = make(controller, clock=clock)
    group.apply_prefs(CheckinPrefs())
    group.after_box.click()
    group.apply_prefs(CheckinPrefs(ask_after_game=False))  # optimistic echo
    assert group.hint.text() == HINT_READY
    clock.now += 6
    group.apply_prefs(CheckinPrefs())  # the write failed: back to the server's
    assert group.after_box.isChecked()
    assert group.hint.text() == HINT_SAVE_FAILED
    # Much later a different value is just a change made elsewhere.
    group.after_box.click()
    clock.now += 60
    group.apply_prefs(CheckinPrefs(enabled=False))
    assert group.hint.text() == HINT_READY


def test_clicks_before_the_preference_loaded_change_nothing(make) -> None:
    controller = Controller(available=None)
    group = make(controller)
    group.enabled_box.setEnabled(True)
    group.enabled_box.click()
    assert controller.changes == []
    assert group.enabled_box.isChecked() and not group.enabled_box.isEnabled()


# ---------------------------------------------------- with the real controller


@pytest.fixture
def wired(app):
    proxy = CheckinViewProxy(lambda method, args: host.dispatch(method, args))
    group = CheckinSettingsGroup(controller=lambda: proxy.controller, available=True)
    host = BuildCheckinHost(controller=lambda: proxy.controller, settings=group)
    h = Harness(view=proxy)
    proxy.bind_controller(h.ctl)
    yield h, group
    group.deleteLater()
    app.processEvents()


def test_preference_round_trip_through_the_controller(wired) -> None:
    h, group = wired
    h.api.prefs = {"enabled": True, "askAtLoading": False, "askAfterGame": True}
    assert group.hint.text() == HINT_LOADING
    h.boot()
    assert group.state == "ready"
    assert [box.isChecked() for box in boxes(group)] == [True, False, True]

    group.loading_box.click()
    h.pump()
    assert h.api.calls_to("put_checkin_prefs")[-1][0][0] == {
        "enabled": True, "askAtLoading": True, "askAfterGame": True,
    }
    assert h.api.prefs["askAtLoading"] is True
    assert group.loading_box.isChecked()
    assert group.hint.text() == HINT_READY

    h.api.fail_next("put_checkin_prefs", api_error(503, "unavailable"))
    group.enabled_box.click()
    h.pump()
    assert h.api.prefs["enabled"] is True
    assert group.enabled_box.isChecked()
    assert group.hint.text() == HINT_SAVE_FAILED


def test_card_links_reach_the_settings_boxes(wired) -> None:
    h, group = wired
    h.boot()
    h.ctl.disable("postgame")
    h.pump()
    assert not group.after_box.isChecked()
    assert h.api.prefs["askAfterGame"] is False


# --------------------------------------------------------- GuiUI integration


def test_gui_wires_the_view_settings_and_backlog(tmp_path: Path) -> None:
    # Like the other main-window tests: a QApplication of its own, so the
    # import-fallback tests can drop PySide6 from sys.modules safely.
    script = textwrap.dedent("""
        import sys
        import threading
        from pathlib import Path
        from PySide6 import QtCore, QtGui, QtWidgets
        from sc2tools_agent.build_checkin.models import CheckinPrefs, LoadingCardModel
        from sc2tools_agent.ui import build_checkin_settings as settings_mod
        from sc2tools_agent.ui import win32_window
        from sc2tools_agent.ui.gui import GuiUI, SettingsPayload, _GuiSignals, _MainWindow

        for name in ("exclude_from_capture", "keep_topmost", "foreground_window",
                     "find_sc2_window", "monitor_of_window", "restore_foreground"):
            setattr(win32_window, name, lambda *args: None)

        app = QtWidgets.QApplication([])
        base = Path(sys.argv[1])
        moved = []
        reset = []

        class Controller:
            available = True
            def __init__(self):
                self.calls = []
            def set_prefs(self, **change):
                self.calls.append(("set_prefs", change))
            def declare(self, *args):
                self.calls.append(("declare", args))
            def refresh_prefs(self):
                pass

        def make(**extra):
            ui = GuiUI(
                version="0.16.9", dashboard_url="https://example.test",
                pairing_url="https://example.test/devices", log_dir=base,
                log_file=base / "agent.log", api_base="https://api.example.test",
                replay_folders=[], initial_paused=False, initial_paired=True,
                initial_user_id="u1", initial_settings=SettingsPayload(),
                on_pause=lambda value: None, on_resync=lambda: None,
                on_choose_folder=lambda path: None, on_check_updates=lambda: None,
                on_save_settings=lambda payload: None, on_quit=lambda: None,
                **extra,
            )
            ui._signals = _GuiSignals()
            window = _MainWindow(ui=ui, signals=ui._signals, QtCore=QtCore,
                                 QtGui=QtGui, QtWidgets=QtWidgets)
            window._log_timer.stop()
            return ui, window

        ui, window = make(
            build_checkin_available=True,
            build_checkin_positions={"loading": [5, 6]},
            on_build_checkin_moved=lambda kind, x, y: moved.append((kind, x, y)),
            on_build_checkin_reset=lambda: reset.append(True),
            build_checkin_preview_race=lambda: "Terran",
        )
        group = window._checkin_settings
        assert isinstance(group, settings_mod.CheckinSettingsGroup)
        assert group.hint.text() == settings_mod.HINT_CONNECTING
        page = group.parentWidget()
        assert page is not None and window._stack.isAncestorOf(group)

        proxy = ui.build_checkin_view()
        assert ui.build_checkin_view() is proxy
        controller = Controller()

        # The boot worker binds and paints before the window is wired.
        def early():
            proxy.bind_controller(controller)
            proxy.update_prefs(CheckinPrefs(ask_after_game=False))
            proxy.show_loading(LoadingCardModel(game_key="k|1", title="PvZ · vs Foo",
                                                waiting_for_matchup=False))
        worker = threading.Thread(target=early)
        worker.start(); worker.join(timeout=2)
        assert len(ui._checkin_backlog) == 3
        assert window._checkin_host.existing_window("loading") is None

        ui._start_build_checkin_delivery()
        assert len(ui._checkin_backlog) == 0
        assert group.state == "ready"
        assert not group.after_box.isChecked()
        card = window._checkin_host.existing_window("loading")
        assert card is not None and card.isVisible()
        assert (card.x(), card.y()) == (5, 6)
        assert card.title.text() == "PvZ · vs Foo"

        # Later calls from another thread arrive through the signal.
        worker = threading.Thread(target=lambda: proxy.hide_loading("k|1", "in_game"))
        worker.start(); worker.join(timeout=2)
        assert card.isVisible()
        app.processEvents()
        assert not card.isVisible()

        group.loading_box.click()
        assert controller.calls == [("set_prefs", {"ask_at_loading": False})]
        window._checkin_host.remember_position("postgame", 7, 8)
        assert moved == [("postgame", 7, 8)]

        # Exercise the actual Settings -> host callback wiring with no live card.
        before = list(controller.calls)
        group.preview_loading.click()
        preview = window._checkin_host.window("loading")
        assert preview.is_preview and preview.model.matchup == "TvP"
        group.preview_postgame.click()
        assert not preview.isVisible()
        preview = window._checkin_host.window("postgame")
        assert preview.is_preview
        group.reset_positions.click()
        assert reset == [True] and window._checkin_host._positions == {}
        assert group.positions_status.text() == "Positions reset"
        import webbrowser
        opened = []
        webbrowser.open = lambda url, **kwargs: opened.append((url, kwargs))
        group.queue_link.click()
        assert opened == [("https://example.test/app", {"new": 2})]
        assert controller.calls == before

        window._checkin_host.close()
        window.deleteLater()

        ui2, window2 = make()
        assert window2._checkin_settings.hint.text() == settings_mod.HINT_NO_LIVE
        assert not window2._checkin_settings.enabled_box.isEnabled()
        window2.deleteLater()
        app.processEvents()
        print("build checkin gui wiring passed")
    """)
    environment = dict(os.environ)
    environment["QT_QPA_PLATFORM"] = "offscreen"
    agent_dir = str(Path(__file__).resolve().parents[1])
    environment["PYTHONPATH"] = os.pathsep.join(
        value for value in (agent_dir, environment.get("PYTHONPATH")) if value
    )
    result = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path)],
        capture_output=True, text=True, timeout=60, env=environment,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "build checkin gui wiring passed" in result.stdout

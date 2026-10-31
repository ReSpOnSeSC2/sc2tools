"""Real local card lifecycle, controls and keyboard flow; no controller writes."""
import os
from pathlib import Path
from dataclasses import replace

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest
from PySide6 import QtCore, QtGui, QtTest, QtWidgets

from sc2tools_agent.build_checkin.models import CheckinPrefs
from sc2tools_agent.build_checkin.preview import sample_loading_model, sample_postgame_model
from sc2tools_agent.ui import win32_window
from sc2tools_agent.ui.build_checkin_window import BuildCheckinHost, LOADING, POSTGAME, default_card_position, rect_of
from sc2tools_agent.ui.build_checkin_settings import (
    PREVIEW_ASSISTANCE_OFF, PREVIEW_CARD_OPEN, PREVIEW_CONNECTING, PREVIEW_UNAVAILABLE, PREVIEW_UNPAIRED,
    CheckinSettingsGroup,
)
from tests._gui_offscreen import run_gui_check
from tests.test_build_checkin_ui_cards import Recorder, loading_model, postgame_model, FEATURED, MORE


@pytest.fixture
def app():
    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    if not QtGui.QFontDatabase.families():
        for name in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf", "seguisym.ttf"):
            source = Path(os.environ.get("SystemRoot", "C:/Windows")) / "Fonts" / name
            if source.is_file(): QtGui.QFontDatabase.addApplicationFont(str(source))
        application.setFont(QtGui.QFont("Segoe UI", 9))
    return application


@pytest.fixture
def native(app, monkeypatch):
    for name in ("exclude_from_capture", "keep_topmost", "foreground_window", "find_sc2_window", "monitor_of_window", "restore_foreground"):
        monkeypatch.setattr(win32_window, name, lambda *_: None)
    # Preview actions must not silently grow network or browser side effects.
    def forbidden(*_args, **_kwargs): raise AssertionError("preview attempted external work")
    monkeypatch.setattr("requests.sessions.Session.request", forbidden)
    monkeypatch.setattr("webbrowser.open", forbidden)
    recorder = Recorder(); moved = []; reset = []
    host = BuildCheckinHost(controller=lambda: recorder, preview_race=lambda: "Terran",
                           positions={"loading": [80, 90], "future-hud": [1, 2]},
                           on_moved=lambda *args: moved.append(args), on_reset_positions=lambda: reset.append(True))
    yield host, recorder, moved, reset
    host.close()
    for kind in (LOADING, POSTGAME):
        if host.existing_window(kind) is not None: host.existing_window(kind).deleteLater()
    app.processEvents()


def test_fixed_sample_models_reuse_scouting_and_last_known_race():
    sample = sample_loading_model(None)
    assert sample.matchup == "ZvP" and sample.opponent_name == "PreviewOpponent"
    assert "Alcyone" in sample.title and sample.scouting is not None
    assert [row.name for row in sample.featured] == ["12 Pool", "Hatch First", "Roach-Ravager"]
    assert sample_loading_model("Protoss").matchup == "PvZ"
    assert sample_loading_model("Terran").matchup == "TvP"
    assert sample_loading_model("Random").matchup == "ZvP"
    assert sample_postgame_model().matchup == "ZvP"


@pytest.mark.parametrize("kind,action", [
    (LOADING, "pick"), (LOADING, "not_now"), (LOADING, "dossier"), (LOADING, "disable"),
    (POSTGAME, "pick"), (POSTGAME, "confirm"), (POSTGAME, "later"), (POSTGAME, "add"),
    (POSTGAME, "no_set"), (POSTGAME, "disable"),
])
def test_preview_actions_close_locally_without_controller_api_or_browser(native, kind, action):
    host, recorder, *_ = native
    assert host.show_preview(kind) is None
    window = host.window(kind)
    assert window.preview_chip.isVisible() and window.preview_chip.text() == "Preview - nothing is saved"
    assert window._preview_timer.interval() == 90_000
    assert window.model.matchup == "TvP"
    actions = {
        "pick": lambda: window.builds.row("preview-0").click(),
        "not_now": lambda: window.not_now.click(), "dossier": lambda: window.scouting.dossier.click(),
        "confirm": lambda: window.primary.click(), "later": lambda: window.later.click(),
        "add": lambda: window.add_build.click(), "no_set": lambda: window.secondary.click(),
        "disable": lambda: (window.dont_ask if kind == LOADING else window.turn_off).click(),
    }
    actions[action]()
    assert not window.isVisible() and not window._preview_timer.isActive()
    assert recorder.calls == []


def test_preview_escape_and_timeout_are_local_and_real_card_replaces_immediately(native, app):
    host, recorder, *_ = native
    host.show_preview(POSTGAME); preview = host.window(POSTGAME)
    # Real elapsed Qt timer dispatch, shortened only after checking the contract.
    assert preview._preview_timer.interval() == 90_000
    assert preview._preview_timer.isActive()
    elapsed = QtTest.QSignalSpy(preview._preview_timer.timeout)
    preview._preview_timer.setInterval(15)
    assert elapsed.wait(1000), "the real Qt preview timeout was not delivered"
    assert not preview.isVisible() and recorder.calls == []
    host.show_preview(LOADING); preview = host.window(LOADING)
    # Loading cards retain their no-focus native flags. Escape is app-local:
    # it works while the user remains in Settings without a global game hotkey.
    settings_input = QtWidgets.QLineEdit()
    settings_input.show(); settings_input.activateWindow(); settings_input.setFocus()
    app.processEvents()
    QtTest.QTest.keyClick(settings_input, QtCore.Qt.Key_Escape)
    app.processEvents()
    assert not preview.isVisible() and recorder.calls == []
    settings_input.close(); settings_input.deleteLater()
    host.show_preview(LOADING)
    real = postgame_model()
    host.dispatch("show_postgame", (real,)); app.processEvents()
    window = host.window(POSTGAME)
    assert not preview.isVisible() and window.isVisible() and not window.is_preview
    assert not window.preview_chip.isVisible() and not window._preview_timer.isActive()
    window._preview_timer.timeout.emit()  # stale queued timeout cannot hide a real card
    assert window.isVisible()
    assert host.show_preview(LOADING) == "card_open" and window.model is real


def test_preview_drag_is_remembered_and_generic_reset_moves_visible_card(native, app):
    host, recorder, moved, reset = native
    host.show_preview(LOADING); window = host.window(LOADING); app.processEvents()
    initial = window.pos()
    start = window.header.mapToGlobal(QtCore.QPoint(5, 5))
    for event_type, delta, buttons in ((QtCore.QEvent.MouseButtonPress, QtCore.QPoint(), QtCore.Qt.LeftButton),
                                      (QtCore.QEvent.MouseMove, QtCore.QPoint(40, 30), QtCore.Qt.LeftButton),
                                      (QtCore.QEvent.MouseButtonRelease, QtCore.QPoint(40, 30), QtCore.Qt.NoButton)):
        event = QtGui.QMouseEvent(event_type, QtCore.QPointF(5, 5), QtCore.QPointF(start + delta), QtCore.Qt.LeftButton, buttons, QtCore.Qt.NoModifier)
        QtWidgets.QApplication.sendEvent(window.header, event)
    assert moved[-1] == (LOADING, initial.x()+40, initial.y()+30)
    host.reset_positions(); app.processEvents()
    assert host._positions == {} and reset == [True] and recorder.calls == []
    screen = window._target_screen()
    assert (window.x(), window.y()) == default_card_position(rect_of(screen.availableGeometry()), rect_of(screen.geometry()), (window.width(), window.height()))


def test_settings_controls_work_when_checkins_are_off_and_feedback_expires(app, native):
    host, recorder, _, reset = native
    group = CheckinSettingsGroup(controller=lambda: None, available=False,
                                on_preview=host.show_preview, on_reset_positions=host.reset_positions,
                                on_open_queue=lambda: reset.append("queue"))
    group.apply_prefs(CheckinPrefs(enabled=False)); group.show(); app.processEvents()
    assert group.preview_loading.isEnabled() and group.preview_postgame.isEnabled()
    assert group.preview_hint.text() == "Check-ins are off; this is only a preview"
    group.preview_loading.click(); assert host.window(LOADING).is_preview
    group.preview_postgame.click(); assert host.window(POSTGAME).is_preview
    group.reset_positions.click(); assert group.positions_status.text() == "Positions reset"
    assert group._position_feedback.interval() == 3000
    elapsed = QtTest.QSignalSpy(group._position_feedback.timeout)
    group._position_feedback.setInterval(15)
    assert elapsed.wait(1000), "the real Qt position-feedback timeout was not delivered"
    assert group.positions_status.text() == ""
    group.queue_link.click(); assert reset == [True, "queue"] and recorder.calls == []
    group.deleteLater(); app.processEvents()


def test_settings_preview_hint_names_each_refusal_and_clears_after_a_preview(app):
    replies = iter(["assistance_off", "unpaired", "connecting", "card_open", "unavailable", None])
    group = CheckinSettingsGroup(controller=lambda: None, available=True, on_preview=lambda _kind: next(replies))
    note = group.preview_hint.text()
    for expected in (PREVIEW_ASSISTANCE_OFF, PREVIEW_UNPAIRED, PREVIEW_CONNECTING, PREVIEW_CARD_OPEN,
                     PREVIEW_UNAVAILABLE, note):
        group.preview_loading.click()
        assert group.preview_hint.text() == expected
    group.deleteLater(); app.processEvents()


def test_main_window_preview_explains_the_companion_assistance_state(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui import win32_window
        from sc2tools_agent.ui.build_checkin_settings import PREVIEW_ASSISTANCE_OFF, PREVIEW_CONNECTING, PREVIEW_UNPAIRED
        for name in ("exclude_from_capture", "keep_topmost", "foreground_window", "find_sc2_window", "monitor_of_window", "restore_foreground"):
            setattr(win32_window, name, lambda *_: None)
        snapshot = {"paired": True, "accountKey": "owner", "liveGame": None, "live": None, "preferences": {}}
        def handler(request):
            if request["action"] == "snapshot":
                return dict(snapshot)
            return {"items": [], "preferences": request.get("preferences", {})}
        def settle(done):
            deadline = QtCore.QDeadlineTimer(5000)
            while not done() and not deadline.hasExpired():
                QtTest.QTest.qWait(10)
            assert done()
        ui, win = make_window(on_companion_action=handler)
        companion, settings, host = win._companion_page, win._checkin_settings, win._checkin_host
        companion.timer.stop()
        settings.preview_loading.click()
        assert settings.preview_hint.text() == PREVIEW_CONNECTING
        settle(lambda: companion._snapshot_healthy)
        # In-game assistance starts off, so the default first preview names that switch.
        settings.preview_loading.click()
        assert settings.preview_hint.text() == PREVIEW_ASSISTANCE_OFF
        snapshot["paired"] = False
        companion.refresh(); settle(lambda: not companion._paired)
        companion.refresh(); settle(lambda: companion._snapshot_healthy)
        settings.preview_postgame.click()
        assert settings.preview_hint.text() == PREVIEW_UNPAIRED
        snapshot["paired"] = True
        companion.refresh(); settle(lambda: companion._paired)
        companion.set_preference("overlaysEnabled", True)
        settings.preview_loading.click()
        assert host.window("loading").is_preview and settings.preview_hint.text() == settings._preview_note()
        host.close(); companion.shutdown()
    ''')


def test_search_enter_selects_top_filtered_match_then_ctrl_enter_confirms(native, app):
    host, recorder, *_ = native
    host.dispatch("show_postgame", (postgame_model(),)); window = host.window(POSTGAME)
    window.activateWindow(); app.processEvents()
    search = window.builds.search; search.setFocus()
    QtTest.QTest.keyClicks(search, "Catalog build 6")
    QtTest.QTest.keyClick(search, QtCore.Qt.Key_Return); app.processEvents()
    assert window.selection() == "catalog-6" and window.builds.row("catalog-6").hasFocus()
    assert not recorder.named("confirm")
    QtTest.QTest.keyClick(window.builds.row("catalog-6"), QtCore.Qt.Key_Return, QtCore.Qt.ControlModifier)
    assert recorder.named("confirm") == [(window.model.card_id, "catalog-6", "")]


def test_search_down_focuses_without_picking_up_returns_and_empty_enter_is_noop(native, app):
    host, recorder, *_ = native
    host.dispatch("show_postgame", (postgame_model(),)); window = host.window(POSTGAME)
    window.activateWindow(); app.processEvents()
    search = window.builds.search; search.setFocus(); selection = window.selection()
    QtTest.QTest.keyClick(search, QtCore.Qt.Key_Down); app.processEvents()
    first = window.builds.row(window.builds.visible_keys()[0])
    assert first.hasFocus() and window.selection() == selection
    QtTest.QTest.keyClick(first, QtCore.Qt.Key_Up); assert search.hasFocus()
    QtTest.QTest.keyClicks(search, "no such build")
    QtTest.QTest.keyClick(search, QtCore.Qt.Key_Return)
    assert window.selection() == selection and search.hasFocus()
    assert window.builds.empty_label.isVisible() and not recorder.named("confirm")


def test_search_matches_keep_featured_before_more_after_filtering(native, app):
    host, recorder, *_ = native
    model = postgame_model(featured=(replace(FEATURED[0], name="Hidden"), replace(FEATURED[1], name="Macro first")),
                           more=(replace(MORE[0], name="Macro second"),))
    host.dispatch("show_postgame", (model,)); window = host.window(POSTGAME)
    window.activateWindow(); app.processEvents(); window.builds.search.setFocus()
    QtTest.QTest.keyClicks(window.builds.search, "Macro")
    QtTest.QTest.keyClick(window.builds.search, QtCore.Qt.Key_Return)
    assert window.selection() == FEATURED[1].key and window.builds.row(FEATURED[1].key).hasFocus()
    assert not recorder.named("confirm")


def test_preview_retains_loading_native_flags_and_never_requests_focus(native, monkeypatch):
    from sc2tools_agent.ui.build_checkin_cards import LoadingCardWindow
    requested = []
    monkeypatch.setattr(LoadingCardWindow, "activateWindow", lambda *_: requested.append("activate"))
    monkeypatch.setattr(LoadingCardWindow, "setFocus", lambda *_: requested.append("focus"))
    host, *_ = native; host.show_preview(LOADING); window = host.window(LOADING)
    flags, handle = window.windowFlags(), window.winId()
    assert flags & QtCore.Qt.WindowDoesNotAcceptFocus
    assert window.testAttribute(QtCore.Qt.WA_ShowWithoutActivating)
    assert not requested
    host.dispatch("show_loading", (loading_model(),))
    assert window.windowFlags() == flags and window.winId() == handle
    assert not window.is_preview and not window._preview_escape.isEnabled() and not requested

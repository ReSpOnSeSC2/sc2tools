from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import textwrap

import pytest

from sc2tools_agent.ui.companion_session import SESSION_FRESH_SECONDS, format_session_elapsed, session_presentation
from tests._gui_offscreen import run_gui_check


NOW = 1_790_000_000


def snapshot(**session_fields):
    return {
        "paired": True, "accountKey": "owned-session", "receivedAt": NOW, "source": "overlay-session",
        "session": {"wins": 0, "losses": 1, "games": 1,
                    "sessionStartedAt": datetime.fromtimestamp(NOW - 7020, timezone.utc).isoformat(),
                    **session_fields},
    }


def test_source_record_and_actual_session_start_are_presented_without_local_day_inference():
    source = snapshot(region="na")
    original = deepcopy(source)
    view = session_presentation(source, now=NOW)
    assert view["available"] and view["winsText"] == "0W" and view["lossesText"] == "1L"
    assert view["elapsedText"] == "1h 57m" and view["region"] == "NA"
    assert "0 wins, 1 losses" in view["description"] and "NA" in view["description"]
    assert source == original


def test_explicit_empty_record_is_not_confused_with_missing_data_or_missing_start():
    source = snapshot(wins=0, losses=0, games=0, sessionStartedAt=None)
    view = session_presentation(source, now=NOW)
    assert view["available"] and view["winsText"] == "0W" and view["lossesText"] == "0L"
    assert view["elapsedText"] == "—"
    source["session"] = None
    missing = session_presentation(source, now=NOW)
    assert not missing["available"] and missing["winsText"] == "—W" and missing["lossesText"] == "—L"
    assert missing["elapsedText"] == "—" and missing["region"] is None


@pytest.mark.parametrize("field,value", [
    ("paired", False), ("paired", 1), ("accountKey", None), ("accountKey", "  "),
    ("source", "local-history"), ("receivedAt", None), ("receivedAt", True),
    ("receivedAt", float("nan")), ("receivedAt", float("inf")), ("receivedAt", 10 ** 1000),
    ("receivedAt", NOW - SESSION_FRESH_SECONDS - 0.1), ("receivedAt", NOW + 5.1),
])
def test_unknown_owner_or_unreliable_envelope_never_paints_a_private_or_zero_record(field, value):
    source = snapshot(region="EU")
    source[field] = value
    view = session_presentation(source, now=NOW)
    assert not view["available"] and view["winsText"] == "—W" and view["lossesText"] == "—L"
    assert view["elapsedText"] == "—" and view["region"] is None


@pytest.mark.parametrize("value", [None, True, -1, 1.0, "1", float("nan"), 2 ** 53])
@pytest.mark.parametrize("field", ["wins", "losses", "games"])
def test_malformed_counters_are_not_coerced_to_a_record(field, value):
    view = session_presentation(snapshot(**{field: value}), now=NOW)
    assert not view["available"] and view["wins"] is None and view["losses"] is None


def test_game_count_cannot_contradict_the_record_but_draws_are_not_invented_as_losses():
    assert not session_presentation(snapshot(wins=2, losses=1, games=2), now=NOW)["available"]
    view = session_presentation(snapshot(wins=1, losses=1, games=3), now=NOW)
    assert view["available"] and view["winsText"] == "1W" and view["lossesText"] == "1L"


@pytest.mark.parametrize("started", [None, "", "not-a-date", "2026-01-01", "2026-01-01T00:00:00", 123,
                                     datetime.fromtimestamp(NOW + 1, timezone.utc).isoformat()])
def test_missing_naive_or_future_session_start_does_not_fabricate_a_zero_timer(started):
    view = session_presentation(snapshot(sessionStartedAt=started), now=NOW)
    assert view["available"] and view["elapsedText"] == "—"


def test_timezone_offsets_are_honored_and_elapsed_ticks_only_until_source_freshness_expires():
    source = snapshot(sessionStartedAt=datetime.fromtimestamp(NOW - 45, timezone.utc).isoformat().replace("+00:00", "Z"))
    assert session_presentation(source, now=NOW)["elapsedText"] == "0m 45s"
    assert session_presentation(source, now=NOW + 10)["elapsedText"] == "0m 55s"
    assert session_presentation(source, now=NOW + SESSION_FRESH_SECONDS)["available"]
    assert not session_presentation(source, now=NOW + SESSION_FRESH_SECONDS + 1)["available"]
    source["session"]["sessionStartedAt"] = datetime.fromtimestamp(NOW, timezone.utc).isoformat()
    assert session_presentation(source, now=NOW)["elapsedText"] == "0m 00s"
    source["session"]["sessionStartedAt"] = datetime.fromtimestamp(NOW, timezone.utc).isoformat().replace("+00:00", "+01:00")
    assert session_presentation(source, now=NOW)["elapsedText"] == "1h 00m"


@pytest.mark.parametrize("seconds,expected", [(0, "0m 00s"), (59.9, "0m 59s"), (60, "1m 00s"),
                                              (3599, "59m 59s"), (3600, "1h 00m"), (7020, "1h 57m"),
                                              (90000, "25h 00m"), (None, "—"), (True, "—"),
                                              (-1, "—"), (float("inf"), "—"), (10 ** 1000, "—")])
def test_elapsed_formatting_is_bounded_readable_and_does_not_guess_invalid_values(seconds, expected):
    assert format_session_elapsed(seconds) == expected


@pytest.mark.parametrize("region,expected", [(None, None), ("", None), ("na", "NA"), (" EU ", "EU"),
                                            ("SEA", "SEA"), ("Unknown region", None), ("<b>NA</b>", None)])
def test_region_is_optional_and_only_shown_from_an_explicit_valid_source(region, expected):
    assert session_presentation(snapshot(region=region), now=NOW)["region"] == expected


def test_own_rating_is_explicitly_latest_known_and_region_is_not_claimed_as_active_server():
    source = snapshot(region="EU", mmrCurrent=9999)
    source["ownRating"] = {"mmr": 5157, "source": "overlay-session", "status": "latest-known"}
    source["opponent"] = {"mmr": 6000}
    view = session_presentation(source, now=NOW)
    assert view["mmr"] == 5157 and view["ratingText"] == "5157 MMR · latest"
    assert view["regionText"] == "Rating region EU"
    assert "latest-known MMR" in view["description"] and "Active server is unavailable" in view["description"]
    source["receivedAt"] = NOW - SESSION_FRESH_SECONDS - 1
    stale = session_presentation(source, now=NOW)
    assert stale["mmr"] is None and stale["ratingText"] == "MMR —" and stale["regionText"] == "Rating region —"


@pytest.mark.parametrize("rating", [None, {}, {"mmr": 5000},
    {"mmr": True, "source": "overlay-session", "status": "latest-known"},
    {"mmr": 5000, "source": "opponent", "status": "latest-known"},
    {"mmr": 5000, "source": "overlay-session", "status": "current"},
    {"mmr": -1, "source": "overlay-session", "status": "latest-known"},
    {"mmr": 20_001, "source": "overlay-session", "status": "latest-known"}])
def test_unknown_or_unproven_rating_never_falls_back_to_opponent_or_raw_session_mmr(rating):
    source = snapshot(mmrCurrent=9999, region="EU")
    source["ownRating"] = rating
    source["opponent"] = {"mmr": 5000}
    view = session_presentation(source, now=NOW)
    assert view["mmr"] is None and view["ratingText"] == "MMR —"


def run_session_check(tmp_path, body):
    setup = '''
import time
from datetime import datetime, timezone
from unittest.mock import patch
from sc2tools_agent.ui import theme
from sc2tools_agent.ui.companion_session import build_companion_session
for filename in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
    QtGui.QFontDatabase.addApplicationFont("C:/Windows/Fonts/" + filename)
app.setStyleSheet(theme.STYLE)
panel = build_companion_session(QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
now = time.time()
source = {"paired": True, "accountKey": "owner", "receivedAt": now, "source": "overlay-session",
          "session": {"wins": 0, "losses": 1, "games": 1,
                      "sessionStartedAt": datetime.fromtimestamp(now - 7020, timezone.utc).isoformat()}}
closed = []
panel.userClosed.connect(lambda: closed.append(True))
'''
    cleanup = '''
finally:
    panel.shutdown()
    panel.deleteLater()
    app.processEvents()
'''
    run_gui_check(tmp_path, setup + "\ntry:\n" + textwrap.indent(textwrap.dedent(body), "    ") + cleanup)


def test_small_session_panel_has_themed_controls_real_native_drag_resize_and_no_game_gate(tmp_path):
    run_session_check(tmp_path, '''
        from types import SimpleNamespace
        assert not panel.isVisible() and not panel._timer.isActive()
        panel.update_session(source)
        panel.set_enabled(True)
        app.processEvents()
        assert panel.size().toTuple() == (150, 138)
        assert panel.windowFlags() & QtCore.Qt.FramelessWindowHint
        assert panel.windowFlags() & QtCore.Qt.Tool
        assert panel.windowFlags() & QtCore.Qt.WindowStaysOnTopHint
        assert panel.testAttribute(QtCore.Qt.WA_ShowWithoutActivating)
        assert not panel.testAttribute(QtCore.Qt.WA_QuitOnClose)
        assert panel.testAttribute(QtCore.Qt.WA_StyledBackground)
        assert panel.grab().toImage().pixelColor(0, 50).name() == theme.ACCENT
        assert panel.parentWidget() is None
        assert panel._timer.isActive()
        assert panel.wins_label.text() == "0W" and panel.losses_label.text() == "1L"
        assert panel.wins_label.font().pixelSize() >= 24 and panel.losses_label.font().pixelSize() >= 24
        assert panel.elapsed_label.text() == "1h 57m"
        assert panel.window_controls.maximize_button.isHidden()
        for widget in (panel.title, panel.wins_label, panel.losses_label, panel.rating_label, panel.region_label, panel.elapsed_label,
                       panel.window_controls.minimize_button, panel.window_controls.close_button):
            position = widget.mapTo(panel, QtCore.QPoint())
            assert panel.rect().contains(QtCore.QRect(position, widget.size())), widget.objectName()
        interactions = panel._window_interactions
        assert interactions._drag_target(panel.title) and interactions._drag_target(panel.wins_label)
        assert not interactions._drag_target(panel.window_controls.close_button)
        assert not interactions._drag_target(panel.window_controls.minimize_button)
        calls = []
        panel.windowHandle = lambda: SimpleNamespace(startSystemMove=lambda: calls.append("move") or True,
                                                     startSystemResize=lambda edges: calls.append(edges) or True)
        def mouse(position):
            return QtGui.QMouseEvent(QtCore.QEvent.MouseButtonPress, QtCore.QPointF(position),
                QtCore.QPointF(position), QtCore.Qt.LeftButton, QtCore.Qt.LeftButton, QtCore.Qt.NoModifier)
        assert interactions.eventFilter(panel.title, mouse(QtCore.QPoint(10, 10)))
        assert interactions.eventFilter(panel, mouse(QtCore.QPoint(1, 45)))
        assert calls == ["move", QtCore.Qt.LeftEdge]
        panel.resize(220, 150)
        app.processEvents()
        assert panel.size().toTuple() == (220, 150)
        assert panel.wins_label.text() == "0W" and panel.losses_label.text() == "1L"
        assert panel.grab().save(str(base / "session-default.png"))
    ''')


def test_session_polling_keeps_minimized_and_only_explicit_reenable_restores_the_panel(tmp_path):
    run_session_check(tmp_path, '''
        panel.update_session(source)
        panel.set_enabled(True)
        panel.window_controls.minimize_button.click()
        app.processEvents()
        assert panel.isMinimized()
        for tick in range(3):
            panel.update_session(source)
            panel.set_enabled(True)
            app.processEvents()
            assert panel.isMinimized()
        panel.set_enabled(False)
        assert not panel.isVisible() and not panel._timer.isActive()
        panel.set_enabled(True)
        app.processEvents()
        assert panel.isVisible() and not panel.isMinimized()
        panel.window_controls.close_button.click()
        assert closed == [True] and not panel.isVisible() and not panel._enabled and not panel._timer.isActive()
        panel.update_session(source)
        assert not panel.isVisible()
        panel.set_enabled(True)
        app.processEvents()
        assert panel.isVisible() and not panel.isMinimized()
        panel.shutdown()
        assert closed == [True]
    ''')


def test_session_timer_expires_stale_data_and_account_clear_removes_the_previous_record(tmp_path):
    run_session_check(tmp_path, '''
        source["session"]["region"] = "EU"
        panel.update_session(source)
        panel.set_enabled(True)
        app.processEvents()
        source["session"]["wins"] = 99
        panel._timer.timeout.emit()
        assert panel.wins_label.text() == "0W"
        with patch("sc2tools_agent.ui.companion_session.time.time", return_value=now + 91):
            panel._timer.timeout.emit()
            assert panel.wins_label.text() == "—W" and panel.losses_label.text() == "—L"
            assert panel.elapsed_label.text() == "—"
            assert "stale" in panel.accessibleDescription()
        panel.update_session({"paired": False})
        assert panel.wins_label.text() == "—W" and panel.elapsed_label.text() == "—"
        panel.update_session({"paired": True, "accountKey": "new-owner", "receivedAt": now,
                              "source": "overlay-session", "session": None})
        assert panel.wins_label.text() == "—W" and panel.losses_label.text() == "—L"
        assert panel.isVisible()
    ''')


def test_session_own_rating_labels_fit_and_clear_with_expired_data(tmp_path):
    run_session_check(tmp_path, '''
        source["session"]["region"] = "EU"
        source["ownRating"] = {"mmr": 5157, "source": "overlay-session", "status": "latest-known"}
        panel.update_session(source)
        panel.set_enabled(True)
        app.processEvents()
        assert panel.rating_label.text() == "5157 MMR · latest"
        assert panel.region_label.text() == "Rating region EU"
        assert "not a verified active server" in panel.region_label.accessibleName()
        for widget in (panel.rating_label, panel.region_label):
            assert "…" not in widget.text()
            assert panel.rect().contains(QtCore.QRect(widget.mapTo(panel, QtCore.QPoint()), widget.size()))
        source["ownRating"]["mmr"] = 9999
        panel._timer.timeout.emit()
        assert panel.rating_label.text() == "5157 MMR · latest"
        with patch("sc2tools_agent.ui.companion_session.time.time", return_value=now + 91):
            panel._timer.timeout.emit()
            assert panel.rating_label.text() == "MMR —" and panel.region_label.text() == "Rating region —"
    ''')


def test_session_panel_all_race_borders_restore_default_without_clipping_or_idle_animation(tmp_path):
    run_session_check(tmp_path, '''
        panel.update_session(source)
        panel.set_enabled(True)
        app.processEvents()
        original_geometry = panel.geometry()
        original_style = panel.styleSheet()
        original_controls = panel.window_controls.styleSheet()
        for skin in ("protoss", "terran", "zerg"):
            panel.set_appearance(skin, True)
            app.processEvents()
            assert panel._race_effects.skin == skin and panel._race_effects.motion_enabled
            assert panel._race_effects.overlay.isVisible()
            assert panel._race_effects.overlay.artwork.image_for_skin(skin) is not None
            assert panel._race_effects.overlay.testAttribute(QtCore.Qt.WA_TransparentForMouseEvents)
            assert panel._race_effects.overlay.focusPolicy() == QtCore.Qt.NoFocus
            assert panel.geometry() == original_geometry
            assert not panel._race_effects.timer.isActive()
            assert panel.wins_label.text() == "0W" and panel.losses_label.text() == "1L"
            assert panel.grab().save(str(base / ("session-" + skin + ".png")))
        panel.set_appearance("default", False)
        assert panel.styleSheet() == original_style and panel.window_controls.styleSheet() == original_controls
        assert not panel._race_effects.overlay.isVisible() and not panel._race_effects.motion_enabled
        assert panel.geometry() == original_geometry
        panel.set_appearance("protoss", True)
        assert panel._race_effects.play_expand()
        assert panel._race_effects.timer.isActive()
        panel.shutdown()
        assert not panel.isVisible() and not panel._timer.isActive() and not panel._race_effects.timer.isActive()
        assert panel._race_effects._closed
        panel.set_enabled(True)
        panel.update_session(source)
        assert not panel.isVisible() and not panel._timer.isActive()
    ''')


@pytest.mark.parametrize("skin", ["default", "protoss", "terran", "zerg"])
def test_saved_session_race_chrome_is_correct_when_applied_before_first_enable(tmp_path, skin):
    run_session_check(tmp_path, f'''
        from sc2tools_agent.ui.race_visuals import palette_for_skin
        panel.set_appearance({skin!r}, True)
        panel.update_session(source)
        assert not panel.isVisible()
        panel.set_enabled(True)
        app.processEvents()
        expected = palette_for_skin({skin!r})["frame"]
        for button in (panel.window_controls.minimize_button, panel.window_controls.close_button):
            image = button.grab().toImage()
            assert image.pixelColor(8, 8).name() == expected
        assert panel._race_effects.skin == {skin!r}
        assert panel.size().toTuple() == (150, 138)
        assert panel.wins_label.text() == "0W" and panel.losses_label.text() == "1L"
        panel.window_controls.minimize_button.click()
        panel.update_session(source)
        panel.set_enabled(True)
        app.processEvents()
        assert panel.isMinimized()
    ''')

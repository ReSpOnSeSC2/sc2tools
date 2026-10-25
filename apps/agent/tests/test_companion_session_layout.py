import pytest

from tests._gui_offscreen import run_gui_check


@pytest.mark.parametrize("scale_factor", ["1", "1.25", "1.5"])
def test_session_record_rating_and_elapsed_stay_inside_every_bezel_when_resized(tmp_path, monkeypatch, scale_factor):
    monkeypatch.setenv("QT_SCALE_FACTOR", scale_factor)
    run_gui_check(tmp_path, '''
        import math
        import time
        from datetime import datetime, timezone
        from sc2tools_agent.ui import theme
        from sc2tools_agent.ui.companion_session import build_companion_session

        for filename in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
            QtGui.QFontDatabase.addApplicationFont("C:/Windows/Fonts/" + filename)
        app.setFont(QtGui.QFont("Segoe UI", 10))
        app.setStyleSheet(theme.STYLE)
        now = time.time()
        source = {
            "paired": True, "accountKey": "layout-owner", "receivedAt": now, "source": "overlay-session",
            "ownRating": {"mmr": 5161, "source": "overlay-session", "status": "latest-known"},
            "session": {"wins": 1, "losses": 1, "games": 2, "region": "EU",
                        "sessionStartedAt": datetime.fromtimestamp(now - 9540, timezone.utc).isoformat()},
        }
        for skin in ("default", "protoss", "terran", "zerg"):
            panel = build_companion_session(QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
            panel.set_appearance(skin, False)
            panel.update_session(source)
            panel.set_enabled(True)
            try:
                for width, height in ((150, 138), (150, 144), (150, 145), (150, 150), (220, 190), (150, 138)):
                    panel.resize(width, height)
                    QtTest.QTest.qWait(10)
                    assert panel.size().toTuple() == (width, height)
                    assert panel.wins_label.text() == "1W" and panel.losses_label.text() == "1L"
                    assert panel.rating_label.text() == "5161 MMR · latest"
                    assert panel.region_label.text() == "Rating region EU"
                    assert panel.elapsed_label.text() == "2h 39m"
                    safe = panel.rect().marginsRemoved(panel.layout().contentsMargins())
                    labels = (panel.title, panel.wins_label, panel.losses_label,
                              panel.rating_label, panel.region_label, panel.elapsed_label)
                    for label in labels:
                        bounds = QtCore.QRect(label.mapTo(panel, QtCore.QPoint()), label.size())
                        assert safe.contains(bounds), (skin, panel.size(), label.objectName(), bounds, safe)
                        assert label.height() >= label.fontMetrics().height(), (skin, label.objectName())
                        assert label.fontMetrics().horizontalAdvance(label.text()) <= label.width()
                    assert panel.wins_label.font().pixelSize() >= 24
                    assert panel.losses_label.font().pixelSize() >= 24
                    for button in (panel.window_controls.minimize_button, panel.window_controls.close_button):
                        bounds = QtCore.QRect(button.mapTo(panel, QtCore.QPoint()), button.size())
                        assert safe.contains(bounds)
                    if skin != "default":
                        overlay = panel._race_effects.overlay
                        assert overlay.isVisible()
                        image = overlay.grab().toImage()
                        ratio = image.devicePixelRatio()
                        for label in labels:
                            position = label.mapTo(overlay, QtCore.QPoint())
                            for vertical in range(math.floor(position.y() * ratio),
                                                  math.ceil((position.y() + label.height()) * ratio)):
                                for horizontal in range(math.floor(position.x() * ratio),
                                                        math.ceil((position.x() + label.width()) * ratio)):
                                    assert image.pixelColor(horizontal, vertical).alpha() == 0, (
                                        skin, panel.size(), label.objectName(), horizontal, vertical,
                                    )
                assert panel.grab().save(str(base / ("session-readable-" + skin + ".png")))
                panel.window_controls.minimize_button.click()
                app.processEvents()
                assert panel.isMinimized()
                panel.set_enabled(False)
                panel.set_enabled(True)
                app.processEvents()
                assert panel.isVisible() and not panel.isMinimized()
                panel.window_controls.close_button.click()
                assert not panel.isVisible() and not panel._enabled
            finally:
                panel.shutdown()
                panel.deleteLater()
                app.processEvents()
    ''')


def test_compact_bezel_opt_in_does_not_change_normal_race_artwork_callers(tmp_path):
    run_gui_check(tmp_path, '''
        from unittest.mock import patch
        from sc2tools_agent.ui import race_artwork

        normal = race_artwork.create_race_artwork(QtCore=QtCore, QtGui=QtGui)
        compact = race_artwork.create_race_artwork(QtCore=QtCore, QtGui=QtGui, compact_bezel=True)
        image = QtGui.QImage(280, 200, QtGui.QImage.Format_ARGB32_Premultiplied)
        image.fill(QtCore.Qt.transparent)
        painter = QtGui.QPainter(image)
        try:
            with patch.object(race_artwork, "frame_pieces", wraps=race_artwork.frame_pieces) as pieces:
                for skin in ("protoss", "terran", "zerg"):
                    rectangle = QtCore.QRectF(2, 2, 275, 195)
                    assert normal.paint(painter, skin, rectangle)
                    expected = race_artwork.ZERG_NORMAL_CORNER if skin == "zerg" else race_artwork.NORMAL_CORNER
                    assert pieces.call_args.kwargs["normal_corner"] == expected
                    assert compact.paint(painter, skin, rectangle)
                    assert pieces.call_args.kwargs["normal_corner"] == race_artwork.COMPACT_CORNER
        finally:
            painter.end()
    ''')

import pytest

from tests._gui_offscreen import run_gui_check


@pytest.mark.parametrize("scale_factor", ["1", "1.25", "1.5"])
def test_scouting_pin_keeps_controls_and_timings_accessible_inside_themed_frame(tmp_path, monkeypatch, scale_factor):
    monkeypatch.setenv("QT_SCALE_FACTOR", scale_factor)
    run_gui_check(tmp_path, '''
        import os
        from sc2tools_agent.ui import theme
        from sc2tools_agent.ui.companion_page import build_companion_page

        fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
        for filename in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
            font_path = fonts / filename
            if font_path.is_file():
                QtGui.QFontDatabase.addApplicationFont(str(font_path))
        app.setFont(QtGui.QFont("Segoe UI", 10))
        app.setStyleSheet(theme.STYLE)
        page = build_companion_page(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
        panel = page.overlays["scouting"]
        games = [{"gameId": "first", "myBuild": "PvT - Two base Blink into macro",
                  "oppStrategy": "TvP - Three Barracks timing", "map": "An example map",
                  "myTechMilestones": [{"name": "Cybernetics Core", "timeSec": 85, "kind": "building", "timing": "started"}],
                  "oppTechMilestones": [{"name": "Stimpack", "timeSec": 180, "kind": "upgrade", "timing": "completed"}]},
                 {"gameId": "second", "myBuild": "A longer alternative build name", "oppStrategy": "A different opponent opening"}]
        panel.update_context({"name": "NorthStar Example Opponent", "race": "Terran", "mmr": 4300,
                              "headToHead": {"wins": 3, "losses": 2}, "last5GamesScouting": games})
        selected = panel.games.currentData()
        try:
            for skin in ("default", "protoss", "terran", "zerg"):
                panel.set_appearance(skin, False)
                for width, height in ((650, 450), (420, 300), (650, 600), (420, 300), (650, 450)):
                    panel.resize(width, height)
                    panel.show()
                    QtTest.QTest.qWait(10)
                    assert panel.size().toTuple() == (width, height)
                    assert panel.games.currentData() == selected
                    safe = QtCore.QRect(32, 30, width - 64, height - 58)
                    assert safe.contains(panel.header.geometry())
                    assert safe.contains(panel.scouting_scroll.geometry())
                    assert panel.scouting_scroll.horizontalScrollBar().maximum() == 0
                    for widget in (panel.subtitle, panel.detail, panel.games, panel.build_time_range,
                                   panel.comparison_title, panel.observation_note):
                        panel.scouting_scroll.ensureWidgetVisible(widget)
                        QtTest.QTest.qWait(5)
                        viewport = panel.scouting_scroll.viewport()
                        rectangle = QtCore.QRect(widget.mapTo(viewport, QtCore.QPoint()), widget.size())
                        assert viewport.rect().contains(rectangle), (skin, (width, height), widget.objectName(), rectangle, viewport.rect())
                    for side in ("my", "opp"):
                        card = panel.comparison.chain_cards[0 if side == "my" else 1]
                        assert card.geometry().right() < panel.comparison.width()
                        assert panel.comparison.build_chains[side].scroll.horizontalScrollBar().maximum() == 0
                        button = panel.comparison.chain_reference_buttons["you" if side == "my" else "opponent"]
                        assert card.rect().contains(button.geometry())
                    started = panel.comparison.build_chains["my"].steps[0]
                    completed = panel.comparison.upgrade_chains["opp"].steps[0]
                    assert started.time_label.text() == "1:25"
                    assert started.timing_label.text() == "Started"
                    assert completed.time_label.text() == "3:00"
                    assert completed.timing_label.text() == "Completed"
            assert getattr(panel.games, "_sc2_wheel_guard", None) is not None
            panel.games.setCurrentIndex(1)
            panel.update_context({"name": "NorthStar Example Opponent", "last5GamesScouting": games})
            assert panel.games.currentData() == "second"
        finally:
            page.shutdown()
            page.deleteLater()
            app.processEvents()
    ''', timeout=60)
